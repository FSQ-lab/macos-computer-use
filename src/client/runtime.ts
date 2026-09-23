import { createHash, randomBytes } from "node:crypto";
import type { Clock, Hasher, IdGenerator, SecretResolver } from "../kernel/index.js";

export class SystemClock implements Clock {
  wallNow(): Date {
    return new Date();
  }
  monotonicMs(): number {
    return performance.now();
  }
  schedule(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  }
  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Sleep cancelled."));
        return;
      }
      const cancel = this.schedule(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      const abort = (): void => {
        cancel();
        signal.removeEventListener("abort", abort);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Sleep cancelled."));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
export class SecureIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return prefix + "-" + Date.now().toString(36).padStart(10, "0") + "-" + randomBytes(10).toString("hex");
  }
}
export class Sha256Hasher implements Hasher {
  sha256(input: string | Uint8Array): string {
    return createHash("sha256").update(input).digest("hex");
  }
}
import type { SensitiveDataPolicy } from "../contracts/index.js";
export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly sensitive?: SensitiveDataPolicy) {}
  resolve(name: string): string | undefined {
    const value = process.env[name];
    if (value !== undefined) this.sensitive?.remember(value);
    return value;
  }
}
