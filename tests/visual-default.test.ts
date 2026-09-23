import { describe, expect, it } from "vitest";
import { Mac2DesktopAdapter } from "../src/adapters/mac2/index.js";
import { ObservationSchema, VisualEvaluationSchema } from "../src/contracts/index.js";

describe("visual opt-in boundary", () => {
  it("is disabled without an injected evaluator", async () => {
    const observation = ObservationSchema.parse({
      runId: "run-00000001",
      environmentId: "env",
      generation: 1,
      sessionId: "session-00000001",
      windowId: "window-00000001",
      observationId: "observation-00000001",
      capturedAt: "2026-09-22T00:00:00.000Z",
      screenshot: { artifactId: "artifact-00000001", sha256: "a".repeat(64) },
      uiSnapshot: { artifactId: "artifact-00000002", sha256: "b".repeat(64) },
      coverage: "complete",
      elements: [],
    });
    const result = await new Mac2DesktopAdapter().evaluate(
      { kind: "aiVisual", accepted: true, goal: "Check window" },
      observation,
    );
    expect(result.ok && result.value.status).toBe("unverifiable");
  });
  it("rejects unrecognized status and additional response fields", () => {
    expect(VisualEvaluationSchema.safeParse({ status: "confirmed", reason: "ok" }).success).toBe(false);
    expect(
      VisualEvaluationSchema.safeParse({ status: "passed", reason: "ok", providerReceipt: true }).success,
    ).toBe(false);
    expect(
      () =>
        new Mac2DesktopAdapter(fetch, {
          model: "bad model\n",
          evaluate: async () => ({ status: "passed", reason: "ok" }),
        }),
    ).toThrow();
  });
});
