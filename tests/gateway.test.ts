import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ok,
  type EvidenceEvent,
  type Observation,
  type ProviderReceipt,
  type RunId,
  type Scenario,
} from "../src/contracts/index.js";
import { LocalEvidenceAdapter } from "../src/adapters/evidence/index.js";
import { FakePlatform, fakeReceipt as receipt } from "./support/fake-platform.js";
import {
  ActionTransaction,
  Gateway,
  type Clock,
  type GatewayLock,
  type IdGenerator,
} from "../src/kernel/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class TestClock implements Clock {
  value = 0;
  wallNow(): Date {
    return new Date("2026-09-21T00:00:00.000Z");
  }
  monotonicMs(): number {
    return this.value++;
  }
  schedule(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  }
  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  }
}
class TestIds implements IdGenerator {
  value = 0;
  next(prefix: string): string {
    return `${prefix}-${String(++this.value).padStart(8, "0")}`;
  }
}
const support = {
  hasher: { sha256: (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex") },
  secrets: { resolve: () => undefined },
};

const config = (root: string) => ({
  image: {
    buildIdentity: "fixture-build-1",
    reference: "ghcr.io/example/image",
    digest: `sha256:${"a".repeat(64)}`,
  },
  aut: { bundleId: "com.example.App", window: { isMain: true } },
  timeouts: {
    runTotalMs: 100_000,
    imagePullMs: 1000,
    cloneMs: 1000,
    vmBootMs: 1000,
    guestReadyMs: 1000,
    appiumStartMs: 1000,
    mac2SessionMs: 1000,
    appReadyMs: 1000,
    observeMs: 1000,
    actionMs: 1000,
    assertionMs: 1000,
    evidenceFinalizeMs: 1000,
    cleanupMs: 1000,
  },
  state: { root: join(root, "state"), tempRoot: join(root, "temp") },
  evidence: {
    root: join(root, "evidence"),
    retentionDays: 7,
    maxArtifactBytes: 10_000,
    maxRunBytes: 100_000,
  },
  retry: {
    imagePull: { maxAttempts: 2, backoffMs: 1 },
    readiness: { maxAttempts: 2, backoffMs: 1 },
    observation: { maxAttempts: 2, backoffMs: 1 },
  },
  network: [],
  secrets: { allowedNames: [] },
  compatibility: {
    tart: "2.35" as const,
    appiumMajor: 3 as const,
    appium: "3.7.0" as const,
    mac2: "4.3.1" as const,
    wdaSha256: "bad71dfeaaa51d3a7224f022c580cdb7424565ca0c4b7f72ad4b0c2b9a339b62" as const,
    guestMacOS: "26.0",
    xcode: "26.0",
    fixtureBuild: "1",
  },
});

describe("gateway", () => {
  it("verifies the exact image digest before allocating Run identity or Evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-image-preallocation-"));
    roots.push(root);
    const platform = new FakePlatform();
    vi.spyOn(platform, "ensureImage").mockResolvedValue({
      ok: false,
      error: {
        code: "ImageDigestMismatch",
        phase: "image",
        message: "digest mismatch",
        retryDisposition: "notApplicable",
        dispatch: "notDispatched",
      },
    });
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const append = vi.spyOn(evidence, "append");
    const ids = new TestIds();
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids,
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const result = await gateway.execute(
      config(root),
      {
        schemaVersion: 1,
        name: "image-preallocation",
        actions: [],
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "ImageDigestMismatch" } });
    expect(ids.value).toBe(0);
    expect(append).not.toHaveBeenCalled();
  });
  it("does not start cleanup operations after the cleanup budget is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-cleanup-budget-"));
    roots.push(root);
    const platform = new FakePlatform();
    const clock = new TestClock();
    const stopSession = vi.spyOn(platform, "stopSession").mockImplementation(async () => {
      clock.value += 2_000;
      return ok(receipt());
    });
    const stopAppium = vi.spyOn(platform, "stopAppium");
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const input = config(root);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock,
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const result = await gateway.execute(
      input,
      {
        schemaVersion: 1,
        name: "cleanup-budget",
        actions: [],
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.cleanup).toBe("failed");
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopAppium).not.toHaveBeenCalled();
  });
  it("passes only the ImagePort request contract at the adapter boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-image-request-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    await gateway.execute(
      config(root),
      {
        schemaVersion: 1,
        name: "image-request-boundary",
        actions: [],
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      },
      new AbortController().signal,
    );
    expect(platform.imageRequest).toEqual({
      reference: "ghcr.io/example/image",
      digest: `sha256:${"a".repeat(64)}`,
    });
  });
  it("does not dispatch business actions when mandatory environment Evidence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-environment-evidence-"));
    roots.push(root);
    const platform = new FakePlatform();
    const dispatch = vi.spyOn(platform, "dispatch");
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const commit = evidence.commitArtifact.bind(evidence);
    vi.spyOn(evidence, "commitArtifact").mockImplementation((request, signal) =>
      request.type === "environment"
        ? Promise.resolve({
            ok: false,
            error: {
              code: "EvidenceIncomplete",
              phase: "evidence",
              message: "environment failed",
              retryDisposition: "notApplicable",
            },
          })
        : commit(request, signal),
    );
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const result = await gateway.execute(
      config(root),
      {
        schemaVersion: 1,
        name: "mandatory-environment-evidence",
        actions: [
          {
            stepId: "click",
            target: { role: "button" },
            action: { kind: "click" },
            verification: { policy: "deferred" },
          },
        ],
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.verdict).toBe("inconclusive");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("rejects dispatch when readiness expires during before Evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-expired-before-"));
    roots.push(root);
    const platform = new FakePlatform();
    const dispatch = vi.spyOn(platform, "dispatch");
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10000);
    const clock = new TestClock();
    const transaction = new ActionTransaction(platform, evidence, clock, new TestIds(), {
      actionMs: 1000,
      observeMs: 1000,
      assertionMs: 1000,
    });
    const result = await transaction.execute(
      {
        runId: "run-00000001" as RunId,
        generation: 1,
        sessionId: "session-00000001" as Observation["sessionId"],
        windowId: "window-00000001" as Observation["windowId"],
        expectedObservationId: "observation-00000001",
        sequence: 0,
        startedMono: 0,
        readyUntilMs: 0,
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.dispatch).toBe("notDispatched");
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("records malformed Hook contributions without changing business facts or skipping cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-hook-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
      hooks: [
        {
          name: "bad-contribution",
          deliver: async (event) => {
            event.sequence = 999;
            return [{ type: "bad", bytes: "not-bytes" }];
          },
        },
      ],
    });
    const result = await gateway.execute(
      config(root),
      {
        schemaVersion: 1,
        name: "hook-isolation",
        actions: [],
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.verdict).toBe("passed");
    expect(platform.destroyed).toBe(true);
    if (!result.ok) return;
    const timeline = await evidence.readTimeline(result.value.runId);
    expect(timeline.ok && timeline.value.some((event) => event.type === "HookFailed")).toBe(true);
    expect(timeline.ok && timeline.value[0]?.sequence).toBe(1);
  });
  it("delivers ActionTransaction facts to configured Hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-action-hook-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const seen: string[] = [];
    const action = new ActionTransaction(
      platform,
      evidence,
      new TestClock(),
      new TestIds(),
      { actionMs: 1000, observeMs: 1000, assertionMs: 1000 },
      [{ name: "observer", deliver: async (event) => void seen.push(event.type) }],
    );
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    await action.execute(
      {
        runId,
        generation: 1,
        sessionId: "session-0001" as Observation["sessionId"],
        windowId: "window-0001" as Observation["windowId"],
        expectedObservationId: "observation-0001",
        sequence: 1,
        startedMono: 0,
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(seen).toContain("ActionPlanned");
    expect(seen).toContain("ProviderReceiptRecorded");
    expect(seen).toContain("ActionResultRecorded");
  });
  it("persists ActionTransaction Hook contributions and failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-action-hook-artifact-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const action = new ActionTransaction(
      platform,
      evidence,
      new TestClock(),
      new TestIds(),
      { actionMs: 1000, observeMs: 1000, assertionMs: 1000 },
      [
        { name: "artifact", deliver: async () => [{ type: "note", bytes: new Uint8Array([1]) }] },
        {
          name: "broken",
          deliver: async () => {
            throw new Error("broken");
          },
        },
      ],
    );
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    const result = await action.execute(
      {
        runId,
        generation: 1,
        sessionId: "session-0001" as Observation["sessionId"],
        windowId: "window-0001" as Observation["windowId"],
        expectedObservationId: "observation-0001",
        sequence: 1,
        startedMono: 0,
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const timeline = await evidence.readTimeline(runId);
    expect(
      timeline.ok &&
        timeline.value.some((event) => event.type === "ArtifactCommitted" && event.source === "hook"),
    ).toBe(true);
    expect(timeline.ok && timeline.value.some((event) => event.type === "HookFailed")).toBe(true);
    expect(
      result.ok && result.value.artifacts?.some((artifact) => artifact.type === "hook-artifact-note"),
    ).toBe(true);
  });
  it("does not continue until an aborted Hook has actually settled", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-hook-drain-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    let settled = false;
    const action = new ActionTransaction(
      platform,
      evidence,
      new TestClock(),
      new TestIds(),
      { actionMs: 1000, observeMs: 1000, assertionMs: 1000 },
      [
        {
          name: "drain",
          deliver: async (_event, signal) => {
            if (signal.aborted) throw signal.reason;
            await Promise.resolve();
            settled = true;
            return [];
          },
        },
      ],
    );
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    await action.execute(
      {
        runId,
        generation: 1,
        sessionId: "session-0001" as Observation["sessionId"],
        windowId: "window-0001" as Observation["windowId"],
        expectedObservationId: "observation-0001",
        sequence: 1,
        startedMono: 0,
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(settled).toBe(true);
  });
  it("returns Hook artifacts even when a precondition stops dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-hook-precondition-"));
    roots.push(root);
    const platform = new FakePlatform();
    platform.assertionStatus = "failed";
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const transaction = new ActionTransaction(
      platform,
      evidence,
      new TestClock(),
      new TestIds(),
      { actionMs: 1000, observeMs: 1000, assertionMs: 1000 },
      [{ name: "early", deliver: async () => [{ type: "note", bytes: new Uint8Array([3]) }] }],
    );
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    const output = await transaction.execute(
      {
        runId,
        generation: 1,
        sessionId: "session-0001" as Observation["sessionId"],
        windowId: "window-0001" as Observation["windowId"],
        expectedObservationId: "observation-0001",
        sequence: 1,
        startedMono: 0,
        preconditions: [{ kind: "visible", query: { role: "button" } }],
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(output.ok && output.value.result.dispatch).toBe("notDispatched");
    expect(output.ok && output.value.artifacts?.some((artifact) => artifact.type === "hook-early-note")).toBe(
      true,
    );
  });
  it("includes interactive Action Hook artifacts in the final Manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-hook-manifest-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
      hooks: [{ name: "manifest", deliver: async () => [{ type: "note", bytes: new Uint8Array([7]) }] }],
    });
    const result = await gateway.executeInteractive(
      config(root),
      [{ kind: "visible", query: { role: "button" } }],
      async (run) => {
        const target = run.query({ role: "button" });
        if (!target.ok) throw new Error(target.error.code);
        await run.action({ kind: "click", target: { element: target.value } });
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shown = await evidence.showRun(result.value.runId);
    expect(shown.ok).toBe(true);
    expect(shown.ok && shown.value.artifacts.some((artifact) => artifact.type === "hook-manifest-note")).toBe(
      true,
    );
  });
  it("keeps event sequence contiguous when a Hook contribution fails to persist", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-hook-artifact-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const commitArtifact = evidence.commitArtifact.bind(evidence);
    vi.spyOn(evidence, "commitArtifact").mockImplementation((request) =>
      request.type.startsWith("hook-")
        ? Promise.resolve({
            ok: false,
            error: {
              code: "EvidenceIncomplete",
              phase: "evidence",
              message: "Hook Artifact rejected.",
              retryDisposition: "notApplicable",
            },
          })
        : commitArtifact(request),
    );
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
      hooks: [
        {
          name: "oversized",
          deliver: async () => [{ type: "blob", bytes: new Uint8Array([1]) }],
        },
      ],
    });
    const result = await gateway.execute(
      config(root),
      {
        schemaVersion: 1,
        name: "hook-artifact-failure",
        actions: [],
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      },
      new AbortController().signal,
    );
    expect(platform.destroyed).toBe(true);
    expect(result.ok && result.value.result.evidence).toBe("complete");
    if (!result.ok) return;
    const timeline = await evidence.readTimeline(result.value.runId);
    expect(timeline.ok).toBe(true);
    expect(timeline.ok && timeline.value.some((event) => event.type === "HookFailed")).toBe(true);
    expect(timeline.ok && timeline.value.map((event) => event.sequence)).toEqual(
      timeline.ok ? timeline.value.map((_, index) => index + 1) : [],
    );
  });
  it("retains partial before artifacts and does not dispatch when snapshot commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-before-partial-"));
    roots.push(root);
    const platform = new FakePlatform();
    const dispatch = vi.spyOn(platform, "dispatch");
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10000);
    const original = evidence.commitArtifact.bind(evidence);
    vi.spyOn(evidence, "commitArtifact").mockImplementation(async (request) =>
      request.type === "ui-snapshot"
        ? {
            ok: false,
            error: {
              code: "EvidenceIncomplete",
              phase: "evidence",
              message: "snapshot failure",
              retryDisposition: "notApplicable",
            },
          }
        : original(request),
    );
    const transaction = new ActionTransaction(platform, evidence, new TestClock(), new TestIds(), {
      actionMs: 1000,
      observeMs: 1000,
      assertionMs: 1000,
    });
    const result = await transaction.execute(
      {
        runId: "run-00000001" as RunId,
        generation: 1,
        sessionId: "session-00000001" as Observation["sessionId"],
        windowId: "window-00000001" as Observation["windowId"],
        expectedObservationId: "observation-00000001",
        sequence: 0,
        startedMono: 0,
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.dispatch).toBe("notDispatched");
    expect(result.ok && result.value.artifacts).toHaveLength(1);
    expect(result.ok && result.value.evidenceComplete).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("evaluates a standalone predeclared assertion on a new Observation and closes the handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-assert-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    let saved: Parameters<Parameters<Gateway["executeInteractive"]>[2]>[0] | undefined;
    const result = await gateway.executeInteractive(
      config(root),
      [{ kind: "visible", query: { role: "button" } }],
      async (run) => {
        saved = run;
        const asserted = await run.assert({ kind: "visible", query: { role: "button" } });
        expect(asserted.ok && asserted.value.status).toBe("passed");
        expect(asserted.ok && asserted.value.assertionId).toMatch(/^assertion-/);
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.cleanup).toBe("completed");
    const late = await saved?.assert({ kind: "visible", query: { role: "button" } });
    expect(late && !late.ok && late.error.code).toBe("RunClosed");
  });
  it("aborts an outstanding interactive operation before cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-scope-abort-"));
    roots.push(root);
    const platform = new FakePlatform();
    let actionSignal: AbortSignal | undefined;
    vi.spyOn(platform, "dispatch").mockImplementation(
      (_action, _operationId, signal) =>
        new Promise<ReturnType<typeof ok<ProviderReceipt>>>((resolve) => {
          actionSignal = signal;
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                ok: false,
                error: {
                  code: "Cancelled",
                  phase: "action",
                  message: "cancelled",
                  retryDisposition: "reconcileRequired",
                  dispatch: "unknown",
                },
              }),
            { once: true },
          );
        }),
    );
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const result = await gateway.executeInteractive(
      config(root),
      [{ kind: "visible", query: { role: "button" } }],
      async (run) => {
        const target = run.query({ role: "button" });
        if (!target.ok) throw new Error(target.error.code);
        const pending = run.action({ kind: "click", target: { element: target.value } });
        for (let attempt = 0; attempt < 100 && !actionSignal; attempt += 1)
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        void pending.catch(() => undefined);
        return "scope returned";
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.cleanup).toBe("completed");
    expect(actionSignal?.aborted).toBe(true);
    expect(platform.destroyed).toBe(true);
  });
  it("preserves a successful receipt when after capture throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-after-failure-"));
    roots.push(root);
    const platform = new FakePlatform();
    const observe = platform.observe.bind(platform);
    let count = 0;
    vi.spyOn(platform, "observe").mockImplementation(async (request) => {
      if (++count > 1) throw new Error("capture failure");
      return observe(request);
    });
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    const transaction = new ActionTransaction(platform, evidence, new TestClock(), new TestIds(), {
      actionMs: 1000,
      observeMs: 1000,
      assertionMs: 1000,
    });
    const result = await transaction.execute(
      {
        runId,
        generation: 1,
        sessionId: "session-00000001" as Observation["sessionId"],
        windowId: "window-00000001" as Observation["windowId"],
        expectedObservationId: "observation-00000001",
        sequence: 1,
        startedMono: 0,
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(result.ok && result.value.result).toEqual({
      dispatch: "dispatched",
      providerOutcome: "succeeded",
      verification: "unverifiable",
      retryDisposition: "unsafe",
    });
    expect(result.ok && result.value.evidenceComplete).toBe(false);
    expect(result.ok && result.value.artifacts?.length).toBe(2);
  });
  it("attempts and persists an after Observation when dispatch returns an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-receipt-error-after-"));
    roots.push(root);
    const platform = new FakePlatform();
    vi.spyOn(platform, "dispatch").mockResolvedValue({
      ok: false,
      error: {
        code: "ProviderFailure",
        phase: "action",
        message: "uncertain provider response",
        retryDisposition: "reconcileRequired",
        dispatch: "unknown",
      },
    });
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    const transaction = new ActionTransaction(platform, evidence, new TestClock(), new TestIds(), {
      actionMs: 1000,
      observeMs: 1000,
      assertionMs: 1000,
    });
    const result = await transaction.execute(
      {
        runId,
        generation: 1,
        sessionId: "session-0001" as Observation["sessionId"],
        windowId: "window-0001" as Observation["windowId"],
        expectedObservationId: "observation-0001",
        sequence: 1,
        startedMono: 0,
      },
      { kind: "pressKey", key: "enter" },
      [],
      new AbortController().signal,
    );
    expect(result.ok && result.value.after?.observationId).toMatch(/^observation-/);
    expect(result.ok && result.value.evidenceComplete).not.toBe(false);
    const timeline = await evidence.readTimeline(runId);
    expect(timeline.ok && timeline.value.some((event) => event.type === "ObservationCaptured")).toBe(true);
    expect(timeline.ok && timeline.value.some((event) => event.type === "ActionResultRecorded")).toBe(true);
  });
  it.each(["ProviderReceiptRecorded", "ObservationCaptured"] as const)(
    "preserves known post-dispatch facts when %s Evidence fails",
    async (failedType) => {
      const root = await mkdtemp(join(tmpdir(), "mcu-post-dispatch-fact-"));
      roots.push(root);
      const platform = new FakePlatform();
      const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
      const runId = "run-00000001" as RunId;
      await evidence.append({
        schemaVersion: 1,
        runId,
        sequence: 1,
        recordedAt: "2026-09-21T00:00:00.000Z",
        elapsedMs: 0,
        type: "RunStarted",
        source: "kernel",
        data: { mode: "interactive" },
      });
      const append = evidence.append.bind(evidence);
      let failed = false;
      let matchingEvents = 0;
      vi.spyOn(evidence, "append").mockImplementation((event, signal) => {
        if (event.type === failedType) matchingEvents += 1;
        const failureOccurrence = failedType === "ObservationCaptured" ? 2 : 1;
        if (!failed && event.type === failedType && matchingEvents === failureOccurrence) {
          failed = true;
          return Promise.resolve({
            ok: false,
            error: {
              code: "EvidenceIncomplete",
              phase: "evidence",
              message: "injected post-dispatch failure",
              retryDisposition: "notApplicable",
            },
          });
        }
        return append(event, signal);
      });
      const transaction = new ActionTransaction(platform, evidence, new TestClock(), new TestIds(), {
        actionMs: 1000,
        observeMs: 1000,
        assertionMs: 1000,
      });
      const result = await transaction.execute(
        {
          runId,
          generation: 1,
          sessionId: "session-00000001" as Observation["sessionId"],
          windowId: "window-00000001" as Observation["windowId"],
          expectedObservationId: "observation-00000001",
          sequence: 1,
          startedMono: 0,
        },
        { kind: "pressKey", key: "enter" },
        [],
        new AbortController().signal,
      );
      expect(result.ok && result.value.evidenceComplete).toBe(false);
      expect(result.ok && result.value.result).toMatchObject({
        dispatch: "dispatched",
        providerOutcome: "succeeded",
        verification: "unverifiable",
      });
      const timeline = await evidence.readTimeline(runId);
      if (!timeline.ok) throw new Error(timeline.error.message);
      expect(timeline.value.map((event) => event.sequence)).toEqual(
        timeline.value.map((_, index) => index + 1),
      );
      expect(timeline.value.find((event) => event.type === "ActionResultRecorded")?.data).toEqual(
        expect.objectContaining({
          result: expect.objectContaining({
            dispatch: "dispatched",
            providerOutcome: "succeeded",
          }) as unknown,
        }),
      );
    },
  );
  it.each([true, false])("recovers an interrupted Run with ownership record=%s", async (hasRecord) => {
    const root = await mkdtemp(join(tmpdir(), "mcu-recovery-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    if (hasRecord)
      await evidence.writeManagedResource({
        schemaVersion: 1,
        runId,
        resourceId: "mcu-run-00000001",
        imageDigest: `sha256:${"a".repeat(64)}`,
        phase: "clonePlanned",
      });
    const artifact = await evidence.commitArtifact({
      runId,
      type: "test-data",
      mimeType: "text/plain",
      sensitivity: "normal",
      bytes: new TextEncoder().encode("durable-before-crash"),
    });
    if (!artifact.ok) throw new Error("artifact setup failed");
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 2,
      recordedAt: "2026-09-21T00:00:01.000Z",
      elapsedMs: 1,
      type: "ArtifactCommitted",
      source: "kernel",
      data: {
        artifactId: artifact.value.artifactId,
        type: artifact.value.type,
        sha256: artifact.value.sha256,
      },
    });
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    expect((await gateway.recover(new AbortController().signal)).ok).toBe(true);
    const shown = await evidence.showRun(runId);
    expect(shown.ok).toBe(true);
    expect(shown.ok && shown.value.artifacts.some((item) => item.sha256 === artifact.value.sha256)).toBe(
      true,
    );
    expect(shown.ok && shown.value.result).toEqual({
      verdict: "inconclusive",
      evidence: "incomplete",
      cleanup: "completed",
    });
  });
  it("finalizes healthy unfinished Runs before reporting a corrupt neighbor", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-recovery-neighbor-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidenceRoot = join(root, "evidence");
    const evidence = new LocalEvidenceAdapter(evidenceRoot, join(root, "state"), 10_000);
    const healthy = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId: healthy,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(evidenceRoot, "runs", "run-00000002"), { recursive: true });
    await writeFile(join(evidenceRoot, "runs", "run-00000002", "timeline.jsonl"), "corrupt");
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const recovered = await gateway.recover(new AbortController().signal);
    expect(recovered).toMatchObject({ ok: false, error: { code: "RecoveryRequired" } });
    expect((await evidence.showRun(healthy)).ok).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, "state", "recovery", "run-00000002.json"), "utf8")),
    ).toMatchObject({
      runId: "run-00000002",
      unknownDispatch: true,
      result: { verdict: "inconclusive", evidence: "incomplete", cleanup: "completed" },
    });
  });
  it("does not pass final assertions after an action target is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-missing-target-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const result = await gateway.execute(
      config(root),
      {
        schemaVersion: 1,
        name: "missing",
        actions: [
          {
            stepId: "missing",
            target: { role: "checkbox" },
            action: { kind: "click" },
            verification: { policy: "deferred" },
          },
        ],
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      },
      new AbortController().signal,
    );
    expect(result.ok && result.value.result.verdict).toBe("inconclusive");
    expect(platform.destroyed).toBe(true);
  });
  it("runs a complete scenario and always cleans up", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-test-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const lock: GatewayLock = { acquire: async () => ok(async () => undefined) };
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock,
      buildVersion: "test",
    });
    const scenario: Scenario = {
      schemaVersion: 1,
      name: "save",
      actions: [
        {
          stepId: "save",
          target: { role: "button", name: { exact: "Save" } },
          action: { kind: "click" },
          verification: {
            policy: "immediate",
            assertions: [{ kind: "visible", query: { role: "button", name: { exact: "Save" } } }],
          },
        },
      ],
      finalAssertions: [{ kind: "visible", query: { role: "button", name: { exact: "Save" } } }],
    };
    const result = await gateway.execute(config(root), scenario, new AbortController().signal);
    expect(result.ok && result.value.result).toEqual({
      verdict: "passed",
      evidence: "complete",
      cleanup: "completed",
    });
    expect(platform.destroyed).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const shown = await evidence.showRun(result.value.runId);
    expect(shown.ok).toBe(true);
    const timeline = await evidence.readTimeline(result.value.runId);
    if (!timeline.ok) throw new Error(timeline.error.message);
    const planned = timeline.value.findIndex((event) => event.type === "ActionPlanned");
    const actionResult = timeline.value.find((event) => event.type === "ActionResultRecorded");
    const observations = timeline.value
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "ObservationCaptured");
    expect(observations.some(({ index }) => index < planned)).toBe(true);
    expect(observations.some(({ index }) => index > planned)).toBe(true);
    expect(actionResult?.data).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "confirmed",
        }) as unknown,
      }),
    );
    if (!actionResult || typeof actionResult.data !== "object") throw new Error("result");
    expect("actionId" in actionResult.data && String(actionResult.data.actionId)).toMatch(/^action-/);
    expect("operationId" in actionResult.data && String(actionResult.data.operationId)).toMatch(
      /^operation-/,
    );
  });

  it("does not confirm a provider success without assertions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-action-"));
    roots.push(root);
    const platform = new FakePlatform();
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const action = new ActionTransaction(platform, evidence, new TestClock(), new TestIds(), {
      actionMs: 1000,
      observeMs: 1000,
      assertionMs: 1000,
    });
    const runId = "run-00000001" as RunId;
    await evidence.append({
      schemaVersion: 1,
      runId,
      sequence: 1,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    });
    const result = await action.execute(
      {
        runId,
        generation: 1,
        sessionId: "session-0001" as Observation["sessionId"],
        windowId: "window-0001" as Observation["windowId"],
        expectedObservationId: "observation-0001",
        sequence: 1,
        startedMono: 0,
      },
      {
        kind: "click",
        target: {
          element: {
            runId,
            environmentId: "environment-test",
            generation: 1,
            sessionId: "session-0001" as Observation["sessionId"],
            windowId: "window-0001" as Observation["windowId"],
            observationId: "observation-0001" as Observation["observationId"],
            elementId: "element-00000001" as Observation["elements"][number]["elementId"],
          },
        },
      },
      [],
      new AbortController().signal,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.result.verification).toBe("notRequested");
  });

  it("classifies an immediate assertion failure as a failed Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-failed-"));
    roots.push(root);
    const platform = new FakePlatform();
    platform.assertionStatus = "failed";
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const scenario: Scenario = {
      schemaVersion: 1,
      name: "failed",
      actions: [
        {
          stepId: "click",
          target: { role: "button" },
          action: { kind: "click" },
          verification: { policy: "immediate", assertions: [{ kind: "visible", query: { role: "button" } }] },
        },
      ],
      finalAssertions: [{ kind: "visible", query: { role: "button" } }],
    };
    const result = await gateway.execute(config(root), scenario, new AbortController().signal);
    expect(result.ok && result.value.result.verdict).toBe("failed");
  });

  it("continues later cleanup after session cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-cleanup-"));
    roots.push(root);
    const platform = new FakePlatform();
    platform.failSessionCleanup = true;
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 10_000);
    const gateway = new Gateway({
      image: platform,
      vm: platform,
      guest: platform,
      desktop: platform,
      evidence,
      clock: new TestClock(),
      ids: new TestIds(),
      ...support,
      lock: { acquire: async () => ok(async () => undefined) },
      buildVersion: "test",
    });
    const scenario: Scenario = {
      schemaVersion: 1,
      name: "cleanup",
      actions: [],
      finalAssertions: [{ kind: "visible", query: { role: "button" } }],
    };
    const result = await gateway.execute(config(root), scenario, new AbortController().signal);
    expect(result.ok && result.value.result.cleanup).toBe("failed");
    expect(platform.stoppedAppium).toBe(true);
    expect(platform.destroyed).toBe(true);
  });

  it("rejects an out-of-order evidence sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-evidence-"));
    roots.push(root);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 1000);
    const runId = "run-00000001" as RunId;
    const event: EvidenceEvent = {
      schemaVersion: 1,
      runId,
      sequence: 2,
      recordedAt: "2026-09-21T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted",
      source: "kernel",
      data: { mode: "interactive" },
    };
    expect((await evidence.append(event)).ok).toBe(false);
  });
});
