export interface Clock {
  wallNow(): Date;
  monotonicMs(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}
export type { IdGenerator } from "../contracts/index.js";
export interface Hasher {
  sha256(input: string | Uint8Array): string;
}
export interface SecretResolver {
  resolve(name: string): string | undefined;
}
export type { EventHook as KernelHook } from "../contracts/index.js";
