import { beforeEach, describe, expect, it, vi } from "vitest";
import { TartAdapter, tartRunArguments } from "../src/adapters/tart/index.js";
import { runProcess } from "../src/adapters/tart/process-runner.js";

vi.mock("../src/adapters/tart/process-runner.js", () => ({ runProcess: vi.fn() }));

describe("Tart conservative resource facts", () => {
  const ids = { next: (prefix: string) => `${prefix}-00000001` };
  beforeEach(() => vi.mocked(runProcess).mockReset());
  it("uses shared networking while disabling clipboard and forwarding modes", () => {
    const args = tartRunArguments("mcu-run-00000001");
    expect(args).toEqual(["run", "--no-clipboard", "mcu-run-00000001"]);
    expect(args).not.toContain("--net-host");
    expect(args.some((arg) => arg.startsWith("--net-bridged") || arg.includes("expose"))).toBe(false);
  });
  it("does not treat an unavailable OCI inventory as a missing image", async () => {
    vi.mocked(runProcess).mockResolvedValue({ code: 1, stdout: "", stderr: "", aborted: false });
    const result = await new TartAdapter("tart", ids).checkImage(
      "localhost:5000/project/image",
      `sha256:${"a".repeat(64)}`,
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "ProviderFailure" } });
  });
  it("trusts only the exact immutable digest cache identity without mutating it", async () => {
    const reference = "localhost:5000/project/image";
    const digest = `sha256:${"a".repeat(64)}`;
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { Source: "OCI", Name: `${reference}@${digest}` },
        { Source: "OCI", Name: `${reference}:mutable` },
      ]),
      stderr: "",
      aborted: false,
    });
    const result = await new TartAdapter("tart", ids).ensureImage(
      { reference, digest },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(vi.mocked(runProcess).mock.calls).toHaveLength(1);
    expect(vi.mocked(runProcess).mock.calls[0]?.[1]).toEqual(["list", "--source", "oci", "--format", "json"]);
  });
  it("pulls by exact digest and rejects a cache that is still absent afterward", async () => {
    const reference = "localhost:5000/project/image";
    const digest = `sha256:${"a".repeat(64)}`;
    vi.mocked(runProcess)
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "", aborted: false })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "", aborted: false })
      .mockResolvedValueOnce({ code: 0, stdout: "[]", stderr: "", aborted: false });
    const result = await new TartAdapter("tart", ids).ensureImage(
      { reference, digest },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "ImageDigestMismatch" } });
    expect(vi.mocked(runProcess).mock.calls[1]?.[1]).toEqual(["pull", `${reference}@${digest}`]);
    expect(vi.mocked(runProcess).mock.calls.some((call) => call[1].includes("delete"))).toBe(false);
  });
  it.each(["{}", "[{}]", "[null]"])("rejects malformed inventory %s", async (stdout) => {
    vi.mocked(runProcess).mockResolvedValue({ code: 0, stdout, stderr: "", aborted: false });
    expect((await new TartAdapter("tart", ids).listManaged(new AbortController().signal)).ok).toBe(false);
  });
  it("does not interpret inspect errors as absence", async () => {
    vi.mocked(runProcess).mockResolvedValue({ code: 1, stdout: "", stderr: "", aborted: false });
    const result = await new TartAdapter("tart", ids).inspect("run-00000001", new AbortController().signal);
    expect(!result.ok && result.error.retryDisposition).toBe("reconcileRequired");
  });
  it("keeps unfamiliar VM states unknown", async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ State: "unexpected" }),
      stderr: "",
      aborted: false,
    });
    const result = await new TartAdapter("tart", ids).inspect("run-00000001", new AbortController().signal);
    expect(result.ok && result.value.state).toBe("unknown");
  });
});
