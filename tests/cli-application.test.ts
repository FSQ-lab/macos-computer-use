import { describe, expect, it, vi } from "vitest";
import { executeCliInvocation } from "../src/cli/application.js";
import { err, ok, type RunManifest, type RunId, type Scenario } from "../src/contracts/index.js";
import type { MacOSComputerUseClient } from "../src/client/client.js";

const result = { verdict: "passed" as const, evidence: "complete" as const, cleanup: "completed" as const };
const client = (): MacOSComputerUseClient => ({
  run: vi.fn(),
  runScenario: vi.fn(async () => ok({ runId: "run-00000001" as RunId, result })),
  loadScenario: vi.fn(async () =>
    ok({
      schemaVersion: 1,
      name: "test",
      actions: [],
      finalAssertions: [{ kind: "visible", query: { role: "window" } }],
    } as Scenario),
  ),
  doctor: vi.fn(async () => ok({ checks: [{ name: "host", status: "passed" as const, detail: "ok" }] })),
  recover: vi.fn(async () => ok({ status: "clean" as const })),
  listRuns: vi.fn(async () => ok([])),
  showRun: vi.fn(async () => ok({} as RunManifest)),
  exportEvidence: vi.fn(async () => ok({ exported: true as const })),
  applyRetention: vi.fn(async () => ok([])),
  listRetentionFailures: vi.fn(async () => ok([])),
});

describe("CLI application routing", () => {
  it.each([
    [{ command: "doctor", deep: true } as const, 0],
    [{ command: "recover" } as const, 0],
    [{ command: "runs-list" } as const, 0],
    [{ command: "runs-show", runId: "run-00000001" } as const, 0],
    [{ command: "evidence-export", runId: "run-00000001", destination: "out" } as const, 0],
    [{ command: "run", scenarioPath: "scenario.json" } as const, 0],
  ])("routes %j", async (invocation, exitCode) => {
    expect((await executeCliInvocation(invocation, client(), new AbortController().signal)).exitCode).toBe(
      exitCode,
    );
  });

  it("maps busy recovery and corrupt Evidence", async () => {
    const busy = client();
    busy.recover = vi.fn(async () =>
      err({ code: "GatewayBusy", phase: "vm", message: "busy", retryDisposition: "safe" }),
    );
    expect(
      (await executeCliInvocation({ command: "recover" }, busy, new AbortController().signal)).exitCode,
    ).toBe(3);
    const corrupt = client();
    corrupt.showRun = vi.fn(async () =>
      err({
        code: "EvidenceCorrupted",
        phase: "evidence",
        message: "bad",
        retryDisposition: "notApplicable",
      }),
    );
    expect(
      (
        await executeCliInvocation(
          { command: "runs-show", runId: "run-00000001" },
          corrupt,
          new AbortController().signal,
        )
      ).exitCode,
    ).toBe(20);
  });

  it.each([
    [{ verdict: "failed", evidence: "complete", cleanup: "completed" } as const, 10],
    [{ verdict: "inconclusive", evidence: "complete", cleanup: "completed" } as const, 11],
    [{ verdict: "passed", evidence: "incomplete", cleanup: "completed" } as const, 12],
    [{ verdict: "passed", evidence: "complete", cleanup: "failed" } as const, 13],
    [{ verdict: "failed", evidence: "incomplete", cleanup: "failed" } as const, 14],
  ])("maps Run result %j to exit %i", async (runResult, expected) => {
    const fake = client();
    fake.runScenario = async () => ok({ runId: "run-00000001" as RunId, result: runResult });
    expect(
      (
        await executeCliInvocation(
          { command: "run", scenarioPath: "scenario.json" },
          fake,
          new AbortController().signal,
        )
      ).exitCode,
    ).toBe(expected);
  });

  it("passes the interrupt signal to run and doctor routes", async () => {
    const fake = client();
    let runSignal: AbortSignal | undefined;
    let doctorSignal: AbortSignal | undefined;
    fake.runScenario = async (_scenario, options) => {
      runSignal = options?.signal;
      return ok({ runId: "run-00000001" as RunId, result });
    };
    fake.doctor = async (options) => {
      doctorSignal = options?.signal;
      return ok({ checks: [] });
    };
    const controller = new AbortController();
    controller.abort();
    await executeCliInvocation({ command: "run", scenarioPath: "scenario.json" }, fake, controller.signal);
    expect(runSignal).toBe(controller.signal);
    await executeCliInvocation({ command: "doctor", deep: true }, fake, controller.signal);
    expect(doctorSignal).toBe(controller.signal);
  });
});
