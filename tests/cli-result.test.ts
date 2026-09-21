import { describe, expect, it } from "vitest";
import { renderHuman, runExitCode } from "../src/cli/result-mapping.js";
import { err, ok } from "../src/contracts/index.js";

describe("CLI result mapping", () => {
  it.each([
    [{ verdict: "passed", evidence: "complete", cleanup: "completed" }, 0],
    [{ verdict: "failed", evidence: "complete", cleanup: "completed" }, 10],
    [{ verdict: "inconclusive", evidence: "complete", cleanup: "completed" }, 11],
    [{ verdict: "passed", evidence: "incomplete", cleanup: "completed" }, 12],
    [{ verdict: "passed", evidence: "complete", cleanup: "failed" }, 13],
    [{ verdict: "passed", evidence: "incomplete", cleanup: "failed" }, 14],
  ] as const)("maps %j to %i", (result, code) => {
    expect(runExitCode(ok({ result }))).toBe(code);
  });

  it("renders a concise human result without dumping JSON", () => {
    expect(
      renderHuman(ok({ result: { verdict: "passed", evidence: "complete", cleanup: "completed" } })),
    ).toBe("Run passed; Evidence complete; cleanup completed.");
    expect(
      renderHuman(err({ code: "GatewayBusy", phase: "vm", message: "busy", retryDisposition: "safe" })),
    ).toBe("Error GatewayBusy: busy");
  });
});
