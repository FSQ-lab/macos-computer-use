import { expect, it, vi } from "vitest";
import { appiumLifecycleFilterProgram, TartExecGuestAdapter } from "../src/adapters/guest/index.js";
import { ProviderLifecycleDiagnosticSchema } from "../src/contracts/index.js";
import { runProcess } from "../src/adapters/guest/process-runner.js";
vi.mock("../src/adapters/guest/process-runner.js", () => ({ runProcess: vi.fn() }));
const ids = { next: (prefix: string) => `${prefix}-00000001` };
it("does not turn an unconfirmed termination into successful cleanup", async () => {
  vi.mocked(runProcess).mockResolvedValue({ code: 24, stdout: "", stderr: "", aborted: false });
  const result = await new TartExecGuestAdapter("tart", undefined, undefined, ids).stopAppium(
    "run-00000001",
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  const command = vi.mocked(runProcess).mock.calls[0]?.[1].at(-1) ?? "";
  expect(command).toContain("kill -0");
  expect(command).not.toContain("pkill");
});
it("starts Appium through a streaming lifecycle allowlist without raw log files", async () => {
  vi.mocked(runProcess).mockClear();
  vi.mocked(runProcess)
    .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "", aborted: false })
    .mockResolvedValueOnce({ code: 0, stdout: "127.0.0.1\n", stderr: "", aborted: false });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ value: { ready: true } }), { status: 200 }));
  try {
    const result = await new TartExecGuestAdapter("tart", undefined, undefined, ids).startAppium(
      "run-00000001",
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const command = vi.mocked(runProcess).mock.calls[0]?.[1].at(-1) ?? "";
    expect(command).toContain("lifecycle.jsonl");
    expect(command).toContain("appium.pipe");
    expect(command).toContain("--log-level debug");
    expect(command).not.toContain("appium.log");
    expect(command).not.toContain("> /dev/null 2>&1");
  } finally {
    fetcher.mockRestore();
  }
});

it("uses a finite lifecycle allowlist with aliases and no raw payload projection", () => {
  expect(appiumLifecycleFilterProgram).toContain("sessionCreated");
  expect(appiumLifecycleFilterProgram).toContain("sessionDeleteRequested");
  expect(appiumLifecycleFilterProgram).toContain("sessionReplaced");
  expect(appiumLifecycleFilterProgram).toContain("unexpectedShutdown");
  expect(appiumLifecycleFilterProgram).toContain("processExited");
  expect(appiumLifecycleFilterProgram).toContain("outer-");
  expect(appiumLifecycleFilterProgram).toContain("inner-");
  expect(appiumLifecycleFilterProgram).not.toContain("requestBody");
  expect(appiumLifecycleFilterProgram).not.toContain("userText");
});

it("projects real Appium lifecycle lines while dropping raw identifiers and unknown content", () => {
  const outer = "11111111-2222-4333-8444-555555555555";
  const inner = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const input = [
    `[Mac2Driver] Session created with session id: ${outer}`,
    "[WD Proxy] Proxying [POST /session] to the downstream server",
    `[WD Proxy] Got response with status 200: {"value":{"sessionId":"${inner}"}}`,
    "user text and secret=must-not-survive",
    `[Mac2Driver] Calling AppiumDriver.deleteSession() with args: ["${outer}"]`,
  ].join("\n");
  const output = execFileSync("/usr/bin/awk", [appiumLifecycleFilterProgram], {
    encoding: "utf8",
    input,
  });
  const events = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events).toMatchObject([
    { event: "sessionCreated", alias: "outer-1" },
    { event: "sessionCreated", alias: "inner-1" },
    { event: "sessionDeleteRequested", alias: "outer-1" },
  ]);
  expect(output).not.toContain(outer);
  expect(output).not.toContain(inner);
  expect(output).not.toContain("must-not-survive");
});

it("attributes replacement, unexpected shutdown, and provider exit in source order", () => {
  const outer = "11111111-2222-4333-8444-555555555555";
  const firstInner = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const secondInner = "99999999-8888-4777-8666-555555555555";
  const input = [
    `[Mac2Driver] Session created with session id: ${outer}`,
    "[WD Proxy] Proxying [POST /session] to the downstream server",
    `[WD Proxy] Got response with status 200: {"value":{"sessionId":"${firstInner}"}}`,
    "[WD Proxy] Proxying [POST /session] to the downstream server",
    `[WD Proxy] Got response with status 200: {"value":{"sessionId":"${secondInner}"}}`,
    "[AppiumDriver] Ending session, cause was 'New Command Timeout of 3000 seconds expired'",
    "[WebDriverAgentMac] Mac2Driver host process has exited with code 1, signal SIGTERM",
  ].join("\n");
  const output = execFileSync("/usr/bin/awk", [appiumLifecycleFilterProgram], {
    encoding: "utf8",
    input,
  });
  const events = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events).toMatchObject([
    { sequence: 1, event: "sessionCreated", alias: "outer-1" },
    { sequence: 2, event: "sessionCreated", alias: "inner-1" },
    { sequence: 3, event: "sessionReplaced", alias: "inner-1", cause: "replacement" },
    { sequence: 4, event: "sessionCreated", alias: "inner-2" },
    { sequence: 5, event: "unexpectedShutdown", cause: "newCommandTimeout" },
    { sequence: 6, event: "processExited", cause: "providerExit", exitCode: 1, signal: "SIGTERM" },
  ]);
  expect(output).not.toContain(outer);
  expect(output).not.toContain(firstInner);
  expect(output).not.toContain(secondInner);
});

