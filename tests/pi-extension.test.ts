import { describe, expect, it } from "vitest";
import {
  PiTaskRequestError,
  type TaskId,
  type TaskOperationInput,
  type TaskValue,
} from "../src/pi-extension/runtime/index.js";
import { createPiExtension, type PiTaskSupervisor } from "../src/pi-extension/index.js";
import type { ExtensionAPI, ToolContext, ToolDefinition } from "../src/pi-extension/pi-types.js";

class FakeSupervisor implements PiTaskSupervisor {
  readonly taskId = "task-0123456789abcdef01234567" as TaskId;
  readonly requests: TaskOperationInput[] = [];
  readonly shutdowns: string[] = [];
  failAction = false;
  structuredFailure = false;
  structuredFailureCode: "TargetNotFound" | "TargetAmbiguous" | "ReadinessExpired" = "TargetNotFound";
  actionResultFailure = false;
  structuredStartFailure = false;
  pendingAction: Promise<TaskValue> | undefined;
  pendingShutdown: Promise<void> | undefined;
  assertionStatus: "passed" | "failed" | "unverifiable" = "failed";

  async start(
    application: Extract<TaskOperationInput, { type: "begin" }>["application"],
  ): Promise<TaskValue> {
    this.requests.push({ type: "begin", application });
    if (this.structuredStartFailure)
      throw new PiTaskRequestError({ code: "ClientFailure", message: "RecoveryRequired: dirty" });
    return {
      kind: "begun",
      leaseId: "lease-00000001",
      observationId: "observation-00000001" as never,
      compact: '[element-00000001] button "Save" id="fixture.save" depth=0 enabled',
    };
  }

  async request(input: Exclude<TaskOperationInput, { type: "begin" | "heartbeat" }>): Promise<TaskValue> {
    this.requests.push(input);
    if (this.structuredFailure)
      throw new PiTaskRequestError({
        code: "ClientFailure",
        clientCode: this.structuredFailureCode,
        message: `${this.structuredFailureCode}: missing`,
      });
    if (input.type === "action" && this.actionResultFailure)
      throw new PiTaskRequestError({
        code: "ActionFailed",
        message: "Action failed: dispatch=dispatched, providerOutcome=succeeded, verification=contradicted.",
        actionResult: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "contradicted",
          retryDisposition: "unsafe",
        },
      });
    if (input.type === "action" && this.pendingAction) return this.pendingAction;
    if (input.type === "action" && this.failAction) throw new Error("safe action failure");
    if (input.type === "finish")
      return {
        kind: "finished",
        runId: "run-00000001" as never,
        result: { verdict: "passed", evidence: "complete", cleanup: "completed" },
      };
    if (input.type === "abort") return { kind: "aborted" };
    if (input.type === "observe")
      return {
        kind: "observation",
        observationId: "observation-00000001" as never,
        compact: '[element-00000001] button "Save" id="fixture.save" enabled',
      };
    if (input.type === "query")
      return {
        kind: "query",
        status: "unique",
        observationId: "observation-00000001" as never,
        count: 1,
        candidates: [
          {
            elementId: "element-00000001" as never,
            role: input.query.role ?? "button",
            ...(input.query.identifier ? { identifier: input.query.identifier } : {}),
          },
        ],
        element: {
          elementId: "element-00000001" as never,
          role: input.query.role ?? "button",
          ...(input.query.identifier ? { identifier: input.query.identifier } : {}),
        },
      };
    if (input.type === "freezeAssertions")
      return { kind: "assertionsFrozen", count: input.assertions.length };
    if (input.type === "expand")
      return {
        kind: "expanded",
        element: { elementId: input.elementId, role: "button", identifier: "fixture.save" },
      };
    if (input.type === "assert")
      return {
        kind: "assertion",
        assertionId: "assertion-00000001",
        status: this.assertionStatus,
        observationId: "observation-00000001" as never,
        reason: "not complete",
      };
    if (input.type === "action")
      return {
        kind: "action",
        result: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "confirmed",
          retryDisposition: "unsafe",
        },
        sequence: 1,
        observationId: "observation-00000001" as never,
        compact: "button Save",
        finalAssertionsPassed: this.assertionStatus === "passed",
      };
    return { kind: "status", state: "active" };
  }

  async shutdown(reason?: string): Promise<void> {
    this.shutdowns.push(reason ?? "");
    await this.pendingShutdown;
  }
}

