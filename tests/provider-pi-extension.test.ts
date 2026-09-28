import { execFile, fork } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createMacOSComputerUseClient,
  GatewayConfigSchema,
  ProviderLifecycleDiagnosticSchema,
} from "../src/index.js";
import { PiTaskSupervisor } from "../src/pi-extension/runtime/index.js";
import { createPiExtension } from "../src/pi-extension/index.js";
import type { ExtensionAPI, ToolContext, ToolDefinition } from "../src/pi-extension/pi-types.js";

const execFileAsync = promisify(execFile);
const configPath = process.env.MCU_PROVIDER_CONFIG;
const profile = process.env.MCU_PROVIDER_PROFILE;
const managed = async () => {
  const { stdout } = await execFileAsync("tart", ["list", "--format", "json"]);
  return (JSON.parse(stdout) as { Name?: unknown }[]).filter(
    (item) => typeof item.Name === "string" && item.Name.startsWith("mcu-run-"),
  );
};
const finalAssertions = [{ kind: "visible" as const, query: { identifier: "fixture.click" } }];
const application = { name: "MacOSComputerUseFixture" };
const isolatedConfig = async (): Promise<{ path: string; cleanup(): Promise<void> }> => {
  if (!configPath) throw new Error("Config required");
  const directory = await mkdtemp(join(tmpdir(), "mcu-pi-uat-"));
  const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  config.state.root = join(directory, "state");
  config.state.tempRoot = join(directory, "temp");
  config.evidence.root = join(directory, "evidence");
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
};
const waitForNoManagedClone = async (): Promise<void> => {
  for (let attempt = 0; attempt < 1_200 && (await managed()).length > 0; attempt += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  expect(await managed()).toEqual([]);
};
const startCrashFixture = async (path: string) => {
  const child = fork("tests/fixtures/pi-parent-crash.mjs", [path], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.on("message", (message) => {
      if ((message as { ready?: unknown }).ready) resolve();
    });
  });
  return child;
};

describe.skipIf(!configPath || profile !== "pi-fail-dead")("Pi Extension fail-dead supervision", () => {
  it("finishes normally with complete Evidence and no residual managed clone", async () => {
    const isolated = await isolatedConfig();
    try {
      const supervisor = new PiTaskSupervisor(isolated.path, process.cwd());
      await supervisor.start(application);
      const result = await supervisor.request({ type: "finish" });
      expect(result).toMatchObject({
        kind: "finished",
        result: { evidence: "complete", cleanup: "completed" },
      });
      if (result.kind !== "finished") throw new Error("Unexpected finish result.");
      expect(["passed", "failed", "inconclusive"]).toContain(result.result.verdict);
      await waitForNoManagedClone();
    } finally {
      await isolated.cleanup();
    }
  }, 600_000);

  it("stops automation and cleans the clone when the Pi parent process disappears", async () => {
    const isolated = await isolatedConfig();
    const child = await startCrashFixture(isolated.path);
    expect((await managed()).length).toBe(1);
    child.kill("SIGKILL");
    await waitForNoManagedClone();
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(isolated.path, "utf8")) as unknown);
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    let recovery = await client.value.recover();
    for (
      let attempt = 0;
      attempt < 100 && !recovery.ok && recovery.error.code === "GatewayBusy";
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      recovery = await client.value.recover();
    }
    expect(recovery).toEqual({ ok: true, value: { status: "clean" } });
    await isolated.cleanup();
  }, 600_000);

  it("recovers runner-crash ownership before accepting the next task", async () => {
    const isolated = await isolatedConfig();
    const parent = await startCrashFixture(isolated.path);
    const before = await managed();
    expect(before).toHaveLength(1);
    const { stdout } = await execFileAsync("pgrep", ["-P", String(parent.pid)]);
    const runnerPid = Number(stdout.trim().split(/\s+/)[0]);
    expect(Number.isInteger(runnerPid)).toBe(true);
    process.kill(runnerPid, "SIGKILL");
    parent.kill("SIGKILL");

    const next = new PiTaskSupervisor(isolated.path, process.cwd());
    await next.start(application);
    const during = await managed();
    expect(during).toHaveLength(1);
    expect(during[0]?.Name).not.toBe(before[0]?.Name);
    await next.shutdown("runner crash recovery verified");
    await waitForNoManagedClone();
    await isolated.cleanup();
  }, 600_000);
});

