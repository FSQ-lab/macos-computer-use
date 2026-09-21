import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type OperationResult } from "../contracts/index.js";
import type { GatewayLock } from "../kernel/index.js";

export class FileGatewayLock implements GatewayLock {
  constructor(private readonly path: string) {}
  async acquire(): Promise<OperationResult<() => Promise<void>>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn("/usr/bin/shlock", ["-p", String(process.pid), "-f", this.path], {
        stdio: "ignore",
      });
      child.once("error", () => resolve(null));
      child.once("close", resolve);
    });
    if (code !== 0)
      return err({
        code: "GatewayBusy",
        phase: "vm",
        message: "Another Gateway operation holds the user lock.",
        retryDisposition: "safe",
      });
    return ok(async () => {
      await rm(this.path, { force: true });
    });
  }
}
