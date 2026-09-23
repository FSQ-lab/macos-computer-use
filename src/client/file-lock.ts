import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";
import { err, ok, type OperationResult } from "../contracts/index.js";
import type { GatewayLock } from "../kernel/index.js";

export class FileGatewayLock implements GatewayLock {
  static userLockPath(): string {
    return join(homedir(), "Library", "Application Support", "macos-computer-use", "user-gateway.lock");
  }
  constructor(private readonly path: string) {}
  async acquire(): Promise<OperationResult<() => Promise<void>>> {
    const globalPath = FileGatewayLock.userLockPath();
    const global = await this.#acquirePath(globalPath).catch(() =>
      err<() => Promise<void>>({
        code: "RecoveryRequired",
        phase: "vm",
        message: "User lock storage is unavailable.",
        retryDisposition: "notApplicable",
      }),
    );
    if (!global.ok) return global;
    if (this.path === globalPath) return global;
    try {
      const local = await this.#acquirePath(this.path);
      if (!local.ok) {
        await global.value();
        return local;
      }
      return ok(async () => {
        try {
          await local.value();
        } finally {
          await global.value();
        }
      });
    } catch {
      await global.value();
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Gateway lock storage is unavailable.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async #acquirePath(path: string): Promise<OperationResult<() => Promise<void>>> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn("/usr/bin/shlock", ["-p", String(process.pid), "-f", path], {
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
      await rm(path, { force: true });
    });
  }
}
