import { z } from "zod";
import { ElementRefSchema, ElementQuerySchema, WindowQuerySchema } from "./observation.js";

export const RelativePointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
export const ElementPointSchema = z
  .object({ element: ElementRefSchema, point: RelativePointSchema.optional() })
  .strict();
export const ModifierSchema = z.enum(["command", "control", "option", "shift", "function"]);
const specialKeys = [
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
] as const;
const printableKey = z
  .string()
  .refine((value) => Array.from(value).length === 1 && !/[\p{Cc}\p{Cf}\r\n]/u.test(value));
export const SupportedKeySchema = z.union([z.enum(specialKeys), printableKey]);
export const SecretRefSchema = z
  .object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    purpose: z.enum(["textInput", "appEnvironment"]),
  })
  .strict();
export const TextInputSchema = z.union([
  z.object({ literal: z.string().max(100_000) }).strict(),
  z.object({ secret: SecretRefSchema }).strict(),
]);

const pointer = z
  .object({
    kind: z.enum(["click", "doubleClick", "rightClick", "hover"]),
    target: ElementPointSchema,
    modifiers: z.array(ModifierSchema).max(5).optional(),
  })
  .strict();
const scroll = z
  .object({
    kind: z.literal("scroll"),
    target: ElementPointSchema,
    delta: z
      .object({ x: z.number().min(-10).max(10), y: z.number().min(-10).max(10) })
      .strict()
      .refine((v) => v.x !== 0 || v.y !== 0),
  })
  .strict();
const swipe = z
  .object({
    kind: z.literal("swipe"),
    target: ElementPointSchema,
    direction: z.enum(["up", "down", "left", "right"]),
    velocity: z.enum(["slow", "default", "fast"]).optional(),
  })
  .strict();
const drag = z
  .object({
    kind: z.literal("drag"),
    from: ElementPointSchema,
    to: ElementPointSchema,
    durationMs: z.number().int().min(50).max(30_000).optional(),
  })
  .strict();
const typedText = z
  .object({ kind: z.literal("typeText"), value: TextInputSchema })
  .strict()
  .superRefine((action, context) => {
    if (
      "literal" in action.value &&
      (action.value.literal.length === 0 || /[\p{Cc}\p{Cf}\r\n]/u.test(action.value.literal))
    )
      context.addIssue({
        code: "custom",
        path: ["value", "literal"],
        message: "Typed text must contain printable characters only.",
      });
  });
const key = z
  .object({
    kind: z.literal("pressKey"),
    key: SupportedKeySchema,
    modifiers: z
      .array(ModifierSchema)
      .max(5)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
  })
  .strict();
export const DesktopActionSchema = z.union([pointer, scroll, swipe, drag, typedText, key]);

export const AssertionSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("visible"), query: ElementQuerySchema }).strict(),
  z.object({ kind: z.literal("notVisible"), query: ElementQuerySchema }).strict(),
  z
    .object({
      kind: z.enum(["text", "value"]),
      query: ElementQuerySchema,
      expected: z.string(),
      match: z.enum(["exact", "contains"]).default("exact"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("state"),
      query: ElementQuerySchema,
      state: z
        .object({
          enabled: z.boolean().optional(),
          selected: z.boolean().optional(),
          focused: z.boolean().optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("elementOrder"),
      queries: z.array(ElementQuerySchema).min(2),
      direction: z.enum(["topToBottom", "leftToRight"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("aiVisual"), goal: z.string().min(1).max(2000), accepted: z.literal(true) })
    .strict(),
]);

export const ActionTemplateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["click", "doubleClick", "rightClick", "hover"]),
      point: RelativePointSchema.optional(),
      modifiers: z
        .array(ModifierSchema)
        .max(5)
        .refine((value) => new Set(value).size === value.length)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      point: RelativePointSchema.optional(),
      delta: z.object({ x: z.number().min(-10).max(10), y: z.number().min(-10).max(10) }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("swipe"),
      point: RelativePointSchema.optional(),
      direction: z.enum(["up", "down", "left", "right"]),
      velocity: z.enum(["slow", "default", "fast"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("drag"),
      point: RelativePointSchema.optional(),
      destination: ElementQuerySchema,
      destinationPoint: RelativePointSchema.optional(),
      durationMs: z.number().int().min(50).max(30_000).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("typeText"), value: TextInputSchema })
    .strict()
    .superRefine((action, context) => {
      if (
        "literal" in action.value &&
        (action.value.literal.length === 0 || /[\p{Cc}\p{Cf}\r\n]/u.test(action.value.literal))
      )
        context.addIssue({
          code: "custom",
          path: ["value", "literal"],
          message: "Typed text must contain printable characters only.",
        });
    }),
  z
    .object({
      kind: z.literal("pressKey"),
      key: SupportedKeySchema,
      modifiers: z
        .array(ModifierSchema)
        .max(5)
        .refine((value) => new Set(value).size === value.length)
        .optional(),
    })
    .strict(),
]);

export const ScenarioStepSchema = z
  .object({
    stepId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    window: WindowQuerySchema.optional(),
    preconditions: z.array(AssertionSpecSchema).optional(),
    target: ElementQuerySchema.optional(),
    action: ActionTemplateSchema,
    verification: z.union([
      z.object({ policy: z.literal("immediate"), assertions: z.array(AssertionSpecSchema).min(1) }).strict(),
      z.object({ policy: z.literal("deferred") }).strict(),
    ]),
  })
  .strict()
  .superRefine((step, context) => {
    const targetless = step.action.kind === "pressKey" || step.action.kind === "typeText";
    if (targetless && step.target !== undefined)
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Keyboard actions do not accept a target.",
      });
    if (!targetless && step.target === undefined)
      context.addIssue({ code: "custom", path: ["target"], message: "Element action requires a target." });
  });

export const ScenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !Array.from(value).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          }),
        "Scenario name cannot contain control characters",
      ),
    actions: z.array(ScenarioStepSchema),
    finalAssertions: z.array(AssertionSpecSchema).min(1),
  })
  .strict()
  .refine((v) => new Set(v.actions.map((s) => s.stepId)).size === v.actions.length, "stepId must be unique");

export type RelativePoint = z.infer<typeof RelativePointSchema>;
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export type AssertionSpec = z.infer<typeof AssertionSpecSchema>;
export type ActionTemplate = z.infer<typeof ActionTemplateSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
