import { z } from "zod";
import {
  ActionIdSchema,
  ArtifactIdSchema,
  ObservationIdSchema,
  OperationIdSchema,
  RunIdSchema,
} from "./ids.js";
import { ActionResultSchema, RunResultSchema } from "./results.js";
import { GatewayConfigSchema } from "./config.js";
import type { RunId } from "./ids.js";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.startsWith("/") && !v.split("/").includes(".."));

export const ArtifactRefSchema = z.object({ artifactId: ArtifactIdSchema, sha256: Sha256Schema }).strict();
export const ArtifactDescriptorSchema = z
  .object({
    artifactId: ArtifactIdSchema,
    type: z.string().min(1).max(80),
    relativePath: RelativePathSchema,
    mimeType: z.string().min(1).max(120),
    size: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    sensitivity: z.enum(["normal", "potentiallySensitive"]),
  })
  .strict();

export const ProviderLifecycleAliasSchema = z.string().regex(/^(?:outer|inner)-[1-9][0-9]{0,3}$/);
export const ProviderLifecycleSourceSchema = z.enum(["appium", "wda", "xcodebuild"]);
export const ProviderLifecycleEventTypeSchema = z.enum([
  "sessionCreated",
  "sessionDeleteRequested",
  "sessionRemoved",
  "sessionReplaced",
  "unexpectedShutdown",
  "processExited",
]);
export const ProviderLifecycleCauseSchema = z.enum([
  "explicitDelete",
  "newCommandTimeout",
  "unexpectedShutdown",
  "replacement",
  "providerExit",
  "unknown",
]);
export const ProviderTerminationEventTypeSchema = z.enum([
  "sessionDeleteRequested",
  "sessionRemoved",
  "sessionReplaced",
  "unexpectedShutdown",
  "processExited",
]);
const lifecycleBase = {
  sequence: z.number().int().positive().max(10_000),
  recordedAt: z.iso.datetime(),
  observedBeforeCleanup: z.literal(true),
};
export const ProviderLifecycleEventSchema = z.discriminatedUnion("event", [
  z
    .object({
      ...lifecycleBase,
      source: z.enum(["appium", "wda"]),
      event: z.literal("sessionCreated"),
      alias: ProviderLifecycleAliasSchema,
    })
    .strict(),
  z
    .object({
      ...lifecycleBase,
      source: z.enum(["appium", "wda"]),
      event: z.literal("sessionDeleteRequested"),
      alias: ProviderLifecycleAliasSchema,
      cause: z.literal("explicitDelete"),
    })
    .strict(),
  z
    .object({
      ...lifecycleBase,
      source: z.enum(["appium", "wda"]),
      event: z.literal("sessionRemoved"),
      alias: ProviderLifecycleAliasSchema,
      cause: z.enum(["unexpectedShutdown", "unknown"]),
    })
    .strict(),
  z
    .object({
      ...lifecycleBase,
      source: z.literal("wda"),
      event: z.literal("sessionReplaced"),
      alias: ProviderLifecycleAliasSchema,
      cause: z.literal("replacement"),
    })
    .strict(),
  z
    .object({
      ...lifecycleBase,
      source: z.literal("appium"),
      event: z.literal("unexpectedShutdown"),
      cause: z.enum(["newCommandTimeout", "unexpectedShutdown"]),
    })
    .strict(),
  z
    .object({
      ...lifecycleBase,
      source: ProviderLifecycleSourceSchema,
      event: z.literal("processExited"),
      cause: z.literal("providerExit"),
      exitCode: z.number().int().min(0).max(255).optional(),
      signal: z.enum(["SIGABRT", "SIGBUS", "SIGILL", "SIGKILL", "SIGSEGV", "SIGTERM"]).optional(),
    })
    .strict(),
]);
export const ProviderLifecycleDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    compatibility: z
      .object({
        appium: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
        mac2: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
      })
      .strict(),
    events: z.array(ProviderLifecycleEventSchema).max(2_000),
    snapshot: z
      .object({
        capturedAt: z.iso.datetime(),
        observedBeforeCleanup: z.literal(true),
        appiumStatus: z.enum(["ready", "unavailable"]),
        wdaStatus: z.enum(["ready", "unavailable"]),
        activeSessionCount: z.number().int().min(0).max(16).optional(),
        processes: z.object({ appium: z.boolean(), xcodebuild: z.boolean(), wda: z.boolean() }).strict(),
      })
      .strict(),
    earliestTermination: z
      .object({
        sequence: z.number().int().positive().max(10_000),
        source: ProviderLifecycleSourceSchema,
        event: ProviderTerminationEventTypeSchema,
        alias: ProviderLifecycleAliasSchema.optional(),
        cause: ProviderLifecycleCauseSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((diagnostic, ctx) => {
    for (let index = 0; index < diagnostic.events.length; index += 1)
      if (diagnostic.events[index]?.sequence !== index + 1)
        ctx.addIssue({ code: "custom", path: ["events", index, "sequence"], message: "Invalid sequence." });
    const terminal = diagnostic.events.find(
      (event) => ProviderTerminationEventTypeSchema.safeParse(event.event).success,
    );
    if (terminal === undefined && diagnostic.earliestTermination !== undefined)
      ctx.addIssue({ code: "custom", path: ["earliestTermination"], message: "Unexpected termination." });
    if (terminal !== undefined) {
      const expected = {
        sequence: terminal.sequence,
        source: terminal.source,
        event: terminal.event,
        ...("alias" in terminal ? { alias: terminal.alias } : {}),
        ...("cause" in terminal ? { cause: terminal.cause } : {}),
      };
      if (JSON.stringify(diagnostic.earliestTermination) !== JSON.stringify(expected))
        ctx.addIssue({ code: "custom", path: ["earliestTermination"], message: "Wrong termination." });
    }
  });

export const EventTypeSchema = z.enum([
  "RunStarted",
  "EnvironmentAllocated",
  "ReadinessEvaluated",
  "ObservationCaptured",
  "FinalAssertionsFrozen",
  "ActionPlanned",
  "ProviderReceiptRecorded",
  "ActionResultRecorded",
  "AssertionEvaluated",
  "ArtifactCommitted",
  "EvidenceCollectionFailed",
  "CleanupStarted",
  "CleanupFinished",
  "RunRecoveryStarted",
  "RunRecoveryFinished",
  "HookFailed",
  "RunFinished",
  "OperationFailed",
  "StepProjected",
]);

const EventDataSchemas = {
  RunStarted: z.union([
    z.object({ scenario: z.string(), scenarioSha256: Sha256Schema }).strict(),
    z.object({ mode: z.literal("interactive") }).strict(),
  ]),
  EnvironmentAllocated: z.object({ clone: z.literal("managed") }).strict(),
  ReadinessEvaluated: z
    .object({ vm: z.string(), guest: z.string(), driver: z.string(), app: z.string() })
    .strict(),
  ObservationCaptured: z
    .object({
      observationId: z.string(),
      screenshotScope: z.enum(["window", "display", "unavailable"]).optional(),
      coverage: z.string().optional(),
      screenshot: ArtifactRefSchema.optional(),
      uiSnapshot: ArtifactRefSchema.optional(),
    })
    .strict(),
  FinalAssertionsFrozen: z
    .object({ count: z.number().int().positive().max(50), observationId: ObservationIdSchema })
    .strict(),
  ActionPlanned: z
    .object({ actionId: ActionIdSchema, operationId: OperationIdSchema, kind: z.string() })
    .strict(),
  ProviderReceiptRecorded: z
    .object({
      provider: z.string(),
      operationId: z.string(),
      dispatch: z.enum(["notDispatched", "dispatched", "unknown"]),
      outcome: z.enum(["succeeded", "failed", "unknown"]),
      startedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().optional(),
      diagnosticRef: ArtifactRefSchema.optional(),
    })
    .strict(),
  ActionResultRecorded: z
    .object({ actionId: ActionIdSchema, operationId: OperationIdSchema, result: ActionResultSchema })
    .strict(),
  AssertionEvaluated: z
    .object({
      kind: z.string(),
      status: z.enum(["passed", "failed", "unverifiable"]),
      reason: z.string(),
      observationId: ObservationIdSchema,
    })
    .strict(),
  ArtifactCommitted: z
    .object({ artifactId: ArtifactIdSchema, type: z.string(), sha256: Sha256Schema })
    .strict(),
  EvidenceCollectionFailed: z.object({ stage: z.string(), code: z.string() }).strict(),
  CleanupStarted: z.object({}).strict(),
  CleanupFinished: z.object({ status: z.enum(["completed", "failed"]) }).strict(),
  RunRecoveryStarted: z.object({ resourceId: z.string() }).strict(),
  RunRecoveryFinished: z.object({ status: z.enum(["completed", "failed"]) }).strict(),
  HookFailed: z.object({ hook: z.string(), code: z.string() }).strict(),
  RunFinished: RunResultSchema,
  OperationFailed: z.object({ code: z.string(), phase: z.string(), message: z.string() }).strict(),
  StepProjected: z.object({ stepId: z.string(), status: z.enum(["completed", "failed", "notRun"]) }).strict(),
} as const;

export const EvidenceEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    sequence: z.number().int().positive(),
    recordedAt: z.iso.datetime(),
    elapsedMs: z.number().nonnegative(),
    type: EventTypeSchema,
    source: z.enum(["kernel", "adapter", "hook"]),
    provider: z.string().min(1).max(80).optional(),
    data: z.unknown(),
  })
  .strict()
  .superRefine((event, ctx) => {
    const parsed = EventDataSchemas[event.type].safeParse(event.data);
    if (!parsed.success)
      ctx.addIssue({ code: "custom", path: ["data"], message: `Invalid data for ${event.type}.` });
  });
