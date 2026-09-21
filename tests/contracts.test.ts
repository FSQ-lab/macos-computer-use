import { describe, expect, it } from "vitest";
import {
  ActionResultSchema,
  DesktopActionSchema,
  ElementQuerySchema,
  GatewayConfigSchema,
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
      image: { reference: "ghcr.io/example/image", digest: `sha256:${"a".repeat(64)}` },
      aut: { bundleId: "com.example.TestApp", window: { isMain: true } },
      timeouts: {
        runTotalMs: 100_000,
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
        cleanupMs: 1_000,
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
        mac2: "4.3.1",
        guestMacOS: "26.0",
        xcode: "26.0",
        fixtureBuild: "1",
      },
    };
    expect(GatewayConfigSchema.parse(base)).toBeTruthy();
    expect(() =>
      GatewayConfigSchema.parse({ ...base, network: [{ cidr: "0.0.0.0/0", ports: [443], protocol: "tcp" }] }),
    ).toThrow();
  });
});
