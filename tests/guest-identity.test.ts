import { describe, expect, it, vi } from "vitest";
import {
  TartExecGuestAdapter,
  parseApplicationInventoryPaths,
  parseApplicationMetadata,
} from "../src/adapters/guest/index.js";
import { runProcess } from "../src/adapters/guest/process-runner.js";

vi.mock("../src/adapters/guest/process-runner.js", () => ({ runProcess: vi.fn() }));

describe("Guest build identity", () => {
  it("parses standard and Cryptex GUI applications without returning paths", () => {
    const inventory = [
      "/System/Cryptexes/App/System/Applications/Safari.app",
      "/Applications/MacOSComputerUseFixture.app",
      "/System/Library/CoreServices/Hidden.app",
    ].join("\n");
    expect(parseApplicationInventoryPaths(inventory)).toEqual([
      "/System/Cryptexes/App/System/Applications/Safari.app",
      "/Applications/MacOSComputerUseFixture.app",
    ]);
    expect(
      parseApplicationMetadata(
        "/System/Cryptexes/App/System/Applications/Safari.app",
        "com.apple.Safari",
        "26.0",
      ),
    ).toEqual({ name: "Safari", bundleId: "com.apple.Safari", version: "26.0", location: "system" });
  });

  it("returns stable missing and ambiguous application errors", async () => {
    vi.mocked(runProcess).mockReset();
    vi.mocked(runProcess).mockResolvedValue({ code: 0, stdout: "", stderr: "", aborted: false });
    const guest = new TartExecGuestAdapter();
    expect(
      await guest.resolveApplication("run-00000001", { name: "Missing" }, new AbortController().signal),
    ).toMatchObject({ ok: false, error: { code: "ApplicationNotFound" } });
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      stderr: "",
      aborted: false,
      stdout: "/Applications/App.app\n/Users/admin/Applications/App.app\n",
    });
    expect(
      await guest.resolveApplication("run-00000001", { name: "app" }, new AbortController().signal),
    ).toMatchObject({ ok: false, error: { code: "ApplicationAmbiguous" } });
  });
  it.each([
    ["fixture-build-1", "ready"],
    ["other-build", "failed"],
    [`sha256:${"a".repeat(64)}`, "failed"],
  ])("checks independent build identity %s", async (identity, status) => {
    const outputs = [
      "26.0",
      "Xcode 26.0\nBuild version 17A",
      "3.7.0",
      JSON.stringify({ mac2: { version: "4.3.5" } }),
      "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
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
          mac2: "4.3.5",
          wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
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
        mac2: "4.3.5",
        wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
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
      JSON.stringify({ mac2: { version: "4.3.5" } }),
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
          mac2: "4.3.5",
          wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
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
