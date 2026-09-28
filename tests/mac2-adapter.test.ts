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
const checkboxXml = (value: "0" | "1", selected: "false" | "true") =>
  `<?xml version="1.0"?><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeWindow type="XCUIElementTypeWindow" title="Main" focused="true" x="0" y="0" width="800" height="600"><XCUIElementTypeCheckBox type="XCUIElementTypeCheckBox" identifier="fixture.checkbox" value="${value}" selected="${selected}" enabled="true" x="10" y="20" width="100" height="40"/></XCUIElementTypeWindow></XCUIElementTypeApplication>`;
const textFieldXml = (value?: string) =>
  `<?xml version="1.0"?><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeWindow type="XCUIElementTypeWindow" title="Main" focused="true" x="0" y="0" width="800" height="600"><XCUIElementTypeTextField type="XCUIElementTypeTextField" identifier="input"${value === undefined ? "" : ` value="${value}"`} enabled="true" x="10" y="20" width="200" height="40"/></XCUIElementTypeWindow></XCUIElementTypeApplication>`;
const rowXml = `<?xml version="1.0"?><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeWindow type="XCUIElementTypeWindow" title="Main" focused="true" x="0" y="0" width="800" height="600"><XCUIElementTypeGroup type="XCUIElementTypeGroup" value="First task"><XCUIElementTypeCheckBox type="XCUIElementTypeCheckBox" title="Toggle" value="0" enabled="true" x="10" y="20" width="40" height="40"/></XCUIElementTypeGroup><XCUIElementTypeGroup type="XCUIElementTypeGroup" value="Second task"><XCUIElementTypeCheckBox type="XCUIElementTypeCheckBox" title="Toggle" value="0" enabled="true" x="10" y="70" width="40" height="40"/></XCUIElementTypeGroup></XCUIElementTypeWindow></XCUIElementTypeApplication>`;
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
]);
let logicalId = 0;
const ids = { next: (prefix: string) => `${prefix}-${String(++logicalId).padStart(8, "0")}` };

