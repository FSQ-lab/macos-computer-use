import { describe, expect, it } from "vitest";
import { runProcess } from "../src/adapters/tart/process-runner.js";

describe("bounded process runner", () => {
  it("normalizes missing executables", async () => {
    const result = await runProcess("/nonexistent/mcu-provider", [], new AbortController().signal);
    expect(result.code).toBeNull();
    expect(result.stderr).toBe("");
  });
  it("does not run a pre-cancelled process", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess(process.execPath, ["-e", "console.log('unexpected')"], controller.signal);
    expect(result).toEqual({ code: null, stdout: "", stderr: "", aborted: true });
  });
  it("rejects truncated output as a successful provider response", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "console.log('x'.repeat(10000))"],
      new AbortController().signal,
      10,
    );
    expect(result.code).toBeNull();
    expect(result.stdout).toBe("");
  });
  it("escalates cancellation of a process that ignores SIGTERM", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const result = await runProcess(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        controller.signal,
      );
      expect(result.aborted).toBe(true);
      expect(result.code).toBeNull();
    } finally {
      clearTimeout(timer);
    }
  }, 5000);
});
