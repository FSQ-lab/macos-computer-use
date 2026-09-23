import { z } from "zod";
import type { EvidenceEvent } from "./evidence.js";

export const HookNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);
export const HookContributionSchema = z
  .object({
    type: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
    bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength <= 1_000_000),
  })
  .strict();
export const HookContributionsSchema = z.array(HookContributionSchema).max(16);
export const HookDescriptorSchema = z
  .object({
    name: HookNameSchema,
    modulePath: z
      .string()
      .min(1)
      .refine((value) => value.startsWith("/"), "Hook module path must be absolute."),
  })
  .strict();
export type HookDescriptor = z.infer<typeof HookDescriptorSchema>;
export interface EventHook {
  readonly name: string;
  deliver(event: EvidenceEvent, signal: AbortSignal): Promise<unknown>;
}
