import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Mac2DesktopAdapter } from "../src/adapters/mac2/index.js";
import {
  type ArtifactId,
  type DesktopAction,
  type ObservationId,
  type OperationId,
  type RunId,
  type SessionId,
  type WindowId,
} from "../src/contracts/index.js";

const xml = `<?xml version="1.0"?><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeWindow type="XCUIElementTypeWindow" title="Main" focused="true" x="0" y="0" width="800" height="600"><XCUIElementTypeButton type="XCUIElementTypeButton" identifier="save" title="Save" enabled="true" x="10" y="20" width="100" height="40"/></XCUIElementTypeWindow></XCUIElementTypeApplication>`;
let logicalId = 0;
const ids = { next: (prefix: string) => `${prefix}-${String(++logicalId).padStart(8, "0")}` };

describe("Mac2DesktopAdapter", () => {
  it.each([
    ["unsupported operation", "UnsupportedAction", "notDispatched", "safe"],
    ["invalid argument", "InvalidConfiguration", "unknown", "reconcileRequired"],
    ["timeout", "ProviderTimeout", "unknown", "reconcileRequired"],
  ] as const)(
    "classifies provider error %s as %s",
    async (providerCode, expectedCode, dispatch, retryDisposition) => {
      let failKey = false;
      const fetcher: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
        const value = url.endsWith("/session")
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: xml }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
              : JSON.stringify(body ?? null).includes("macos: queryAppState")
                ? { value: 4 }
                : failKey && JSON.stringify(body ?? null).includes("macos: keys")
                  ? { value: { error: providerCode } }
                  : { value: null };
        return new Response(JSON.stringify(value), { status: 200 });
      };
      const adapter = new Mac2DesktopAdapter(
        fetcher,
        undefined,
        undefined,
        () => ({
          endpoint: "http://guest:4723",
          elementOriginActions: false,
        }),
        ids,
      );
      expect(
        (
          await adapter.startSession(
            {
              channelId: "operation-00000009" as OperationId,
              bundleId: "com.example.App",
              window: { title: { exact: "Main" } },
            },
            new AbortController().signal,
          )
        ).ok,
      ).toBe(true);
      failKey = true;
      expect(
        await adapter.dispatch(
          { kind: "pressKey", key: "enter" },
          "operation-00000001" as OperationId,
          new AbortController().signal,
        ),
      ).toMatchObject({ ok: false, error: { code: expectedCode, dispatch, retryDisposition } });
    },
  );
  it("keeps the session usable when element-origin capability probing is unsupported", async () => {
    let probeFailed = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.endsWith("/actions") && JSON.stringify(body).includes("element-origin-capability-probe")) {
        probeFailed = true;
        return new Response(JSON.stringify({ value: { error: "unsupported operation" } }), { status: 200 });
      }
      const value = url.endsWith("/session")
        ? { sessionId: "native-session", value: { sessionId: "native-session" } }
        : url.endsWith("/source")
          ? { value: xml }
          : url.endsWith("/elements")
            ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
            : JSON.stringify(body ?? null).includes("macos: queryAppState")
              ? { value: 4 }
              : { value: null };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({
        endpoint: "http://guest:4723",
        elementOriginActions: false,
      }),
      ids,
    );
    const started = await adapter.startSession(
      {
        channelId: "operation-00000009" as OperationId,
        bundleId: "com.example.App",
        window: { title: { exact: "Main" } },
      },
      new AbortController().signal,
    );
    expect(started.ok).toBe(true);
    expect(probeFailed).toBe(false);
    const key = await adapter.dispatch(
      { kind: "pressKey", key: "enter" },
      "operation-00000001" as OperationId,
      new AbortController().signal,
    );
    expect(key.ok).toBe(true);
  });
  it("classifies unsupported provider commands before allowing retries", async () => {
    let failClick = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const value = url.endsWith("/session")
        ? { sessionId: "native-session", value: { sessionId: "native-session" } }
        : url.endsWith("/source")
          ? { value: xml }
          : url.endsWith("/element/native-window/screenshot")
            ? { value: Buffer.from("png").toString("base64") }
            : url.endsWith("/elements")
              ? JSON.stringify(body).includes("XCUIElementTypeWindow")
                ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
                : { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-save" }] }
              : url.endsWith("/element/native-save/displayed")
                ? { value: true }
                : url.endsWith("/element/native-save/rect")
                  ? { value: { x: 0, y: 0, width: 100, height: 40 } }
                  : JSON.stringify(body ?? null).includes("macos: queryAppState")
                    ? { value: 4 }
                    : failClick && JSON.stringify(body ?? null).includes("macos: click")
                      ? { value: { error: "unsupported operation" } }
                      : { value: null };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({
        endpoint: "http://guest:4723",
        elementOriginActions: true,
      }),
      ids,
    );
    const signal = new AbortController().signal;
    expect(
      (
        await adapter.startSession(
          {
            channelId: "operation-00000009" as OperationId,
            bundleId: "com.example.App",
            window: { title: { exact: "Main" } },
          },
          signal,
        )
      ).ok,
    ).toBe(true);
    const observed = await adapter.observe(
      {
        runId: "run-00000001" as RunId,
        generation: 1,
        observationId: "observation-00000001" as ObservationId,
        sessionId: "session-00000001" as SessionId,
        windowId: "window-00000001" as WindowId,
      },
      signal,
    );
    if (!observed.ok) throw new Error(observed.error.code);
    const complete = {
      ...observed.value.observation,
      screenshot: { artifactId: "artifact-00000001" as ArtifactId, sha256: "a".repeat(64) },
      uiSnapshot: { artifactId: "artifact-00000002" as ArtifactId, sha256: "b".repeat(64) },
    };
    const ref = adapter.query(complete, { identifier: "save" });
    if (!ref.ok) throw new Error(ref.error.code);
    failClick = true;
    const result = await adapter.dispatch(
      { kind: "click", target: { element: ref.value } },
      "operation-00000001" as OperationId,
      signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UnsupportedAction", dispatch: "notDispatched", retryDisposition: "safe" },
    });
  });
  it("includes every WindowQuery predicate in native window resolution", async () => {
    const calls: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push(body);
      const value = url.endsWith("/session")
        ? { sessionId: "native-session", value: { sessionId: "native-session" } }
        : url.endsWith("/status")
          ? { value: { build: { version: "4.3.1" } } }
          : url.endsWith("/source")
            ? { value: xml.replace('focused="true"', 'focused="true" main="true" modal="false"') }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
              : JSON.stringify(body ?? null).includes("macos: queryAppState")
                ? { value: 4 }
                : { value: null };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({
        endpoint: "http://guest:4723",
        elementOriginActions: true,
      }),
      ids,
    );
    const result = await adapter.startSession(
      {
        channelId: "operation-00000009" as OperationId,
        bundleId: "com.example.App",
        window: {
          title: { exact: "main", caseSensitive: false },
          role: "window",
          isMain: true,
          isModal: false,
        },
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const request = calls.find((body) => JSON.stringify(body ?? null).includes("XCUIElementTypeWindow"));
    expect(JSON.stringify(request)).toContain("@type='XCUIElementTypeWindow'");
    expect(JSON.stringify(request)).toContain("@main='true'");
    expect(JSON.stringify(request)).toContain("@modal='false'");
  });
  it("uses Mac2 top-left element offsets and bounded canonical identities", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    let foreground = true;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, ...(body === undefined ? {} : { body }) });
      const value =
        url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/status")
            ? { value: { build: { version: "4.3.1" } } }
            : url.endsWith("/source")
              ? { value: foreground ? xml : xml.replace(`focused="true"`, `focused="false"`) }
              : url.endsWith("/element/native-window/screenshot")
                ? { value: Buffer.from("png").toString("base64") }
                : url.endsWith("/elements")
                  ? JSON.stringify(body).includes("XCUIElementTypeWindow")
                    ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
                    : { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-save" }] }
                  : url.endsWith("/element/native-save/rect")
                    ? { value: { x: 900, y: 700, width: 200, height: 60 } }
                    : url.endsWith("/element/native-save/displayed")
                      ? { value: true }
                      : JSON.stringify(body ?? null).includes("macos: queryAppState")
                        ? { value: foreground ? 4 : 2 }
                        : { value: null };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    let visualCalls = 0;
    let malformedVisual = false;
    let pendingVisual = false;
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      {
        model: "test-model-1",
        evaluate: async (input) => {
          visualCalls += 1;
          if (pendingVisual) return new Promise<never>(() => undefined);
          expect(new TextDecoder().decode(input.screenshot)).toBe("png");
          return malformedVisual
            ? { status: "passed", reason: "ok", extra: true }
            : { status: "passed", reason: "ok" };
        },
      },
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: true }),
      ids,
    );
    const signal = new AbortController().signal;
    expect(
      (
        await adapter.startSession(
          {
            channelId: "operation-00000009" as OperationId,
            bundleId: "com.example.App",
            window: { title: { exact: "Main" } },
          },
          signal,
        )
      ).ok,
    ).toBe(true);
    expect(calls.filter((call) => call.url.endsWith("/actions")).map((call) => call.body)).toEqual([
      {
        actions: [
          {
            type: "key",
            id: "capability-probe",
            actions: [{ type: "pause", duration: 1 }],
          },
        ],
      },
    ]);
    const observed = await adapter.observe(
      {
        runId: "run-00000001" as RunId,
        generation: 1,
        observationId: "observation-00000001" as ObservationId,
        sessionId: "session-00000001" as SessionId,
        windowId: "window-00000001" as WindowId,
      },
      signal,
    );
    if (!observed.ok) throw new Error(observed.error.message);
    const visualObservation = {
      ...observed.value.observation,
      screenshot: {
        artifactId: "artifact-00000001" as ArtifactId,
        sha256: createHash("sha256").update("png").digest("hex"),
      },
      uiSnapshot: { artifactId: "artifact-00000002" as ArtifactId, sha256: "b".repeat(64) },
    };
    const visual = await adapter.evaluate(
      { kind: "aiVisual", goal: "Button is present", accepted: true },
      visualObservation,
      signal,
    );
    expect(visual.ok && visual.value.status).toBe("passed");
    expect(visual.ok && visual.value.reason).toContain("test-model-1");
    malformedVisual = true;
    const invalidVisual = await adapter.evaluate(
      { kind: "aiVisual", goal: "Button is present", accepted: true },
      visualObservation,
      signal,
    );
    expect(invalidVisual.ok && invalidVisual.value.status).toBe("unverifiable");
    pendingVisual = true;
    const cancelledVisual = await adapter.evaluate(
      { kind: "aiVisual", goal: "Button is present", accepted: true },
      visualObservation,
      AbortSignal.timeout(5),
    );
    expect(cancelledVisual.ok && cancelledVisual.value.status).toBe("unverifiable");
    pendingVisual = false;
    expect(calls.some((call) => call.url.endsWith("/element/native-window/screenshot"))).toBe(true);
    const button = observed.value.observation.elements.find((item) => item.identifier === "save");
    if (!button) throw new Error("button missing");
    const ref = {
      runId: observed.value.observation.runId,
      environmentId: observed.value.observation.environmentId,
      generation: 1,
      sessionId: observed.value.observation.sessionId,
      windowId: observed.value.observation.windowId,
      observationId: observed.value.observation.observationId,
      elementId: button.elementId,
    };
    const action: DesktopAction = { kind: "click", target: { element: ref, point: { x: 0.2, y: 0.5 } } };
    expect((await adapter.dispatch(action, "operation-00000001" as OperationId, signal)).ok).toBe(true);
    const staleVisual = await adapter.evaluate(
      { kind: "aiVisual", goal: "Button is present", accepted: true },
      visualObservation,
      signal,
    );
    expect(staleVisual.ok && staleVisual.value.status).toBe("unverifiable");
    expect(visualCalls).toBe(3);
    const execute = calls.find(
      (call) => call.url.endsWith("/execute/sync") && JSON.stringify(call.body).includes("macos: click"),
    );
    expect(execute?.body).toMatchObject({ args: [{ elementId: "native-save", x: 40, y: 30 }] });
    const repeated = await adapter.dispatch(action, "operation-00000004" as OperationId, signal);
    expect(!repeated.ok && repeated.error).toMatchObject({
      code: "StaleElementRef",
      dispatch: "notDispatched",
    });
    expect(calls.filter((call) => JSON.stringify(call.body ?? null).includes("macos: click"))).toHaveLength(
      1,
    );
    const liveResolution = calls.filter((call) => call.url.endsWith("/elements")).at(-1);
    expect(liveResolution?.body).toEqual({
      using: "xpath",
      value: ".//XCUIElementTypeButton[@identifier='save' and @title='Save' and @enabled='true']",
    });
    expect(
      adapter
        .compact({
          ...observed.value.observation,
          screenshot: {
            artifactId: "artifact-00000001" as ArtifactId,
            sha256: createHash("sha256").update("png").digest("hex"),
          },
          uiSnapshot: { artifactId: "artifact-00000002" as ArtifactId, sha256: "b".repeat(64) },
        })
        .split("\n").length,
    ).toBeLessThanOrEqual(202);
    const keyboard = await adapter.dispatch(
      { kind: "pressKey", key: "enter", modifiers: ["command"] },
      "operation-00000003" as OperationId,
      signal,
    );
    expect(keyboard.ok).toBe(true);
    expect(
      calls.find((call) => JSON.stringify(call.body ?? null).includes("macos: keys"))?.body,
    ).toMatchObject({ args: [{ keys: [{ modifierFlags: 16 }] }] });
    const clicksBefore = calls.filter((call) =>
      JSON.stringify(call.body ?? null).includes("macos: click"),
    ).length;
    foreground = false;
    const rejected = await adapter.dispatch(action, "operation-00000002" as OperationId, signal);
    expect(!rejected.ok && rejected.error).toMatchObject({
      code: "StaleElementRef",
      dispatch: "notDispatched",
    });
    expect(calls.filter((call) => JSON.stringify(call.body ?? null).includes("macos: click")).length).toBe(
      clicksBefore,
    );
  });
});