it("does not report replacement after the active inner session was explicitly deleted", () => {
  const firstInner = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const secondInner = "99999999-8888-4777-8666-555555555555";
  const input = [
    "[WD Proxy] Proxying [POST /session] to the downstream server",
    `[WD Proxy] Got response with status 200: {"value":{"sessionId":"${firstInner}"}}`,
    `[WD Proxy] Proxying [DELETE /session/${firstInner}] to the downstream server`,
    "[WD Proxy] Proxying [POST /session] to the downstream server",
    `[WD Proxy] Got response with status 200: {"value":{"sessionId":"${secondInner}"}}`,
  ].join("\n");
  const output = execFileSync("/usr/bin/awk", [appiumLifecycleFilterProgram], {
    encoding: "utf8",
    input,
  });
  const events = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events.map((event) => event.event)).toEqual([
    "sessionCreated",
    "sessionDeleteRequested",
    "sessionCreated",
  ]);
  expect(events).not.toContainEqual(expect.objectContaining({ event: "sessionReplaced" }));
});

it("fails lifecycle diagnostic export when its generated journal is absent", async () => {
  vi.mocked(runProcess).mockClear();
  vi.mocked(runProcess).mockResolvedValue({ code: 25, stdout: "", stderr: "", aborted: false });
  const result = await new TartExecGuestAdapter().exportDiagnostics(
    "run-00000001",
    { maxFileBytes: 1024, maxTotalBytes: 2048 },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: false, error: { code: "EvidenceIncomplete" } });
  const command = vi.mocked(runProcess).mock.calls[0]?.[1].at(-1) ?? "";
  expect(command).toContain("exit 25");
  expect(command).toContain("1024");
  expect(command).toContain("sysopen -r -o nofollow");
  expect(command).toContain("lifecycle.jsonl");
});

it("exports a strict pre-cleanup lifecycle diagnostic without provider identifiers", async () => {
  vi.mocked(runProcess).mockClear();
  const uuid = "11111111-2222-4333-8444-555555555555";
  const event = JSON.stringify({
    sequence: 1,
    recordedAt: "2026-09-26T00:00:00.000Z",
    source: "appium",
    event: "sessionCreated",
    alias: "outer-1",
    observedBeforeCleanup: true,
  });
  vi.mocked(runProcess)
    .mockResolvedValueOnce({
      code: 0,
      stdout: Buffer.from(`${event}\n`).toString("base64"),
      stderr: "",
      aborted: false,
    })
    .mockResolvedValueOnce({ code: 0, stdout: "127.0.0.1\n", stderr: "", aborted: false })
    .mockResolvedValueOnce({ code: 0, stdout: "1 1 1 ready\n", stderr: "", aborted: false });
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({ value: { ready: true } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{}] }), { status: 200 }));
  try {
    const result = await new TartExecGuestAdapter().exportDiagnostics(
      "run-00000001",
      { maxFileBytes: 4096, maxTotalBytes: 4096 },
      new AbortController().signal,
    );
    if (!result.ok) throw new Error(result.error.message);
    const decoded = new TextDecoder().decode(result.value);
    expect(ProviderLifecycleDiagnosticSchema.parse(JSON.parse(decoded) as unknown)).toMatchObject({
      events: [{ alias: "outer-1" }],
      snapshot: { activeSessionCount: 1, observedBeforeCleanup: true },
    });
    expect(decoded).not.toContain(uuid);
    expect(decoded).not.toContain("path");
    expect(decoded).not.toContain("request");
  } finally {
    fetcher.mockRestore();
  }
});
it.each([22, 21])("fails diagnostic export for unsafe file status %s", async (code) => {
  vi.mocked(runProcess).mockClear();
  vi.mocked(runProcess).mockResolvedValue({ code, stdout: "", stderr: "", aborted: false });
  const result = await new TartExecGuestAdapter().exportDiagnostics(
    "run-00000001",
    { maxFileBytes: 1024, maxTotalBytes: 2048 },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: false, error: { code: "EvidenceIncomplete" } });
});
import { execFileSync } from "node:child_process";