describe.skipIf(!configPath || profile !== "pi-uat-fix")("Pi Extension UAT fixes", () => {
  const extensionTools = (path: string): { tools: Map<string, ToolDefinition>; context: ToolContext } => {
    const tools = new Map<string, ToolDefinition>();
    const api: ExtensionAPI = {
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: () => undefined,
      on: (() => () => undefined) as ExtensionAPI["on"],
    };
    createPiExtension({ configPath: path, registerProcessSignal: () => () => undefined })(api);
    return {
      tools,
      context: {
        cwd: process.cwd(),
        mode: "tui",
        hasUI: true,
        ui: { confirm: async () => true, notify: () => undefined },
      },
    };
  };

  it("remains usable after more than 60 seconds idle and returns compact post-action state", async () => {
    const isolated = await isolatedConfig();
    try {
      const raw = GatewayConfigSchema.parse(JSON.parse(await readFile(isolated.path, "utf8")) as unknown);
      await writeFile(isolated.path, JSON.stringify(raw));
      const { tools, context } = extensionTools(isolated.path);
      const begin = tools.get("macos_begin");
      const observe = tools.get("macos_observe");
      const action = tools.get("macos_action");
      const freeze = tools.get("macos_freeze_assertions");
      const finish = tools.get("macos_finish");
      if (!begin || !observe || !action || !freeze || !finish) throw new Error("Pi tools unavailable.");
      await begin.execute("begin", { application }, undefined, undefined, context);
      await freeze.execute(
        "freeze",
        {
          assertions: [
            {
              kind: "text",
              query: { identifier: "fixture.status" },
              expected: "Clicked",
              match: "exact",
            },
          ],
        },
        undefined,
        undefined,
        context,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 65_000));
      await observe.execute("observe-after-idle", {}, undefined, undefined, context);
      const clicked = await action.execute(
        "click",
        {
          target: { identifier: "fixture.click" },
          action: { kind: "click" },
          assertions: [
            {
              kind: "text",
              query: { identifier: "fixture.status" },
              expected: "Clicked",
              match: "exact",
            },
          ],
        },
        undefined,
        undefined,
        context,
      );
      expect(clicked.details).toMatchObject({
        kind: "action",
        result: { verification: "confirmed" },
      });
      const compact = (clicked.details as { compact?: unknown }).compact;
      expect(typeof compact === "string" && compact).toContain("Clicked");
      expect(typeof compact === "string" && compact).toContain('id="fixture.click"');
      const finished = await finish.execute("finish", {}, undefined, undefined, context);
      expect(finished.details).toMatchObject({
        kind: "finished",
        result: { cleanup: "completed" },
      });
      expect(await managed()).toEqual([]);
    } finally {
      await waitForNoManagedClone();
      await isolated.cleanup();
    }
  }, 600_000);

  it("auto-cleans a terminal post-dispatch action failure before returning it", async () => {
    const isolated = await isolatedConfig();
    try {
      const { tools, context } = extensionTools(isolated.path);
      const begin = tools.get("macos_begin");
      const action = tools.get("macos_action");
      if (!begin || !action) throw new Error("Pi tools unavailable.");
      await begin.execute("begin", { application }, undefined, undefined, context);
      await tools
        .get("macos_freeze_assertions")
        ?.execute("freeze", { assertions: finalAssertions }, undefined, undefined, context);
      const terminal = await action.execute(
        "contradicted",
        {
          target: { identifier: "fixture.click" },
          action: { kind: "click" },
          assertions: [
            {
              kind: "text",
              query: { identifier: "fixture.status" },
              expected: "Impossible status",
              match: "exact",
            },
          ],
        },
        undefined,
        undefined,
        context,
      );
      expect(terminal.details).toMatchObject({
        kind: "error",
        error: {
          code: "ActionFailed",
          actionResult: {
            dispatch: "dispatched",
            providerOutcome: "succeeded",
            verification: "contradicted",
          },
        },
      });
      expect(await managed()).toEqual([]);
    } finally {
      await waitForNoManagedClone();
      await isolated.cleanup();
    }
  }, 600_000);
});

