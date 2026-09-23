import { z } from "zod";
import { ArtifactIdSchema, OperationIdSchema } from "./ids.js";

export const DispatchStatusSchema = z.enum(["notDispatched", "dispatched", "unknown"]);
export const ProviderOutcomeSchema = z.enum(["succeeded", "failed", "unknown"]);
export const RetryDispositionSchema = z.enum(["safe", "unsafe", "reconcileRequired", "notApplicable"]);
export const IdempotencySchema = z.enum(["idempotent", "nonIdempotent", "unknown"]);

export const ErrorCodeSchema = z.enum([
  "InvalidConfiguration",
  "InvalidScenario",
  "UnsupportedRuntime",
  "GatewayBusy",
  "RecoveryRequired",
  "RunClosed",
  "LeaseExpired",
  "ReadinessExpired",
  "ImageDigestMismatch",
  "GuestPermissionNotGranted",
  "SessionUnavailable",
  "AppNotForeground",
  "AmbiguousWindowOwner",
  "StaleWindowRef",
  "StaleElementRef",
  "TargetNotFound",
  "TargetAmbiguous",
  "SnapshotIncomplete",
  "UnsupportedAction",
  "UnsupportedKey",
  "ProviderFailure",
  "ProviderTimeout",
  "EvidenceIncomplete",
  "EvidenceCorrupted",
  "CleanupFailed",
  "Cancelled",
  "InternalError",
]);

export const OperationErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    phase: z.enum(["image", "vm", "guest", "driver", "observe", "action", "evidence", "cleanup"]),
    message: z.string().min(1).max(500),
    retryDisposition: RetryDispositionSchema,
    dispatch: DispatchStatusSchema.optional(),
    diagnosticRef: z
      .object({ artifactId: ArtifactIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();

export const ActionResultSchema = z
  .object({
    dispatch: DispatchStatusSchema,
    providerOutcome: ProviderOutcomeSchema,
    verification: z.enum(["notRequested", "confirmed", "contradicted", "unverifiable"]),
    retryDisposition: z.enum(["safe", "unsafe", "reconcileRequired"]),
  })
  .strict();

export const RunResultSchema = z
  .object({
    verdict: z.enum(["passed", "failed", "inconclusive"]),
    evidence: z.enum(["complete", "incomplete"]),
    cleanup: z.enum(["completed", "failed"]),
  })
  .strict();

export const ProviderReceiptSchema = z
  .object({
    provider: z.string().min(1),
    operationId: OperationIdSchema,
    dispatch: DispatchStatusSchema,
    outcome: ProviderOutcomeSchema,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().optional(),
    diagnosticRef: z
      .object({ artifactId: ArtifactIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();
export const ProbeResultSchema = z
  .object({
    status: z.enum(["ready", "notReady", "failed"]),
    observedAt: z.iso.datetime(),
    validForMs: z.number().nonnegative(),
    durationMs: z.number().nonnegative(),
    reason: z.string().optional(),
    actual: z
      .object({
        guestMacOS: z.string(),
        xcode: z.string(),
        appium: z.string(),
        mac2: z.string(),
        wdaSha256: z.string().regex(/^[a-f0-9]{64}$/),
        buildIdentity: z.string(),
        fixtureBuild: z.string(),
        bundleId: z.string(),
        windowServerReady: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const VmStatusSchema = z
  .object({ exists: z.boolean(), state: z.enum(["stopped", "running", "unknown"]) })
  .strict();
export const CloneResultSchema = z
  .object({ resourceId: z.string().min(1).max(128), receipt: ProviderReceiptSchema })
  .strict();
export const AppiumStartResultSchema = z
  .object({ channelId: OperationIdSchema, receipt: ProviderReceiptSchema })
  .strict();

export type OperationError = z.infer<typeof OperationErrorSchema>;
export type ActionResult = z.infer<typeof ActionResultSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;
export type RetryDisposition = z.infer<typeof RetryDispositionSchema>;
export type ProviderReceipt = z.infer<typeof ProviderReceiptSchema>;
export type ProbeResult = z.infer<typeof ProbeResultSchema>;
export type VmStatus = z.infer<typeof VmStatusSchema>;
export type CloneResult = z.infer<typeof CloneResultSchema>;
export type AppiumStartResult = z.infer<typeof AppiumStartResultSchema>;
export type OperationResult<T> = { ok: true; value: T } | { ok: false; error: OperationError };

export const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });
export const err = <T = never>(error: OperationError): OperationResult<T> => ({ ok: false, error });
