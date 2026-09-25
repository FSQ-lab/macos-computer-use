import { z } from "zod";
import { ArtifactRefSchema } from "./evidence.js";
import { ElementIdSchema, ObservationIdSchema, RunIdSchema, SessionIdSchema, WindowIdSchema } from "./ids.js";

export const TextMatchSchema = z.union([
  z.object({ exact: z.string(), caseSensitive: z.boolean().optional() }).strict(),
  z.object({ contains: z.string(), caseSensitive: z.boolean().optional() }).strict(),
]);

export const ElementSelectorSchema = z
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
    ancestor: ElementSelectorSchema.optional(),
    descendant: ElementSelectorSchema.optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).some((key) => key !== "ancestor" && key !== "descendant"),
    "At least one target query field is required",
  );

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
    nativeRole: z.string().min(1).optional(),
    identifier: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    value: z.string().optional(),
    visible: z.boolean().optional(),
    enabled: z.boolean().optional(),
    selected: z.boolean().optional(),
    focused: z.boolean().optional(),
    isModal: z.boolean().optional(),
    isMain: z.boolean().optional(),
    parentElementId: ElementIdSchema.optional(),
    depth: z.number().int().nonnegative().max(128).optional(),
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
    screenshot: ArtifactRefSchema.optional(),
    uiSnapshot: ArtifactRefSchema,
    screenshotScope: z.enum(["window", "display", "unavailable"]),
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
export type ElementSelector = z.infer<typeof ElementSelectorSchema>;
export type ElementQuery = z.infer<typeof ElementQuerySchema>;
export type WindowQuery = z.infer<typeof WindowQuerySchema>;
export type ElementSummary = z.infer<typeof ElementSummarySchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type ElementRef = z.infer<typeof ElementRefSchema>;

export const QueryPageSchema = z
  .object({
    status: z.enum(["unique", "ambiguous", "notFound", "incomplete"]),
    observationId: ObservationIdSchema,
    count: z.number().int().nonnegative(),
    candidates: z.array(ElementSummarySchema).max(100),
    nextOffset: z.number().int().nonnegative().optional(),
    reference: ElementRefSchema.optional(),
  })
  .strict();
export type QueryPage = z.infer<typeof QueryPageSchema>;
