import { describe, expect, it } from "vitest";
import { EnvironmentState } from "../src/kernel/index.js";
import type { LeaseId } from "../src/contracts/index.js";

describe("EnvironmentState", () => {
  it("requires four fresh readiness layers and invalidates state on reconstruction", () => {
    const state = new EnvironmentState("lease-00000001" as LeaseId, 100);
    for (const layer of ["vm", "guest", "driver", "app"] as const) state.recordReady(layer, 10, 20);
    state.activate(20);
    state.requireLease("lease-00000001" as LeaseId, 20);
    state.reconstruct();
    expect(state.generation).toBe(2);
    expect(() => state.activate(20)).toThrow();
  });
});
