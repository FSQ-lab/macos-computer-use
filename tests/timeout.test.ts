import { describe, expect, it } from "vitest";
import { StageTimeoutError, retrySafe, withStageSignal } from "../src/kernel/index.js";

describe("withStageSignal", () => {
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
