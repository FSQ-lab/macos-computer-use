import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMacOSComputerUseClient,
  GatewayConfigSchema,
  ProviderLifecycleDiagnosticSchema,
  ScenarioSchema,
} from "../src/index.js";

const configPath = process.env.MCU_PROVIDER_CONFIG;
const profile = process.env.MCU_PROVIDER_PROFILE;
const execFileAsync = promisify(execFile);

const managedClones = async (): Promise<string[]> => {
  const { stdout } = await execFileAsync("tart", ["list", "--format", "json"], {
    maxBuffer: 1_000_000,
  });
  const inventory = JSON.parse(stdout) as { Name?: unknown }[];
  return inventory.flatMap((item) =>
    typeof item.Name === "string" && item.Name.startsWith("mcu-run-") ? [item.Name] : [],
  );
};

describe.skipIf(!configPath || profile !== "failure")("provisioned provider failures", () => {
  it("cancels during lifecycle, finalizes Evidence, and leaves cleanup idempotent", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    const controller = new AbortController();
    const scenario = ScenarioSchema.parse(
      JSON.parse(await readFile("examples/fixture.scenario.json", "utf8")) as unknown,
    );
    const pending = client.value.runScenario(scenario, { signal: controller.signal });
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const allocated = await readFile(`${config.state.root}/managed-resource.json`, "utf8")
        .then((value) => (JSON.parse(value) as { phase?: unknown }).phase === "started")
        .catch(() => false);
      if (allocated) break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    controller.abort();
    const result = await pending;
    expect(result.ok && result.value.result).toEqual({
      verdict: "inconclusive",
      evidence: "complete",
      cleanup: "completed",
    });
    if (result.ok) expect((await client.value.showRun(result.value.runId)).ok).toBe(true);
    expect(await client.value.recover()).toEqual({ ok: true, value: { status: "clean" } });
    expect(await client.value.recover()).toEqual({ ok: true, value: { status: "clean" } });
    const doctor = await client.value.doctor();
    expect(doctor.ok && doctor.value.checks.find((item) => item.name === "managed-resources")?.status).toBe(
      "passed",
    );
  }, 600_000);

  it("times out a real Mac2 action without guessing dispatch and completes cleanup", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const input = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const parsed = GatewayConfigSchema.parse(input);
    const config = GatewayConfigSchema.parse({
      ...parsed,
      timeouts: { ...parsed.timeouts, actionMs: 1 },
    });
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    const scenario = ScenarioSchema.parse(
      JSON.parse(await readFile("examples/fixture.scenario.json", "utf8")) as unknown,
    );
    const result = await client.value.runScenario(scenario);
    expect(result.ok && result.value.result).toEqual({
      verdict: "inconclusive",
      evidence: "complete",
      cleanup: "completed",
    });
    if (!result.ok) return;
    const manifest = await client.value.showRun(result.value.runId);
    expect(manifest.ok).toBe(true);
    expect(await client.value.recover()).toEqual({ ok: true, value: { status: "clean" } });
    const doctor = await client.value.doctor();
    expect(doctor.ok && doctor.value.checks.find((item) => item.name === "managed-resources")?.status).toBe(
      "passed",
    );
  }, 600_000);

  it("classifies a real Appium transport loss and still destroys the disposable clone", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    const client = createMacOSComputerUseClient(config, {
      hooks: [
        {
          name: "transport-fault",
          modulePath: resolve("tests/fixtures/transport-fault-hook.mjs"),
        },
      ],
    });
    if (!client.ok) throw new Error(client.error.message);
    let actionResult:
      | { dispatch: string; providerOutcome: string; verification: string; retryDisposition: string }
      | undefined;
    const result = await client.value.run(
      { finalAssertions: [{ kind: "visible", query: { identifier: "fixture.click" } }] },
      async (run) => {
        const target = run.query({ identifier: "fixture.click" });
        if (!target.ok) throw new Error(target.error.code);
        const action = await run.action({ kind: "click", target: { element: target.value } });
        if (!action.ok) throw new Error(action.error.code);
        actionResult = action.value.result;
      },
    );
    expect(actionResult).toMatchObject({
      dispatch: "unknown",
      providerOutcome: "unknown",
      verification: "unverifiable",
      retryDisposition: "reconcileRequired",
    });
    expect(result.ok && result.value.result.verdict).toBe("inconclusive");
    if (!result.ok) return;
    const manifest = await client.value.showRun(result.value.runId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const diagnostic = manifest.value.artifacts.find((artifact) => artifact.type === "guest-diagnostics");
    if (!diagnostic) throw new Error("Lifecycle diagnostic missing");
    const raw = await readFile(
      `${config.evidence.root}/runs/${result.value.runId}/${diagnostic.relativePath}`,
    );
    const lifecycle = ProviderLifecycleDiagnosticSchema.parse(JSON.parse(raw.toString("utf8")) as unknown);
    expect(lifecycle.earliestTermination).toMatchObject({
      source: "appium",
      event: "processExited",
      cause: "providerExit",
    });
    expect(lifecycle.snapshot.observedBeforeCleanup).toBe(true);
    expect(raw.toString("utf8")).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
    expect(await managedClones()).toEqual([]);
    expect(await client.value.recover()).toEqual({ ok: true, value: { status: "clean" } });
  }, 600_000);

  it("recovers an attributed clone after the Host client process is killed", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    const script = `
      import { readFile } from "node:fs/promises";
      import { createMacOSComputerUseClient } from "./dist/index.js";
      const config = JSON.parse(await readFile(process.argv[1], "utf8"));
      const client = createMacOSComputerUseClient(config);
      if (!client.ok) throw new Error(client.error.message);
      await client.value.runScenario(JSON.parse(await readFile("examples/fixture.scenario.json", "utf8")));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, configPath], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    const ownershipPath = `${config.state.root}/managed-resource.json`;
    let attributed = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const record = await readFile(ownershipPath, "utf8")
        .then((value) => JSON.parse(value) as { phase?: unknown })
        .catch(() => undefined);
      if (record && ["cloneCreated", "started"].includes(String(record.phase))) {
        attributed = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(attributed).toBe(true);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    expect(await client.value.recover()).toEqual({ ok: true, value: { status: "clean" } });
    expect(await client.value.recover()).toEqual({ ok: true, value: { status: "clean" } });
    expect(await managedClones()).toEqual([]);
  }, 600_000);
});