export const CurrentEvidenceEventSchema = EvidenceEventSchema;

export const RunManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    runId: RunIdSchema,
    buildVersion: z.string().min(1),
    eventCount: z.number().int().nonnegative(),
    timelineSha256: Sha256Schema,
    result: RunResultSchema,
    artifacts: z.array(ArtifactDescriptorSchema),
    configArtifact: ArtifactRefSchema.optional(),
    environmentArtifact: ArtifactRefSchema.optional(),
    previousRevisionSha256: Sha256Schema.optional(),
  })
  .strict();

const ManagedResourcePhaseSchema = z.enum([
  "clonePlanned",
  "cloneCreated",
  "started",
  "cleanupStarted",
  "cleanupCompleted",
]);
export const ManagedResourceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    resourceId: z.string().min(1).max(128),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    phase: ManagedResourcePhaseSchema,
  })
  .strict();
export const RunIndexEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    event: z.enum(["RunStarted", "RunFinished"]),
    recordedAt: z.iso.datetime(),
  })
  .strict();
export const StepProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    stepId: z.string(),
    status: z.enum(["completed", "failed", "notRun"]),
  })
  .strict();
export const DamagedRunRecoverySchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    status: z.literal("failed"),
    recordedAt: z.iso.datetime(),
    buildVersion: z.string().min(1),
    timelineSha256: Sha256Schema,
    timelineBytes: z.number().int().nonnegative(),
    unknownDispatch: z.literal(true),
    result: z.object({
      verdict: z.literal("inconclusive"),
      evidence: z.literal("incomplete"),
      cleanup: z.enum(["completed", "failed"]),
    }),
  })
  .strict();
