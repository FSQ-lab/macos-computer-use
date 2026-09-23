export class StageTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stage exceeded ${String(timeoutMs)} ms.`);
  }
}

export const withStageSignal = async <T>(
  timeoutMs: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
  clock: { schedule(callback: () => void, delayMs: number): () => void } = {
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  },
  drainAfterAbort = false,
): Promise<T> => {
  if (parent.aborted) throw parent.reason;
  if (timeoutMs <= 0) throw new StageTimeoutError(timeoutMs);
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", abortFromParent, { once: true });
  let cancelTimer: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    cancelTimer = clock.schedule(() => {
      const error = new StageTimeoutError(timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  const work = operation(controller.signal);
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (drainAfterAbort && controller.signal.aborted) await work.catch(() => undefined);
    throw error;
  } finally {
    cancelTimer?.();
    parent.removeEventListener("abort", abortFromParent);
  }
};

export const retrySafe = async <T>(
  policy: { maxAttempts: number; backoffMs: number },
  signal: AbortSignal,
  operation: (attempt: number) => Promise<T>,
  shouldRetry: (value: T) => boolean,
  clock: { sleep(delayMs: number, signal: AbortSignal): Promise<void> } = {
    sleep: (delayMs, waitSignal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        waitSignal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Retry backoff was cancelled."));
          },
          { once: true },
        );
      }),
  },
): Promise<T> => {
  let last: T | undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal.aborted) throw signal.reason;
    last = await operation(attempt);
    if (!shouldRetry(last) || attempt === policy.maxAttempts) return last;
    await clock.sleep(policy.backoffMs, signal);
  }
  if (last === undefined) throw new Error("Retry policy did not execute an attempt.");
  return last;
};
