import { describe, expect, it } from "vitest";
import { StageTimeoutError, retrySafe, withStageSignal } from "../src/kernel/index.js";

describe("withStageSignal", () => {
  it("uses the injected scheduler for deadlines and backoff", async () => {
    let scheduled = 0;
    const scheduler = {
      schedule: (callback: () => void) => {
        scheduled += 1;
        queueMicrotask(callback);
        return () => undefined;
      },
      sleep: async () => {
        scheduled += 1;
      },
    };
    await expect(
      withStageSignal(5, new AbortController().signal, () => new Promise<never>(() => undefined), scheduler),
    ).rejects.toBeInstanceOf(StageTimeoutError);
    let attempts = 0;
    await retrySafe(
      { maxAttempts: 2, backoffMs: 10 },
      new AbortController().signal,
      async () => ++attempts,
      (value) => value < 2,
      scheduler,
    );
    expect(scheduled).toBe(2);
  });
  it("bounds a provider that ignores cancellation", async () => {
    let providerSignal: AbortSignal | undefined;
    await expect(
      withStageSignal(5, new AbortController().signal, (signal) => {
        providerSignal = signal;
        return new Promise<never>(() => undefined);
      }),
    ).rejects.toBeInstanceOf(StageTimeoutError);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("does not start an operation after parent cancellation", async () => {
    const parent = new AbortController();
    parent.abort(new Error("cancelled"));
    let started = false;
    await expect(
      withStageSignal(100, parent.signal, async () => {
        started = true;
      }),
    ).rejects.toThrow("cancelled");
    expect(started).toBe(false);
  });
  it("aborts a stage when its budget expires", async () => {
    await expect(
      withStageSignal(5, new AbortController().signal, async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw signal.reason;
      }),
    ).rejects.toBeInstanceOf(StageTimeoutError);
  });

  it("propagates parent cancellation", async () => {
    const parent = new AbortController();
    const task = withStageSignal(1000, parent.signal, async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return signal.aborted;
    });
    parent.abort();
    await expect(task).resolves.toBe(true);
  });

  it("retries only while the caller classifies results as safe", async () => {
    let attempts = 0;
    const result = await retrySafe(
      { maxAttempts: 3, backoffMs: 0 },
      new AbortController().signal,
      async () => ++attempts,
      (value) => value < 3,
    );
    expect(result).toBe(3);
    expect(attempts).toBe(3);
  });
});