describe.skipIf(!configPath || profile !== "pi-text-minimal")("Pi Extension text input", () => {
  it("composes focus, selection, deletion, typing, caret movement, and selection", async () => {
    const isolated = await isolatedConfig();
    try {
      const supervisor = new PiTaskSupervisor(isolated.path, process.cwd());
      await supervisor.start(application);
      await supervisor.request({
        type: "freezeAssertions",
        assertions: [
          {
            kind: "value",
            query: { identifier: "fixture.text-input" },
            expected: "Alpha Beta",
            match: "exact",
          },
          { kind: "state", query: { identifier: "fixture.checkbox" }, state: { selected: true } },
        ],
      });
      await supervisor.request({ type: "observe" });
      const focused = await supervisor.request({
        type: "action",
        target: { identifier: "fixture.text-input" },
        action: { kind: "click" },
        assertions: [],
      });
      expect(focused).toMatchObject({ kind: "action", result: { providerOutcome: "succeeded" } });
      await supervisor.request({
        type: "action",
        action: { kind: "pressKey", key: "a", modifiers: ["command"] },
        assertions: [],
      });
      await supervisor.request({
        type: "action",
        action: { kind: "pressKey", key: "backspace" },
        assertions: [],
      });
      const typed = await supervisor.request({
        type: "action",
        action: { kind: "typeText", value: { literal: "Alpha" } },
        assertions: [],
      });
      expect(typed).toMatchObject({ kind: "action", result: { providerOutcome: "succeeded" } });
      await supervisor.request({ type: "action", action: { kind: "pressKey", key: "end" }, assertions: [] });
      await supervisor.request({
        type: "action",
        action: { kind: "typeText", value: { literal: " Beta" } },
        assertions: [],
      });
      const selected = await supervisor.request({
        type: "action",
        target: { identifier: "fixture.checkbox" },
        action: { kind: "click" },
        assertions: [{ kind: "state", query: { identifier: "fixture.checkbox" }, state: { selected: true } }],
      });
      expect(selected).toMatchObject({ kind: "action", result: { verification: "confirmed" } });
      const keyboard = await supervisor.request({
        type: "action",
        action: { kind: "pressKey", key: "enter", modifiers: ["command"] },
        assertions: [],
      });
      expect(keyboard).toMatchObject({ kind: "action", result: { providerOutcome: "succeeded" } });
      const finished = await supervisor.request({ type: "finish" });
      expect(finished).toMatchObject({
        kind: "finished",
        result: { verdict: "passed", evidence: "complete", cleanup: "completed" },
      });
      expect(await managed()).toEqual([]);
    } finally {
      await waitForNoManagedClone();
      await isolated.cleanup();
    }
  }, 600_000);
});

