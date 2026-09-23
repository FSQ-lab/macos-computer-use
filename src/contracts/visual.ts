import { z } from "zod";
import type { ObservationId } from "./ids.js";
import { ObservationIdSchema, AssertionIdSchema } from "./ids.js";
import { ArtifactRefSchema } from "./evidence.js";

export const AssertionResultSchema = z
  .object({
    assertionId: AssertionIdSchema,
    status: z.enum(["passed", "failed", "unverifiable"]),
    observationId: ObservationIdSchema,
    observationRef: ArtifactRefSchema,
    reason: z.string().max(500),
  })
  .strict();
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const VisualEvaluationSchema = z
  .object({ status: z.enum(["passed", "failed", "unverifiable"]), reason: z.string().max(500) })
  .strict();
export const VisualModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
export interface VisualEvaluator {
  readonly model: string;
  evaluate(
    input: { goal: string; observationId: ObservationId; screenshot: Uint8Array; mimeType: "image/png" },
    signal: AbortSignal,
  ): Promise<unknown>;
}
