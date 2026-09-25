import { resolve } from "node:path";
import type { ExtensionAPI as OfficialExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import {
  PiTaskRequestError,
  PiTaskSupervisor as PiRuntimeSupervisor,
  type SafeElementSummarySchema,
  type TaskOperationInput,
  type TaskValue,
} from "./runtime/index.js";
import {
  ActionTemplateSchema,
  ApplicationTargetSchema,
  AssertionSpecSchema,
  ElementIdSchema,
  ElementQuerySchema,
} from "../contracts/public.js";
import type { ExtensionAPI, ToolDefinition, ToolResult } from "./pi-types.js";

export interface PiTaskSupervisor {
  start(
    application: Extract<TaskOperationInput, { type: "begin" }>["application"],
    finalAssertions: Extract<TaskOperationInput, { type: "begin" }>["finalAssertions"],
  ): Promise<TaskValue>;
  request(input: Exclude<TaskOperationInput, { type: "begin" | "heartbeat" }>): Promise<TaskValue>;
  shutdown(reason?: string): Promise<void>;
}

export type PiExtensionOptions = {
  configPath?: string;
  createSupervisor?: (configPath: string, cwd: string) => PiTaskSupervisor;
  registerProcessSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => () => void;
};

const jsonResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  details: value,
});
const applicationJson = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 200 }) },
  {
    additionalProperties: false,
    description: "Installed macOS GUI application display name, for example Safari or TextEdit.",
  },
);
const requestErrorResult = (error: PiTaskRequestError): ToolResult =>
  jsonResult({ kind: "error", error: error.details });
const correctableClientErrors = new Set(["TargetNotFound", "TargetAmbiguous", "SnapshotIncomplete"]);
const isTerminalTaskError = (error: PiTaskRequestError): boolean =>
  error.details.code !== "ClientFailure" ||
  error.details.clientCode === undefined ||
  !correctableClientErrors.has(error.details.clientCode);
const textMatchJson = Type.Union([
  Type.Object({ exact: Type.String(), caseSensitive: Type.Optional(Type.Boolean()) }),
  Type.Object({ contains: Type.String(), caseSensitive: Type.Optional(Type.Boolean()) }),
]);
const elementStateJson = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  selected: Type.Optional(Type.Boolean()),
  focused: Type.Optional(Type.Boolean()),
});
const queryJson = Type.Object(
  {
    role: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    identifier: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    name: Type.Optional(textMatchJson),
    label: Type.Optional(textMatchJson),
    value: Type.Optional(textMatchJson),
    state: Type.Optional(elementStateJson),
  },
  {
    additionalProperties: false,
    minProperties: 1,
    description: "Logical element query. Prefer the stable accessibility identifier when known.",
  },
);
const assertionJson = Type.Union(
  [
    Type.Object({ kind: Type.Literal("visible"), query: queryJson }),
    Type.Object({ kind: Type.Literal("notVisible"), query: queryJson }),
    Type.Object({
      kind: Type.Literal("text"),
      query: queryJson,
      expected: Type.String(),
      match: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("contains")])),
    }),
    Type.Object({
      kind: Type.Literal("value"),
      query: queryJson,
      expected: Type.String(),
      match: Type.Optional(Type.Union([Type.Literal("exact"), Type.Literal("contains")])),
    }),
    Type.Object({ kind: Type.Literal("state"), query: queryJson, state: elementStateJson }),
    Type.Object({
      kind: Type.Literal("elementOrder"),
      queries: Type.Array(queryJson, { minItems: 2 }),
      direction: Type.Union([Type.Literal("topToBottom"), Type.Literal("leftToRight")]),
    }),
    Type.Object({
      kind: Type.Literal("aiVisual"),
      goal: Type.String({ minLength: 1, maxLength: 2000 }),
      accepted: Type.Literal(true),
    }),
  ],
  { description: "One deterministic MCU assertion. The kind discriminator is required." },
);
const relativePointJson = Type.Object({
  x: Type.Number({ minimum: 0, maximum: 1 }),
  y: Type.Number({ minimum: 0, maximum: 1 }),
});
const modifiersJson = Type.Array(
  Type.Union([
    Type.Literal("command"),
    Type.Literal("control"),
    Type.Literal("option"),
    Type.Literal("shift"),
    Type.Literal("function"),
  ]),
  { maxItems: 5, uniqueItems: true },
);
const textInputJson = Type.Union([
  Type.Object({ literal: Type.String({ maxLength: 100000 }) }),
  Type.Object({
    secret: Type.Object({
      name: Type.String({ pattern: "^[A-Z][A-Z0-9_]{1,127}$" }),
      purpose: Type.Union([Type.Literal("textInput"), Type.Literal("appEnvironment")]),
    }),
  }),
]);
const actionJson = Type.Union(
  [
    Type.Object({
      kind: Type.Union([
        Type.Literal("click"),
        Type.Literal("doubleClick"),
        Type.Literal("rightClick"),
        Type.Literal("hover"),
      ]),
      point: Type.Optional(relativePointJson),
      modifiers: Type.Optional(modifiersJson),
    }),
    Type.Object({
      kind: Type.Literal("scroll"),
      point: Type.Optional(relativePointJson),
      delta: Type.Object({
        x: Type.Number({ minimum: -10, maximum: 10 }),
        y: Type.Number({ minimum: -10, maximum: 10 }),
      }),
    }),
    Type.Object({
      kind: Type.Literal("swipe"),
      point: Type.Optional(relativePointJson),
      direction: Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
      ]),
      velocity: Type.Optional(
        Type.Union([Type.Literal("slow"), Type.Literal("default"), Type.Literal("fast")]),
      ),
    }),
    Type.Object({
      kind: Type.Literal("drag"),
      point: Type.Optional(relativePointJson),
      destination: queryJson,
      destinationPoint: Type.Optional(relativePointJson),
      durationMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 30000 })),
    }),
    Type.Object({ kind: Type.Literal("typeText"), value: textInputJson }),
    Type.Object({
      kind: Type.Literal("pressKey"),
      key: Type.Union([
        Type.String({ minLength: 1, maxLength: 2 }),
        ...[
          "enter",
          "tab",
          "escape",
          "delete",
          "backspace",
          "space",
          "arrowUp",
          "arrowDown",
          "arrowLeft",
          "arrowRight",
          "home",
          "end",
          "pageUp",
          "pageDown",
        ].map((key) => Type.Literal(key)),
      ]),
      modifiers: Type.Optional(modifiersJson),
    }),
  ],
  { description: "One bounded element-relative MCU action. The kind discriminator is required." },
);

