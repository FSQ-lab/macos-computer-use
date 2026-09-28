import { describe, expect, it } from "vitest";
import {
  ActionResultSchema,
  ApplicationTargetSchema,
  DesktopActionSchema,
  ElementQuerySchema,
  EvidenceEventSchema,
  CurrentEvidenceEventSchema,
  GatewayConfigSchema,
  ProviderLifecycleDiagnosticSchema,
  RelativePointSchema,
  ScenarioSchema,
  TextInputSchema,
} from "../src/contracts/index.js";

const ref = {
  runId: "run-00000001",
  environmentId: "env-1",
  generation: 1,
  sessionId: "session-00000001",
  windowId: "window-00000001",
  observationId: "observation-00000001",
  elementId: "element-00000001",
};

describe("contracts", () => {
  it("validates lifecycle diagnostics without raw provider fields", () => {
    const diagnostic = {
      schemaVersion: 1,
      compatibility: { appium: "3.7.0", mac2: "4.3.5" },
      events: [
        {
          sequence: 1,
          recordedAt: "2026-09-26T00:00:00.000Z",
          source: "appium",
          event: "sessionCreated",
          alias: "outer-1",
          observedBeforeCleanup: true,
        },
        {
          sequence: 2,
          recordedAt: "2026-09-26T00:00:01.000Z",
          source: "appium",
          event: "unexpectedShutdown",
          cause: "newCommandTimeout",
          observedBeforeCleanup: true,
        },
      ],
      snapshot: {
        capturedAt: "2026-09-26T00:00:02.000Z",
        observedBeforeCleanup: true,
        appiumStatus: "ready",
        wdaStatus: "ready",
        activeSessionCount: 0,
        processes: { appium: true, xcodebuild: true, wda: true },
      },
      earliestTermination: {
        sequence: 2,
        source: "appium",
        event: "unexpectedShutdown",
        cause: "newCommandTimeout",
      },
    };
    expect(ProviderLifecycleDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(
      ProviderLifecycleDiagnosticSchema.safeParse({ ...diagnostic, requestBody: "secret" }).success,
    ).toBe(false);
    expect(
      ProviderLifecycleDiagnosticSchema.safeParse({
        ...diagnostic,
        events: [{ ...diagnostic.events[0], alias: "11111111-2222-4333-8444-555555555555" }],
        earliestTermination: undefined,
      }).success,
    ).toBe(false);
    expect(
      ProviderLifecycleDiagnosticSchema.safeParse({
        ...diagnostic,
        earliestTermination: { ...diagnostic.earliestTermination, sequence: 1 },
      }).success,
    ).toBe(false);
  });

  it("accepts display names while rejecting bundle IDs, paths, and patterns", () => {
    expect(ApplicationTargetSchema.parse({ name: "  Safari  " })).toEqual({ name: "Safari" });
    expect(ApplicationTargetSchema.parse({ name: "Acme.App 2" })).toEqual({ name: "Acme.App 2" });
    for (const name of [
      "com.apple.Safari",
      "/Applications/Safari.app",
      "Safari.app",
      "Saf*",
      "~Safari",
      "Safari~",
      "Safari|TextEdit",
      `Safari${String.fromCodePoint(0x202e)}`,
      "😀".repeat(201),
    ])
      expect(() => ApplicationTargetSchema.parse({ name })).toThrow();
    expect(ApplicationTargetSchema.parse({ name: "😀".repeat(200) }).name).toHaveLength(400);
  });

  it("requires typed action and operation identities in durable action facts", () => {
    const base = {
      schemaVersion: 1 as const,
      runId: "run-00000001",
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      source: "kernel" as const,
    };
    expect(
      EvidenceEventSchema.safeParse({
        ...base,
        type: "ActionPlanned",
        data: { actionId: "action-00000001", operationId: "operation-00000001", kind: "click" },
      }).success,
    ).toBe(true);
    expect(
      CurrentEvidenceEventSchema.safeParse({
        ...base,
        type: "ActionPlanned",
        data: { operationId: "operation-00000001", kind: "click" },
      }).success,
    ).toBe(false);
  });
  it("models provider facts independently", () => {
    expect(
      ActionResultSchema.parse({
        dispatch: "dispatched",
        providerOutcome: "succeeded",
        verification: "unverifiable",
        retryDisposition: "unsafe",
      }),
    ).toBeTruthy();
  });

  it("rejects identifiers from a different family", () => {
    expect(() =>
      DesktopActionSchema.parse({
        kind: "click",
        target: { element: { ...ref, elementId: "window-00000001" } },
      }),
    ).toThrow();
  });

  it("rejects absolute-coordinate action shapes", () => {
    expect(() => DesktopActionSchema.parse({ kind: "click", x: 10, y: 20 })).toThrow();
    expect(() =>
      DesktopActionSchema.parse({ kind: "drag", startX: 1, startY: 2, endX: 3, endY: 4 }),
    ).toThrow();
  });

  it("accepts element-relative points only within range", () => {
    expect(RelativePointSchema.parse({ x: 0.2, y: 0.5 })).toEqual({ x: 0.2, y: 0.5 });
    expect(() => RelativePointSchema.parse({ x: 1.1, y: 0.5 })).toThrow();
    expect(
      DesktopActionSchema.parse({ kind: "scroll", target: { element: ref }, delta: { x: 0, y: 0.5 } }),
    ).toBeTruthy();
  });

  it("requires meaningful structured queries", () => {
    expect(() => ElementQuerySchema.parse({})).toThrow();
    expect(ElementQuerySchema.parse({ role: "button", name: { exact: "Save" } })).toBeTruthy();
  });

  it("keeps secret values out of secret references", () => {
    expect(TextInputSchema.parse({ secret: { name: "LOGIN_PASSWORD", purpose: "textInput" } })).toBeTruthy();
    expect(() =>
      TextInputSchema.parse({ secret: { name: "LOGIN_PASSWORD", purpose: "textInput", value: "secret" } }),
    ).toThrow();
  });

  it("requires explicit verification and final assertions", () => {
    const scenario = {
      schemaVersion: 1,
      name: "demo",
      actions: [
        {
          stepId: "click-one",
          target: { role: "button", name: { exact: "1" } },
          action: { kind: "click" },
          verification: { policy: "deferred" },
        },
      ],
      finalAssertions: [{ kind: "text", query: { role: "text" }, expected: "1", match: "exact" }],
    };
    expect(ScenarioSchema.parse(scenario)).toBeTruthy();
    expect(() => ScenarioSchema.parse({ ...scenario, finalAssertions: [] })).toThrow();
  });

  it("rejects unsafe network and inconsistent evidence limits", () => {
    const base = {
      image: {
        buildIdentity: "fixture-build-1",
        reference: "ghcr.io/example/image",
        digest: `sha256:${"a".repeat(64)}`,
      },
      aut: { bundleId: "com.example.TestApp", window: { isMain: true } },
      timeouts: {
        runTotalMs: 7_200_000,
        imagePullMs: 1_000,
        cloneMs: 1_000,
        vmBootMs: 1_000,
        guestReadyMs: 1_000,
        appiumStartMs: 1_000,
        mac2SessionMs: 1_000,
        appReadyMs: 1_000,
        observeMs: 1_000,
        actionMs: 1_000,
        assertionMs: 1_000,
        evidenceFinalizeMs: 1_000,
        cleanupMs: 120_000,
      },
      state: { root: "/tmp/state", tempRoot: "/tmp/temp" },
      evidence: { root: "/tmp/evidence", retentionDays: 7, maxArtifactBytes: 10, maxRunBytes: 100 },
      retry: {
        imagePull: { maxAttempts: 2, backoffMs: 1 },
        readiness: { maxAttempts: 2, backoffMs: 1 },
        observation: { maxAttempts: 2, backoffMs: 1 },
      },
      network: [],
      secrets: { allowedNames: [] },
      compatibility: {
        tart: "2.35",
        appiumMajor: 3,
        appium: "3.7.0",
        mac2: "4.3.5",
        wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
        guestMacOS: "26.0",
        xcode: "26.0",
        fixtureBuild: "1",
      },
    };
    expect(GatewayConfigSchema.parse(base)).toBeTruthy();
    expect(
      GatewayConfigSchema.safeParse({
        ...base,
        timeouts: { ...base.timeouts, runTotalMs: 600_000 },
      }).success,
    ).toBe(false);
    expect(
      GatewayConfigSchema.safeParse({
        ...base,
        timeouts: { ...base.timeouts, cleanupMs: 60_000 },
      }).success,
    ).toBe(false);
    expect(
      GatewayConfigSchema.safeParse({ ...base, image: { ...base.image, buildIdentity: undefined } }).success,
    ).toBe(false);
    expect(
      GatewayConfigSchema.safeParse({ ...base, image: { ...base.image, buildIdentity: base.image.digest } })
        .success,
    ).toBe(false);
    expect(() =>
      GatewayConfigSchema.parse({ ...base, network: [{ cidr: "0.0.0.0/0", ports: [443], protocol: "tcp" }] }),
    ).toThrow();
  });
});
