import { describe, expect, it } from "vitest";
import {
  PiTaskSession,
  AGENT_TASK_PROTOCOL_VERSION,
  type TaskResponse,
} from "../src/pi-extension/runtime/index.js";
import type { ClientRun } from "../src/client/index.js";
import type { PiMacOSComputerUseClient } from "../src/client/client.js";
import { ok, type DesktopAction, type LeaseId, type Observation } from "../src/index.js";

const taskId = "task-0123456789abcdef01234567";
const request = (sequence: number, type: string, extra: Record<string, unknown> = {}) => ({
  protocolVersion: AGENT_TASK_PROTOCOL_VERSION,
  taskId,
  requestId: `req-${String(sequence).padStart(16, "0")}`,
  sequence,
  type,
  ...extra,
});

const postActionObservation = (): Observation => ({
  observationId: "observation-00000002" as never,
  runId: "run-00000001" as never,
  environmentId: "environment-1",
  generation: 1,
  sessionId: "session-00000001" as never,
  windowId: "window-00000001" as never,
  capturedAt: "2026-09-23T00:00:01.000Z",
  screenshotScope: "window",
  screenshot: { artifactId: "artifact-00000003" as never, sha256: "c".repeat(64) },
  uiSnapshot: { artifactId: "artifact-00000004" as never, sha256: "d".repeat(64) },
  coverage: "complete",
  elements: [],
});

