import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_PROTOCOL_VERSION,
  buildPiRunnerEnvironment,
  PiTaskSupervisor,
  TaskResponseSchema,
  type SpawnPiTaskRunner,
  type TaskRequest,
  type TaskValue,
} from "../src/pi-extension/runtime/index.js";

class FakeChild extends EventEmitter {
  connected = true;
  killed = false;
  readonly sent: TaskRequest[] = [];
  responseFor: (request: TaskRequest) => unknown = (request) => {
    const values: Record<TaskRequest["type"], TaskValue> = {
      begin: {
        kind: "begun",
        leaseId: "lease-00000001",
        observationId: "observation-00000001" as never,
        compact: "button Save",
      },
      heartbeat: { kind: "heartbeat", alive: true },
      observe: {
        kind: "observation",
        observationId: "observation-00000001" as never,
        compact: "button Save",
      },
      query: {
        kind: "query",
        status: "unique",
        observationId: "observation-00000001" as never,
        count: 1,
        candidates: [{ elementId: "element-00000001" as never, role: "button" }],
        element: { elementId: "element-00000001" as never, role: "button" },
      },
      expand: {
        kind: "expanded",
        element: { elementId: "element-00000001" as never, role: "button" },
      },
      freezeAssertions: { kind: "assertionsFrozen", count: 1 },
      action: {
        kind: "action",
        result: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "confirmed",
          retryDisposition: "unsafe",
        },
        sequence: 1,
        finalAssertionsPassed: false,
        observationId: "observation-00000001" as never,
        compact: "button Save",
      },
      assert: {
        kind: "assertion",
        assertionId: "assertion-00000001",
        status: "passed",
        observationId: "observation-00000001" as never,
        reason: "ok",
      },
      finish: {
        kind: "finished",
        runId: "run-00000001" as never,
        result: { verdict: "passed", evidence: "complete", cleanup: "completed" },
      },
      abort: { kind: "aborted" },
      status: { kind: "status", state: "active" },
    };
    return TaskResponseSchema.parse({
      protocolVersion: AGENT_TASK_PROTOCOL_VERSION,
      taskId: request.taskId,
      requestId: request.requestId,
      sequence: request.sequence,
      type: request.type,
      ok: true,
      value: values[request.type],
    });
  };
  holdBegin = false;
  heldBegin: TaskRequest | undefined;

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    const request = message as TaskRequest;
    this.sent.push(request);
    if (request.type === "begin" && this.holdBegin) {
      this.heldBegin = request;
      callback?.(null);
      return true;
    }
    setImmediate(() => {
      callback?.(null);
      this.emit("message", this.responseFor(request));
    });
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }

  releaseBegin(): void {
    if (!this.heldBegin) throw new Error("No held begin request.");
    this.emit("message", this.responseFor(this.heldBegin));
    this.heldBegin = undefined;
  }
}

const application = { name: "Fixture" };

