import { spawn } from "node:child_process";

export type ProcessResult = { code: number | null; stdout: string; stderr: string; aborted: boolean };

export const runProcess = (
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  maxBytes = 1_000_000,
): Promise<ProcessResult> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ code: null, stdout: "", stderr: "", aborted: true });
      return;
    }
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let aborted = false;
    let overflow = false;
    let finished = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      clearTimeout(escalation);
      clearTimeout(killDeadline);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code: overflow ? null : code,
        stdout: overflow ? "" : Buffer.concat(stdout).toString("utf8"),
        stderr: overflow ? "" : Buffer.concat(stderr).toString("utf8"),
        aborted,
      });
    };
    const kill = (): void => {
      child.kill("SIGKILL");
      killDeadline ??= setTimeout(() => {
        child.unref();
        finish(null);
      }, 1000);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= maxBytes) stdout.push(chunk);
      else {
        overflow = true;
        kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= maxBytes) stderr.push(chunk);
      else {
        overflow = true;
        kill();
      }
    });
    const abort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
      escalation ??= setTimeout(kill, 1000);
    };
    child.once("error", () => finish(null));
    child.once("close", finish);
    signal.addEventListener("abort", abort, { once: true });
  });
