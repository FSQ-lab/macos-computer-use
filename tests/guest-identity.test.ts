import { describe, expect, it, vi } from "vitest";
import { TartExecGuestAdapter } from "../src/adapters/guest/index.js";
import { runProcess } from "../src/adapters/guest/process-runner.js";

vi.mock("../src/adapters/guest/process-runner.js", () => ({ runProcess: vi.fn() }));

describe("Guest build identity", () => {
  it.each([
    ["fixture-build-1", "ready"],
    ["other-build", "failed"],
    [`sha256:${"a".repeat(64)}`, "failed"],
  ])("checks independent build identity %s", async (identity, status) => {
    const outputs = [
      "26.0",
      "Xcode 26.0\nBuild version 17A",
      "3.7.0",
      JSON.stringify({ mac2: { version: "4.3.1" } }),
      "bad71dfeaaa51d3a7224f022c580cdb7424565ca0c4b7f72ad4b0c2b9a339b62",
      identity,
      JSON.stringify({ bundleId: "com.example.Fixture", build: "1" }),
      "123",
    ];
    vi.mocked(runProcess).mockReset();
    for (const stdout of outputs)
      vi.mocked(runProcess).mockResolvedValueOnce({ code: 0, stdout, stderr: "", aborted: false });
    const result = await new TartExecGuestAdapter().probe(
      "run-00000001",
      {
        buildIdentity: "fixture-build-1",
        bundleId: "com.example.Fixture",
        compatibility: {
          appiumMajor: 3,
          appium: "3.7.0",
          mac2: "4.3.1",
          wdaSha256: "bad71dfeaaa51d3a7224f022c580cdb7424565ca0c4b7f72ad4b0c2b9a339b62",
          guestMacOS: "26.0",
          xcode: "26.0",
          fixtureBuild: "1",
        },
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.status).toBe(status);
    if (identity === "fixture-build-1")
      expect(result.ok && result.value.actual).toMatchObject({
        guestMacOS: "26.0",
        xcode: "26.0",
        appium: "3.7.0",
        mac2: "4.3.1",
        wdaSha256: "bad71dfeaaa51d3a7224f022c580cdb7424565ca0c4b7f72ad4b0c2b9a339b62",
        buildIdentity: "fixture-build-1",
        fixtureBuild: "1",
        windowServerReady: true,
      });
  });
  it("rejects a live WDA content identity mismatch", async () => {
    const outputs = [
      "26.0",
      "Xcode 26.0\nBuild version 17A",
      "3.7.0",
      JSON.stringify({ mac2: { version: "4.3.1" } }),
      "a".repeat(64),
      "fixture-build-1",
      JSON.stringify({ bundleId: "com.example.Fixture", build: "1" }),
      "123",
    ];
    vi.mocked(runProcess).mockReset();
    for (const stdout of outputs)
      vi.mocked(runProcess).mockResolvedValueOnce({ code: 0, stdout, stderr: "", aborted: false });
    const result = await new TartExecGuestAdapter().probe(
      "run-00000001",
      {
        buildIdentity: "fixture-build-1",
        bundleId: "com.example.Fixture",
        compatibility: {
          appiumMajor: 3,
          appium: "3.7.0",
          mac2: "4.3.1",
          wdaSha256: "bad71dfeaaa51d3a7224f022c580cdb7424565ca0c4b7f72ad4b0c2b9a339b62",
          guestMacOS: "26.0",
          xcode: "26.0",
          fixtureBuild: "1",
        },
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.status).toBe("failed");
  });
});
