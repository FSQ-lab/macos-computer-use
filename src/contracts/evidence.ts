import { z } from "zod";
import { ArtifactIdSchema, ObservationIdSchema, RunIdSchema } from "./ids.js";
import { RunResultSchema } from "./results.js";

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

export const EventTypeSchema = z.enum([
  "RunStarted",
  "EnvironmentAllocated",
  "ReadinessEvaluated",
  "ObservationCaptured",
  "ActionPlanned",
  "ProviderReceiptRecorded",
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
      coverage: z.string().optional(),
      screenshot: ArtifactRefSchema.optional(),
      uiSnapshot: ArtifactRefSchema.optional(),
    })
    .strict(),
  ActionPlanned: z.object({ operationId: z.string(), kind: z.string() }).strict(),
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
  RunRecoveryStarted: z.object({ cloneName: z.string() }).strict(),
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

export const ManagedResourceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    cloneName: z.string().regex(/^mcu-[0-9a-z-]+$/),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    phase: z.enum(["clonePlanned", "cloneCreated", "started", "cleanupStarted", "cleanupCompleted"]),
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
export const EnvironmentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    cloneName: z.string(),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    compatibility: z.object({ tart: z.string(), appiumMajor: z.literal(3), mac2: z.string() }).strict(),
    bundleId: z.string(),
  })
  .strict();
export const ConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    image: z.object({ reference: z.string(), digest: z.string() }).strict(),
    bundleId: z.string(),
    secretNames: z.array(z.string()),
    retentionDays: z.number().int().positive().nullable(),
  })
  .strict();

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type ManagedResourceRecord = z.infer<typeof ManagedResourceRecordSchema>;
export type RunIndexEntry = z.infer<typeof RunIndexEntrySchema>;
export type StepProjection = z.infer<typeof StepProjectionSchema>;
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshotSchema>;
export type ConfigSnapshot = z.infer<typeof ConfigSnapshotSchema>;
