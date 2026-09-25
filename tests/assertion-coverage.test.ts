import { describe, expect, it } from "vitest";
import { Mac2DesktopAdapter } from "../src/adapters/mac2/index.js";
import { ObservationSchema } from "../src/contracts/index.js";

const observation = (elements: unknown[], coverage = "complete") =>
  ObservationSchema.parse({
    runId: "run-00000001",
    environmentId: "env-test",
    generation: 1,
    sessionId: "session-00000001",
    windowId: "window-00000001",
    observationId: "observation-00000001",
    capturedAt: "2026-09-22T00:00:00.000Z",
    screenshotScope: "window",
    screenshot: { artifactId: "artifact-00000001", sha256: "a".repeat(64) },
    uiSnapshot: { artifactId: "artifact-00000002", sha256: "b".repeat(64) },
    coverage,
    elements,
  });
const element = { elementId: "element-00000001", role: "button", identifier: "target" };

describe("independent assertion evidence", () => {
  it("returns bounded candidates and continuation without choosing an ambiguous target", () => {
    const adapter = new Mac2DesktopAdapter();
    const snapshot = observation([element, { ...element, elementId: "element-00000002" }]);
    const page = adapter.queryPage(snapshot, { role: "button" }, 0, 1);
    expect(page.ok && page.value).toMatchObject({ status: "ambiguous", count: 2, nextOffset: 1 });
    expect(page.ok && page.value.candidates).toHaveLength(1);
    expect(page.ok && page.value.reference).toBeUndefined();
    const incomplete = adapter.queryPage(observation([element], "partial"), { role: "button" }, 0, 10);
    expect(incomplete.ok && incomplete.value.status).toBe("incomplete");
  });
  it("does not equate presence with known visibility", async () => {
    const result = await new Mac2DesktopAdapter().evaluate(
      { kind: "visible", query: { identifier: "target" } },
      observation([element]),
    );
    expect(result.ok && result.value.status).toBe("unverifiable");
  });
  it("accepts explicit invisibility on a complete snapshot", async () => {
    const result = await new Mac2DesktopAdapter().evaluate(
      { kind: "notVisible", query: { identifier: "target" } },
      observation([{ ...element, visible: false }]),
    );
    expect(result.ok && result.value.status).toBe("passed");
  });
  it("does not treat unknown text as an empty string", async () => {
    const result = await new Mac2DesktopAdapter().evaluate(
      { kind: "value", query: { identifier: "target" }, expected: "", match: "exact" },
      observation([element]),
    );
    expect(result.ok && result.value.status).toBe("unverifiable");
  });
  it("does not claim uniqueness or absence from incomplete coverage", async () => {
    const adapter = new Mac2DesktopAdapter();
    const snapshot = observation([element], "truncated");
    expect(adapter.query(snapshot, { identifier: "target" }).ok).toBe(false);
    const result = await adapter.evaluate({ kind: "visible", query: { identifier: "missing" } }, snapshot);
    expect(result.ok && result.value.status).toBe("unverifiable");
  });
});
