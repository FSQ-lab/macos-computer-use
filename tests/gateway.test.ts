import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ok,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type EvidenceEvent,
  type GuestPort,
  type ImagePort,
  type ElementQuery,
  type Observation,
  type OperationId,
  type ProviderReceipt,
  type RunId,
  type Scenario,
  type VmPort,
} from "../src/contracts/index.js";
import { LocalEvidenceAdapter } from "../src/adapters/evidence/index.js";
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
}
class TestIds implements IdGenerator {
  value = 0;
  next(prefix: string): string {
    return `${prefix}-${String(++this.value).padStart(8, "0")}`;
  }
}
const receipt = (operationId = "operation-00000001" as OperationId): ProviderReceipt => ({
  provider: "fake",
  operationId,
  dispatch: "dispatched",
  outcome: "succeeded",
  startedAt: "2026-09-21T00:00:00.000Z",
  finishedAt: "2026-09-21T00:00:01.000Z",
});
const support = {
  hasher: { sha256: (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex") },
  secrets: { resolve: () => undefined },
};

class FakePlatform implements ImagePort, VmPort, GuestPort, DesktopPort {
  destroyed = false;
  stoppedAppium = false;
  failSessionCleanup = false;
  assertionStatus: "passed" | "failed" | "unverifiable" = "passed";
  async ensureImage() {
    return ok(receipt());
  }
  async listManaged() {
    return ok([]);
  }
  async clone(request: Parameters<VmPort["clone"]>[0]) {
    return ok({ cloneName: request.cloneName, receipt: receipt() });
  }
  async start() {
    return ok(receipt());
  }
  async inspect() {
    return ok({ exists: true, state: "running" as const });
  }
  async stop() {
    return ok(receipt());
  }
  async destroy() {
    this.destroyed = true;
    return ok(receipt());
  }
  async probe() {
    return ok({
      status: "ready" as const,
      observedAt: "2026-09-21T00:00:00.000Z",
      validForMs: 5000,
      durationMs: 1,
    });
  }
  async configureNetwork() {
    return ok(receipt());
  }
  async startAppium() {
    return ok({ endpoint: "http://127.0.0.1:4723", receipt: receipt() });
  }
  async stopAppium() {
    this.stoppedAppium = true;
    return ok(receipt());
  }
  async exportDiagnostics() {
    return ok(new Uint8Array());
  }
  async startSession() {
    return ok(receipt());
  }
  async stopSession() {
    return this.failSessionCleanup
      ? {
          ok: false as const,
          error: {
            code: "CleanupFailed" as const,
            phase: "cleanup" as const,
            message: "failed",
            retryDisposition: "safe" as const,
          },
        }
      : ok(receipt());
  }
  async dispatch(_action: DesktopAction, operationId: OperationId) {
    return ok(receipt(operationId));
  }
  rebind(action: DesktopAction) {
    return ok(action);
  }
  async observe(request: Parameters<DesktopPort["observe"]>[0]) {
    const observation: Omit<Observation, "screenshot" | "uiSnapshot"> = {
      observationId: request.observationId,
      runId: request.runId,
      environmentId: "environment-test",
      generation: request.generation,
      sessionId: request.sessionId,
      windowId: request.windowId,
      capturedAt: "2026-09-21T00:00:00.000Z",
      coverage: "complete",
      elements: [
        {
          elementId: "element-00000001" as Observation["elements"][number]["elementId"],
          role: "button",
          name: "Save",
          enabled: true,
        },
      ],
    };
    return ok({
      observation,
      screenshot: new Uint8Array([1, 2, 3]),
      snapshot: new TextEncoder().encode("{}"),
    });
  }
  async evaluate(assertion: AssertionSpec) {
    return ok({
      status: assertion.kind === "visible" ? this.assertionStatus : ("unverifiable" as const),
      reason: "fake",
    });
  }
  compact(observation: Observation) {
    return `snapshot=${observation.observationId}`;
  }
  query(observation: Observation, query: ElementQuery) {
    const element = observation.elements.find((item) => !query.role || item.role === query.role);
    return element
      ? ok({
          runId: observation.runId,
          environmentId: observation.environmentId,
          generation: observation.generation,
          sessionId: observation.sessionId,
          windowId: observation.windowId,
          observationId: observation.observationId,
          elementId: element.elementId,
        })
      : {
          ok: false as const,
          error: {
            code: "TargetNotFound" as const,
            phase: "observe" as const,
            message: "not found",
            retryDisposition: "safe" as const,
          },
        };
  }
  expand(observation: Observation, elementId: Observation["elements"][number]["elementId"]) {
    const element = observation.elements.find((item) => item.elementId === elementId);
    return element
      ? ok(element)
      : {
          ok: false as const,
          error: {
            code: "TargetNotFound" as const,
            phase: "observe" as const,
            message: "not found",
            retryDisposition: "safe" as const,
          },
        };
  }
}

const config = (root: string) => ({
  image: { reference: "ghcr.io/example/image", digest: `sha256:${"a".repeat(64)}` },
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
    tart: "2.35",
    appiumMajor: 3 as const,
    mac2: "4.3.1" as const,
    guestMacOS: "26.0",
    xcode: "26.0",
    fixtureBuild: "1",
  },
});

describe("gateway", () => {
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
    const observations = timeline.value
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === "ObservationCaptured");
    expect(observations.some(({ index }) => index < planned)).toBe(true);
    expect(observations.some(({ index }) => index > planned)).toBe(true);
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
      data: {},
    };
    expect((await evidence.append(event)).ok).toBe(false);
  });
});
