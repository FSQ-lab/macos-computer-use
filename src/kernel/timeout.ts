export class StageTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stage exceeded ${String(timeoutMs)} ms.`);
  }
}

export const withStageSignal = async <T>(
  timeoutMs: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new StageTimeoutError(timeoutMs));
  }, timeoutMs);
  try {
    const result = await operation(controller.signal);
    return result;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abortFromParent);
  }
};

export const retrySafe = async <T>(
  policy: { maxAttempts: number; backoffMs: number },
  signal: AbortSignal,
  operation: (attempt: number) => Promise<T>,
  shouldRetry: (value: T) => boolean,
): Promise<T> => {
  let last: T | undefined;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal.aborted) throw signal.reason;
    last = await operation(attempt);
    if (!shouldRetry(last) || attempt === policy.maxAttempts) return last;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, policy.backoffMs);
      const abort = (): void => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Retry backoff was cancelled."));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  if (last === undefined) throw new Error("Retry policy did not execute an attempt.");
  return last;
};
