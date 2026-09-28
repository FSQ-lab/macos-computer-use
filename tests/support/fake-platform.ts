import {
  ok,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type ElementQuery,
  type GuestPort,
  type ImagePort,
  type Observation,
  type OperationId,
  type ProviderReceipt,
  type VmPort,
} from "../../src/contracts/index.js";

export const fakeReceipt = (operationId = "operation-00000001" as OperationId): ProviderReceipt => ({
  provider: "fake",
  operationId,
  dispatch: "dispatched",
  outcome: "succeeded",
  startedAt: "2026-09-21T00:00:00.000Z",
  finishedAt: "2026-09-21T00:00:01.000Z",
});

export class FakePlatform implements ImagePort, VmPort, GuestPort, DesktopPort {
  imageRequest: Parameters<ImagePort["ensureImage"]>[0] | undefined;
  destroyed = false;
  stoppedAppium = false;
  failSessionCleanup = false;
  assertionStatus: "passed" | "failed" | "unverifiable" = "passed";
  sessionRequest: Parameters<DesktopPort["startSession"]>[0] | undefined;
  #ignore(..._values: unknown[]): void {
    void _values;
  }
  async ensureImage(request: Parameters<ImagePort["ensureImage"]>[0], signal?: AbortSignal) {
    this.#ignore(signal);
    this.imageRequest = request;
    return ok(fakeReceipt());
  }
  async listManaged(
    signal?: AbortSignal,
  ): Promise<ReturnType<VmPort["listManaged"]> extends Promise<infer T> ? T : never> {
    this.#ignore(signal);
    return ok([] as readonly string[]);
  }
  async clone(request: Parameters<VmPort["clone"]>[0], signal?: AbortSignal) {
    this.#ignore(signal);
    return ok({ resourceId: request.runId, receipt: fakeReceipt() });
  }
  async start(request?: unknown, signal?: AbortSignal) {
    this.#ignore(request, signal);
    return ok(fakeReceipt());
  }
  async inspect(resourceId?: string, signal?: AbortSignal) {
    this.#ignore(resourceId, signal);
    return ok({ exists: true, state: "running" as const });
  }
  async stop(resourceId?: string, signal?: AbortSignal) {
    this.#ignore(resourceId, signal);
    return ok(fakeReceipt());
  }
  async destroy(request?: unknown, signal?: AbortSignal) {
    this.#ignore(request, signal);
    this.destroyed = true;
    return ok(fakeReceipt());
  }
  async probe(resourceId?: string, expected?: unknown, signal?: AbortSignal) {
    this.#ignore(resourceId, expected, signal);
    return ok({
      status: "ready" as const,
      observedAt: "2026-09-21T00:00:00.000Z",
      validForMs: 5000,
      durationMs: 1,
      actual: {
        guestMacOS: "26.0",
        xcode: "26.0",
        appium: "3.7.0",
        mac2: "4.3.5",
        wdaSha256: "094e95c782c034d5755a4056e55ae6e98284e9f2339f15b210a1309c4f46b733",
        buildIdentity: "fixture-build-1",
        fixtureBuild: "1",
        bundleId: "com.example.App",
        windowServerReady: true,
      },
    });
  }
  async configureNetwork(resourceId?: string, rules?: unknown, signal?: AbortSignal) {
    this.#ignore(resourceId, rules, signal);
    return ok(fakeReceipt());
  }
  resolveApplication(
    resourceId?: string,
    target?: { name: string },
    signal?: AbortSignal,
  ): ReturnType<GuestPort["resolveApplication"]> {
    this.#ignore(resourceId, signal);
    return Promise.resolve(
      ok({
        name: target?.name ?? "App",
        bundleId: "com.example.App",
        version: "1.0",
        build: "1",
        location: "system" as const,
      }),
    );
  }
  async startAppium(resourceId?: string, signal?: AbortSignal) {
    this.#ignore(resourceId, signal);
    return ok({ channelId: "operation-00000002" as OperationId, receipt: fakeReceipt() });
  }
  async stopAppium(resourceId?: string, signal?: AbortSignal) {
    this.#ignore(resourceId, signal);
    this.stoppedAppium = true;
    return ok(fakeReceipt());
  }
  async exportDiagnostics(resourceId?: string, limits?: unknown, signal?: AbortSignal) {
    this.#ignore(resourceId, limits, signal);
    return ok(
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          compatibility: { appium: "3.7.0", mac2: "4.3.5" },
          events: [],
          snapshot: {
            capturedAt: "2026-09-21T00:00:00.000Z",
            observedBeforeCleanup: true,
            appiumStatus: "ready",
            wdaStatus: "ready",
            activeSessionCount: 1,
            processes: { appium: true, xcodebuild: true, wda: true },
          },
        }),
      ),
    );
  }
  async startSession(request: Parameters<DesktopPort["startSession"]>[0], signal?: AbortSignal) {
    this.#ignore(signal);
    this.sessionRequest = request;
    if (signal?.aborted)
      return {
        ok: false as const,
        error: {
          code: "Cancelled" as const,
          phase: "driver" as const,
          message: "cancelled",
          retryDisposition: "safe" as const,
          dispatch: "unknown" as const,
        },
      };
    return ok(fakeReceipt());
  }
  async stopSession(signal?: AbortSignal) {
    this.#ignore(signal);
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
      : ok(fakeReceipt());
  }
  async dispatch(_action: DesktopAction, operationId: OperationId, _signal: AbortSignal) {
    if (_signal.aborted)
      return {
        ok: false as const,
        error: {
          code: "Cancelled" as const,
          phase: "action" as const,
          message: "cancelled",
          retryDisposition: "reconcileRequired" as const,
          dispatch: "unknown" as const,
        },
      };
    return ok(fakeReceipt(operationId));
  }
  rebind(action: DesktopAction, _observation?: Observation) {
    this.#ignore(_observation);
    return ok(action);
  }
  async observe(request: Parameters<DesktopPort["observe"]>[0], signal?: AbortSignal) {
    if (signal?.aborted)
      return {
        ok: false as const,
        error: {
          code: "Cancelled" as const,
          phase: "observe" as const,
          message: "cancelled",
          retryDisposition: "safe" as const,
        },
      };
    const observation: Omit<Observation, "screenshot" | "uiSnapshot"> = {
      observationId: request.observationId,
      runId: request.runId,
      environmentId: "environment-test",
      generation: request.generation,
      sessionId: request.sessionId,
      windowId: request.windowId,
      capturedAt: "2026-09-21T00:00:00.000Z",
      screenshotScope: "window",
      coverage: "complete",
      elements: [
        {
          elementId: "element-00000001" as Observation["elements"][number]["elementId"],
          role: "button",
          name: "Save",
          visible: true,
          enabled: true,
          geometry: { x: 0, y: 0, width: 100, height: 40 },
        },
      ],
    };
    return ok({
      observation,
      screenshot: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      snapshot: new TextEncoder().encode("{}"),
    });
  }
  async evaluate(assertion: AssertionSpec, observation?: Observation, signal?: AbortSignal) {
    this.#ignore(signal);
    if (!observation?.elements.length)
      return ok({ status: "failed" as const, reason: "Assertion target is not unique." });
    return ok({
      status: assertion.kind === "visible" ? this.assertionStatus : ("unverifiable" as const),
      reason: "fake",
    });
  }
  preflightAssertion(_assertion: AssertionSpec, _observation: Observation) {
    this.#ignore(_assertion, _observation);
    return ok({ status: "admissible" as const, reason: "fake" });
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
  queryPage(observation: Observation, query: ElementQuery, offset: number, limit: number) {
    void offset;
    void limit;
    const result = this.query(observation, query);
    const element = observation.elements.find((item) => !query.role || item.role === query.role);
    if (result.ok && element)
      return ok({
        status: "unique" as const,
        observationId: observation.observationId,
        count: 1,
        candidates: [element],
        reference: result.value,
      });
    if (!result.ok && result.error.code === "TargetNotFound")
      return ok({
        status: "notFound" as const,
        observationId: observation.observationId,
        count: 0,
        candidates: [],
      });
    return {
      ok: false as const,
      error: result.ok
        ? {
            code: "TargetNotFound" as const,
            phase: "observe" as const,
            message: "not found",
            retryDisposition: "safe" as const,
          }
        : result.error,
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
