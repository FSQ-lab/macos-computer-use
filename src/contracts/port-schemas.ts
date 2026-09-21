import { z } from "zod";
import { OperationIdSchema, RunIdSchema } from "./ids.js";
import { ObservationIdSchema, SessionIdSchema, WindowIdSchema } from "./ids.js";
import { WindowQuerySchema } from "./observation.js";
import { NetworkRuleSchema } from "./config.js";

export const ImageRequestSchema = z
  .object({
    reference: z.string().min(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const CloneRequestSchema = z
  .object({
    runId: RunIdSchema,
    cloneName: z.string().regex(/^mcu-[0-9a-z-]+$/),
    image: z.string().min(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const ManagedCloneRequestSchema = z
  .object({ cloneName: z.string().regex(/^mcu-[0-9a-z-]+$/), runId: RunIdSchema })
  .strict();
export const CompatibilityProbeSchema = z
  .object({
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    bundleId: z.string(),
    compatibility: z
      .object({
        appiumMajor: z.literal(3),
        mac2: z.string(),
        guestMacOS: z.string(),
        xcode: z.string(),
        fixtureBuild: z.string(),
      })
      .strict(),
  })
  .strict();
export const ProviderOperationSchema = z.object({ operationId: OperationIdSchema }).strict();
export const VmStartRequestSchema = z
  .object({ cloneName: z.string().regex(/^mcu-[0-9a-z-]+$/), network: z.array(NetworkRuleSchema) })
  .strict();
export const SessionRequestSchema = z
  .object({
    endpoint: z.url().refine((value) => value.startsWith("http://")),
    bundleId: z.string(),
    window: WindowQuerySchema,
    arguments: z.array(z.string()).optional(),
    environment: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export const ObserveRequestSchema = z
  .object({
    runId: RunIdSchema,
    generation: z.number().int().positive(),
    observationId: ObservationIdSchema,
    sessionId: SessionIdSchema,
    windowId: WindowIdSchema,
    window: WindowQuerySchema.optional(),
  })
  .strict();
export const ArtifactCommitRequestSchema = z
  .object({
    runId: RunIdSchema,
    type: z.string().min(1),
    mimeType: z.string().min(1),
    sensitivity: z.enum(["normal", "potentiallySensitive"]),
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  })
  .strict();

export type ImageRequest = z.infer<typeof ImageRequestSchema>;
export type CloneRequest = z.infer<typeof CloneRequestSchema>;
export type ManagedCloneRequest = z.infer<typeof ManagedCloneRequestSchema>;
export type CompatibilityProbe = z.infer<typeof CompatibilityProbeSchema>;
export type VmStartRequest = z.infer<typeof VmStartRequestSchema>;
export type SessionRequest = z.infer<typeof SessionRequestSchema>;
export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;
export type ArtifactCommitRequest = z.infer<typeof ArtifactCommitRequestSchema>;
