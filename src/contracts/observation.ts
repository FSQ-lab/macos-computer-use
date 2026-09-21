import { z } from "zod";
import { ArtifactRefSchema } from "./evidence.js";
import { ElementIdSchema, ObservationIdSchema, RunIdSchema, SessionIdSchema, WindowIdSchema } from "./ids.js";

export const TextMatchSchema = z.union([
  z.object({ exact: z.string(), caseSensitive: z.boolean().optional() }).strict(),
  z.object({ contains: z.string(), caseSensitive: z.boolean().optional() }).strict(),
]);

export const ElementQuerySchema = z
  .object({
    role: z.string().min(1).max(100).optional(),
    identifier: z.string().min(1).max(500).optional(),
    name: TextMatchSchema.optional(),
    label: TextMatchSchema.optional(),
    value: TextMatchSchema.optional(),
    state: z
      .object({
        enabled: z.boolean().optional(),
        selected: z.boolean().optional(),
        focused: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one query field is required");

export const WindowQuerySchema = z
  .object({
    title: TextMatchSchema.optional(),
    role: z.string().min(1).max(100).optional(),
    isMain: z.boolean().optional(),
    isModal: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one window field is required");

export const ElementSummarySchema = z
  .object({
    elementId: ElementIdSchema,
    role: z.string().min(1),
    identifier: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    value: z.string().optional(),
    enabled: z.boolean().optional(),
    selected: z.boolean().optional(),
    focused: z.boolean().optional(),
    isModal: z.boolean().optional(),
    isMain: z.boolean().optional(),
    geometry: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ObservationSchema = z
  .object({
    observationId: ObservationIdSchema,
    runId: RunIdSchema,
    environmentId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    sessionId: SessionIdSchema,
    windowId: WindowIdSchema,
    capturedAt: z.iso.datetime(),
    screenshot: ArtifactRefSchema,
    uiSnapshot: ArtifactRefSchema,
    coverage: z.enum(["complete", "partial", "truncated"]),
    truncationReason: z.string().optional(),
    elements: z.array(ElementSummarySchema),
  })
  .strict();

export const ElementRefSchema = z
  .object({
    runId: RunIdSchema,
    environmentId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    sessionId: SessionIdSchema,
    windowId: WindowIdSchema,
    observationId: ObservationIdSchema,
    elementId: ElementIdSchema,
  })
  .strict();

export type TextMatch = z.infer<typeof TextMatchSchema>;
export type ElementQuery = z.infer<typeof ElementQuerySchema>;
export type WindowQuery = z.infer<typeof WindowQuerySchema>;
export type ElementSummary = z.infer<typeof ElementSummarySchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type ElementRef = z.infer<typeof ElementRefSchema>;
