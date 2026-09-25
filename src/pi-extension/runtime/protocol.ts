import { z } from "zod";
import {
  ApplicationTargetSchema,
  ActionResultSchema,
  ActionTemplateSchema,
  AssertionSpecSchema,
  ElementIdSchema,
  ElementQuerySchema,
  ObservationIdSchema,
  ErrorCodeSchema,
  RunIdSchema,
  RunResultSchema,
} from "../../contracts/public.js";

export const AGENT_TASK_PROTOCOL_VERSION = 2 as const;
export const TaskIdSchema = z.string().regex(/^task-[a-f0-9]{24}$/);
export const TaskRequestIdSchema = z.string().regex(/^req-[a-f0-9]{16,64}$/);

const EnvelopeSchema = z.object({
  protocolVersion: z.literal(AGENT_TASK_PROTOCOL_VERSION),
  taskId: TaskIdSchema,
  requestId: TaskRequestIdSchema,
  sequence: z.number().int().positive(),
});

export const TaskActionPayloadSchema = z
  .object({
    target: ElementQuerySchema.optional(),
    action: ActionTemplateSchema,
    assertions: z.array(AssertionSpecSchema).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.action.kind === "pressKey" || value.action.kind === "typeText") && value.target !== undefined)
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Keyboard actions do not accept a target. Click the control first when focus is required.",
      });
    if ((value.action.kind === "pressKey" || value.action.kind === "typeText") && value.assertions.length > 0)
      context.addIssue({
        code: "custom",
        path: ["assertions"],
        message: "Keyboard actions do not accept immediate assertions.",
      });
    if (value.action.kind !== "pressKey" && value.action.kind !== "typeText" && value.target === undefined)
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "A target query is required for this action.",
      });
  });

const requestSchemas = [
  EnvelopeSchema.extend({
    type: z.literal("begin"),
    application: ApplicationTargetSchema,
    finalAssertions: z.array(AssertionSpecSchema).min(1).max(50),
  }).strict(),
  EnvelopeSchema.extend({ type: z.literal("heartbeat") }).strict(),
  EnvelopeSchema.extend({ type: z.literal("observe") }).strict(),
  EnvelopeSchema.extend({ type: z.literal("query"), query: ElementQuerySchema }).strict(),
  EnvelopeSchema.extend({ type: z.literal("expand"), elementId: ElementIdSchema }).strict(),
  EnvelopeSchema.extend({
    type: z.literal("action"),
    target: ElementQuerySchema.optional(),
    action: ActionTemplateSchema,
    assertions: z.array(AssertionSpecSchema).max(20).default([]),
  })
    .strict()
    .superRefine((value, context) => {
      if (
        (value.action.kind === "pressKey" || value.action.kind === "typeText") &&
        value.target !== undefined
      )
        context.addIssue({
          code: "custom",
          path: ["target"],
          message: "Keyboard actions do not accept a target. Click the control first when focus is required.",
        });
      if (
        (value.action.kind === "pressKey" || value.action.kind === "typeText") &&
        value.assertions.length > 0
      )
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: "Keyboard actions do not accept immediate assertions.",
        });
      if (value.action.kind !== "pressKey" && value.action.kind !== "typeText" && value.target === undefined)
        context.addIssue({
          code: "custom",
          path: ["target"],
          message: "A target query is required for this action.",
        });
    }),
  EnvelopeSchema.extend({ type: z.literal("assert"), assertion: AssertionSpecSchema }).strict(),
  EnvelopeSchema.extend({ type: z.literal("finish") }).strict(),
  EnvelopeSchema.extend({ type: z.literal("abort"), reason: z.string().min(1).max(200) }).strict(),
  EnvelopeSchema.extend({ type: z.literal("status") }).strict(),
] as const;

export const TaskRequestSchema = z.union(requestSchemas);

export const SafeElementSummarySchema = z
  .object({
    elementId: ElementIdSchema,
    role: z.string().min(1).max(100),
    identifier: z.string().max(500).optional(),
    name: z.string().max(2_000).optional(),
    label: z.string().max(2_000).optional(),
    value: z.string().max(10_000).optional(),
    visible: z.boolean().optional(),
    enabled: z.boolean().optional(),
    selected: z.boolean().optional(),
    focused: z.boolean().optional(),
    isModal: z.boolean().optional(),
    isMain: z.boolean().optional(),
  })
  .strict();