describe("PiTaskSupervisor", () => {
  it("serializes caller operations through one FIFO", async () => {
    const child = new FakeChild();
    const supervisor = new PiTaskSupervisor("/config.json", "/workspace", (() => child) as SpawnPiTaskRunner);
    await supervisor.start(application);
    const first = supervisor.request({ type: "observe" });
    const second = supervisor.request({ type: "status" });
    await Promise.all([first, second]);
    expect(child.sent.filter((request) => request.type !== "begin").map((request) => request.type)).toEqual([
      "observe",
      "status",
    ]);
    await supervisor.shutdown();
  });

  it("terminates supervision when a child response violates identity or sequence", async () => {
    const child = new FakeChild();
    const supervisor = new PiTaskSupervisor("/config.json", "/workspace", (() => child) as SpawnPiTaskRunner);
    await supervisor.start(application);
    child.responseFor = (request) => {
      const valid = new FakeChild().responseFor(request);
      if (typeof valid !== "object" || valid === null) throw new Error("Invalid fake response.");
      return { ...valid, sequence: request.sequence + 1 };
    };
    await expect(supervisor.request({ type: "observe" })).rejects.toThrow(
      "Unexpected Pi task runner response",
    );
    expect(child.killed).toBe(true);
    await expect(supervisor.request({ type: "status" })).rejects.toThrow();
  });

  it("rejects pending and future work when the child disconnects", async () => {
    const child = new FakeChild();
    const supervisor = new PiTaskSupervisor("/config.json", "/workspace", (() => child) as SpawnPiTaskRunner);
    await supervisor.start(application);
    child.send = () => true;
    const pending = supervisor.request({ type: "observe" });
    await new Promise((resolve) => setImmediate(resolve));
    child.connected = false;
    child.emit("disconnect");
    await expect(pending).rejects.toThrow("disconnected");
    await expect(supervisor.request({ type: "status" })).rejects.toThrow();
  });

  it("closes after finish without sending a second abort", async () => {
    const child = new FakeChild();
    const supervisor = new PiTaskSupervisor("/config.json", "/workspace", (() => child) as SpawnPiTaskRunner);
    await supervisor.start(application);
    await supervisor.request({ type: "finish" });
    await supervisor.shutdown("already finished");
    expect(child.sent.map((request) => request.type)).toEqual(["begin", "finish"]);
    expect(child.killed).toBe(true);
  });

  it("maintains heartbeats while a real environment begin is still pending", async () => {
    const child = new FakeChild();
    child.holdBegin = true;
    const supervisor = new PiTaskSupervisor("/config.json", "/workspace", (() => child) as SpawnPiTaskRunner);
    const starting = supervisor.start(application);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(child.sent.map((request) => request.type)).toEqual(["begin", "heartbeat", "heartbeat"]);
    child.releaseBegin();
    await expect(starting).resolves.toMatchObject({ kind: "begun" });
    await supervisor.shutdown();
  });

  it("bounds shutdown and terminates an unresponsive runner", async () => {
    const child = new FakeChild();
    const supervisor = new PiTaskSupervisor(
      "/config.json",
      "/workspace",
      (() => child) as SpawnPiTaskRunner,
      10,
    );
    await supervisor.start(application);
    child.send = (message) => {
      child.sent.push(message as TaskRequest);
      return true;
    };
    await supervisor.shutdown("timeout test");
    expect(child.killed).toBe(true);
    await expect(supervisor.request({ type: "status" })).rejects.toThrow();
  });

  it("waits for abort cleanup when shutdown occurs during pending begin", async () => {
    const child = new FakeChild();
    child.holdBegin = true;
    const supervisor = new PiTaskSupervisor(
      "/config.json",
      "/workspace",
      (() => child) as SpawnPiTaskRunner,
      100,
    );
    const starting = supervisor.start(application);
    await new Promise((resolve) => setImmediate(resolve));
    let abortRequest: TaskRequest | undefined;
    child.send = (message, callback) => {
      const request = message as TaskRequest;
      child.sent.push(request);
      if (request.type === "abort") abortRequest = request;
      callback?.(null);
      return true;
    };
    const stopping = supervisor.shutdown("owner stopped during startup");
    child.emit(
      "message",
      TaskResponseSchema.parse({
        protocolVersion: AGENT_TASK_PROTOCOL_VERSION,
        taskId: child.heldBegin?.taskId,
        requestId: child.heldBegin?.requestId,
        sequence: child.heldBegin?.sequence,
        type: "begin",
        ok: false,
        error: { code: "SupervisionLost", message: "revoked during startup" },
      }),
    );
    await expect(starting).rejects.toThrow("revoked during startup");
    expect(child.killed).toBe(false);
    if (!abortRequest) throw new Error("abort request missing");
    child.emit("message", new FakeChild().responseFor(abortRequest));
    await stopping;
    expect(child.killed).toBe(true);
  });

  it("builds a minimal child environment with only configured secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcu-pi-env-"));
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        image: {
          reference: "registry.example/macos/image",
          digest: `sha256:${"a".repeat(64)}`,
          buildIdentity: "build-1",
        },
        aut: {
          bundleId: "com.example.App",
          window: { title: { exact: "App" } },
          allowedEnvironmentSecrets: ["APP_SECRET"],
        },
        timeouts: {
          runTotalMs: 7_200_000,
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
          cleanupMs: 120_000,
        },
        state: { root: "/tmp/state", tempRoot: "/tmp/temp" },
        evidence: { root: "/tmp/evidence", retentionDays: 7, maxArtifactBytes: 10, maxRunBytes: 100 },
        secrets: { allowedNames: ["TEXT_SECRET"] },
      }),
    );
    const environment = buildPiRunnerEnvironment(configPath, {
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      APP_SECRET: "app",
      TEXT_SECRET: "text",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      OTHER_TOKEN: "must-not-leak",
    });
    expect(environment).toMatchObject({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      APP_SECRET: "app",
      TEXT_SECRET: "text",
      MACOS_COMPUTER_USE_CONFIG: configPath,
    });
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.OTHER_TOKEN).toBeUndefined();
  });
});