describe("Mac2DesktopAdapter", () => {
  it("renders the first nonempty element label in compact observations", () => {
    const adapter = new Mac2DesktopAdapter();
    const compact = adapter.compact({
      observationId: "observation-00000001" as never,
      runId: "run-00000001" as never,
      environmentId: "environment-1",
      generation: 1,
      sessionId: "session-00000001" as never,
      windowId: "window-00000001" as never,
      capturedAt: new Date().toISOString(),
      screenshotScope: "window",
      screenshot: { artifactId: "artifact-00000001" as never, sha256: "a".repeat(64) },
      uiSnapshot: { artifactId: "artifact-00000002" as never, sha256: "b".repeat(64) },
      coverage: "complete",
      elements: [
        {
          elementId: "element-00000001" as never,
          role: "button",
          identifier: "fixture.click",
          name: "",
          label: "Click",
          enabled: true,
        },
      ],
    });
    expect(compact).toContain('button "Click" id="fixture.click" depth=0 enabled');
  });
  it("projects hierarchy and resolves a child through an ancestor selector", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: rowXml }
            : JSON.stringify(body ?? null).includes("macos: screenshots")
              ? { value: { main: { isMain: true, payload: PNG_BYTES.toString("base64") } } }
              : url.includes("/elements")
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
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
    const observation = {
      ...observed.value.observation,
      uiSnapshot: { artifactId: "artifact-00000001" as ArtifactId, sha256: "a".repeat(64) },
    };
    const page = adapter.queryPage(
      observation,
      { role: "checkbox", ancestor: { role: "group", value: { exact: "Second task" } } },
      0,
      10,
    );
    expect(page.ok && page.value.status).toBe("unique");
    expect(page.ok && page.value.candidates[0]).toMatchObject({
      role: "checkbox",
      depth: 2,
    });
    expect(adapter.compact(observation)).toContain("  [");
    expect(adapter.compact(observation)).toContain("parent=element-");
    expect(
      adapter.preflightAssertion(
        { kind: "state", query: { role: "checkbox" }, state: { focused: true } },
        observation,
      ),
    ).toMatchObject({ ok: true, value: { status: "unverifiable" } });
    expect(
      adapter.preflightAssertion(
        {
          kind: "value",
          query: { role: "group", value: { exact: "Future" }, descendant: { role: "checkbox" } },
          expected: "Future",
          match: "exact",
        },
        observation,
      ),
    ).toMatchObject({ ok: true, value: { status: "admissible" } });
    const duplicateText = {
      ...observation,
      elements: [
        ...observation.elements,
        {
          elementId: "element-duplicate-00000001" as never,
          role: "statictext",
          value: "Second task",
        },
        {
          elementId: "element-duplicate-00000002" as never,
          role: "statictext",
          value: "Second task",
        },
      ],
    };
    expect(
      adapter.preflightAssertion(
        { kind: "visible", query: { role: "statictext", value: { exact: "Second task" } } },
        duplicateText,
      ),
    ).toMatchObject({ ok: true, value: { status: "unverifiable" } });
  });
  it.each([
    ["1", "false", true],
    ["0", "true", false],
  ] as const)(
    "normalizes checkbox value %s over misleading selected=%s",
    async (checkboxValue, selectedValue, expected) => {
      const fetcher: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
        const value = url.endsWith("/timeouts")
          ? { value: { command: 3_000_000 } }
          : url.endsWith("/session") && init?.method === "POST"
            ? { sessionId: "native-session", value: { sessionId: "native-session" } }
            : url.endsWith("/source")
              ? { value: checkboxXml(checkboxValue, selectedValue) }
              : JSON.stringify(body ?? null).includes("macos: screenshots")
                ? { value: { main: { isMain: true, payload: PNG_BYTES.toString("base64") } } }
                : url.endsWith("/element/active")
                  ? { value: { "element-6066-11e4-a52e-4f735466cecf": "native-input" } }
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
        () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
      expect(observed.ok && observed.value.observation.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ identifier: "fixture.checkbox", selected: expected }),
        ]),
      );
    },
  );
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
        const value = url.endsWith("/timeouts")
          ? { value: { command: 3_000_000 } }
          : url.endsWith("/session")
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
  it("requests and verifies the fixed Appium new-command timeout", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    let effectiveTimeout = 3_000_000;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, ...(body === undefined ? {} : { body }) });
      const value = url.endsWith("/timeouts")
        ? { value: { command: effectiveTimeout } }
        : url.endsWith("/session") && init?.method === "POST"
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
    const make = () =>
      new Mac2DesktopAdapter(
        fetcher,
        undefined,
        undefined,
        () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
        ids,
      );
    const request = {
      channelId: "operation-00000009" as OperationId,
      bundleId: "com.example.App",
      window: { title: { exact: "Main" } },
    };
    expect((await make().startSession(request, new AbortController().signal)).ok).toBe(true);
    expect(JSON.stringify(calls.find((call) => call.url.endsWith("/session"))?.body)).toContain(
      '"appium:newCommandTimeout":3000',
    );
    effectiveTimeout = 60_000;
    expect(await make().startSession(request, new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "SessionUnavailable", dispatch: "notDispatched" },
    });
  });
  it("uses only the unique Mac2 main-display screenshot", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push(url);
      bodies.push(body);
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: xml }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
              : JSON.stringify(body ?? null).includes("macos: queryAppState")
                ? { value: 4 }
                : JSON.stringify(body ?? null).includes("macos: screenshots")
                  ? {
                      value: {
                        main: {
                          id: 1,
                          isMain: true,
                          payload: PNG_BYTES.toString("base64"),
                        },
                      },
                    }
                  : { value: null };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
    bodies.length = 0;
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
    expect(observed.ok && observed.value.observation.screenshotScope).toBe("display");
    expect(calls.some((url) => /\/element\/[^/]+\/screenshot$/u.test(url))).toBe(false);
    expect(bodies.filter((body) => JSON.stringify(body ?? null).includes("macos: screenshots"))).toHaveLength(
      1,
    );
  });
  it("classifies a stopped Mac2 provider process as SessionUnavailable", async () => {
    let failKey = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const response =
        failKey && JSON.stringify(body ?? null).includes("macos: keys")
          ? {
              value: {
                error: "unknown error",
                message: "Mac2 Driver server process is not running (probably crashed).",
              },
            }
          : url.endsWith("/timeouts")
            ? { value: { command: 3_000_000 } }
            : url.endsWith("/session") && init?.method === "POST"
              ? { sessionId: "native-session", value: { sessionId: "native-session" } }
              : url.endsWith("/source")
                ? { value: xml }
                : url.endsWith("/elements")
                  ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
                  : JSON.stringify(body ?? null).includes("macos: queryAppState")
                    ? { value: 4 }
                    : { value: null };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
    failKey = true;
    expect(
      await adapter.dispatch({ kind: "pressKey", key: "enter" }, "operation-00000001" as OperationId, signal),
    ).toMatchObject({ ok: false, error: { code: "SessionUnavailable" } });
  });
  it("classifies a stopped Mac2 provider during observation as SessionUnavailable", async () => {
    let failSource = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (failSource && (url.endsWith("/source") || JSON.stringify(body ?? null).includes("macos: source")))
        return new Response(
          JSON.stringify({
            value: {
              error: "unknown error",
              message: "Mac2 Driver server process is not running (probably crashed).",
            },
          }),
          { status: 500 },
        );
      const response = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: xml }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
              : JSON.stringify(body ?? null).includes("macos: queryAppState")
                ? { value: 4 }
                : { value: null };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
    failSource = true;
    expect(
      await adapter.observe(
        {
          runId: "run-00000001" as RunId,
          generation: 1,
          observationId: "observation-00000001" as ObservationId,
          sessionId: "session-00000001" as SessionId,
          windowId: "window-00000001" as WindowId,
        },
        signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "SessionUnavailable" } });
  });
  it("preserves the standard-source error when the Mac2 source fallback also fails", async () => {
    let failSource = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (failSource && url.endsWith("/source"))
        return new Response(JSON.stringify({ value: { error: "unknown error" } }), { status: 500 });
      if (failSource && JSON.stringify(body ?? null).includes("macos: source"))
        return new Response(JSON.stringify({ value: { error: "unsupported operation" } }), { status: 500 });
      const response = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: xml }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
              : JSON.stringify(body ?? null).includes("macos: queryAppState")
                ? { value: 4 }
                : { value: null };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
    failSource = true;
    expect(
      await adapter.observe(
        {
          runId: "run-00000001" as RunId,
          generation: 1,
          observationId: "observation-00000001" as ObservationId,
          sessionId: "session-00000001" as SessionId,
          windowId: "window-00000001" as WindowId,
        },
        signal,
      ),
    ).toMatchObject({
      ok: false,
      error: { message: "Mac2 observation failed at pageSource with provider category providerError." },
    });
  });
  it("uses Mac2 source exactly once when standard source fails", async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      bodies.push(body);
      if (url.endsWith("/source"))
        return new Response(JSON.stringify({ value: { error: "unknown error" } }), { status: 200 });
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : JSON.stringify(body ?? null).includes("macos: screenshots")
            ? { value: { main: { isMain: true, payload: PNG_BYTES.toString("base64") } } }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
              : JSON.stringify(body ?? null).includes("macos: queryAppState")
                ? { value: 4 }
                : JSON.stringify(body ?? null).includes("macos: source")
                  ? { value: xml }
                  : { value: null };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
    bodies.length = 0;
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
    expect(observed.ok).toBe(true);
    expect(bodies.filter((body) => JSON.stringify(body ?? null).includes("macos: source"))).toHaveLength(1);
  });
  it("rejects text actions against non-text elements before provider dispatch", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push(url);
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: xml }
            : JSON.stringify(body ?? null).includes("macos: screenshots")
              ? { value: { main: { isMain: true, payload: PNG_BYTES.toString("base64") } } }
              : url.endsWith("/elements")
                ? !JSON.stringify(body).includes("//XCUIElementTypeTextField")
                  ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
                  : { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-save" }] }
                : url.endsWith("/element/native-save/displayed")
                  ? { value: true }
                  : JSON.stringify(body ?? null).includes("macos: queryAppState")
                    ? { value: 4 }
                    : { value: null };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
      ids,
    );
    const signal = new AbortController().signal;
    const started = await adapter.startSession(
      {
        channelId: "operation-00000009" as OperationId,
        bundleId: "com.example.App",
        window: { title: { exact: "Main" } },
      },
      signal,
    );
    expect(started.ok).toBe(true);
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
    const dispatched = await adapter.dispatch(
      { kind: "typeText", value: { secret: { name: "TEXT_SECRET", purpose: "textInput" } } },
      "operation-00000001" as OperationId,
      signal,
    );
    expect(dispatched).toMatchObject({
      ok: false,
      error: { code: "InvalidConfiguration", dispatch: "notDispatched" },
    });
    expect(calls.some((url) => /\/element\/[^/]+\/value$/u.test(url))).toBe(false);
  });
  it("types Unicode code points through separate Mac2 keys commands without element-value writes", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    let keyCalls = 0;
    let failAtKeyCall = Number.POSITIVE_INFINITY;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, ...(body === undefined ? {} : { body }) });
      const isKeyCall = JSON.stringify(body ?? null).includes("macos: keys");
      if (isKeyCall) keyCalls += 1;
      const response =
        keyCalls === failAtKeyCall && isKeyCall
          ? { value: { error: "invalid session id" } }
          : url.endsWith("/timeouts")
            ? { value: { command: 3_000_000 } }
            : url.endsWith("/session") && init?.method === "POST"
              ? { sessionId: "native-session", value: { sessionId: "native-session" } }
              : url.endsWith("/source")
                ? { value: textFieldXml("Alpha") }
                : JSON.stringify(body ?? null).includes("macos: screenshots")
                  ? { value: { main: { isMain: true, payload: PNG_BYTES.toString("base64") } } }
                  : url.endsWith("/elements")
                    ? !JSON.stringify(body).includes("]//XCUIElementTypeTextField")
                      ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
                      : { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-input" }] }
                    : url.endsWith("/element/native-input/displayed")
                      ? { value: true }
                      : JSON.stringify(body ?? null).includes("macos: queryAppState")
                        ? { value: 4 }
                        : { value: null };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
      ids,
    );
    const signal = new AbortController().signal;
    const started = await adapter.startSession(
      {
        channelId: "operation-00000009" as OperationId,
        bundleId: "com.example.App",
        window: { title: { exact: "Main" } },
      },
      signal,
    );
    expect(started.ok).toBe(true);
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
    const result = await adapter.dispatch(
      { kind: "typeText", value: { literal: "A🙂" } },
      "operation-00000001" as OperationId,
      signal,
    );
    expect(result.ok).toBe(true);
    expect(calls.some((call) => /\/element\/[^/]+\/value$/u.test(call.url))).toBe(false);
    expect(
      calls
        .filter((call) => JSON.stringify(call.body ?? null).includes("macos: keys"))
        .map((call) => call.body),
    ).toEqual([
      { script: "macos: keys", args: [{ keys: ["A"] }] },
      { script: "macos: keys", args: [{ keys: ["🙂"] }] },
    ]);
    expect(calls.some((call) => call.url.endsWith("/element/active"))).toBe(false);
    expect(calls.some((call) => JSON.stringify(call.body ?? null).includes('"elementId"'))).toBe(false);
    keyCalls = 0;
    failAtKeyCall = 2;
    const partial = await adapter.dispatch(
      { kind: "typeText", value: { literal: "XYZ" } },
      "operation-00000002" as OperationId,
      signal,
    );
    expect(partial).toMatchObject({
      ok: false,
      error: { code: "SessionUnavailable", dispatch: "dispatched", retryDisposition: "reconcileRequired" },
    });
    expect(keyCalls).toBe(2);
  });
  it("uses the same application-scoped typeText path without an active-element probe", async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      bodies.push(body);
      const response = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: textFieldXml("") }
            : url.endsWith("/elements")
              ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
              : JSON.stringify(body ?? null).includes("macos: queryAppState")
                ? { value: 4 }
                : { value: null };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    const adapter = new Mac2DesktopAdapter(
      fetcher,
      undefined,
      undefined,
      () => ({ endpoint: "http://guest:4723", elementOriginActions: false }),
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
    expect(
      await adapter.dispatch(
        { kind: "typeText", value: { literal: "hello" } },
        "operation-00000001" as OperationId,
        signal,
      ),
    ).toMatchObject({ ok: true });
    expect(bodies.filter((body) => JSON.stringify(body ?? null).includes("macos: keys"))).toHaveLength(5);
  });
  it("keeps the session usable when element-origin capability probing is unsupported", async () => {
    let probeFailed = false;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.endsWith("/actions") && JSON.stringify(body).includes("element-origin-capability-probe")) {
        probeFailed = true;
        return new Response(JSON.stringify({ value: { error: "unsupported operation" } }), { status: 200 });
      }
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session")
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
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session")
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/source")
            ? { value: xml }
            : JSON.stringify(body ?? null).includes("macos: screenshots")
              ? { value: { main: { isMain: true, payload: PNG_BYTES.toString("base64") } } }
              : url.endsWith("/elements")
                ? !JSON.stringify(body).includes("XCUIElementTypeButton")
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
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session")
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/status")
            ? { value: { build: { version: "4.3.5" } } }
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
    expect(JSON.stringify(request)).toContain("//XCUIElementTypeWindow");
    expect(JSON.stringify(request)).not.toContain("@type='XCUIElementTypeWindow'");
    expect(JSON.stringify(request)).toContain("@main='true' or @focused='true'");
    expect(JSON.stringify(request)).toContain("@modal='false'");
  });
  it("uses Mac2 top-left element offsets and bounded canonical identities", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    let foreground = true;
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, ...(body === undefined ? {} : { body }) });
      const value = url.endsWith("/timeouts")
        ? { value: { command: 3_000_000 } }
        : url.endsWith("/session") && init?.method === "POST"
          ? { sessionId: "native-session", value: { sessionId: "native-session" } }
          : url.endsWith("/status")
            ? { value: { build: { version: "4.3.5" } } }
            : url.endsWith("/source")
              ? { value: foreground ? xml : xml.replace(`focused="true"`, `focused="false"`) }
              : JSON.stringify(body ?? null).includes("macos: screenshots")
                ? { value: { main: { isMain: true, payload: PNG_BYTES.toString("base64") } } }
                : url.endsWith("/elements")
                  ? !JSON.stringify(body).includes("XCUIElementTypeButton")
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
          expect(Array.from(input.screenshot.subarray(0, 8))).toEqual(Array.from(PNG_BYTES.subarray(0, 8)));
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
        sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
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
    expect(calls.some((call) => /\/element\/[^/]+\/screenshot$/u.test(call.url))).toBe(false);
    expect(calls.some((call) => JSON.stringify(call.body ?? null).includes("macos: screenshots"))).toBe(true);
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
    const actionCallsStart = calls.length;
    expect((await adapter.dispatch(action, "operation-00000001" as OperationId, signal)).ok).toBe(true);
    const actionCalls = calls.slice(actionCallsStart);
    const foregroundIndex = actionCalls.findIndex((call) =>
      JSON.stringify(call.body ?? null).includes("macos: queryAppState"),
    );
    const windowIndex = actionCalls.findIndex(
      (call) =>
        call.url.endsWith("/elements") &&
        JSON.stringify(call.body ?? null).includes("//XCUIElementTypeWindow"),
    );
    const targetIndex = actionCalls.findIndex(
      (call) =>
        call.url.endsWith("/elements") &&
        JSON.stringify(call.body ?? null).includes("**/XCUIElementTypeWindow"),
    );
    const dispatchIndex = actionCalls.findIndex((call) =>
      JSON.stringify(call.body ?? null).includes("macos: click"),
    );
    expect([foregroundIndex, windowIndex, targetIndex, dispatchIndex]).toEqual(
      [...[foregroundIndex, windowIndex, targetIndex, dispatchIndex]].sort((left, right) => left - right),
    );
    expect(foregroundIndex).toBeGreaterThanOrEqual(0);
    expect(windowIndex).toBeGreaterThan(foregroundIndex);
    expect(targetIndex).toBeGreaterThan(windowIndex);
    expect(dispatchIndex).toBeGreaterThan(targetIndex);
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
      using: "class chain",
      value:
        '**/XCUIElementTypeWindow[`title ==[c] "Main"`]/**/XCUIElementTypeButton[`identifier == "save" AND title == "Save" AND enabled == TRUE`]',
    });
    expect(
      adapter
        .compact({
          ...observed.value.observation,
          screenshot: {
            artifactId: "artifact-00000001" as ArtifactId,
            sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
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