const setup = (confirm = true) => {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler(args: string, context: ToolContext): Promise<void> }>();
  let shutdown: (() => Promise<void>) | undefined;
  let beforeAgentStart:
    | ((event: {
        prompt: string;
        systemPromptOptions: { selectedTools: string[]; promptGuidelines: string[] };
      }) => void)
    | undefined;
  let toolCall:
    | ((event: {
        toolName: string;
        input: Record<string, unknown>;
      }) => { block: boolean; reason: string; terminate?: boolean } | undefined)
    | undefined;
  const context: ToolContext = {
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    ui: { confirm: async () => confirm, notify: () => undefined },
  };
  let confirmationCount = 0;
  context.ui.confirm = async () => {
    confirmationCount += 1;
    return confirm;
  };
  const supervisor = new FakeSupervisor();
  const signals = new Map<"SIGINT" | "SIGTERM", () => void>();
  const api: ExtensionAPI = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: ((event: string, handler: (...args: never[]) => unknown) => {
      if (event === "session_shutdown")
        shutdown = () =>
          Promise.resolve(
            (handler as unknown as (event: unknown, context: ToolContext) => unknown)({}, context),
          ).then(() => undefined);
      if (event === "before_agent_start") beforeAgentStart = handler as typeof beforeAgentStart;
      if (event === "tool_call") toolCall = handler as typeof toolCall;
      return () => undefined;
    }) as ExtensionAPI["on"],
  };
  createPiExtension({
    createSupervisor: () => supervisor,
    registerProcessSignal: (signal, handler) => {
      signals.set(signal, handler);
      return () => signals.delete(signal);
    },
  })(api);
  return {
    tools,
    commands,
    context,
    supervisor,
    shutdown: () => shutdown?.(),
    beforeAgentStart: (prompt: string) => {
      const event = {
        prompt,
        systemPromptOptions: { selectedTools: ["bash", "read"], promptGuidelines: [] },
      };
      beforeAgentStart?.(event);
      return event.systemPromptOptions;
    },
    toolCall: (toolName: string, input: Record<string, unknown> = {}) => toolCall?.({ toolName, input }),
    signal: async (signal: "SIGINT" | "SIGTERM") => {
      signals.get(signal)?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
    confirmationCount: () => confirmationCount,
  };
};

const begin = async (state: ReturnType<typeof setup>): Promise<void> => {
  const tool = state.tools.get("macos_begin");
  if (!tool) throw new Error("begin tool missing");
  await tool.execute("begin", { application: { name: "Fixture" } }, undefined, undefined, state.context);
  await state.tools
    .get("macos_freeze_assertions")
    ?.execute(
      "freeze",
      { assertions: [{ kind: "visible", query: { role: "button" } }] },
      undefined,
      undefined,
      state.context,
    );
};

