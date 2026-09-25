import { z } from "zod";
import { WindowQuerySchema } from "./observation.js";

export const TimeoutConfigSchema = z
  .object({
    runTotalMs: z.literal(7_200_000),
    imagePullMs: z.number().int().positive(),
    cloneMs: z.number().int().positive(),
    vmBootMs: z.number().int().positive(),
    guestReadyMs: z.number().int().positive(),
    appiumStartMs: z.number().int().positive(),
    mac2SessionMs: z.number().int().positive(),
    appReadyMs: z.number().int().positive(),
    observeMs: z.number().int().positive(),
    actionMs: z.number().int().positive(),
    assertionMs: z.number().int().positive(),
    evidenceFinalizeMs: z.number().int().positive(),
    cleanupMs: z.literal(120_000),
  })
  .strict();

export const NetworkRuleSchema = z
  .object({
    cidr: z
      .string()
      .regex(/^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\/(?:[1-9]|[12]\d|3[0-2])$/),
    ports: z.array(z.number().int().min(1).max(65535)).min(1).max(64),
    protocol: z.enum(["tcp", "udp"]),
  })
  .strict();

export const GatewayConfigSchema = z
  .object({
    image: z
      .object({
        reference: z
          .string()
          .regex(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/)
          .refine((value) => !value.includes("..") && !value.startsWith("http")),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        buildIdentity: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      })
      .strict(),
    aut: z
      .object({
        bundleId: z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
        window: z.lazy(() => WindowQuerySchema),
        arguments: z.array(z.string()).max(64).optional(),
        allowedEnvironmentSecrets: z.array(z.string()).optional(),
      })
      .strict(),
    timeouts: TimeoutConfigSchema,
    state: z.object({ root: z.string().min(1), tempRoot: z.string().min(1) }).strict(),
    evidence: z
      .object({
        root: z.string().min(1),
        retentionDays: z.number().int().min(1).max(3650).nullable().default(7),
        maxArtifactBytes: z.number().int().positive(),
        maxRunBytes: z.number().int().positive(),
      })
      .strict(),
    retry: z
      .object({
        imagePull: z
          .object({
            maxAttempts: z.number().int().min(1).max(5),
            backoffMs: z.number().int().min(0).max(60_000),
          })
          .strict(),
        readiness: z
          .object({
            maxAttempts: z.number().int().min(1).max(20),
            backoffMs: z.number().int().min(0).max(60_000),
          })
          .strict(),
        observation: z
          .object({
            maxAttempts: z.number().int().min(1).max(5),
            backoffMs: z.number().int().min(0).max(60_000),
          })
          .strict(),
      })
      .strict()
      .default({
        imagePull: { maxAttempts: 2, backoffMs: 500 },
        readiness: { maxAttempts: 10, backoffMs: 1000 },
        observation: { maxAttempts: 5, backoffMs: 3_000 },
      }),
    network: z.array(NetworkRuleSchema).default([]),
    secrets: z
      .object({ allowedNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/)) })
      .strict()
      .default({ allowedNames: [] }),
    compatibility: z
      .object({
        tart: z.literal("2.35").default("2.35"),
        appiumMajor: z.literal(3).default(3),
        appium: z.literal("3.7.0").default("3.7.0"),
        mac2: z.literal("4.3.5").default("4.3.5"),
        wdaSha256: z
          .literal("094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733")
          .default("094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733"),
        guestMacOS: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
        xcode: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
        fixtureBuild: z.string().regex(/^[0-9A-Za-z._-]+$/),
      })
      .strict()
      .default({
        tart: "2.35",
        appiumMajor: 3,
        appium: "3.7.0",
        mac2: "4.3.5",
        wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
        guestMacOS: "26.0",
        xcode: "26.0",
        fixtureBuild: "1",
      }),
  })
  .strict()
  .superRefine((v, ctx) => {
    const phases = Object.entries(v.timeouts).filter(([k]) => k !== "runTotalMs");
    for (const [key, value] of phases)
      if (value > v.timeouts.runTotalMs && key !== "cleanupMs")
        ctx.addIssue({ code: "custom", path: ["timeouts", key], message: "stage timeout exceeds run total" });
    if (v.evidence.maxArtifactBytes > v.evidence.maxRunBytes)
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "artifact limit exceeds run limit" });
    if (v.network.length > 0)
      ctx.addIssue({
        code: "custom",
        path: ["network"],
        message: "Nonempty network rules are unsupported in the shared-network profile.",
      });
  });

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type TimeoutConfig = z.infer<typeof TimeoutConfigSchema>;
