import { z } from "zod";

const bundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const executableSuffixPattern = /\.(?:app|appex|xpc|framework|dylib|so|bin|sh|command|exe)$/i;

export const ApplicationTargetSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .refine((value) => Array.from(value).length <= 200, "Application name is too long.")
      .refine((value) => !/\p{C}/u.test(value), "Application name has control characters.")
      .refine((value) => !/[/\\]/u.test(value), "Application name cannot be a path.")
      .refine((value) => value !== "." && value !== "..", "Application name is invalid.")
      .refine((value) => !bundleIdPattern.test(value), "Bundle IDs are not accepted.")
      .refine((value) => !executableSuffixPattern.test(value), "Application paths are not accepted.")
      .refine((value) => !/[*?{}[\]]/u.test(value), "Application name cannot be a pattern.")
      .refine((value) => !/[~|]/u.test(value), "Application name cannot use fuzzy or alternate syntax.")
      .transform((value) => value.normalize("NFC")),
  })
  .strict();

export const ApplicationDescriptorSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    bundleId: z.string().regex(bundleIdPattern),
    version: z.string().trim().min(1).max(100).optional(),
    build: z.string().trim().min(1).max(100).optional(),
    location: z.enum(["system", "user"]),
  })
  .strict();

export type ApplicationTarget = z.infer<typeof ApplicationTargetSchema>;
export type ApplicationDescriptor = z.infer<typeof ApplicationDescriptorSchema>;
