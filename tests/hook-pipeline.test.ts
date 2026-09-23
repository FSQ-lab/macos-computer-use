import { resolve } from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ok, type EvidencePort, type RunId } from "../src/contracts/index.js";
import { deliverHooks } from "../src/kernel/hook-pipeline.js";
import { WorkerEventHook } from "../src/client/worker-hook.js";
import { SystemClock } from "../src/client/runtime.js";

describe("deliverHooks", () => {
  it("records failure and returns after a noncooperative Hook timeout", async () => {
    const appended: string[] = [];
    const evidence = {
      append: async (event: { type: string }) => {
        appended.push(event.type);
        return ok(undefined);
      },
    } as unknown as EvidencePort;
    const work = deliverHooks({
      event: {
        schemaVersion: 1,
        runId: "run-00000001" as RunId,
        sequence: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        elapsedMs: 0,
        type: "RunStarted",
        source: "kernel",
        data: { mode: "interactive" },
      },
      hooks: [new WorkerEventHook({ name: "stuck", modulePath: resolve("tests/fixtures/stuck-hook.mjs") })],
      evidence,
      artifacts: [],
      sequence: 1,
      startedMono: 0,
      clock: new SystemClock(),
      signal: new AbortController().signal,
    });
    await expect(work).resolves.toEqual({ ok: true, value: 2 });
    expect(appended).toEqual(["HookFailed"]);
  }, 10_000);

  it("terminates Worker authority before a timed-out Hook can perform late work", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "mcu-hook-worker-"));
    const sentinel = resolve(root, "late.txt");
    process.env.MCU_HOOK_SENTINEL = sentinel;
    try {
      const evidence = { append: async () => ok(undefined) } as unknown as EvidencePort;
      await deliverHooks({
        event: {
          schemaVersion: 1,
          runId: "run-00000001" as RunId,
          sequence: 1,
          recordedAt: "2026-01-01T00:00:00.000Z",
          elapsedMs: 0,
          type: "RunStarted",
          source: "kernel",
          data: { mode: "interactive" },
        },
        hooks: [
          new WorkerEventHook({
            name: "late",
            modulePath: resolve("tests/fixtures/late-write-hook.mjs"),
          }),
        ],
        evidence,
        artifacts: [],
        sequence: 1,
        startedMono: 0,
        clock: new SystemClock(),
        signal: new AbortController().signal,
      });
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 750));
      await expect(access(sentinel)).rejects.toThrow();
    } finally {
      delete process.env.MCU_HOOK_SENTINEL;
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