describe.skipIf(!configPath || profile !== "pi-safari-input")("Pi Safari TodoMVC input", () => {
  it("executes the short two-task command with relationship queries", async () => {
    const isolated = await isolatedConfig();
    let completed = false;
    const tools = new Map<string, ToolDefinition>();
    const context: ToolContext = {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      ui: { confirm: async () => true, notify: () => undefined },
    };
    try {
      const api: ExtensionAPI = {
        registerTool: (tool) => tools.set(tool.name, tool),
        registerCommand: () => undefined,
        on: (() => () => undefined) as ExtensionAPI["on"],
      };
      createPiExtension({ configPath: isolated.path, registerProcessSignal: () => () => undefined })(api);
      const begin = tools.get("macos_begin");
      const observe = tools.get("macos_observe");
      const query = tools.get("macos_query");
      const action = tools.get("macos_action");
      const freeze = tools.get("macos_freeze_assertions");
      const finish = tools.get("macos_finish");
      if (!begin || !observe || !query || !action || !freeze || !finish)
        throw new Error("Pi tools unavailable.");
      await begin.execute("begin", { application: { name: "Safari" } }, undefined, undefined, context);
      await action.execute(
        "focus-address",
        {
          action: { kind: "pressKey", key: "l", modifiers: ["command"] },
          assertions: [],
        },
        undefined,
        undefined,
        context,
      );
      await action.execute(
        "type-url",
        {
          action: { kind: "typeText", value: { literal: "https://demo.playwright.dev/todomvc/" } },
          assertions: [],
        },
        undefined,
        undefined,
        context,
      );
      await action.execute(
        "navigate",
        {
          action: { kind: "pressKey", key: "enter" },
          assertions: [],
        },
        undefined,
        undefined,
        context,
      );
      let inputReady = false;
      for (let attempt = 0; attempt < 10 && !inputReady; attempt += 1) {
        inputReady = await query
          .execute("wait", { query: { role: "window" } }, undefined, undefined, context)
          .then(() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)))
          .then(() => observe.execute("poll-observe", {}, undefined, undefined, context))
          .then(() =>
            query.execute(
              "poll-query",
              { query: { role: "textfield", value: { exact: "" } } },
              undefined,
              undefined,
              context,
            ),
          )
          .then((result) => (result.details as { status?: unknown }).status === "unique")
          .catch(() => false);
        if (!inputReady) await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
      expect(inputReady).toBe(true);
      const rejectedFreeze = await freeze.execute(
        "reject-unreliable-freeze",
        {
          assertions: [
            { kind: "visible", query: { role: "statictext", value: { exact: "Publish v0.1.0" } } },
            { kind: "state", query: { role: "link", name: { exact: "Active" } }, state: { focused: true } },
          ],
        },
        undefined,
        undefined,
        context,
      );
      expect(rejectedFreeze.details).toMatchObject({
        kind: "error",
        error: { code: "ClientFailure", clientCode: "InvalidScenario" },
      });
      await freeze.execute(
        "freeze",
        {
          assertions: [
            {
              kind: "value",
              query: {
                role: "group",
                value: { exact: "Publish v0.1.0" },
                descendant: { role: "checkbox" },
              },
              expected: "Publish v0.1.0",
              match: "exact",
            },
            {
              kind: "notVisible",
              query: {
                role: "group",
                value: { exact: "Review FSQ evidence" },
                descendant: { role: "checkbox" },
              },
            },
          ],
        },
        undefined,
        undefined,
        context,
      );
      const entered = await action.execute(
        "focus-todo",
        {
          target: { role: "textfield", value: { exact: "" } },
          action: { kind: "click" },
          assertions: [],
        },
        undefined,
        undefined,
        context,
      );
      expect(entered.details).toMatchObject({
        kind: "action",
        result: { dispatch: "dispatched", providerOutcome: "succeeded" },
      });
      const typed = await action.execute(
        "type-todo",
        {
          action: { kind: "typeText", value: { literal: "Review FSQ evidence" } },
          assertions: [],
        },
        undefined,
        undefined,
        context,
      );
      expect(typed.details).toMatchObject({
        kind: "action",
        result: { dispatch: "dispatched", providerOutcome: "succeeded" },
      });
      await action.execute(
        "submit-review",
        {
          action: { kind: "pressKey", key: "enter" },
          assertions: [],
        },
        undefined,
        undefined,
        context,
      );
      await action.execute(
        "type-publish",
        { action: { kind: "typeText", value: { literal: "Publish v0.1.0" } }, assertions: [] },
        undefined,
        undefined,
        context,
      );
      await action.execute(
        "submit-publish",
        { action: { kind: "pressKey", key: "enter" }, assertions: [] },
        undefined,
        undefined,
        context,
      );
      const firstCheckbox = {
        role: "checkbox",
        ancestor: { role: "group", value: { exact: "Review FSQ evidence" } },
      };
      const checkboxQuery = await query.execute(
        "query-first-checkbox",
        { query: firstCheckbox },
        undefined,
        undefined,
        context,
      );
      expect(checkboxQuery.details).toMatchObject({ kind: "query", status: "unique", count: 1 });
      await action.execute(
        "complete-first",
        { target: firstCheckbox, action: { kind: "click" }, assertions: [] },
        undefined,
        undefined,
        context,
      );
      const activeQuery = await query.execute(
        "query-active",
        { query: { role: "link", name: { exact: "Active" } } },
        undefined,
        undefined,
        context,
      );
      expect(activeQuery.details).toMatchObject({ kind: "query", status: "unique", count: 1 });
      const filtered = await action.execute(
        "filter-active",
        { target: { role: "link", name: { exact: "Active" } }, action: { kind: "click" }, assertions: [] },
        undefined,
        undefined,
        context,
      );
      expect(filtered.details).toMatchObject({
        kind: "action",
        result: { dispatch: "dispatched", providerOutcome: "succeeded" },
        completionReady: true,
      });
      const finished = await finish.execute("finish", {}, undefined, undefined, context);
      expect(finished.details).toMatchObject({
        kind: "finished",
        result: { verdict: "passed", cleanup: "completed" },
      });
      const config = GatewayConfigSchema.parse(JSON.parse(await readFile(isolated.path, "utf8")) as unknown);
      const runIds = await readdir(join(config.evidence.root, "runs"));
      expect(runIds).toHaveLength(1);
      const runId = runIds[0];
      if (!runId) throw new Error("Safari UAT run is unavailable.");
      const manifest = JSON.parse(
        await readFile(join(config.evidence.root, "runs", runId, "manifest.v1.json"), "utf8"),
      ) as { artifacts?: { type?: unknown; relativePath?: unknown }[] };
      const screenshotTypes = (manifest.artifacts ?? [])
        .map((artifact) => artifact.type)
        .filter((type): type is string => typeof type === "string" && type.includes("screenshot"));
      expect(screenshotTypes.length).toBeGreaterThan(0);
      expect(new Set(screenshotTypes)).toEqual(new Set(["display-screenshot"]));
      const diagnostic = (manifest.artifacts ?? []).find(
        (artifact) => artifact.type === "guest-diagnostics" && typeof artifact.relativePath === "string",
      );
      if (!diagnostic || typeof diagnostic.relativePath !== "string")
        throw new Error("Lifecycle diagnostic missing.");
      const lifecycleBytes = await readFile(
        join(config.evidence.root, "runs", runId, diagnostic.relativePath),
      );
      const lifecycle = ProviderLifecycleDiagnosticSchema.parse(
        JSON.parse(lifecycleBytes.toString("utf8")) as unknown,
      );
      expect(lifecycle.earliestTermination).toBeUndefined();
      expect(lifecycle.snapshot).toMatchObject({
        observedBeforeCleanup: true,
        appiumStatus: "ready",
        wdaStatus: "ready",
        activeSessionCount: 1,
        processes: { appium: true, xcodebuild: true, wda: true },
      });
      expect(lifecycleBytes.toString("utf8")).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
      expect(await managed()).toEqual([]);
      completed = true;
    } finally {
      if (!completed) {
        const abort = tools.get("macos_abort");
        if (abort)
          await abort
            .execute("uat-failure", { reason: "UAT assertion failed" }, undefined, undefined, context)
            .catch(() => undefined);
      }
      await waitForNoManagedClone();
      if (completed) await isolated.cleanup();
      else process.stderr.write(`SAFARI_UAT_DIR=${isolated.path.slice(0, isolated.path.lastIndexOf("/"))}\n`);
    }
  }, 600_000);
});