const fakeRun = (): ClientRun => ({
  leaseId: "lease-00000001" as LeaseId,
  currentObservation: () =>
    ok({
      observationId: "observation-00000001" as never,
      runId: "run-00000001" as never,
      environmentId: "environment-1",
      generation: 1,
      sessionId: "session-00000001" as never,
      windowId: "window-00000001" as never,
      capturedAt: "2026-09-23T00:00:00.000Z",
      screenshotScope: "window",
      screenshot: { artifactId: "artifact-00000001" as never, sha256: "a".repeat(64) },
      uiSnapshot: { artifactId: "artifact-00000002" as never, sha256: "b".repeat(64) },
      coverage: "complete",
      elements: [],
    }),
  observe: async () =>
    ok({
      observationId: "observation-00000001" as never,
      runId: "run-00000001" as never,
      environmentId: "environment-1",
      generation: 1,
      sessionId: "session-00000001" as never,
      windowId: "window-00000001" as never,
      capturedAt: "2026-09-23T00:00:00.000Z",
      screenshotScope: "window",
      screenshot: { artifactId: "artifact-00000001" as never, sha256: "a".repeat(64) },
      uiSnapshot: { artifactId: "artifact-00000002" as never, sha256: "b".repeat(64) },
      coverage: "complete",
      elements: [
        {
          elementId: "element-00000001" as never,
          role: "button",
          nativeRole: "AXButton",
          name: "Save",
          geometry: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
    }),
  assert: async () =>
    ok({
      assertionId: "assertion-00000001" as never,
      status: "passed",
      observationId: "observation-00000001" as never,
      observationRef: { artifactId: "artifact-00000002" as never, sha256: "b".repeat(64) },
      reason: "ok",
    }),
  assertCurrent: async () =>
    ok({
      assertionId: "assertion-00000001" as never,
      status: "passed",
      observationId: "observation-00000001" as never,
      observationRef: { artifactId: "artifact-00000002" as never, sha256: "b".repeat(64) },
      reason: "ok",
    }),
  freezeFinalAssertions: async () => ok({ frozen: true as const }),
  query: () =>
    ok({
      runId: "run-00000001" as never,
      environmentId: "environment-1",
      generation: 1,
      sessionId: "session-00000001" as never,
      windowId: "window-00000001" as never,
      observationId: "observation-00000001" as never,
      elementId: "element-00000001" as never,
    }),
  queryPage: () =>
    ok({
      status: "unique",
      observationId: "observation-00000001" as never,
      count: 1,
      candidates: [{ elementId: "element-00000001" as never, role: "button", name: "Save" }],
      reference: {
        runId: "run-00000001" as never,
        environmentId: "environment-1",
        generation: 1,
        sessionId: "session-00000001" as never,
        windowId: "window-00000001" as never,
        observationId: "observation-00000001" as never,
        elementId: "element-00000001" as never,
      },
    }),
  compact: () => ok("button Save"),
  expand: () =>
    ok({
      elementId: "element-00000001" as never,
      role: "button",
      nativeRole: "AXButton",
      name: "Save",
      geometry: { x: 1, y: 2, width: 3, height: 4 },
    }),
  action: async () =>
    ok({
      result: {
        dispatch: "dispatched",
        providerOutcome: "succeeded",
        verification: "confirmed",
        retryDisposition: "unsafe",
      },
      sequence: 4,
      after: postActionObservation(),
      artifacts: [{ relativePath: "secret/path" } as never],
      evidenceComplete: true,
    }),
});

const fakeClient = (run = fakeRun()): Pick<PiMacOSComputerUseClient, "recover" | "runForApplication"> => ({
  recover: async () => ok({ status: "clean" }),
  runForApplication: async (application, options, callback) => {
    try {
      void application;
      await callback(run);
      return ok({
        runId: "run-00000001" as never,
        result: { verdict: "passed", evidence: "complete", cleanup: "completed" },
      });
    } catch {
      return ok({
        runId: "run-00000001" as never,
        result: { verdict: "inconclusive", evidence: "complete", cleanup: "completed" },
      });
    } finally {
      void options;
    }
  },
});

const call = async (session: PiTaskSession, message: unknown): Promise<TaskResponse> => {
  let response: TaskResponse | undefined;
  session.accept(message, (value) => {
    response = value;
  });
  for (let attempt = 0; attempt < 20 && !response; attempt += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (!response) throw new Error("No task response.");
  return response;
};

describe("PiTaskSession", () => {
  it("requires one immutable assertion freeze before normal finish", async () => {
    const session = new PiTaskSession(fakeClient());
    const begun = await call(session, request(1, "begin", { application: { name: "Fixture" } }));
    expect(begun).toMatchObject({
      ok: true,
      value: { kind: "begun", observationId: "observation-00000001", compact: "button Save" },
    });
    expect(await call(session, request(2, "finish"))).toMatchObject({
      ok: false,
      error: { code: "TaskState" },
    });
    expect(
      await call(
        session,
        request(3, "freezeAssertions", {
          assertions: [{ kind: "visible", query: { role: "button" } }],
        }),
      ),
    ).toMatchObject({ ok: true, value: { kind: "assertionsFrozen", count: 1 } });
    expect(
      await call(
        session,
        request(4, "freezeAssertions", {
          assertions: [{ kind: "visible", query: { role: "button" } }],
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "TaskState" } });
    expect(await call(session, request(5, "finish"))).toMatchObject({
      ok: true,
      value: { kind: "finished" },
    });
  });

  it("projects safe logical values and strips artifacts, native roles, and geometry", async () => {
    const session = new PiTaskSession(fakeClient());
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    const query = await call(session, request(2, "query", { query: { role: "button" } }));
    expect(query).toMatchObject({
      ok: true,
      value: { kind: "query", element: { role: "button", name: "Save" } },
    });
    expect(JSON.stringify(query)).not.toMatch(/nativeRole|geometry|artifact|relativePath/);
    const action = await call(
      session,
      request(3, "action", {
        target: { role: "button" },
        action: { kind: "click" },
        assertions: [],
      }),
    );
    expect(action).toMatchObject({
      ok: true,
      value: {
        kind: "action",
        sequence: 4,
        evidenceComplete: true,
        observationId: "observation-00000002",
        compact: "button Save",
      },
    });
    expect(JSON.stringify(action)).not.toMatch(/artifact|relativePath|after/);
    await call(session, request(4, "finish"));
  });

  it("fails closed on sequence violation and refuses later dispatch", async () => {
    let dispatched = 0;
    const run = fakeRun();
    run.action = async () => {
      dispatched += 1;
      return ok({
        result: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "confirmed",
          retryDisposition: "unsafe",
        },
        sequence: 1,
      });
    };
    const session = new PiTaskSession(fakeClient(run));
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    const violation = await call(session, request(3, "observe"));
    expect(violation).toMatchObject({ ok: false, error: { code: "SequenceViolation" } });
    session.accept(
      request(2, "action", { target: { role: "button" }, action: { kind: "click" } }),
      () => undefined,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toBe(0);
  });

  it("revokes authority when a mutating operation throws with unknown outcome", async () => {
    const run = fakeRun();
    run.action = async () => {
      throw new Error("/private/secret/path provider stack");
    };
    const session = new PiTaskSession(fakeClient(run));
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    const failed = await call(
      session,
      request(2, "action", { target: { role: "button" }, action: { kind: "click" } }),
    );
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "InternalError", message: "Task operation failed safely." },
    });
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(session.state).toBe("revoked");
  });

  it("returns a bounded protocol error before revoking malformed IPC", async () => {
    const session = new PiTaskSession(fakeClient());
    const response = await call(session, { protocolVersion: 99, arbitrary: "value" });
    expect(response).toMatchObject({ ok: false, type: "protocolError", error: { code: "InvalidMessage" } });
    expect(session.state).toBe("revoked");
  });

  it("revokes dispatch authority when its heartbeat lease expires", async () => {
    let now = 100;
    const session = new PiTaskSession(fakeClient(), () => now, 50);
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    now = 151;
    expect(session.expireLease()).toBe(true);
    expect(session.state).toBe("revoked");
  });

  it("materializes every bounded action family through logical element queries", async () => {
    const captured: DesktopAction[] = [];
    const run = fakeRun();
    run.action = async (action) => {
      captured.push(action);
      return ok({
        result: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "notRequested",
          retryDisposition: "unsafe",
        },
        sequence: captured.length,
        after: postActionObservation(),
      });
    };
    const session = new PiTaskSession(fakeClient(run));
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    const actions = [
      { target: { role: "button" }, action: { kind: "doubleClick" } },
      { target: { role: "button" }, action: { kind: "scroll", delta: { x: 0, y: 1 } } },
      { target: { role: "button" }, action: { kind: "swipe", direction: "down" } },
      { action: { kind: "typeText", value: { literal: "safe" } } },
      { target: { role: "button" }, action: { kind: "drag", destination: { role: "button" } } },
      { action: { kind: "pressKey", key: "enter" } },
    ];
    for (const [index, action] of actions.entries())
      await call(session, request(index + 2, "action", action));
    expect(captured.map((action) => action.kind)).toEqual([
      "doubleClick",
      "scroll",
      "swipe",
      "typeText",
      "drag",
      "pressKey",
    ]);
    await call(session, request(actions.length + 2, "finish"));
  });

  it("runs recovery before begin and returns final cleanup status", async () => {
    const order: string[] = [];
    const client = fakeClient();
    client.recover = async () => {
      order.push("recover");
      return ok({ status: "clean" });
    };
    const originalRun = client.runForApplication;
    client.runForApplication = async (application, options, callback) => {
      order.push("run");
      return originalRun(application, options, callback);
    };
    const session = new PiTaskSession(client);
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    await call(
      session,
      request(2, "freezeAssertions", {
        assertions: [{ kind: "visible", query: { role: "button" } }],
      }),
    );
    const finished = await call(session, request(3, "finish"));
    expect(order).toEqual(["recover", "run"]);
    expect(finished).toMatchObject({
      ok: true,
      value: { kind: "finished", result: { cleanup: "completed" } },
    });
  });

  it("cannot become active after revocation during pending recovery", async () => {
    let releaseRecovery: (() => void) | undefined;
    const recovery = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const client = fakeClient();
    client.recover = async () => {
      await recovery;
      return ok({ status: "clean" });
    };
    const session = new PiTaskSession(client);
    const pending = call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    session.revoke("owner lost");
    releaseRecovery?.();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "SupervisionLost" },
    });
    expect(session.state).toBe("revoked");
  });

  it("revokes when Client reports unknown action dispatch", async () => {
    const run = fakeRun();
    run.action = async () => ({
      ok: false,
      error: {
        code: "ProviderTimeout",
        phase: "action",
        message: "unknown dispatch",
        retryDisposition: "reconcileRequired",
        dispatch: "unknown",
      },
    });
    const session = new PiTaskSession(fakeClient(run));
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    const result = await call(
      session,
      request(2, "action", { target: { role: "button" }, action: { kind: "click" } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "ClientFailure" } });
    expect(session.state).toBe("revoked");
  });

  it("does not report success when an ActionResult remains unknown", async () => {
    const run = fakeRun();
    run.action = async () =>
      ok({
        result: {
          dispatch: "unknown",
          providerOutcome: "unknown",
          verification: "unverifiable",
          retryDisposition: "reconcileRequired",
        },
        sequence: 1,
      });
    const session = new PiTaskSession(fakeClient(run));
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    const result = await call(
      session,
      request(2, "action", { target: { role: "button" }, action: { kind: "click" } }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "SupervisionLost" } });
    expect(session.state).toBe("revoked");
  });

  it("preserves a sanitized provider failure instead of replacing it with SupervisionLost", async () => {
    const run = fakeRun();
    run.action = async () =>
      ok({
        result: {
          dispatch: "unknown",
          providerOutcome: "unknown",
          verification: "unverifiable",
          retryDisposition: "reconcileRequired",
        },
        sequence: 1,
        failure: {
          code: "ProviderFailure",
          phase: "action",
          message: "Mac2 typeText failed with provider category invalidElementState.",
          retryDisposition: "reconcileRequired",
          dispatch: "unknown",
        },
      });
    const session = new PiTaskSession(fakeClient(run));
    await call(
      session,
      request(1, "begin", {
        application: { name: "Fixture" },
      }),
    );
    const failed = await call(
      session,
      request(2, "action", {
        action: { kind: "typeText", value: { literal: "Alpha" } },
      }),
    );
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "ClientFailure",
        clientCode: "ProviderFailure",
        message: "ProviderFailure: Mac2 typeText failed with provider category invalidElementState.",
      },
    });
    expect(session.state).toBe("finalizing");
  });

  it.each([
    {
      dispatch: "dispatched" as const,
      providerOutcome: "failed" as const,
      verification: "unverifiable" as const,
      retryDisposition: "unsafe" as const,
    },
    {
      dispatch: "dispatched" as const,
      providerOutcome: "succeeded" as const,
      verification: "contradicted" as const,
      retryDisposition: "unsafe" as const,
    },
    {
      dispatch: "dispatched" as const,
      providerOutcome: "succeeded" as const,
      verification: "unverifiable" as const,
      retryDisposition: "unsafe" as const,
    },
  ])(
    "returns known terminal ActionResult as a structured failure and closes dispatch authority",
    async (result) => {
      const run = fakeRun();
      run.action = async () => ok({ result, sequence: 1, after: postActionObservation() });
      const session = new PiTaskSession(fakeClient(run));
      await call(
        session,
        request(1, "begin", {
          application: { name: "Fixture" },
        }),
      );
      const failed = await call(
        session,
        request(2, "action", { target: { role: "button" }, action: { kind: "click" } }),
      );
      expect(failed).toMatchObject({
        ok: false,
        error: { code: "ActionFailed", actionResult: result },
      });
      expect(session.state).toBe("finalizing");
      const refused = await call(session, request(3, "observe"));
      expect(refused).toMatchObject({ ok: false, error: { code: "SupervisionLost" } });
    },
  );
});
