import { describe, expect, it, vi } from "vitest";
import { TartExecGuestAdapter } from "../src/adapters/guest/index.js";
import { runProcess } from "../src/adapters/guest/process-runner.js";
vi.mock("../src/adapters/guest/process-runner.js", () => ({ runProcess: vi.fn() }));
const ids = { next: (prefix: string) => `${prefix}-00000001` };

describe("Host-only Guest filtering", () => {
  it("loads the active ruleset and verifies PF instead of an unattached anchor", async () => {
    vi.mocked(runProcess).mockResolvedValue({ code: 0, stdout: "", stderr: "", aborted: false });
    const result = await new TartExecGuestAdapter("tart", undefined, undefined, ids).configureNetwork(
      "run-00000001",
      [{ cidr: "192.168.18.1/32", ports: [18080], protocol: "tcp" }],
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const args = vi.mocked(runProcess).mock.calls.at(-1)?.[1];
    const script = args?.at(-1) ?? "";
    expect(script).toContain("sudo -n /sbin/pfctl -nf");
    expect(script).toContain("sudo -n /sbin/pfctl -f");
    expect(script).toContain("Status: Enabled");
    expect(script).not.toContain("pfctl -a");
    const encoded = /printf %s ([A-Za-z0-9+/=]+)/.exec(script)?.[1];
    expect(encoded).toBeDefined();
    const rules = Buffer.from(encoded ?? "", "base64").toString();
    expect(rules).toContain("proto tcp to 192.168.18.1/32 port 18080");
    expect(rules).toContain("block drop out quick all");
  });
  it("fails closed when policy verification fails", async () => {
    vi.mocked(runProcess).mockResolvedValue({ code: 1, stdout: "", stderr: "", aborted: false });
    const result = await new TartExecGuestAdapter("tart", undefined, undefined, ids).configureNetwork(
      "run-00000001",
      [{ cidr: "192.168.18.1/32", ports: [18080], protocol: "tcp" }],
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });
});