export const TaskValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("begun"), leaseId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("heartbeat"), alive: z.literal(true) }).strict(),
  z
    .object({
      kind: z.literal("observation"),
      observationId: ObservationIdSchema,
      compact: z.string().max(100_000),
    })
    .strict(),
  z.object({ kind: z.literal("query"), element: SafeElementSummarySchema }).strict(),
  z.object({ kind: z.literal("expanded"), element: SafeElementSummarySchema }).strict(),
  z
    .object({
      kind: z.literal("action"),
      result: ActionResultSchema,
      sequence: z.number().int().nonnegative(),
      observationId: ObservationIdSchema,
      compact: z.string().max(100_000),
      finalAssertionsPassed: z.boolean().default(false),
      evidenceComplete: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assertion"),
      assertionId: z.string().min(1).max(128),
      status: z.enum(["passed", "failed", "unverifiable"]),
      observationId: ObservationIdSchema,
      reason: z.string().max(500),
    })
    .strict(),
  z.object({ kind: z.literal("finished"), runId: RunIdSchema, result: RunResultSchema }).strict(),
  z
    .object({
      kind: z.literal("aborted"),
      runId: RunIdSchema.optional(),
      result: RunResultSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("status"),
      state: z.enum(["starting", "active", "finalizing", "closed", "revoked"]),
    })
    .strict(),
]);

export const TaskRuntimeErrorCodeSchema = z.enum([
  "InvalidMessage",
  "UnsupportedProtocol",
  "IdentityMismatch",
  "SequenceViolation",
  "TaskState",
  "SupervisionLost",
  "ClientFailure",
  "ActionFailed",
  "InternalError",
]);

export const TaskRuntimeErrorSchema = z
  .object({
    code: TaskRuntimeErrorCodeSchema,
    message: z.string().min(1).max(500),
    clientCode: ErrorCodeSchema.optional(),
    actionResult: ActionResultSchema.optional(),
  })
  .strict();

const TaskResponseTypeSchema = z.enum([
  "begin",
  "heartbeat",
  "observe",
  "query",
  "expand",
  "action",
  "assert",
  "finish",
  "abort",
  "status",
  "protocolError",
]);
const ResponseEnvelopeSchema = EnvelopeSchema.extend({ type: TaskResponseTypeSchema });
export const TaskResponseSchema = z
  .discriminatedUnion("ok", [
    ResponseEnvelopeSchema.extend({ ok: z.literal(true), value: TaskValueSchema }).strict(),
    ResponseEnvelopeSchema.extend({ ok: z.literal(false), error: TaskRuntimeErrorSchema }).strict(),
  ])
  .superRefine((response, context) => {
    if (!response.ok) return;
    const expectedKind = {
      begin: "begun",
      heartbeat: "heartbeat",
      observe: "observation",
      query: "query",
      expand: "expanded",
      action: "action",
      assert: "assertion",
      finish: "finished",
      abort: "aborted",
      status: "status",
      protocolError: undefined,
    } as const;
    if (expectedKind[response.type] !== response.value.kind)
      context.addIssue({
        code: "custom",
        path: ["value", "kind"],
        message: "Response value does not match its operation type.",
      });
  });

export const invalidTaskProtocolResponse = (message: unknown): TaskResponse => {
  const partial = z
    .object({
      protocolVersion: z.literal(AGENT_TASK_PROTOCOL_VERSION),
      taskId: TaskIdSchema,
      requestId: TaskRequestIdSchema,
      sequence: z.number().int().positive(),
    })
    .loose()
    .safeParse(message);
  return TaskResponseSchema.parse({
    protocolVersion: AGENT_TASK_PROTOCOL_VERSION,
    taskId: partial.success ? partial.data.taskId : "task-000000000000000000000000",
    requestId: partial.success ? partial.data.requestId : "req-0000000000000000",
    sequence: partial.success ? partial.data.sequence : 1,
    type: "protocolError",
    ok: false,
    error: { code: "InvalidMessage", message: "Malformed task protocol message." },
  });
};

export type TaskId = z.infer<typeof TaskIdSchema>;
export type TaskRequestId = z.infer<typeof TaskRequestIdSchema>;
export type TaskActionPayload = z.infer<typeof TaskActionPayloadSchema>;
export type TaskRequest = z.infer<typeof TaskRequestSchema>;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;
export type TaskValue = z.infer<typeof TaskValueSchema>;
export type TaskRuntimeError = z.infer<typeof TaskRuntimeErrorSchema>;
export type TaskOperationInput = TaskRequest extends infer Request
  ? Request extends TaskRequest
    ? Omit<Request, "protocolVersion" | "taskId" | "requestId" | "sequence">
    : never
  : never;
