import { spawn } from "node:child_process";

export type ProcessResult = { code: number | null; stdout: string; stderr: string; aborted: boolean };

export const runProcess = (
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  maxBytes = 1_000_000,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let aborted = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= maxBytes) stdout.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= maxBytes) stderr.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        aborted,
      }),
    );
    const abort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
