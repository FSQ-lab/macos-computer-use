export interface Clock {
  wallNow(): Date;
  monotonicMs(): number;
}
export interface IdGenerator {
  next(prefix: string): string;
}
export interface Hasher {
  sha256(input: string | Uint8Array): string;
}
export interface SecretResolver {
  resolve(name: string): string | undefined;
}
export interface KernelHook {
  readonly name: string;
  onEvent(event: EvidenceEvent, signal: AbortSignal): Promise<readonly { type: string; bytes: Uint8Array }[]>;
}
import type { EvidenceEvent } from "../contracts/index.js";