export const EnvironmentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    buildIdentity: z.string().min(1),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    compatibility: z
      .object({
        tart: z.string(),
        appiumMajor: z.literal(3),
        appium: z.string(),
        mac2: z.string(),
        wdaSha256: Sha256Schema,
        guestMacOS: z.string(),
        xcode: z.string(),
        fixtureBuild: z.string(),
      })
      .strict(),
    bundleId: z.string(),
    actual: z
      .object({
        guestMacOS: z.string(),
        xcode: z.string(),
        appium: z.string(),
        mac2: z.string(),
        wdaSha256: Sha256Schema,
        buildIdentity: z.string(),
        fixtureBuild: z.string(),
        bundleId: z.string(),
        windowServerReady: z.boolean(),
        automationPermissionReady: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const ConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    image: z
      .object({
        reference: z.string(),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        buildIdentity: z.string().min(1),
      })
      .strict(),
    aut: z.lazy(() => GatewayConfigSchema.shape.aut.omit({ window: true })),
    timeouts: z.lazy(() => GatewayConfigSchema.shape.timeouts),
    evidence: z.lazy(() => GatewayConfigSchema.shape.evidence.omit({ root: true })),
    network: z.lazy(() => GatewayConfigSchema.shape.network),
    secrets: z.lazy(() => GatewayConfigSchema.shape.secrets),
    compatibility: z.lazy(() => GatewayConfigSchema.shape.compatibility),
  })
  .strict();

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;
export type ProviderLifecycleDiagnostic = z.infer<typeof ProviderLifecycleDiagnosticSchema>;
type EventDataByType = {
  [K in keyof typeof EventDataSchemas]: z.infer<(typeof EventDataSchemas)[K]>;
};
export type EvidenceEvent = {
  [K in keyof EventDataByType]: {
    schemaVersion: 1;
    runId: RunId;
    sequence: number;
    recordedAt: string;
    elapsedMs: number;
    type: K;
    source: "kernel" | "adapter" | "hook";
    provider?: string;
    data: EventDataByType[K];
  };
}[keyof EventDataByType];
export const parseEvidenceEvent = (value: unknown): EvidenceEvent =>
  EvidenceEventSchema.parse(value) as EvidenceEvent;
export const parseCurrentEvidenceEvent = (value: unknown): EvidenceEvent =>
  CurrentEvidenceEventSchema.parse(value) as EvidenceEvent;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type ManagedResourceRecord = z.infer<typeof ManagedResourceRecordSchema>;
export type RunIndexEntry = z.infer<typeof RunIndexEntrySchema>;
export type StepProjection = z.infer<typeof StepProjectionSchema>;
export type DamagedRunRecovery = z.infer<typeof DamagedRunRecoverySchema>;
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshotSchema>;
export type ConfigSnapshot = z.infer<typeof ConfigSnapshotSchema>;
