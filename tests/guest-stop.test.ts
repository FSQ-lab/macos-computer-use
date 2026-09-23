import { expect, it, vi } from "vitest";
import { TartExecGuestAdapter } from "../src/adapters/guest/index.js";
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
it("fails diagnostic export when a required provider log is absent", async () => {
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
  expect(command).toContain("/dev/fd/$diagnostic_fd");
  expect(command).toContain("base64 <&$diagnostic_fd");
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
it("cancels diagnostic export without accepting partial output", async () => {
  vi.mocked(runProcess).mockClear();
  vi.mocked(runProcess).mockResolvedValue({ code: null, stdout: "", stderr: "", aborted: true });
  const controller = new AbortController();
  controller.abort();
  const result = await new TartExecGuestAdapter().exportDiagnostics(
    "run-00000001",
    { maxFileBytes: 1024, maxTotalBytes: 2048 },
    controller.signal,
  );
  expect(result).toMatchObject({ ok: false, error: { code: "EvidenceIncomplete" } });
});
