import { createHash, randomBytes } from "node:crypto";
import type { Clock, Hasher, IdGenerator, SecretResolver } from "../kernel/index.js";

export class SystemClock implements Clock {
  wallNow(): Date {
    return new Date();
  }
  monotonicMs(): number {
    return performance.now();
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
export class EnvironmentSecretResolver implements SecretResolver {
  resolve(name: string): string | undefined {
    return process.env[name];
  }
}