describe("Pi extension", () => {
  it("registers the complete sequential tool and command surface", () => {
    const state = setup();
    expect([...state.tools.keys()]).toEqual([
      "macos_begin",
      "macos_observe",
      "macos_query",
      "macos_expand",
      "macos_freeze_assertions",
      "macos_action",
      "macos_assert",
      "macos_finish",
      "macos_abort",
    ]);
    expect([...state.tools.values()].every((tool) => tool.executionMode === "sequential")).toBe(true);
    expect([...state.commands.keys()]).toEqual(["macos-status", "macos-abort"]);
  });

  it("publishes exact discriminated assertion and action schemas to the model", () => {
    const state = setup();
    const beginSchema = JSON.stringify(state.tools.get("macos_begin")?.parameters);
    const freezeSchema = JSON.stringify(state.tools.get("macos_freeze_assertions")?.parameters);
    const actionSchema = JSON.stringify(state.tools.get("macos_action")?.parameters);
    for (const kind of ["visible", "notVisible", "text", "value", "state", "elementOrder", "aiVisual"])
      expect(freezeSchema).toContain(`"const":"${kind}"`);
    for (const kind of [
      "click",
      "doubleClick",
      "rightClick",
      "hover",
      "scroll",
      "swipe",
      "drag",
      "typeText",
      "pressKey",
    ])
      expect(actionSchema).toContain(kind);
    expect(actionSchema).not.toContain("appendText");
    expect(actionSchema).not.toContain("replaceText");
    expect(freezeSchema).toContain("identifier");
    expect(beginSchema).toContain("application");
    expect(actionSchema).toContain("destination");
    expect(actionSchema).toContain('"confirm":{"type":"boolean","const":true}');
  });

  it("rejects confirm=false instead of transmitting ambiguous confirmation intent", async () => {
    const state = setup();
    await begin(state);
    const action = state.tools.get("macos_action");
    if (!action) throw new Error("action tool missing");
    await expect(
      action.execute(
        "ambiguous",
        { action: { kind: "pressKey", key: "enter" }, confirm: false },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow();
    expect(state.supervisor.requests.filter((request) => request.type === "action")).toHaveLength(0);
  });

  it("confirms the target application before creating a supervisor", async () => {
    const state = setup(false);
    const beginTool = state.tools.get("macos_begin");
    if (!beginTool) throw new Error("begin tool missing");
    await expect(
      beginTool.execute(
        "begin",
        {
          application: { name: "Safari" },
        },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("denied the target application");
    expect(state.supervisor.requests).toHaveLength(0);
  });

  it("always restricts turns to macos tools and blocks every non-MCU fallback", async () => {
    const state = setup();
    const prompt = state.beforeAgentStart("Open Calculator and enter 2+2");
    expect(prompt.selectedTools).toEqual([
      "macos_begin",
      "macos_observe",
      "macos_query",
      "macos_expand",
      "macos_freeze_assertions",
      "macos_action",
      "macos_assert",
      "macos_finish",
      "macos_abort",
    ]);
    expect(prompt.promptGuidelines.join(" ")).toContain("Never use bash");
    expect(prompt.promptGuidelines.join(" ")).toContain("sole goal authority");
    expect(prompt.promptGuidelines.join(" ")).toContain("macos_freeze_assertions exactly once");
    expect(prompt.promptGuidelines.join(" ")).toContain("ancestor");
    expect(prompt.promptGuidelines.join(" ")).toContain("status=unique");
    await expect(state.toolCall("bash")).resolves.toMatchObject({ block: true, terminate: false });
    await expect(state.toolCall("third_party_tool")).resolves.toMatchObject({
      block: true,
      terminate: false,
    });
    state.toolCall("macos_begin", { application: { name: "Fixture" } });
    await expect(state.toolCall("read")).resolves.toMatchObject({ block: true, terminate: true });
  });

  it("rejects Tab exploration unless the user explicitly requested Tab", async () => {
    const state = setup();
    state.beforeAgentStart("Open Safari and complete the task");
    await begin(state);
    const action = state.tools.get("macos_action");
    if (!action) throw new Error("action tool missing");
    await expect(
      action.execute(
        "tab",
        { action: { kind: "pressKey", key: "tab" } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("Tab focus traversal");
    state.beforeAgentStart("Press the Tab key once");
    await expect(
      action.execute(
        "explicit-tab",
        { action: { kind: "pressKey", key: "tab" } },
        undefined,
        undefined,
        state.context,
      ),
    ).resolves.toBeTruthy();
  });

  it("runs ordinary actions without confirmation and confirms only explicitly flagged actions", async () => {
    const denied = setup();
    await begin(denied);
    const confirmationsAfterBegin = denied.confirmationCount();
    denied.context.ui.confirm = async () => false;
    const action = denied.tools.get("macos_action");
    if (!action) throw new Error("action tool missing");
    await expect(
      action.execute(
        "ordinary",
        { action: { kind: "pressKey", key: "enter" } },
        undefined,
        undefined,
        denied.context,
      ),
    ).resolves.toBeTruthy();
    expect(denied.confirmationCount()).toBe(confirmationsAfterBegin);
    await expect(
      action.execute(
        "denied",
        { action: { kind: "pressKey", key: "enter" }, confirm: true },
        undefined,
        undefined,
        denied.context,
      ),
    ).rejects.toThrow("denied this macOS action");
    expect(denied.supervisor.shutdowns).toHaveLength(0);

    const headless = setup();
    await begin(headless);
    headless.context.hasUI = false;
    const headlessAction = headless.tools.get("macos_action");
    if (!headlessAction) throw new Error("action tool missing");
    await expect(
      headlessAction.execute(
        "headless",
        { action: { kind: "pressKey", key: "enter" }, confirm: true },
        undefined,
        undefined,
        headless.context,
      ),
    ).rejects.toThrow("requires interactive confirmation");
    expect(denied.supervisor.requests.filter((request) => request.type === "action")).toHaveLength(1);
    expect(headless.supervisor.requests.filter((request) => request.type === "action")).toHaveLength(0);
    expect(denied.supervisor.requests.some((request) => "confirm" in request)).toBe(false);
  });

  it("returns expected runner failures as safe structured tool results", async () => {
    const state = setup();
    await begin(state);
    state.supervisor.structuredFailure = true;
    const observe = state.tools.get("macos_observe");
    if (!observe) throw new Error("observe tool missing");
    const result = await observe.execute("observe", {}, undefined, undefined, state.context);
    expect(result.details).toEqual({
      kind: "error",
      error: {
        code: "ClientFailure",
        clientCode: "TargetNotFound",
        message: "TargetNotFound: missing",
      },
    });
    expect(state.supervisor.shutdowns).toHaveLength(0);
  });

  it("waits for cleanup before returning a terminal Client failure", async () => {
    const state = setup();
    await begin(state);
    state.supervisor.structuredFailure = true;
    state.supervisor.structuredFailureCode = "ReadinessExpired";
    const observe = state.tools.get("macos_observe");
    if (!observe) throw new Error("observe tool missing");
    const result = await observe.execute("observe", {}, undefined, undefined, state.context);
    expect(result.details).toEqual({
      kind: "error",
      error: {
        code: "ClientFailure",
        clientCode: "ReadinessExpired",
        message: "ReadinessExpired: missing",
      },
    });
    expect(state.supervisor.shutdowns).toEqual(["Terminal macOS tool failure: ReadinessExpired"]);
    await expect(observe.execute("after", {}, undefined, undefined, state.context)).rejects.toThrow(
      "macos_begin",
    );
    const beginTool = state.tools.get("macos_begin");
    if (!beginTool) throw new Error("begin tool missing");
    await expect(
      beginTool.execute(
        "restart",
        {
          application: { name: "Fixture" },
        },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("already ended this agent turn");
    expect(state.supervisor.requests.filter((request) => request.type === "begin")).toHaveLength(1);
    state.beforeAgentStart("new user turn");
    state.supervisor.structuredFailure = false;
    await expect(
      beginTool.execute(
        "next-turn",
        {
          application: { name: "Fixture" },
        },
        undefined,
        undefined,
        state.context,
      ),
    ).resolves.toBeTruthy();
  });

  it("preserves a terminal ActionResult and waits for cleanup before returning it", async () => {
    const state = setup();
    await begin(state);
    state.supervisor.actionResultFailure = true;
    const action = state.tools.get("macos_action");
    const observe = state.tools.get("macos_observe");
    if (!action || !observe) throw new Error("tool missing");
    await observe.execute("observe", {}, undefined, undefined, state.context);
    const result = await action.execute(
      "action",
      { target: { identifier: "fixture.save" }, action: { kind: "click" } },
      undefined,
      undefined,
      state.context,
    );
    expect(result.details).toMatchObject({
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
    expect(state.supervisor.shutdowns).toEqual(["Terminal macOS action failure: ActionFailed"]);
  });

  it("returns expected begin failures as safe structured tool results", async () => {
    const state = setup();
    state.supervisor.structuredStartFailure = true;
    const beginTool = state.tools.get("macos_begin");
    if (!beginTool) throw new Error("begin tool missing");
    const result = await beginTool.execute(
      "begin",
      {
        application: { name: "Fixture" },
      },
      undefined,
      undefined,
      state.context,
    );
    expect(result.details).toEqual({
      kind: "error",
      error: { code: "ClientFailure", message: "RecoveryRequired: dirty" },
    });
    expect(state.supervisor.shutdowns).toContain("Pi task failed to start");
  });

  it("does not expose raw setup exception paths to the model", async () => {
    const tools = new Map<string, ToolDefinition>();
    const api = setup().context;
    const extensionApi: ExtensionAPI = {
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: () => undefined,
      on: (() => () => undefined) as ExtensionAPI["on"],
    };
    createPiExtension({
      createSupervisor: () => {
        throw new Error("missing /private/audit/nonexistent-config.json");
      },
      registerProcessSignal: () => () => undefined,
    })(extensionApi);
    const beginTool = tools.get("macos_begin");
    if (!beginTool) throw new Error("begin tool missing");
    await expect(
      beginTool.execute(
        "begin",
        {
          application: { name: "Safari" },
        },
        undefined,
        undefined,
        api,
      ),
    ).rejects.toThrow("Check the local MCU configuration");
  });

  it("shuts down active authority on normal Pi process signals", async () => {
    const state = setup();
    await begin(state);
    await state.signal("SIGTERM");
    expect(state.supervisor.shutdowns).toContain("Pi process received SIGTERM");
    await expect(
      state.tools.get("macos_observe")?.execute("observe", {}, undefined, undefined, state.context),
    ).rejects.toThrow("macos_begin");
  });

  it("counts all model-callable task operations and revokes after the limit", async () => {
    const state = setup();
    await begin(state);
    const observe = state.tools.get("macos_observe");
    if (!observe) throw new Error("observe tool missing");
    for (let attempt = 0; attempt < 100; attempt += 1)
      await observe.execute(String(attempt), {}, undefined, undefined, state.context);
    await expect(observe.execute("overflow", {}, undefined, undefined, state.context)).rejects.toThrow(
      "tool-call limit",
    );
    expect(state.supervisor.shutdowns).toContain("Pi task tool-call limit exceeded");
    expect(state.supervisor.requests.filter((request) => request.type === "observe")).toHaveLength(100);
    const beginTool = state.tools.get("macos_begin");
    if (!beginTool) throw new Error("begin tool missing");
    await expect(
      beginTool.execute(
        "same-turn-restart",
        {
          application: { name: "Fixture" },
        },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("already ended this agent turn");
  });

  it("confirms and delegates a strict action to the Pi task runtime", async () => {
    const state = setup();
    await begin(state);
    const action = state.tools.get("macos_action");
    const observe = state.tools.get("macos_observe");
    if (!action || !observe) throw new Error("tool missing");
    await observe.execute("observe", {}, undefined, undefined, state.context);
    const result = await action.execute(
      "action",
      { target: { identifier: "fixture.save" }, action: { kind: "click" }, assertions: [] },
      undefined,
      undefined,
      state.context,
    );
    expect(result.details).toMatchObject({ kind: "action", result: { verification: "confirmed" } });
    expect(state.supervisor.requests.findLast((request) => request.type === "action")).toMatchObject({
      type: "action",
      action: { kind: "click" },
    });
  });

  it("closes authority on cancellation and unexpected mutating failure", async () => {
    const cancelled = setup();
    await begin(cancelled);
    const action = cancelled.tools.get("macos_action");
    if (!action) throw new Error("action tool missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      action.execute(
        "cancelled",
        { action: { kind: "pressKey", key: "enter" } },
        controller.signal,
        undefined,
        cancelled.context,
      ),
    ).rejects.toThrow("cancelled");
    expect(cancelled.supervisor.shutdowns).toContain("Pi mutating tool cancelled");

    const failed = setup();
    await begin(failed);
    failed.supervisor.failAction = true;
    const failedAction = failed.tools.get("macos_action");
    if (!failedAction) throw new Error("action tool missing");
    await expect(
      failedAction.execute(
        "failed",
        { action: { kind: "pressKey", key: "enter" } },
        undefined,
        undefined,
        failed.context,
      ),
    ).rejects.toThrow("safe action failure");
    expect(failed.supervisor.shutdowns).toContain("Pi mutating tool failed");
  });

  it("enforces repeated-action limits before a fourth dispatch", async () => {
    const state = setup();
    await begin(state);
    const action = state.tools.get("macos_action");
    if (!action) throw new Error("action tool missing");
    const input = { action: { kind: "pressKey", key: "enter" } };
    for (let attempt = 0; attempt < 3; attempt += 1)
      await action.execute(String(attempt), input, undefined, undefined, state.context);
    await expect(action.execute("fourth", input, undefined, undefined, state.context)).rejects.toThrow(
      "Repeated macOS action limit",
    );
    expect(state.supervisor.requests.filter((request) => request.type === "action")).toHaveLength(3);
    expect(state.supervisor.shutdowns).toContain("Repeated macOS action limit exceeded");
    await expect(
      state.tools.get("macos_observe")?.execute("after", {}, undefined, undefined, state.context),
    ).rejects.toThrow("macos_begin");
    const beginTool = state.tools.get("macos_begin");
    if (!beginTool) throw new Error("begin tool missing");
    await expect(
      beginTool.execute(
        "same-turn-restart",
        {
          application: { name: "Fixture" },
        },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("already ended this agent turn");
  });

  it("returns final RunResult and shuts down on finish and session exit", async () => {
    const finished = setup();
    await begin(finished);
    const finish = finished.tools.get("macos_finish");
    if (!finish) throw new Error("finish tool missing");
    const result = await finish.execute("finish", {}, undefined, undefined, finished.context);
    expect(result.details).toMatchObject({ kind: "finished", result: { verdict: "passed" } });
    expect(finished.supervisor.shutdowns).toEqual(["Pi task finished"]);
    expect(finished.confirmationCount()).toBe(2);

    const shutdown = setup();
    await begin(shutdown);
    await shutdown.shutdown();
    expect(shutdown.supervisor.shutdowns).toEqual(["Pi session shutdown"]);
  });

  it("leaves the Run active when normal finish confirmation is denied", async () => {
    const state = setup();
    await begin(state);
    state.context.ui.confirm = async () => false;
    const finish = state.tools.get("macos_finish");
    const observe = state.tools.get("macos_observe");
    if (!finish || !observe) throw new Error("tool missing");
    await expect(finish.execute("finish", {}, undefined, undefined, state.context)).rejects.toThrow(
      "denied normal macOS task finish",
    );
    expect(state.supervisor.shutdowns).toHaveLength(0);
    await expect(observe.execute("observe", {}, undefined, undefined, state.context)).resolves.toBeTruthy();
  });

  it("rejects duplicate begin and invalid tool inputs before delegation", async () => {
    const state = setup();
    await begin(state);
    const beginTool = state.tools.get("macos_begin");
    const action = state.tools.get("macos_action");
    if (!beginTool || !action) throw new Error("tool missing");
    await expect(
      beginTool.execute(
        "again",
        {
          application: { name: "Fixture" },
        },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("already active");
    await expect(
      action.execute(
        "invalid",
        { action: { kind: "click", x: 10, y: 20 } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow();
    expect(state.supervisor.requests.filter((request) => request.type === "action")).toHaveLength(0);
  });

  it("supports status and abort commands without exposing a runner endpoint", async () => {
    const notifications: string[] = [];
    const state = setup();
    state.context.ui.notify = (message) => notifications.push(message);
    await begin(state);
    await state.commands.get("macos-status")?.handler("", state.context);
    await state.commands.get("macos-abort")?.handler("operator abort", state.context);
    expect(state.supervisor.requests).toContainEqual({ type: "status" });
    expect(state.supervisor.shutdowns).toContain("operator abort");
    expect(notifications.at(-1)).toBe("macOS task aborted.");
  });

  it("races mid-action cancellation and clears local task ownership", async () => {
    const state = setup();
    await begin(state);
    let release: ((value: TaskValue) => void) | undefined;
    let releaseShutdown: (() => void) | undefined;
    state.supervisor.pendingAction = new Promise((resolve) => {
      release = resolve;
    });
    state.supervisor.pendingShutdown = new Promise((resolve) => {
      releaseShutdown = resolve;
    });
    const action = state.tools.get("macos_action");
    const observe = state.tools.get("macos_observe");
    if (!action || !observe) throw new Error("tool missing");
    const controller = new AbortController();
    const pending = action.execute(
      "pending",
      { action: { kind: "pressKey", key: "enter" } },
      controller.signal,
      undefined,
      state.context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    release?.({
      kind: "action",
      result: {
        dispatch: "dispatched",
        providerOutcome: "succeeded",
        verification: "confirmed",
        retryDisposition: "unsafe",
      },
      sequence: 1,
      observationId: "observation-00000001" as never,
      finalAssertionsPassed: false,
      compact: "button Save",
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseShutdown?.();
    await expect(pending).rejects.toThrow("cancelled");
    await expect(observe.execute("observe", {}, undefined, undefined, state.context)).rejects.toThrow(
      "macos_begin",
    );
    expect(state.supervisor.shutdowns).toContain("Pi mutating tool cancelled");
  });

  it("rejects target or immediate assertions on keyboard actions before IPC", async () => {
    const state = setup();
    await begin(state);
    const action = state.tools.get("macos_action");
    if (!action) throw new Error("action tool missing");
    for (const input of [
      { target: { identifier: "fixture.save" }, action: { kind: "pressKey", key: "enter" } },
      { target: { identifier: "fixture.save" }, action: { kind: "typeText", value: { literal: "x" } } },
      {
        action: { kind: "pressKey", key: "enter" },
        assertions: [{ kind: "visible", query: { role: "button" } }],
      },
    ])
      await expect(action.execute("invalid", input, undefined, undefined, state.context)).rejects.toThrow();
    expect(state.supervisor.requests.filter((request) => request.type === "action")).toHaveLength(0);
  });

  it("requires observed or queried locator provenance and recovery after correctable failures", async () => {
    const state = setup();
    await begin(state);
    const action = state.tools.get("macos_action");
    const observe = state.tools.get("macos_observe");
    if (!action || !observe) throw new Error("tool missing");
    await expect(
      action.execute(
        "guessed",
        { target: { name: { exact: "" } }, action: { kind: "click" } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("not proven");
    await observe.execute("observe", {}, undefined, undefined, state.context);
    state.supervisor.structuredFailure = true;
    state.supervisor.structuredFailureCode = "TargetAmbiguous";
    const failed = await action.execute(
      "ambiguous",
      { target: { identifier: "fixture.save" }, action: { kind: "click" } },
      undefined,
      undefined,
      state.context,
    );
    expect(failed.details).toMatchObject({ kind: "error", error: { clientCode: "TargetAmbiguous" } });
    state.supervisor.structuredFailure = false;
    await expect(
      action.execute(
        "blocked",
        { target: { identifier: "fixture.save" }, action: { kind: "click" } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("refine macos_query");
    await state.tools
      .get("macos_query")
      ?.execute(
        "premature-refine",
        { query: { identifier: "fixture.save" } },
        undefined,
        undefined,
        state.context,
      );
    await expect(
      action.execute(
        "blocked-without-observe",
        { target: { identifier: "fixture.save" }, action: { kind: "click" } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("refine macos_query");
    await observe.execute("recover", {}, undefined, undefined, state.context);
    await expect(
      action.execute(
        "still-blocked",
        { target: { identifier: "fixture.save" }, action: { kind: "click" } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("refine macos_query");
    await state.tools
      .get("macos_query")
      ?.execute("refine", { query: { identifier: "fixture.save" } }, undefined, undefined, state.context);
    await expect(
      action.execute(
        "allowed",
        { target: { identifier: "fixture.save" }, action: { kind: "click" } },
        undefined,
        undefined,
        state.context,
      ),
    ).resolves.toBeTruthy();
  });

  it("requires exact relationship-query provenance before relationship actions", async () => {
    const state = setup();
    await begin(state);
    const action = state.tools.get("macos_action");
    const query = state.tools.get("macos_query");
    if (!action || !query) throw new Error("tool missing");
    const relationship = {
      role: "checkbox",
      ancestor: { role: "group", value: { exact: "Review FSQ evidence" } },
    };
    await expect(
      action.execute(
        "invented-relationship",
        { target: relationship, action: { kind: "click" } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("not proven");
    await query.execute("relationship", { query: relationship }, undefined, undefined, state.context);
    await expect(
      action.execute(
        "proven-relationship",
        { target: relationship, action: { kind: "click" } },
        undefined,
        undefined,
        state.context,
      ),
    ).resolves.toBeTruthy();
  });

  it("blocks extra model work once frozen final assertions pass and permits finish", async () => {
    const state = setup();
    await begin(state);
    await state.tools.get("macos_observe")?.execute("observe", {}, undefined, undefined, state.context);
    state.supervisor.assertionStatus = "passed";
    const action = state.tools.get("macos_action");
    const finish = state.tools.get("macos_finish");
    if (!action || !finish) throw new Error("tool missing");
    const result = await action.execute(
      "done",
      { target: { identifier: "fixture.save" }, action: { kind: "click" } },
      undefined,
      undefined,
      state.context,
    );
    expect(result.details).toMatchObject({ completionReady: true });
    const actionsBefore = state.supervisor.requests.filter((request) => request.type === "action").length;
    await expect(
      action.execute(
        "extra",
        { target: { identifier: "fixture.save" }, action: { kind: "doubleClick" } },
        undefined,
        undefined,
        state.context,
      ),
    ).rejects.toThrow("extra exploration");
    expect(state.supervisor.requests.filter((request) => request.type === "action")).toHaveLength(
      actionsBefore,
    );
    await expect(finish.execute("finish", {}, undefined, undefined, state.context)).resolves.toBeTruthy();
  });

  it("blocks later tool calls at the guard after terminal failure", async () => {
    const state = setup();
    await begin(state);
    state.supervisor.structuredFailure = true;
    state.supervisor.structuredFailureCode = "ReadinessExpired";
    await state.tools.get("macos_observe")?.execute("terminal", {}, undefined, undefined, state.context);
    await expect(state.toolCall("macos_observe")).resolves.toMatchObject({ block: true, terminate: true });
    await expect(state.toolCall("macos_action")).resolves.toMatchObject({ block: true, terminate: true });
  });
});
