import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalEvidenceAdapter } from "../src/adapters/evidence/index.js";
import { TartExecGuestAdapter } from "../src/adapters/guest/index.js";
import { runProcess as runGuestProcess } from "../src/adapters/guest/process-runner.js";
import { Mac2DesktopAdapter } from "../src/adapters/mac2/index.js";
import { TartAdapter } from "../src/adapters/tart/index.js";
import { runProcess as runTartProcess } from "../src/adapters/tart/process-runner.js";
import { FakePlatform } from "./support/fake-platform.js";
import {
  OperationErrorSchema,
  ProviderReceiptSchema,
  ProbeResultSchema,
  VmStatusSchema,
  ok,
  type EvidencePort,
  type DesktopPort,
  type GuestPort,
  type ImagePort,
  type OperationId,
  type Observation,
  type ObservationId,
  type SessionId,
  type WindowId,
  type ArtifactId,
  type ElementId,
  type RunId,
  type VmPort,
  type OperationResult,
} from "../src/contracts/index.js";

vi.mock("../src/adapters/guest/process-runner.js", () => ({ runProcess: vi.fn() }));
vi.mock("../src/adapters/tart/process-runner.js", () => ({ runProcess: vi.fn() }));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const ids = { next: (prefix: string) => `${prefix}-00000001` };
const cancelledError = (phase: "image" | "vm" | "guest" | "driver" | "evidence" | "cleanup") => ({
  ok: false as const,
  error: {
    code: "Cancelled" as const,
    phase,
    message: "cancelled",
    retryDisposition: "safe" as const,
    dispatch: "notDispatched" as const,
  },
});
const semantic = (value: unknown): unknown => {
  if (typeof value === "string") return { kind: "compact", hasSnapshot: value.includes("snapshot=") };
  if (typeof value !== "object" || value === null || !("ok" in value)) return value;
  const result = value as { ok: boolean; value?: Record<string, unknown>; error?: Record<string, unknown> };
  return result.ok
    ? result.value?.status
      ? { ok: true, status: result.value.status }
      : result.value?.dispatch
        ? { ok: true, dispatch: result.value.dispatch, outcome: result.value.outcome }
        : { ok: true }
    : {
        ok: false,
        code: result.error?.code,
        phase: result.error?.phase,
        retryDisposition: result.error?.retryDisposition,
        dispatch: result.error?.dispatch,
      };
};
class FakePorts implements ImagePort, VmPort, GuestPort, EvidencePort, DesktopPort {
  readonly calls: string[] = [];
  #fail(name: string, phase: Parameters<typeof cancelledError>[0]): Promise<OperationResult<never>> {
    this.calls.push(name);
    return Promise.resolve(cancelledError(phase));
  }
  ensureImage = () => this.#fail("ensureImage", "image");
  listManaged = () => {
    this.calls.push("listManaged");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "ProviderFailure" as const,
        phase: "vm" as const,
        message: "inventory",
        retryDisposition: "safe" as const,
        dispatch: "notDispatched" as const,
      },
    });
  };
  clone = () => {
    this.calls.push("clone");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "Cancelled" as const,
        phase: "vm" as const,
        message: "cancelled",
        retryDisposition: "reconcileRequired" as const,
        dispatch: "unknown" as const,
      },
    });
  };
  start = () => this.#fail("start", "vm");
  inspect = () => {
    this.calls.push("inspect");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "ProviderFailure" as const,
        phase: "vm" as const,
        message: "inspect",
        retryDisposition: "reconcileRequired" as const,
      },
    });
  };
  stop = () => {
    this.calls.push("stop");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "Cancelled" as const,
        phase: "cleanup" as const,
        message: "cancelled",
        retryDisposition: "reconcileRequired" as const,
        dispatch: "unknown" as const,
      },
    });
  };
  destroy = () => {
    this.calls.push("destroy");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "Cancelled" as const,
        phase: "cleanup" as const,
        message: "cancelled",
        retryDisposition: "reconcileRequired" as const,
        dispatch: "unknown" as const,
      },
    });
  };
  probe = () => {
    this.calls.push("probe");
    return Promise.resolve(
      ok({
        status: "notReady" as const,
        observedAt: "2026-01-01T00:00:00.000Z",
        validForMs: 1,
        durationMs: 1,
        reason: "failed",
      }),
    );
  };
  configureNetwork = () => {
    this.calls.push("configureNetwork");
    return Promise.resolve(
      ok({
        provider: "fake",
        operationId: "operation-00000001" as OperationId,
        dispatch: "dispatched" as const,
        outcome: "succeeded" as const,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  };
  resolveApplication = () => this.#fail("resolveApplication", "guest");
  startAppium = () => {
    this.calls.push("startAppium");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "ProviderFailure" as const,
        phase: "guest" as const,
        message: "start",
        retryDisposition: "safe" as const,
        dispatch: "notDispatched" as const,
      },
    });
  };
  stopAppium = () => {
    this.calls.push("stopAppium");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "CleanupFailed" as const,
        phase: "cleanup" as const,
        message: "cleanup",
        retryDisposition: "safe" as const,
      },
    });
  };
  exportDiagnostics = () => {
    this.calls.push("exportDiagnostics");
    return Promise.resolve({
      ok: false as const,
      error: {
        code: "EvidenceIncomplete" as const,
        phase: "evidence" as const,
        message: "diagnostic",
        retryDisposition: "notApplicable" as const,
      },
    });
  };
  #evidenceFailure(
    name: string,
    code: "RecoveryRequired" | "EvidenceIncomplete" | "EvidenceCorrupted",
    phase: "evidence" | "vm" | "cleanup",
  ) {
    this.calls.push(name);
    return Promise.resolve({
      ok: false as const,
      error: { code, phase, message: name, retryDisposition: "notApplicable" as const },
    });
  }
  reconcileProjections = () => this.#evidenceFailure("reconcileProjections", "RecoveryRequired", "evidence");
  recordDamagedRun = () => this.#evidenceFailure("recordDamagedRun", "RecoveryRequired", "evidence");
  listUnfinishedRuns = () => this.#evidenceFailure("listUnfinishedRuns", "RecoveryRequired", "evidence");
  preflight = () => this.#evidenceFailure("preflight", "EvidenceIncomplete", "evidence");
  recoverOrphans = () => this.#evidenceFailure("recoverOrphans", "EvidenceCorrupted", "evidence");
  append = () => this.#evidenceFailure("append", "EvidenceIncomplete", "evidence");
  commitArtifact = () => this.#evidenceFailure("commitArtifact", "EvidenceIncomplete", "evidence");
  commitManifest = () => this.#evidenceFailure("commitManifest", "EvidenceIncomplete", "evidence");
  commitRecoveryManifest = () =>
    this.#evidenceFailure("commitRecoveryManifest", "EvidenceIncomplete", "evidence");
  readTimeline = () => this.#evidenceFailure("readTimeline", "EvidenceCorrupted", "evidence");
  readManagedResource = () => this.#evidenceFailure("readManagedResource", "RecoveryRequired", "vm");
  writeManagedResource = () =>
    this.#evidenceFailure("writeManagedResource", "EvidenceIncomplete", "evidence");
  clearManagedResource = () => this.#evidenceFailure("clearManagedResource", "RecoveryRequired", "cleanup");
  startSession = () => this.#fail("startSession", "driver");
  observe = () => this.#fail("observe", "driver");
  dispatch = () => this.#fail("dispatch", "driver");
  rebind = () => {
    this.calls.push("rebind");
    return cancelledError("driver");
  };
  evaluate = () => this.#fail("evaluate", "driver");
  compact = () => {
    this.calls.push("compact");
    return "fake";
  };
  query = () => {
    this.calls.push("query");
    return cancelledError("driver");
  };
  queryPage = () => {
    this.calls.push("queryPage");
    return cancelledError("driver");
  };
  expand = () => {
    this.calls.push("expand");
    return cancelledError("driver");
  };
  stopSession = () => this.#fail("stopSession", "cleanup");
}

