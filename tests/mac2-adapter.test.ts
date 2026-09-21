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

const xml = `<?xml version="1.0"?><XCUIElementTypeApplication type="XCUIElementTypeApplication"><XCUIElementTypeWindow type="XCUIElementTypeWindow" name="Main" focused="true" x="0" y="0" width="800" height="600"><XCUIElementTypeButton type="XCUIElementTypeButton" identifier="save" name="Save" enabled="true" x="10" y="20" width="100" height="40"/></XCUIElementTypeWindow></XCUIElementTypeApplication>`;

describe("Mac2DesktopAdapter", () => {
  it("uses Mac2 top-left element offsets and bounded canonical identities", async () => {
    const calls: { url: string; body?: unknown }[] = [];
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
              ? { value: xml }
              : url.endsWith("/element/native-window/screenshot")
                ? { value: Buffer.from("png").toString("base64") }
                : url.endsWith("/elements")
                  ? JSON.stringify(body).includes("XCUIElementTypeWindow")
                    ? { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-window" }] }
                    : { value: [{ "element-6066-11e4-a52e-4f735466cecf": "native-save" }] }
                  : { value: null };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new Mac2DesktopAdapter(fetcher);
    const signal = new AbortController().signal;
    expect(
      (
        await adapter.startSession(
          {
            endpoint: "http://guest:4723",
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
    if (!observed.ok) throw new Error(observed.error.message);
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
    const execute = calls.find(
      (call) => call.url.endsWith("/execute/sync") && JSON.stringify(call.body).includes("macos: click"),
    );
    expect(execute?.body).toMatchObject({ args: [{ elementId: "native-save", x: 20, y: 20 }] });
    expect(
      adapter
        .compact({
          ...observed.value.observation,
          screenshot: { artifactId: "artifact-00000001" as ArtifactId, sha256: "a".repeat(64) },
          uiSnapshot: { artifactId: "artifact-00000002" as ArtifactId, sha256: "b".repeat(64) },
        })
        .split("\n").length,
    ).toBeLessThanOrEqual(202);
  });
});