export const createPiExtension = (options: PiExtensionOptions = {}) => {
  return (pi: ExtensionAPI): void => {
    let supervisor: PiTaskSupervisor | undefined;
    let taskCalls = 0;
    let lastAction = "";
    let repeatedActions = 0;
    let mcuAttempted = false;
    let terminalFailureThisTurn = false;
    let discoveryRecoveryRequired = false;
    let completionReady = false;
    let finalAssertions: readonly z.infer<typeof AssertionSpecSchema>[] = [];
    const knownIdentifiers = new Set<string>();
    const knownElements: z.infer<typeof SafeElementSummarySchema>[] = [];
    const successfulQueries = new Set<string>();
    const macosTools = [
      "macos_begin",
      "macos_observe",
      "macos_query",
      "macos_expand",
      "macos_action",
      "macos_assert",
      "macos_finish",
      "macos_abort",
    ];
    const create =
      options.createSupervisor ??
      ((configPath: string, cwd: string) => new PiRuntimeSupervisor(configPath, cwd));
    const registerProcessSignal =
      options.registerProcessSignal ??
      ((signal: "SIGINT" | "SIGTERM", handler: () => void) => {
        process.once(signal, handler);
        return () => process.off(signal, handler);
      });
    const shutdownActive = async (reason: string): Promise<void> => {
      const active = supervisor;
      supervisor = undefined;
      if (active) await active.shutdown(reason);
    };
    const removeSignalHandlers = (["SIGINT", "SIGTERM"] as const).map((signal) =>
      registerProcessSignal(signal, () => void shutdownActive(`Pi process received ${signal}`)),
    );
    const requireTask = (): PiTaskSupervisor => {
      if (!supervisor) throw new Error("Call macos_begin first.");
      return supervisor;
    };
    const rememberCompact = (compact: string): void => {
      knownIdentifiers.clear();
      knownElements.length = 0;
      successfulQueries.clear();
      for (const match of compact.matchAll(/ id=("(?:[^"\\]|\\.)*")/gu)) {
        try {
          const value: unknown = JSON.parse(match[1] ?? "");
          if (typeof value === "string") knownIdentifiers.add(value);
        } catch {
          // Ignore malformed display-only locator text.
        }
      }
    };
    const rememberElement = (element: z.infer<typeof SafeElementSummarySchema>): void => {
      knownElements.push(element);
      if (element.identifier) knownIdentifiers.add(element.identifier);
    };
    const queryMatchesElement = (
      query: z.infer<typeof ElementQuerySchema>,
      element: z.infer<typeof SafeElementSummarySchema>,
    ): boolean => {
      const text = (
        actual: string | undefined,
        match:
          | { exact: string; caseSensitive?: boolean | undefined }
          | { contains: string; caseSensitive?: boolean | undefined }
          | undefined,
      ): boolean => {
        if (!match || actual === undefined) return match === undefined;
        const source = match.caseSensitive ? actual : actual.toLocaleLowerCase();
        const raw = "exact" in match ? match.exact : match.contains;
        const expected = match.caseSensitive ? raw : raw.toLocaleLowerCase();
        return "exact" in match ? source === expected : source.includes(expected);
      };
      return (
        (!query.role || query.role === element.role) &&
        (!query.identifier || query.identifier === element.identifier) &&
        text(element.name, query.name) &&
        text(element.label, query.label) &&
        text(element.value, query.value) &&
        (!query.state ||
          Object.entries(query.state).every(
            ([key, value]) => element[key as "enabled" | "selected" | "focused"] === value,
          ))
      );
    };
    const targetIsProven = (query: z.infer<typeof ElementQuerySchema>): boolean =>
      (query.identifier !== undefined && knownIdentifiers.has(query.identifier)) ||
      successfulQueries.has(JSON.stringify(query)) ||
      knownElements.some((element) => queryMatchesElement(query, element));
    const completionProbe = async (active: PiTaskSupervisor, suppress: boolean): Promise<boolean> => {
      const statuses: string[] = [];
      for (const assertion of finalAssertions) {
        try {
          const value = await active.request({ type: "assert", assertion });
          statuses.push(value.kind === "assertion" ? value.status : "unverifiable");
        } catch (error) {
          if (
            error instanceof PiTaskRequestError &&
            error.details.code === "ClientFailure" &&
            error.details.clientCode !== undefined &&
            correctableClientErrors.has(error.details.clientCode)
          )
            statuses.push("unverifiable");
          else throw error;
        }
      }
      const passed = statuses.length > 0 && statuses.every((status) => status === "passed");
      if (passed && !suppress) completionReady = true;
      return completionReady;
    };
    const guardOperation = (
      type: Exclude<TaskOperationInput, { type: "begin" | "heartbeat" }>["type"],
    ): void => {
      if (terminalFailureThisTurn) throw new Error("A terminal macOS failure already ended this agent turn.");
      if (completionReady && type !== "finish" && type !== "abort")
        throw new Error(
          "Final assertions already passed. Call macos_finish now; extra exploration is blocked.",
        );
      if (discoveryRecoveryRequired && !["observe", "query", "abort"].includes(type))
        throw new Error(
          "A target lookup failed. Call macos_observe or refine macos_query before another action.",
        );
    };
    const requestTask = async (
      input: Exclude<TaskOperationInput, { type: "begin" | "heartbeat" }>,
    ): Promise<ToolResult> => {
      const active = requireTask();
      guardOperation(input.type);
      taskCalls += 1;
      if (taskCalls > 100) {
        terminalFailureThisTurn = true;
        supervisor = undefined;
        await active.shutdown("Pi task tool-call limit exceeded");
        throw new Error("macOS task tool-call limit exceeded.");
      }
      try {
        const value = await active.request(input);
        if (value.kind === "observation") {
          rememberCompact(value.compact);
          discoveryRecoveryRequired = false;
        } else if (value.kind === "query") {
          rememberElement(value.element);
          if (input.type === "query") successfulQueries.add(JSON.stringify(input.query));
          discoveryRecoveryRequired = false;
        } else if (value.kind === "expanded") rememberElement(value.element);
        return jsonResult(value);
      } catch (error) {
        if (error instanceof PiTaskRequestError) {
          if (isTerminalTaskError(error)) {
            terminalFailureThisTurn = true;
            supervisor = undefined;
            await active.shutdown(
              `Terminal macOS tool failure: ${error.details.clientCode ?? error.details.code}`,
            );
          } else discoveryRecoveryRequired = true;
          return requestErrorResult(error);
        }
        throw error;
      }
    };
    const configPath = (cwd: string): string =>
      resolve(
        options.configPath ?? process.env.MACOS_COMPUTER_USE_CONFIG ?? `${cwd}/.macos-computer-use.json`,
      );
    const tool = (definition: ToolDefinition): void =>
      pi.registerTool({ ...definition, executionMode: "sequential" });

    pi.on("before_agent_start", (event) => {
      mcuAttempted = false;
      terminalFailureThisTurn = false;
      event.systemPromptOptions.selectedTools = macosTools;
      event.systemPromptOptions.promptGuidelines.push(
        "This is an MCU macOS automation task. Use only macos_* tools. macos_begin must freeze at least one explicit final assertion before any observation or action.",
        "Never use bash, read, edit, write, grep, find, ls, AppleScript, screencapture, CoreGraphics, Host applications, or absolute coordinates as a substitute for macos_* tools.",
        "If a macos_* tool returns a terminal failure, cleanup has already been requested: report that exact failure and stop. Correctable target or snapshot failures may be resolved with a fresh observation or refined logical query. Never claim success without a successful macos_finish RunResult.",
        "For text input, click the observed control to focus it, then use targetless typeText. Clearing, selecting, caret movement, and Enter are separate pressKey actions. Never use replaceText or appendText.",
        "Build element targets only from fields actually present in the latest compact/expanded result or returned by a successful query. Never guess placeholder-derived or empty name, label, or value fields.",
        "pressKey and typeText never accept a target or immediate assertions. Use later macos_assert or frozen final assertions. When completionReady is returned, call macos_finish immediately without extra query, assert, doubleClick, or exploration.",
        "Do not ask for confirmation in natural-language text. Call macos_action directly. Actions run without confirmation unless the user's current prompt explicitly requires confirmation for that action; only then set confirm=true so the Extension displays the single confirmation dialog.",
      );
      return undefined;
    });
    pi.on("tool_call", async (event) => {
      if (event.toolName === "macos_begin") mcuAttempted = true;
      if (!macosTools.includes(event.toolName))
        return {
          block: true as const,
          terminate: mcuAttempted,
          reason:
            "Only macos_* tools are enabled while the MCU extension is loaded. Use a Pi session without this extension for Host tasks.",
        };
      if (terminalFailureThisTurn)
        return {
          block: true as const,
          terminate: true,
          reason: "A terminal macOS failure already ended this turn.",
        };
      if (completionReady && !["macos_finish", "macos_abort"].includes(event.toolName))
        return {
          block: true as const,
          terminate: false,
          reason: "Final assertions passed. Call macos_finish.",
        };
      if (
        discoveryRecoveryRequired &&
        !["macos_observe", "macos_query", "macos_abort"].includes(event.toolName)
      )
        return {
          block: true as const,
          terminate: false,
          reason: "Observe or refine a query before another action.",
        };
      return undefined;
    });

    tool({
      name: "macos_begin",
      label: "Begin macOS Task",
      description: "Start one supervised disposable macOS task with frozen final assertions.",
      parameters: Type.Object({
        application: applicationJson,
        finalAssertions: Type.Array(assertionJson, { minItems: 1 }),
      }),
      async execute(_id, input, _signal, _update, context) {
        const parsed = z
          .object({
            application: ApplicationTargetSchema,
            finalAssertions: z.array(AssertionSpecSchema).min(1).max(50),
          })
          .strict()
          .parse(input);
        if (supervisor) throw new Error("A macOS task is already active.");
        if (terminalFailureThisTurn)
          throw new Error("A terminal macOS failure already ended this agent turn. Wait for new user input.");
        if (!context.hasUI) throw new Error("Starting a macOS task requires interactive confirmation.");
        if (
          !(await context.ui.confirm(
            "Allow macOS application?",
            `Start a disposable VM and control ${parsed.application.name}?`,
          ))
        )
          throw new Error("User denied the target application.");
        let active: PiTaskSupervisor | undefined;
        try {
          active = create(configPath(context.cwd), context.cwd);
          supervisor = active;
          taskCalls = 0;
          repeatedActions = 0;
          lastAction = "";
          discoveryRecoveryRequired = false;
          completionReady = false;
          finalAssertions = parsed.finalAssertions;
          knownIdentifiers.clear();
          knownElements.length = 0;
          successfulQueries.clear();
          return jsonResult(await active.start(parsed.application, parsed.finalAssertions));
        } catch (error) {
          await active?.shutdown("Pi task failed to start");
          supervisor = undefined;
          if (error instanceof PiTaskRequestError) return requestErrorResult(error);
          throw new Error("MCU task could not start. Check the local MCU configuration and runtime setup.");
        }
      },
    });
    tool({
      name: "macos_observe",
      label: "Observe macOS",
      description: "Capture a fresh compact logical UI observation.",
      parameters: Type.Object({}),
      async execute() {
        return requestTask({ type: "observe" });
      },
    });
    tool({
      name: "macos_query",
      label: "Query macOS UI",
      description: "Find one logical UI element.",
      parameters: Type.Object({ query: queryJson }),
      async execute(_id, input) {
        const { query } = z.object({ query: ElementQuerySchema }).strict().parse(input);
        return requestTask({ type: "query", query });
      },
    });
    tool({
      name: "macos_expand",
      label: "Expand macOS Element",
      description: "Expand one logical element from the latest observation.",
      parameters: Type.Object({ elementId: Type.String() }),
      async execute(_id, input) {
        const { elementId } = z.object({ elementId: ElementIdSchema }).strict().parse(input);
        return requestTask({ type: "expand", elementId });
      },
    });
    tool({
      name: "macos_action",
      label: "Act on macOS",
      description:
        "Perform one structured element-relative UI action. Set confirm=true only when the user explicitly requested confirmation for this action.",
      parameters: Type.Object({
        target: Type.Optional(queryJson),
        action: actionJson,
        assertions: Type.Optional(Type.Array(assertionJson)),
        confirm: Type.Optional(Type.Literal(true)),
      }),
      async execute(_id, input, signal, _update, context) {
        const parsed = z
          .object({
            target: ElementQuerySchema.optional(),
            action: ActionTemplateSchema,
            assertions: z.array(AssertionSpecSchema).max(20).default([]),
            confirm: z.literal(true).optional(),
          })
          .strict()
          .superRefine((value, refinement) => {
            const keyboard = value.action.kind === "pressKey" || value.action.kind === "typeText";
            if (keyboard && value.target !== undefined)
              refinement.addIssue({
                code: "custom",
                path: ["target"],
                message:
                  "Keyboard actions do not accept a target. Click the control first when focus is required.",
              });
            if (keyboard && value.assertions.length > 0)
              refinement.addIssue({
                code: "custom",
                path: ["assertions"],
                message: "Keyboard actions do not accept immediate assertions.",
              });
            if (!keyboard && value.target === undefined)
              refinement.addIssue({
                code: "custom",
                path: ["target"],
                message: "Action target is required.",
              });
          })
          .parse(input);
        const active = requireTask();
        guardOperation("action");
        if (parsed.target && !targetIsProven(parsed.target))
          throw new Error("Action target uses locator fields not proven by the latest Observation or query.");
        if (parsed.action.kind === "drag" && !targetIsProven(parsed.action.destination))
          throw new Error(
            "Drag destination uses locator fields not proven by the latest Observation or query.",
          );
        const operation = {
          target: parsed.target,
          action: parsed.action,
          assertions: parsed.assertions,
        };
        const identity = JSON.stringify(operation);
        repeatedActions = identity === lastAction ? repeatedActions + 1 : 1;
        lastAction = identity;
        if (repeatedActions > 3) {
          terminalFailureThisTurn = true;
          supervisor = undefined;
          await active.shutdown("Repeated macOS action limit exceeded");
          throw new Error("Repeated macOS action limit exceeded.");
        }
        if (parsed.confirm) {
          if (!context.hasUI) throw new Error("This macOS action requires interactive confirmation.");
          const summary =
            `${parsed.action.kind} ${parsed.target ? JSON.stringify(parsed.target) : ""}`.trim();
          if (!(await context.ui.confirm("Allow macOS action?", summary)))
            throw new Error("User denied this macOS action.");
        }
        taskCalls += 1;
        if (taskCalls > 100) {
          terminalFailureThisTurn = true;
          supervisor = undefined;
          await active.shutdown("Pi task tool-call limit exceeded");
          throw new Error("macOS task tool-call limit exceeded.");
        }
        if (signal?.aborted) {
          terminalFailureThisTurn = true;
          await active.shutdown("Pi mutating tool cancelled");
          supervisor = undefined;
          throw new Error("Pi mutating tool was cancelled.");
        }
        let abortReject: ((error: Error) => void) | undefined;
        let cancellationShutdown: Promise<void> | undefined;
        const cancelled = new Promise<never>((_resolve, reject) => {
          abortReject = reject;
        });
        const abort = (): void => {
          terminalFailureThisTurn = true;
          supervisor = undefined;
          abortReject?.(new Error("Pi mutating tool was cancelled."));
          cancellationShutdown = active.shutdown("Pi mutating tool cancelled");
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const request = active.request({ type: "action", ...operation });
          const value = await Promise.race([request, cancelled]);
          if (value.kind === "action") rememberCompact(value.compact);
          const ready =
            value.kind === "action" && value.finalAssertionsPassed && parsed.action.kind !== "typeText"
              ? (completionReady = true)
              : completionReady;
          return jsonResult({ ...value, completionReady: ready });
        } catch (error) {
          if (error instanceof PiTaskRequestError) {
            if (isTerminalTaskError(error)) {
              terminalFailureThisTurn = true;
              supervisor = undefined;
              await active.shutdown(
                `Terminal macOS action failure: ${error.details.clientCode ?? error.details.code}`,
              );
            } else discoveryRecoveryRequired = true;
            return requestErrorResult(error);
          }
          if (cancellationShutdown) await cancellationShutdown.catch(() => undefined);
          else {
            terminalFailureThisTurn = true;
            await active.shutdown("Pi mutating tool failed");
          }
          supervisor = undefined;
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
    });
    tool({
      name: "macos_assert",
      label: "Assert macOS UI",
      description: "Evaluate one deterministic assertion on a fresh observation.",
      parameters: Type.Object({ assertion: assertionJson }),
      async execute(_id, input) {
        const { assertion } = z.object({ assertion: AssertionSpecSchema }).strict().parse(input);
        const active = requireTask();
        guardOperation("assert");
        try {
          const value = await active.request({ type: "assert", assertion });
          const ready = await completionProbe(active, false);
          return jsonResult({ ...value, completionReady: ready });
        } catch (error) {
          if (error instanceof PiTaskRequestError) {
            if (isTerminalTaskError(error)) {
              terminalFailureThisTurn = true;
              supervisor = undefined;
              await active.shutdown(
                `Terminal macOS assertion failure: ${error.details.clientCode ?? error.details.code}`,
              );
            } else discoveryRecoveryRequired = true;
            return requestErrorResult(error);
          }
          terminalFailureThisTurn = true;
          supervisor = undefined;
          await active.shutdown("Pi assertion tool failed");
          throw error;
        }
      },
    });
    tool({
      name: "macos_finish",
      label: "Finish macOS Task",
      description: "Confirm normal Tart destruction, finalize Evidence, and clean up.",
      parameters: Type.Object({}),
      async execute(_id, _input, _signal, _update, context) {
        const active = requireTask();
        guardOperation("finish");
        if (!context.hasUI) throw new Error("Finishing a macOS task requires interactive confirmation.");
        if (!(await context.ui.confirm("Finish macOS task?", "Finalize this Run and destroy its Tart VM?")))
          throw new Error("User denied normal macOS task finish.");
        try {
          return await requestTask({ type: "finish" });
        } finally {
          await active.shutdown("Pi task finished");
          supervisor = undefined;
        }
      },
    });
    tool({
      name: "macos_abort",
      label: "Abort macOS Task",
      description: "Cancel and wait for cleanup.",
      parameters: Type.Object({ reason: Type.Optional(Type.String({ maxLength: 200 })) }),
      async execute(_id, input) {
        const { reason } = z
          .object({ reason: z.string().max(200).default("Pi requested abort") })
          .strict()
          .parse(input);
        const active = requireTask();
        try {
          return await requestTask({ type: "abort", reason });
        } finally {
          await active.shutdown(reason);
          supervisor = undefined;
        }
      },
    });

    pi.registerCommand("macos-status", {
      description: "Show the supervised macOS task status",
      async handler(_args, context) {
        if (!supervisor) context.ui.notify("No active macOS task.", "info");
        else context.ui.notify(JSON.stringify(await supervisor.request({ type: "status" })), "info");
      },
    });
    pi.registerCommand("macos-abort", {
      description: "Abort the active macOS task and wait for cleanup",
      async handler(reason, context) {
        if (!supervisor) return context.ui.notify("No active macOS task.", "info");
        await supervisor.shutdown(reason || "Pi command abort");
        supervisor = undefined;
        context.ui.notify("macOS task aborted.", "info");
      },
    });
    pi.on("session_shutdown", async () => {
      for (const remove of removeSignalHandlers) remove();
      await shutdownActive("Pi session shutdown");
    });
  };
};

export default function piExtension(api: OfficialExtensionAPI): void {
  createPiExtension()(api as unknown as ExtensionAPI);
}