const normalizedResultProfile = <T>(
  name: string,
  invoke: () => Promise<readonly ({ ok: true; value: T } | { ok: false; error: unknown })[]>,
  parseSuccess: (value: T) => unknown,
): void => {
  it(name, async () => {
    const results = await invoke();
    expect(results.length).toBeGreaterThan(1);
    for (const result of results)
      if (result.ok) expect(() => parseSuccess(result.value)).not.toThrow();
      else expect(OperationErrorSchema.safeParse(result.error).success).toBe(true);
  });
};

describe("shared semantic Port profile", () => {
  it("runs the Gateway FakePlatform through the shared Adapter profile", async () => {
    const fake = new FakePlatform();
    const signal = new AbortController().signal;
    const runId = "run-00000001" as RunId;
    const observation: Observation = {
      runId,
      environmentId: "environment-test",
      generation: 1,
      observationId: "observation-00000001" as ObservationId,
      sessionId: "session-00000001" as SessionId,
      windowId: "window-00000001" as WindowId,
      capturedAt: "2026-01-01T00:00:00.000Z",
      screenshotScope: "window",
      coverage: "complete",
      screenshot: { artifactId: "artifact-00000001" as ArtifactId, sha256: "a".repeat(64) },
      uiSnapshot: { artifactId: "artifact-00000002" as ArtifactId, sha256: "b".repeat(64) },
      elements: [{ elementId: "element-00000001" as ElementId, role: "button", name: "Save" }],
    };
    const compatibility = {
      buildIdentity: "fixture-build-1",
      bundleId: "com.example.App",
      compatibility: {
        appiumMajor: 3 as const,
        appium: "3.7.0",
        mac2: "4.3.5",
        wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
        guestMacOS: "26.0",
        xcode: "26.0",
        fixtureBuild: "1",
      },
    };
    const values = await Promise.all([
      fake.ensureImage(
        { reference: "registry.example/project/image", digest: `sha256:${"a".repeat(64)}` },
        signal,
      ),
      fake.listManaged(signal),
      fake.clone(
        { runId, image: "registry.example/project/image", digest: `sha256:${"a".repeat(64)}` },
        signal,
      ),
      fake.start({ resourceId: runId, network: [] }, signal),
      fake.inspect(runId, signal),
      fake.stop(runId, signal),
      fake.destroy({ resourceId: runId, runId }, signal),
      fake.probe(runId, compatibility, signal),
      fake.configureNetwork(runId, [], signal),
      fake.resolveApplication(runId, { name: "Fixture" }, signal),
      fake.startAppium(runId, signal),
      fake.stopAppium(runId, signal),
      fake.exportDiagnostics(runId, { maxFileBytes: 1, maxTotalBytes: 1 }, signal),
      fake.startSession(
        {
          channelId: "operation-00000001" as OperationId,
          bundleId: "com.example.Fixture",
          window: { isMain: true },
        },
        signal,
      ),
      fake.stopSession(signal),
      fake.observe(
        {
          runId,
          generation: 1,
          observationId: observation.observationId,
          sessionId: observation.sessionId,
          windowId: observation.windowId,
        },
        signal,
      ),
      fake.dispatch({ kind: "pressKey", key: "enter" }, "operation-00000001" as OperationId, signal),
      Promise.resolve(fake.rebind({ kind: "pressKey", key: "enter" }, observation)),
      fake.evaluate({ kind: "visible", query: { role: "button" } }, observation, signal),
      Promise.resolve(fake.query(observation, { role: "button" })),
      Promise.resolve(fake.queryPage(observation, { role: "button" }, 0, 10)),
      Promise.resolve(fake.expand(observation, "element-00000001" as ElementId)),
    ]);
    expect(fake.compact(observation)).toContain(observation.observationId);
    for (const value of values) expect(value.ok).toBe(true);
    expect(fake.destroyed).toBe(true);
    expect(fake.stoppedAppium).toBe(true);
  });
  it("runs every DesktopPort operation through the same Fake/production semantic harness", async () => {
    const fake = new FakePlatform();
    const production = new Mac2DesktopAdapter(
      async () => {
        throw new Error("transport");
      },
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
      ids,
    );
    const runId = "run-00000001" as RunId;
    const observation: Observation = {
      runId,
      environmentId: "environment-00000001",
      generation: 1,
      observationId: "observation-00000001" as ObservationId,
      sessionId: "session-00000001" as SessionId,
      windowId: "window-00000001" as WindowId,
      capturedAt: "2026-01-01T00:00:00.000Z",
      screenshotScope: "window",
      coverage: "complete",
      screenshot: { artifactId: "artifact-00000001" as ArtifactId, sha256: "a".repeat(64) },
      uiSnapshot: { artifactId: "artifact-00000002" as ArtifactId, sha256: "b".repeat(64) },
      elements: [],
    };
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    const request = {
      channelId: "operation-00000001" as OperationId,
      bundleId: "com.example.Fixture",
      window: { title: { exact: "Main" } },
    };
    const observeRequest = {
      runId,
      generation: 1,
      observationId: observation.observationId,
      sessionId: observation.sessionId,
      windowId: observation.windowId,
    };
    const action = { kind: "pressKey" as const, key: "enter" as const };
    const assertion = { kind: "visible" as const, query: { role: "button" } };
    const invocations = (port: DesktopPort): unknown[] => [
      port.startSession(request, cancelled.signal),
      port.observe(observeRequest, cancelled.signal),
      port.dispatch(action, "operation-00000001" as OperationId, cancelled.signal),
      port.rebind(action, observation),
      port.evaluate(assertion, observation, cancelled.signal),
      port.compact(observation),
      port.query(observation, { role: "button" }),
      port.queryPage?.(observation, { role: "button" }, 0, 10),
      port.expand(observation, "element-00000001" as ElementId),
      port.stopSession(cancelled.signal),
    ];
    const fakeValues = await Promise.all(invocations(fake).map((value) => Promise.resolve(value)));
    const productionValues = await Promise.all(
      invocations(production).map((value) => Promise.resolve(value)),
    );
    for (const value of [...fakeValues, ...productionValues]) {
      if (
        typeof value === "object" &&
        value !== null &&
        "ok" in value &&
        value.ok === false &&
        "error" in value
      )
        expect(OperationErrorSchema.safeParse(value.error).success).toBe(true);
    }
    for (let index = 0; index < fakeValues.length; index += 1) {
      const fakeValue = fakeValues[index];
      const productionValue = productionValues[index];
      expect(semantic(fakeValue)).toEqual(semantic(productionValue));
    }
  });
  it("keeps an exhaustive executable operation inventory for every Port", async () => {
    const imageMethods = ["ensureImage"] as const satisfies readonly (keyof ImagePort)[];
    const vmMethods = [
      "listManaged",
      "clone",
      "start",
      "inspect",
      "stop",
      "destroy",
    ] as const satisfies readonly (keyof VmPort)[];
    const guestMethods = [
      "probe",
      "configureNetwork",
      "resolveApplication",
      "startAppium",
      "stopAppium",
      "exportDiagnostics",
    ] as const satisfies readonly (keyof GuestPort)[];
    const evidenceMethods = [
      "reconcileProjections",
      "recordDamagedRun",
      "listUnfinishedRuns",
      "preflight",
      "recoverOrphans",
      "append",
      "commitArtifact",
      "commitManifest",
      "commitRecoveryManifest",
      "readTimeline",
      "readManagedResource",
      "writeManagedResource",
      "clearManagedResource",
    ] as const satisfies readonly (keyof EvidencePort)[];
    const desktopMethods = [
      "startSession",
      "observe",
      "dispatch",
      "rebind",
      "evaluate",
      "compact",
      "query",
      "queryPage",
      "expand",
      "stopSession",
    ] as const satisfies readonly (keyof DesktopPort)[];
    expect([
      imageMethods.length,
      vmMethods.length,
      guestMethods.length,
      evidenceMethods.length,
      desktopMethods.length,
    ]).toEqual([1, 6, 6, 13, 10]);

    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    vi.mocked(runTartProcess).mockResolvedValue({ code: null, stdout: "", stderr: "", aborted: true });
    vi.mocked(runGuestProcess).mockResolvedValue({ code: null, stdout: "", stderr: "", aborted: true });
    const root = await mkdtemp(join(tmpdir(), "mcu-port-exhaustive-"));
    roots.push(root);
    const tart = new TartAdapter("tart", ids);
    const guest = new TartExecGuestAdapter("tart", undefined, undefined, ids);
    const evidence = new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 1000);
    const digest = `sha256:${"a".repeat(64)}`;
    const runId = "run-00000001" as RunId;
    const event = {
      schemaVersion: 1 as const,
      runId,
      sequence: 1,
      recordedAt: "2026-01-01T00:00:00.000Z",
      elapsedMs: 0,
      type: "RunStarted" as const,
      source: "kernel" as const,
      data: { mode: "interactive" as const },
    };
    const result = {
      verdict: "inconclusive" as const,
      evidence: "incomplete" as const,
      cleanup: "failed" as const,
    };
    const receipt = {
      provider: "fake",
      operationId: "operation-00000001" as OperationId,
      dispatch: "notDispatched" as const,
      outcome: "unknown" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const manifest = {
      schemaVersion: 1 as const,
      revision: 1,
      runId,
      buildVersion: "test",
      eventCount: 0,
      timelineSha256: "a".repeat(64),
      result,
      artifacts: [],
    };
    const compatibility = {
      buildIdentity: "fixture-build-1",
      bundleId: "com.example.Fixture",
      compatibility: {
        appiumMajor: 3 as const,
        appium: "3.7.0",
        mac2: "4.3.5",
        wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
        guestMacOS: "26.0",
        xcode: "26.0",
        fixtureBuild: "1",
      },
    };
    const invocations: Promise<unknown>[] = [
      tart.ensureImage({ reference: "registry.example/project/image", digest }, cancelled.signal),
      tart.listManaged(cancelled.signal),
      tart.clone({ runId, image: "registry.example/project/image", digest }, cancelled.signal),
      tart.start({ resourceId: runId, network: [] }, cancelled.signal),
      tart.inspect(runId, cancelled.signal),
      tart.stop(runId, cancelled.signal),
      tart.destroy({ resourceId: runId, runId }, cancelled.signal),
      guest.probe(runId, compatibility, cancelled.signal),
      guest.configureNetwork(runId, [], cancelled.signal),
      guest.resolveApplication(runId, { name: "Fixture" }, cancelled.signal),
      guest.startAppium(runId, cancelled.signal),
      guest.stopAppium(runId, cancelled.signal),
      guest.exportDiagnostics(runId, { maxFileBytes: 1, maxTotalBytes: 1 }, cancelled.signal),
      evidence.reconcileProjections(cancelled.signal),
      evidence.recordDamagedRun(runId, "test", "failed", cancelled.signal),
      evidence.listUnfinishedRuns(cancelled.signal),
      evidence.preflight(runId, cancelled.signal),
      evidence.recoverOrphans(runId, cancelled.signal),
      evidence.append(event, cancelled.signal),
      evidence.commitArtifact(
        { runId, type: "test", mimeType: "text/plain", sensitivity: "normal", bytes: new Uint8Array() },
        cancelled.signal,
      ),
      evidence.commitManifest(manifest, cancelled.signal),
      evidence.commitRecoveryManifest(runId, "test", result, [], cancelled.signal),
      evidence.readTimeline(runId, cancelled.signal),
      evidence.readManagedResource(cancelled.signal),
      evidence.writeManagedResource(
        { schemaVersion: 1, runId, resourceId: runId, imageDigest: digest, phase: "clonePlanned" },
        cancelled.signal,
      ),
      evidence.clearManagedResource(cancelled.signal),
    ];
    const productionValues = await Promise.all(invocations);
    const methodNames = [...imageMethods, ...vmMethods, ...guestMethods, ...evidenceMethods];
    const fake = new FakePorts();
    const fakeValues = methodNames.map((method) => {
      const operation = fake[method];
      if (typeof operation !== "function") throw new Error(`Missing Fake operation ${method}`);
      return (operation as (this: FakePorts) => unknown).call(fake);
    });
    expect(fake.calls).toEqual(methodNames);
    for (const [index, pending] of fakeValues.entries()) {
      const fakeValue = await Promise.resolve(pending);
      const productionValue = productionValues[index];
      expect(semantic(fakeValue)).toEqual(semantic(productionValue));
    }
    for (const value of [
      ...productionValues,
      ...(await Promise.all(fakeValues.map((value) => Promise.resolve(value)))),
    ]) {
      expect(typeof value).toBe("object");
      if (
        typeof value === "object" &&
        value !== null &&
        "ok" in value &&
        value.ok === false &&
        "error" in value
      )
        expect(OperationErrorSchema.safeParse(value.error).success).toBe(true);
    }
    expect(receipt.provider).toBe("fake");
  });
  it("applies the same normalized error and pre-cancellation rules to every Port family", async () => {
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled"));
    vi.mocked(runTartProcess).mockResolvedValue({ code: null, stdout: "", stderr: "", aborted: true });
    vi.mocked(runGuestProcess).mockResolvedValue({ code: null, stdout: "", stderr: "", aborted: true });
    const root = await mkdtemp(join(tmpdir(), "mcu-port-errors-"));
    roots.push(root);
    const error = {
      code: "Cancelled" as const,
      phase: "vm" as const,
      message: "cancelled",
      retryDisposition: "safe" as const,
      dispatch: "notDispatched" as const,
    };
    const invocations = [
      {
        fake: async () => ({ ok: false as const, error }),
        production: () =>
          new TartAdapter("tart", ids).ensureImage(
            { reference: "registry.example/project/image", digest: `sha256:${"a".repeat(64)}` },
            cancelled.signal,
          ),
      },
      {
        fake: async () => ({ ok: false as const, error }),
        production: () => new TartAdapter("tart", ids).inspect("run-00000001", cancelled.signal),
      },
      {
        fake: async () => ({ ok: false as const, error }),
        production: () =>
          new TartExecGuestAdapter().probe(
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
            cancelled.signal,
          ),
      },
      {
        fake: async () => ({ ok: false as const, error }),
        production: () =>
          new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 1000).preflight(
            "run-00000001" as RunId,
            cancelled.signal,
          ),
      },
    ];
    for (const invocation of invocations)
      for (const result of await Promise.all([invocation.fake(), invocation.production()]))
        if (!result.ok) expect(OperationErrorSchema.safeParse(result.error).success).toBe(true);
  });
  normalizedResultProfile(
    "validates Fake and Tart ImagePort receipts with the same contract",
    async () => {
      vi.mocked(runTartProcess).mockResolvedValue({
        code: 0,
        stdout: JSON.stringify([
          { Source: "OCI", Name: `registry.example/project/image@sha256:${"a".repeat(64)}` },
        ]),
        stderr: "",
        aborted: false,
      });
      const ports: ImagePort[] = [
        {
          ensureImage: async () =>
            ok({
              provider: "fake",
              operationId: "operation-00000001" as OperationId,
              dispatch: "dispatched",
              outcome: "succeeded",
              startedAt: "2026-01-01T00:00:00.000Z",
            }),
        },
        new TartAdapter("tart", ids),
      ];
      const results = await Promise.all(
        ports.map((port) =>
          port.ensureImage(
            { reference: "registry.example/project/image", digest: `sha256:${"a".repeat(64)}` },
            new AbortController().signal,
          ),
        ),
      );
      return results;
    },
    (value) => ProviderReceiptSchema.parse(value),
  );

  normalizedResultProfile(
    "validates Fake and Tart VmPort status with the same contract",
    async () => {
      vi.mocked(runTartProcess).mockResolvedValue({
        code: 0,
        stdout: JSON.stringify({ State: "running" }),
        stderr: "",
        aborted: false,
      });
      const fake = {
        inspect: async () => ok({ exists: true, state: "running" as const }),
      } as unknown as VmPort;
      const ports: VmPort[] = [fake, new TartAdapter("tart", ids)];
      const results = await Promise.all(
        ports.map((port) => port.inspect("run-00000001", new AbortController().signal)),
      );
      return results;
    },
    (value) => VmStatusSchema.parse(value),
  );

  normalizedResultProfile(
    "validates Fake and Tart-exec GuestPort probes with the same contract",
    async () => {
      const outputs = [
        "26.0",
        "Xcode 26.0\nBuild version 17A",
        "3.7.0",
        JSON.stringify({ mac2: { version: "4.3.5" } }),
        "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
        "fixture-build-1",
        JSON.stringify({ bundleId: "com.example.Fixture", build: "1" }),
        "123",
      ];
      for (const stdout of outputs)
        vi.mocked(runGuestProcess).mockResolvedValueOnce({ code: 0, stdout, stderr: "", aborted: false });
      const expected = {
        buildIdentity: "fixture-build-1",
        bundleId: "com.example.Fixture",
        compatibility: {
          appiumMajor: 3 as const,
          appium: "3.7.0",
          mac2: "4.3.5",
          wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
          guestMacOS: "26.0",
          xcode: "26.0",
          fixtureBuild: "1",
        },
      };
      const fake = {
        probe: async () =>
          ok({
            status: "ready" as const,
            observedAt: new Date().toISOString(),
            validForMs: 1,
            durationMs: 1,
          }),
      } as unknown as GuestPort;
      const ports: GuestPort[] = [fake, new TartExecGuestAdapter()];
      const results = await Promise.all(
        ports.map((port) => port.probe("run-00000001", expected, new AbortController().signal)),
      );
      return results;
    },
    (value) => ProbeResultSchema.parse(value),
  );

  normalizedResultProfile(
    "validates Fake and local EvidencePort preflight with the same contract",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mcu-port-profile-"));
      roots.push(root);
      const fake = { preflight: async () => ok(undefined) } as unknown as EvidencePort;
      const ports: EvidencePort[] = [
        fake,
        new LocalEvidenceAdapter(join(root, "evidence"), join(root, "state"), 1000),
      ];
      const results = await Promise.all(
        ports.map((port) => port.preflight("run-00000001" as RunId, new AbortController().signal)),
      );
      return results;
    },
    (value) => value,
  );

  normalizedResultProfile(
    "validates Mac2 DesktopPort receipt through the shared result contract",
    async () => {
      const xml = `<?xml version="1.0"?><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeWindow type="XCUIElementTypeWindow" title="Main" focused="true"/></XCUIElementTypeApplication>`;
      const fetcher: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === "string" ? init.body : "";
        const value = url.endsWith("/session")
          ? { sessionId: "native", value: { sessionId: "native" } }
          : url.endsWith("/source")
            ? { value: xml }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "window" }] }
              : body.includes("queryAppState")
                ? { value: 4 }
                : { value: null };
        return new Response(JSON.stringify(value), { status: 200 });
      };
      const production = new Mac2DesktopAdapter(
        fetcher,
        undefined,
        undefined,
        () => ({ endpoint: "http://guest:4723", elementOriginActions: true }),
        ids,
      );
      const fake = {
        startSession: async () =>
          ok({
            provider: "fake-desktop",
            operationId: "operation-00000001" as OperationId,
            dispatch: "dispatched" as const,
            outcome: "succeeded" as const,
            startedAt: "2026-01-01T00:00:00.000Z",
          }),
      };
      const request = {
        channelId: "operation-00000001" as OperationId,
        bundleId: "com.example.Fixture",
        window: { title: { exact: "Main" } },
      };
      return Promise.all([
        fake.startSession(),
        production.startSession(request, new AbortController().signal),
      ]);
    },
    (value) => ProviderReceiptSchema.parse(value),
  );
});
