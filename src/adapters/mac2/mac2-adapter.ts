import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import {
  ElementSummarySchema,
  QueryPageSchema,
  type QueryPage,
  AssertionSpecSchema,
  VisualEvaluationSchema,
  VisualModelSchema,
  type VisualEvaluator,
  type SensitiveDataPolicy,
  DesktopActionSchema,
  err,
  ok,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type ElementId,
  type ElementRef,
  type ElementQuery,
  type ElementSelector,
  type ElementSummary,
  type Observation,
  type OperationError,
  type OperationId,
  type OperationResult,
  type ProviderReceipt,
  ProviderReceiptSchema,
  type SessionRequest,
  type TextMatch,
  type WindowQuery,
  SessionRequestSchema,
  ObserveRequestSchema,
  type IdGenerator,
} from "../../contracts/index.js";

type JsonObject = Record<string, unknown>;
type ProviderErrorCategory =
  | "unsupportedCommand"
  | "invalidArgument"
  | "invalidElementState"
  | "elementNotInteractable"
  | "staleElement"
  | "noSuchElement"
  | "invalidSession"
  | "timeout"
  | "transport"
  | "providerError";
class WebDriverFailure extends Error {
  constructor(readonly category: ProviderErrorCategory) {
    super(`webdriver:${category}`);
  }
}
type NativeLocator = {
  identifier?: string;
  role: string;
  name?: string;
  title?: string;
  label?: string;
  value?: string;
  enabled?: boolean;
  selected?: boolean;
  focused?: boolean;
  visible?: boolean;
  query?: ElementQuery;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
};
const W3C_ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const NEW_COMMAND_TIMEOUT_SECONDS = 3_000;
const NEW_COMMAND_TIMEOUT_MS = NEW_COMMAND_TIMEOUT_SECONDS * 1_000;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const providerErrorCategory = (value: string, message?: string): ProviderErrorCategory => {
  const normalized = value.trim().toLocaleLowerCase();
  const normalizedMessage = message?.trim().toLocaleLowerCase() ?? "";
  if (
    normalizedMessage.includes("process is not running") ||
    normalizedMessage.includes("process has exited") ||
    normalizedMessage.includes("server process is unavailable")
  )
    return "invalidSession";
  if (normalized === "unsupported operation" || normalized === "unknown command") return "unsupportedCommand";
  if (normalized === "invalid argument") return "invalidArgument";
  if (normalized === "invalid element state") return "invalidElementState";
  if (normalized === "element not interactable") return "elementNotInteractable";
  if (normalized === "stale element reference") return "staleElement";
  if (normalized === "no such element") return "noSuchElement";
  if (normalized === "invalid session id") return "invalidSession";
  if (normalized.includes("timeout")) return "timeout";
  return "providerError";
};
const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
const xpathLiteral = (value: string): string =>
  !value.includes("'")
    ? `'${value}'`
    : !value.includes('"')
      ? `"${value}"`
      : `concat(${value
          .split("'")
          .map((part) => `'${part}'`)
          .join(`, "'", `)})`;
const classChainLiteral = (value: string): string => JSON.stringify(value);

export class Mac2DesktopAdapter implements DesktopPort {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly visualEvaluator?: VisualEvaluator,
    private readonly sensitive?: SensitiveDataPolicy,
    private readonly resolveChannel: (
      channelId: OperationId,
    ) => { endpoint: string; elementOriginActions: boolean } | undefined = () => undefined,
    private readonly ids: IdGenerator = {
      next: () => {
        throw new Error("Mac2 logical ID generator is unavailable.");
      },
    },
  ) {
    if (visualEvaluator) {
      VisualModelSchema.parse(visualEvaluator.model);
      if (typeof visualEvaluator.evaluate !== "function") throw new Error("Invalid visual evaluator");
      this.visualEvaluator = Object.freeze({
        model: visualEvaluator.model,
        evaluate: visualEvaluator.evaluate.bind(visualEvaluator),
      });
    }
  }
  #visualScreenshot: { observationId: string; bytes: Uint8Array } | undefined;
  #endpoint: string | undefined;
  #nativeSessionId: string | undefined;
  #bundleId: string | undefined;
  #locators = new Map<string, NativeLocator>();
  #previousLocators = new Map<string, NativeLocator>();
  #allElements: ElementSummary[] = [];
  #windowQuery: WindowQuery | undefined;
  #elementOriginActionsSupported = false;
  #context:
    | Pick<Observation, "runId" | "generation" | "sessionId" | "windowId" | "observationId">
    | undefined;

  async startSession(
    request: SessionRequest,
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    try {
      request = SessionRequestSchema.parse(request);
      const channel = this.resolveChannel(request.channelId);
      if (!channel?.endpoint.startsWith("http://")) throw new Error("endpoint");
      this.#endpoint = channel.endpoint.replace(/\/$/, "");
      this.#elementOriginActionsSupported = channel.elementOriginActions;
      const response = await this.#request(
        "POST",
        "/session",
        {
          capabilities: {
            alwaysMatch: {
              platformName: "mac",
              "appium:automationName": "Mac2",
              "appium:bundleId": request.bundleId,
              "appium:newCommandTimeout": NEW_COMMAND_TIMEOUT_SECONDS,
              ...(request.arguments ? { "appium:arguments": request.arguments } : {}),
              ...(request.environment ? { "appium:environment": request.environment } : {}),
            },
          },
        },
        signal,
      );
      const value = asObject(response.value);
      const sessionId =
        typeof response.sessionId === "string"
          ? response.sessionId
          : typeof value?.sessionId === "string"
            ? value.sessionId
            : undefined;
      if (!sessionId) throw new Error("missing session");
      this.#nativeSessionId = sessionId;
      this.#bundleId = request.bundleId;
      this.#windowQuery = request.window;
      const capabilities = asObject(value?.capabilities ?? value);
      const automationName = capabilities?.["appium:automationName"] ?? capabilities?.automationName;
      if (automationName !== undefined && automationName !== "Mac2")
        throw new Error("incompatible automation backend");
      const timeouts = asObject((await this.#sessionRequest("GET", "/timeouts", undefined, signal)).value);
      if (timeouts?.command !== NEW_COMMAND_TIMEOUT_MS) throw new Error("incompatible command timeout");
      const source = await this.#pageSource(signal);
      await this.#requireForeground(signal);
      if (typeof source.value !== "string" || !this.#windowMatches(source.value, request.window))
        throw new Error("window readiness");
      await this.#resolveWindow(request.window, signal);
      await this.#sessionRequest(
        "POST",
        "/actions",
        {
          actions: [
            {
              type: "key",
              id: "capability-probe",
              actions: [{ type: "pause", duration: 1 }],
            },
          ],
        },
        signal,
      );
      return ok(
        ProviderReceiptSchema.parse({
          provider: "appium-mac2",
          operationId: this.#nextId("operation") as OperationId,
          dispatch: "dispatched",
          outcome: "succeeded",
          startedAt,
          finishedAt: new Date().toISOString(),
        }),
      );
    } catch {
      if (this.#nativeSessionId) {
        try {
          await this.#sessionRequest("DELETE", "", undefined, new AbortController().signal);
        } catch {
          /* preserve the original readiness failure */
        }
      }
      this.#nativeSessionId = undefined;
      this.#elementOriginActionsSupported = false;
      this.#locators.clear();
      return err({
        code: signal.aborted ? "Cancelled" : "SessionUnavailable",
        phase: "driver",
        message: "Mac2 session could not be created.",
        retryDisposition: "safe",
        dispatch: signal.aborted ? "unknown" : "notDispatched",
      });
    }
  }

  async observe(
    request: Parameters<DesktopPort["observe"]>[0],
    signal: AbortSignal,
  ): ReturnType<DesktopPort["observe"]> {
    let stage = "requestValidation";
    try {
      request = ObserveRequestSchema.parse(request);
      stage = "pageSource";
      const sourceResponse = await this.#pageSource(signal);
      stage = "foreground";
      await this.#requireForeground(signal);
      stage = "windowResolution";
      await this.#resolveWindow(request.window ?? this.#windowQuery, signal);
      stage = "windowOwnership";
      if (typeof sourceResponse.value !== "string") throw new Error("invalid observation");
      const selectedWindow = request.window ?? this.#windowQuery;
      if (!selectedWindow || !this.#windowMatches(sourceResponse.value, selectedWindow))
        throw new Error("window not found");
      stage = "snapshotParse";
      const parsed = this.#parseElements(sourceResponse.value, request.observationId, selectedWindow);
      this.#windowQuery = selectedWindow;
      const elements = parsed.elements.map((element) => this.#sanitizeElement(element));
      this.#allElements = parsed.allElements.map((element) => this.#sanitizeElement(element));
      let screenshotScope: "display" | "unavailable" = "display";
      let screenshot: Uint8Array | undefined;
      let screenshotError: OperationError | undefined;
      stage = "displayScreenshot";
      try {
        const screenshotResponse: JsonObject = { value: await this.#mainDisplayScreenshot(signal) };
        if (typeof screenshotResponse.value !== "string") throw new Error("invalid observation");
        const decoded = Buffer.from(screenshotResponse.value, "base64");
        if (decoded.toString("base64") !== screenshotResponse.value || decoded.byteLength === 0)
          throw new Error("invalid screenshot");
        if (
          decoded.byteLength < PNG_SIGNATURE.byteLength ||
          !PNG_SIGNATURE.every((byte, index) => decoded[index] === byte)
        )
          throw new Error("invalid screenshot png");
        screenshot = new Uint8Array(decoded);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        screenshotScope = "unavailable";
        screenshotError = this.#observationError(error, stage);
      }
      this.#visualScreenshot = screenshot
        ? { observationId: request.observationId, bytes: screenshot.slice() }
        : undefined;
      const observation: Omit<Observation, "screenshot" | "uiSnapshot"> = {
        observationId: request.observationId,
        runId: request.runId,
        environmentId: "environment-active",
        generation: request.generation,
        sessionId: request.sessionId,
        windowId: request.windowId,
        capturedAt: new Date().toISOString(),
        screenshotScope,
        coverage: parsed.truncated ? "truncated" : "complete",
        ...(parsed.truncated ? { truncationReason: "elementLimit" } : {}),
        elements,
      };
      this.#context = {
        runId: request.runId,
        generation: request.generation,
        sessionId: request.sessionId,
        windowId: request.windowId,
        observationId: request.observationId,
      };
      const snapshot = new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          observationId: request.observationId,
          screenshotScope,
          coverage: parsed.truncated ? "truncated" : "complete",
          elements,
        }),
      );
      return ok({
        observation,
        ...(screenshot ? { screenshot } : {}),
        ...(screenshotError ? { screenshotError } : {}),
        snapshot,
      });
    } catch (error) {
      return err(this.#observationError(error, stage, signal));
    }
  }

  async dispatch(
    action: DesktopAction,
    operationId: OperationId,
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    const parsedAction = DesktopActionSchema.safeParse(action);
    if (!parsedAction.success)
      return err({
        code: action.kind === "pressKey" ? "UnsupportedKey" : "UnsupportedAction",
        phase: "action",
        message: "Action is outside supported capabilities.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    action = parsedAction.data;
    let stage = "contextValidation";
    let dispatchedTextCodePoints = 0;
    try {
      this.#validateActionContext(action);
      if (action.kind === "pressKey") {
        stage = "foreground";
        await this.#requireForeground(signal);
        stage = "windowResolution";
        await this.#resolveWindow(this.#windowQuery, signal);
        stage = "keyDispatch";
        await this.#execute(
          "macos: keys",
          { keys: [{ key: this.#key(action.key), modifierFlags: this.#modifierFlags(action.modifiers) }] },
          signal,
        );
      } else if (action.kind === "typeText") {
        stage = "foreground";
        await this.#requireForeground(signal);
        stage = "windowResolution";
        await this.#resolveWindow(this.#windowQuery, signal);
        const text = "literal" in action.value ? action.value.literal : undefined;
        if (text === undefined)
          return err({
            code: "InvalidConfiguration",
            phase: "action",
            message: "Secret text must be resolved before the Adapter boundary.",
            retryDisposition: "safe",
            dispatch: "notDispatched",
          });
        for (const codePoint of text) {
          stage = "textDispatch";
          await this.#execute("macos: keys", { keys: [codePoint] }, signal);
          dispatchedTextCodePoints += 1;
        }
      } else if (action.kind === "drag") {
        if (!this.#elementOriginActionsSupported)
          return err({
            code: "UnsupportedAction",
            phase: "action",
            message: "Element-origin pointer actions are unavailable.",
            retryDisposition: "safe",
            dispatch: "notDispatched",
          });
        await this.#drag(action, signal);
      } else {
        if (!("element" in action.target)) throw new Error("invalid target");
        const ref = action.target.element;
        stage = "foreground";
        await this.#requireForeground(signal);
        stage = "windowResolution";
        await this.#resolveWindow(this.#windowQuery, signal);
        stage = "targetResolution";
        const elementId = await this.#resolve(ref, signal);
        const point = action.target.point ?? { x: 0.5, y: 0.5 };
        const locator = await this.#currentSize(elementId, signal);
        const payload: JsonObject = {
          elementId,
          x: this.#inset(point.x, locator.width),
          y: this.#inset(point.y, locator.height),
        };
        if (action.kind === "scroll") {
          payload.deltaX = action.delta.x * locator.width;
          payload.deltaY = action.delta.y * locator.height;
          await this.#execute("macos: scroll", payload, signal);
        } else if (action.kind === "swipe") {
          payload.direction = action.direction;
          payload.velocity = { slow: 300, default: 800, fast: 1500 }[action.velocity ?? "default"];
          await this.#execute("macos: swipe", payload, signal);
        } else {
          payload.keyModifierFlags = this.#modifierFlags(
            "modifiers" in action ? action.modifiers : undefined,
          );
          await this.#execute(`macos: ${action.kind}`, payload, signal);
        }
      }
      return ok(
        ProviderReceiptSchema.parse({
          provider: "appium-mac2",
          operationId,
          dispatch: "dispatched",
          outcome: "succeeded",
          startedAt,
          finishedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      const providerCategory = error instanceof WebDriverFailure ? error.category : undefined;
      const code = message.includes("not foreground")
        ? "AppNotForeground"
        : message.includes("geometry")
          ? "UnsupportedAction"
          : message.includes("stale")
            ? "StaleElementRef"
            : message.includes("ambiguous")
              ? "TargetAmbiguous"
              : message.includes("not found")
                ? "TargetNotFound"
                : providerCategory === "unsupportedCommand"
                  ? "UnsupportedAction"
                  : providerCategory === "invalidArgument"
                    ? "InvalidConfiguration"
                    : providerCategory === "timeout"
                      ? "ProviderTimeout"
                      : providerCategory === "invalidSession"
                        ? "SessionUnavailable"
                        : providerCategory === "staleElement"
                          ? "StaleElementRef"
                          : providerCategory === "noSuchElement"
                            ? "TargetNotFound"
                            : signal.aborted
                              ? "Cancelled"
                              : "ProviderFailure";
      const beforeDispatch =
        code === "StaleElementRef" ||
        code === "TargetAmbiguous" ||
        code === "TargetNotFound" ||
        code === "AppNotForeground" ||
        code === "UnsupportedAction";
      const partialTextDispatch = action.kind === "typeText" && dispatchedTextCodePoints > 0;
      return err({
        code,
        phase: "action",
        message: beforeDispatch
          ? "Mac2 target could not be resolved safely."
          : providerCategory
            ? `Mac2 ${action.kind} failed at ${stage} with provider category ${providerCategory}.`
            : `Mac2 ${action.kind} failed at ${stage} without a reliable receipt.`,
        retryDisposition: beforeDispatch ? "safe" : "reconcileRequired",
        dispatch: beforeDispatch ? "notDispatched" : partialTextDispatch ? "dispatched" : "unknown",
      });
    } finally {
      this.#context = undefined;
      this.#visualScreenshot = undefined;
      this.#locators.clear();
      this.#previousLocators.clear();
    }
  }

  rebind(action: DesktopAction, observation: Observation): OperationResult<DesktopAction> {
    const rebindRef = (ref: ElementRef): OperationResult<ElementRef> => {
      if (
        ref.runId !== observation.runId ||
        ref.environmentId !== observation.environmentId ||
        ref.generation !== observation.generation ||
        ref.sessionId !== observation.sessionId ||
        ref.windowId !== observation.windowId
      )
        return err({
          code: "StaleElementRef",
          phase: "action",
          message: "Element belongs to a different environment context.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        });
      const locator = this.#previousLocators.get(ref.elementId) ?? this.#locators.get(ref.elementId);
      if (!locator)
        return err({
          code: "StaleElementRef",
          phase: "action",
          message: "Previous locator is unavailable.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        });
      const matches = this.#allElements.filter((element) => {
        if (element.visible === false) return false;
        if (locator.query) return this.#matches(element, locator.query);
        return (
          (!locator.identifier || element.identifier === locator.identifier) &&
          element.role === locator.role.replace("XCUIElementType", "").toLowerCase() &&
          (locator.name === undefined || element.name === locator.name) &&
          (locator.title === undefined || element.name === locator.title) &&
          (locator.label === undefined || element.label === locator.label) &&
          (locator.value === undefined || element.value === locator.value) &&
          (locator.enabled === undefined || element.enabled === locator.enabled) &&
          (locator.selected === undefined || element.selected === locator.selected) &&
          (locator.focused === undefined || element.focused === locator.focused)
        );
      });
      if (matches.length !== 1 || !matches[0])
        return err({
          code: matches.length === 0 ? "TargetNotFound" : "TargetAmbiguous",
          phase: "action",
          message: "Target could not be rebound uniquely.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        });
      return ok({
        runId: observation.runId,
        environmentId: observation.environmentId,
        generation: observation.generation,
        sessionId: observation.sessionId,
        windowId: observation.windowId,
        observationId: observation.observationId,
        elementId: matches[0].elementId,
      });
    };
    if (action.kind === "pressKey" || action.kind === "typeText") return ok(action);
    if (action.kind === "drag") {
      const from = rebindRef(action.from.element);
      const to = rebindRef(action.to.element);
      if (!from.ok) return from;
      if (!to.ok) return to;
      return ok({
        ...action,
        from: { ...action.from, element: from.value },
        to: { ...action.to, element: to.value },
      });
    }
    if (!("element" in action.target))
      return err({
        code: "UnsupportedAction",
        phase: "action",
        message: "Action target is invalid.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    const target = rebindRef(action.target.element);
    return target.ok
      ? ok(DesktopActionSchema.parse({ ...action, target: { ...action.target, element: target.value } }))
      : target;
  }

  async evaluate(
    assertion: AssertionSpec,
    observation: Observation,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<OperationResult<{ status: "passed" | "failed" | "unverifiable"; reason: string }>> {
    if (assertion.kind === "aiVisual") {
      const evaluator = this.visualEvaluator;
      const screenshot = this.#visualScreenshot;
      if (
        !evaluator ||
        !AssertionSpecSchema.safeParse(assertion).success ||
        !screenshot ||
        !observation.screenshot ||
        screenshot.observationId !== observation.observationId ||
        createHash("sha256").update(screenshot.bytes).digest("hex") !== observation.screenshot.sha256 ||
        this.#context?.observationId !== observation.observationId ||
        this.#context.runId !== observation.runId ||
        this.#context.generation !== observation.generation ||
        this.#context.sessionId !== observation.sessionId ||
        this.#context.windowId !== observation.windowId ||
        signal.aborted
      )
        return ok({
          status: "unverifiable",
          reason: "Accepted visual evaluation requires a current window screenshot and configured evaluator.",
        });
      try {
        const evaluation = evaluator.evaluate(
          {
            goal: assertion.goal,
            observationId: observation.observationId,
            screenshot: screenshot.bytes.slice(),
            mimeType: "image/png",
          },
          signal,
        );
        let abort: (() => void) | undefined;
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(new Error("Visual evaluation cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        let response: unknown;
        try {
          response = await Promise.race([evaluation, cancelled]);
        } finally {
          if (abort) signal.removeEventListener("abort", abort);
        }
        const parsed = VisualEvaluationSchema.safeParse(response);
        if (
          !parsed.success ||
          ((current: AbortSignal) => current.aborted)(signal) ||
          this.#context.observationId !== observation.observationId
        )
          throw new Error("Invalid visual result");
        return ok({
          status: parsed.data.status,
          reason: `aiVisual model=${evaluator.model} screenshot=${observation.screenshot.artifactId} sha256=${observation.screenshot.sha256}`,
        });
      } catch {
        return ok({
          status: "unverifiable",
          reason: "Visual evaluator failed or returned invalid evidence.",
        });
      }
    }
    if (observation.coverage !== "complete")
      return ok({ status: "unverifiable", reason: "Snapshot coverage is incomplete." });
    if (assertion.kind === "elementOrder") {
      const elements: ElementSummary[] = [];
      for (const query of assertion.queries) {
        const matches = observation.elements.filter((element) => this.#matches(element, query));
        if (matches.length !== 1 || !matches[0]?.geometry)
          return ok({
            status: "unverifiable",
            reason: "Element order target is not unique or lacks geometry.",
          });
        elements.push(matches[0]);
      }
      const coordinate = (element: ElementSummary): number => {
        const geometry = element.geometry;
        if (!geometry) return Number.NaN;
        return assertion.direction === "topToBottom"
          ? geometry.y + geometry.height / 2
          : geometry.x + geometry.width / 2;
      };
      const ordered = elements.every(
        (element, index) =>
          index === 0 || coordinate(elements[index - 1] as ElementSummary) <= coordinate(element),
      );
      return ok({
        status: ordered ? "passed" : "failed",
        reason: "Deterministic element geometry comparison.",
      });
    }
    const query = assertion.query;
    const matches = observation.elements.filter((element) => this.#matches(element, query));
    if (assertion.kind === "notVisible")
      return ok({
        status:
          matches.length === 0 || matches.every((element) => element.visible === false)
            ? "passed"
            : matches.some((element) => element.visible === true)
              ? "failed"
              : "unverifiable",
        reason: "Complete snapshot absence check.",
      });
    if (matches.length !== 1)
      return ok({
        status: matches.length === 0 ? "failed" : "unverifiable",
        reason: "Assertion target is not unique.",
      });
    const element = matches[0];
    if (!element) return ok({ status: "unverifiable", reason: "Assertion target is unavailable." });
    if (assertion.kind === "visible")
      return ok({
        status: element.visible === undefined ? "unverifiable" : element.visible ? "passed" : "failed",
        reason: "Explicit observed visibility state.",
      });
    if (assertion.kind === "text" || assertion.kind === "value") {
      const actual =
        assertion.kind === "value" ? element.value : element.name || element.label || element.value;
      if (actual === undefined) return ok({ status: "unverifiable", reason: "Text state is unknown." });
      const passed =
        assertion.match === "contains" ? actual.includes(assertion.expected) : actual === assertion.expected;
      return ok({ status: passed ? "passed" : "failed", reason: "Deterministic text comparison." });
    }
    if (!("state" in assertion))
      return ok({ status: "unverifiable", reason: "Unsupported deterministic assertion." });
    const states = Object.entries(assertion.state);
    const unknown = states.some(([key]) => element[key as "enabled" | "selected" | "focused"] === undefined);
    const passed =
      !unknown &&
      states.every(([key, value]) => element[key as "enabled" | "selected" | "focused"] === value);
    return ok({
      status: unknown ? "unverifiable" : passed ? "passed" : "failed",
      reason: "Deterministic state comparison.",
    });
  }

  async stopSession(signal: AbortSignal): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    try {
      if (this.#nativeSessionId) await this.#sessionRequest("DELETE", "", undefined, signal);
      this.#nativeSessionId = undefined;
      this.#elementOriginActionsSupported = false;
      this.#bundleId = undefined;
      this.#locators.clear();
      this.#allElements = [];
      this.#context = undefined;
      this.#visualScreenshot = undefined;
      this.#windowQuery = undefined;
      return ok({
        provider: "appium-mac2",
        operationId: this.#nextId("operation") as OperationId,
        dispatch: "dispatched",
        outcome: "succeeded",
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch {
      return err({
        code: "CleanupFailed",
        phase: "cleanup",
        message: "Mac2 session could not be closed.",
        retryDisposition: "safe",
      });
    }
  }

  compact(observation: Observation): string {
    const visible = observation.elements.slice(0, 200);
    const coverage = observation.elements.length > 200 ? "partial" : observation.coverage;
    return [
      `snapshot=${observation.observationId} window=${observation.windowId} screenshotScope=${observation.screenshotScope} coverage=${coverage}`,
      ...visible.map((e) => {
        const primary =
          [e.name, e.label, e.value].find((value) => value !== undefined && value.length > 0) ?? "";
        const identifier =
          e.identifier === undefined || e.identifier.length === 0
            ? ""
            : ` id=${JSON.stringify(e.identifier.slice(0, 500))}`;
        const depth = e.depth ?? 0;
        const parent = e.parentElementId ? ` parent=${e.parentElementId}` : "";
        return `${"  ".repeat(Math.min(depth, 32))}[${e.elementId}] ${e.role} ${JSON.stringify(primary.slice(0, 120))}${identifier}${parent} depth=${String(depth)}${e.enabled === undefined ? "" : e.enabled ? " enabled" : " disabled"}`;
      }),
      ...(observation.elements.length > 200
        ? [`... ${String(observation.elements.length - 200)} more elements`]
        : []),
    ].join("\n");
  }

  query(observation: Observation, query: ElementQuery): OperationResult<ElementRef> {
    const source =
      this.#context?.observationId === observation.observationId ? this.#allElements : observation.elements;
    const matches = source.filter((element) => this.#matches(element, query, source));
    if (observation.coverage !== "complete")
      return err({
        code: "SnapshotIncomplete",
        phase: "observe",
        message: "Snapshot coverage is incomplete.",
        retryDisposition: "safe",
      });
    if (matches.length !== 1)
      return err({
        code: matches.length === 0 ? "TargetNotFound" : "TargetAmbiguous",
        phase: "observe",
        message: "Snapshot query is not unique.",
        retryDisposition: "safe",
      });
    const match = matches[0];
    if (!match)
      return err({
        code: "TargetNotFound",
        phase: "observe",
        message: "Snapshot query did not match.",
        retryDisposition: "safe",
      });
    const locator = this.#locators.get(match.elementId);
    if (locator) locator.query = structuredClone(query);
    return ok({
      runId: observation.runId,
      environmentId: observation.environmentId,
      generation: observation.generation,
      sessionId: observation.sessionId,
      windowId: observation.windowId,
      observationId: observation.observationId,
      elementId: match.elementId,
    });
  }

  queryPage(
    observation: Observation,
    query: ElementQuery,
    offset: number,
    limit: number,
  ): OperationResult<QueryPage> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return err({
        code: "InvalidScenario",
        phase: "observe",
        message: "Invalid query page bounds.",
        retryDisposition: "safe",
      });
    const current = this.#context?.observationId === observation.observationId;
    const source = current ? this.#allElements : observation.elements;
    const matches = source.filter((element) => this.#matches(element, query, source));
    const complete = current || observation.coverage === "complete";
    const resolved =
      complete && matches.length === 1
        ? this.query({ ...observation, coverage: "complete" }, query)
        : undefined;
    return ok(
      QueryPageSchema.parse({
        status: !complete
          ? "incomplete"
          : matches.length === 0
            ? "notFound"
            : matches.length === 1
              ? "unique"
              : "ambiguous",
        observationId: observation.observationId,
        count: matches.length,
        candidates: matches.slice(offset, offset + limit),
        ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
        ...(resolved?.ok ? { reference: resolved.value } : {}),
      }),
    );
  }

  expand(observation: Observation, elementId: ElementId): OperationResult<ElementSummary> {
    const source =
      this.#context?.observationId === observation.observationId ? this.#allElements : observation.elements;
    const element = source.find((item) => item.elementId === elementId);
    return element
      ? ok(element)
      : err({
          code: "TargetNotFound",
          phase: "observe",
          message: "Element is not present in this snapshot.",
          retryDisposition: "safe",
        });
  }

  async #drag(action: Extract<DesktopAction, { kind: "drag" }>, signal: AbortSignal): Promise<void> {
    const source = await this.#resolve(action.from.element, signal);
    const destination = await this.#resolve(action.to.element, signal);
    const from = action.from.point ?? { x: 0.5, y: 0.5 };
    const to = action.to.point ?? { x: 0.5, y: 0.5 };
    const sourceLocator = await this.#currentSize(source, signal);
    const destinationLocator = await this.#currentSize(destination, signal);
    await this.#sessionRequest(
      "POST",
      "/actions",
      {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              {
                type: "pointerMove",
                duration: 10,
                origin: { [W3C_ELEMENT]: source },
                x: this.#inset(from.x, sourceLocator.width) - sourceLocator.width / 2,
                y: this.#inset(from.y, sourceLocator.height) - sourceLocator.height / 2,
              },
              { type: "pointerDown", button: 0 },
              {
                type: "pointerMove",
                duration: action.durationMs ?? 500,
                origin: { [W3C_ELEMENT]: destination },
                x: this.#inset(to.x, destinationLocator.width) - destinationLocator.width / 2,
                y: this.#inset(to.y, destinationLocator.height) - destinationLocator.height / 2,
              },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      },
      signal,
    );
  }

  async #resolve(ref: ElementRef, signal: AbortSignal): Promise<string> {
    const locator = this.#locators.get(ref.elementId);
    if (!locator) throw new Error("stale");
    const using = "xpath";
    const predicates: string[] = [];
    const query = locator.query;
    const selectorPredicate = (selector: ElementSelector): string => {
      const clauses: string[] = [];
      if (selector.identifier) clauses.push(`@identifier=${xpathLiteral(selector.identifier)}`);
      if (selector.name) clauses.push(this.#textXpath("@title", selector.name));
      if (selector.label) clauses.push(this.#textXpath("@label", selector.label));
      if (selector.value) clauses.push(this.#textXpath("@value", selector.value));
      if (selector.state)
        for (const [field, expected] of Object.entries(selector.state))
          if (expected !== undefined) clauses.push(`@${field}=${xpathLiteral(String(expected))}`);
      return clauses.join(" and ");
    };
    const nativeRoleFor = (selector: ElementSelector): string => {
      if (!selector.role) return "*";
      const roles = [
        ...new Set(
          this.#allElements
            .filter((element) => element.role === selector.role)
            .flatMap((element) => (element.nativeRole ? [element.nativeRole] : [])),
        ),
      ];
      return roles.length === 1 ? (roles[0] as string) : "*";
    };
    for (const field of ["identifier", "name", "title", "label", "value"] as const) {
      const expected = locator[field];
      if (expected !== undefined) predicates.push(`@${field}=${xpathLiteral(expected)}`);
    }
    for (const field of ["enabled", "selected", "focused"] as const) {
      const expected = locator[field];
      if (expected !== undefined) predicates.push(`@${field}=${xpathLiteral(String(expected))}`);
    }
    const idsFrom = (response: JsonObject): string[] =>
      (Array.isArray(response.value) ? response.value : []).flatMap((item) => {
        const id = asObject(item)?.[W3C_ELEMENT];
        return typeof id === "string" ? [id] : [];
      });
    const find = async (path: string, value: string): Promise<string[]> =>
      idsFrom(await this.#sessionRequest("POST", path, { using, value }, signal));
    const targetPath = `${locator.role}${predicates.length ? `[${predicates.join(" and ")}]` : ""}`;
    let candidateIds: string[];
    if (!query?.ancestor && !query?.descendant) {
      const clauses: string[] = [];
      for (const field of ["identifier", "name", "title", "label", "value"] as const) {
        const expected = locator[field];
        if (expected !== undefined) clauses.push(`${field} == ${classChainLiteral(expected)}`);
      }
      for (const field of ["enabled", "selected", "focused"] as const) {
        const expected = locator[field];
        if (expected !== undefined) clauses.push(`${field} == ${expected ? "TRUE" : "FALSE"}`);
      }
      const windowClauses: string[] = [];
      const window = this.#windowQuery;
      if (!window) throw new Error("ambiguous window");
      if (window.title) {
        const field = window.title.caseSensitive ? "title" : "title";
        const raw = "exact" in window.title ? window.title.exact : window.title.contains;
        const operator = "exact" in window.title ? "==" : "CONTAINS";
        const modifier = window.title.caseSensitive ? "" : "[c]";
        windowClauses.push(`${field} ${operator}${modifier} ${classChainLiteral(raw)}`);
      }
      if (window.isMain === true) windowClauses.push("(main == TRUE OR focused == TRUE)");
      if (window.isMain === false) windowClauses.push("main == FALSE AND focused == FALSE");
      if (window.isModal !== undefined) windowClauses.push(`modal == ${window.isModal ? "TRUE" : "FALSE"}`);
      candidateIds = idsFrom(
        await this.#sessionRequest(
          "POST",
          "/elements",
          {
            using: "class chain",
            value: `**/XCUIElementTypeWindow${windowClauses.length ? `[\`${windowClauses.join(" AND ")}\`]` : ""}/**/${locator.role}${clauses.length ? `[\`${clauses.join(" AND ")}\`]` : ""}`,
          },
          signal,
        ),
      );
    } else if (query.ancestor) {
      const relation = selectorPredicate(query.ancestor);
      const role = nativeRoleFor(query.ancestor);
      candidateIds = await find(
        "/elements",
        `${this.#windowXpath(this.#windowQuery)}//${role}${relation ? `[${relation}]` : ""}//${targetPath}`,
      );
    } else {
      candidateIds = await find("/elements", `${this.#windowXpath(this.#windowQuery)}//${targetPath}`);
    }
    if (query?.descendant) {
      const relation = selectorPredicate(query.descendant);
      const role = nativeRoleFor(query.descendant);
      const ancestorPrefix = query.ancestor
        ? `//${nativeRoleFor(query.ancestor)}${selectorPredicate(query.ancestor) ? `[${selectorPredicate(query.ancestor)}]` : ""}`
        : "";
      candidateIds = await find(
        "/elements",
        `${this.#windowXpath(this.#windowQuery)}${ancestorPrefix}//${targetPath}[descendant::${role}${relation ? `[${relation}]` : ""}]`,
      );
    }
    if (
      candidateIds.length > 1 &&
      [locator.x, locator.y, locator.width, locator.height].every(Number.isFinite)
    ) {
      const matching: string[] = [];
      for (const candidateId of candidateIds.slice(0, 100)) {
        const rect = asObject(
          (
            await this.#sessionRequest(
              "GET",
              `/element/${encodeURIComponent(candidateId)}/rect`,
              undefined,
              signal,
            )
          ).value,
        );
        if (
          rect &&
          Math.abs(Number(rect.x) - Number(locator.x)) < 0.5 &&
          Math.abs(Number(rect.y) - Number(locator.y)) < 0.5 &&
          Math.abs(Number(rect.width) - Number(locator.width)) < 0.5 &&
          Math.abs(Number(rect.height) - Number(locator.height)) < 0.5
        )
          matching.push(candidateId);
      }
      candidateIds = matching;
    }
    if (candidateIds.length !== 1) throw new Error(candidateIds.length === 0 ? "not found" : "ambiguous");
    const id = candidateIds[0];
    if (!id) throw new Error("element id");
    const visible = await this.#sessionRequest(
      "GET",
      `/element/${encodeURIComponent(id)}/displayed`,
      undefined,
      signal,
    );
    if (visible.value !== true && visible.value !== "true") throw new Error("not visible");
    return id;
  }

  async #currentSize(elementId: string, signal: AbortSignal): Promise<{ width: number; height: number }> {
    const response = await this.#sessionRequest(
      "GET",
      `/element/${encodeURIComponent(elementId)}/rect`,
      undefined,
      signal,
    );
    const rect = asObject(response.value);
    const width = rect?.width;
    const height = rect?.height;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    )
      throw new Error("geometry");
    return { width, height };
  }

  async #requireForeground(signal: AbortSignal): Promise<void> {
    if (!this.#bundleId) throw new Error("session");
    const response = await this.#execute("macos: queryAppState", { bundleId: this.#bundleId }, signal);
    if (response.value !== 4) throw new Error("not foreground");
  }

  async #resolveWindow(query: WindowQuery | undefined, signal: AbortSignal): Promise<string> {
    if (!query) throw new Error("ambiguous window");
    const xpath = this.#windowXpath(query);
    const response = await this.#sessionRequest(
      "POST",
      "/elements",
      { using: "xpath", value: xpath },
      signal,
    );
    const elements = Array.isArray(response.value) ? response.value : [];
    if (elements.length !== 1)
      throw new Error(elements.length === 0 ? "window not found" : "ambiguous window");
    const item = asObject(elements[0]);
    const id = typeof item?.[W3C_ELEMENT] === "string" ? item[W3C_ELEMENT] : undefined;
    if (!id) throw new Error("window element id");
    return id;
  }

  #windowXpath(query: WindowQuery | undefined): string {
    if (!query) throw new Error("ambiguous window");
    const clauses: string[] = [];
    if (query.title) {
      const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = "abcdefghijklmnopqrstuvwxyz";
      const field = query.title.caseSensitive
        ? "@title"
        : `translate(@title, ${xpathLiteral(upper)}, ${xpathLiteral(lower)})`;
      const raw = "exact" in query.title ? query.title.exact : query.title.contains;
      const expected = query.title.caseSensitive
        ? raw
        : raw.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
      if ("exact" in query.title) clauses.push(`${field}=${xpathLiteral(expected)}`);
      else clauses.push(`contains(${field}, ${xpathLiteral(expected)})`);
    }
    if (query.role) {
      if (query.role !== "window") throw new Error("window not found");
    }
    if (query.isMain !== undefined)
      clauses.push(
        query.isMain
          ? `(@main=${xpathLiteral("true")} or @focused=${xpathLiteral("true")})`
          : `not(@main=${xpathLiteral("true")}) and not(@focused=${xpathLiteral("true")})`,
      );
    if (query.isModal !== undefined) clauses.push(`@modal=${xpathLiteral(String(query.isModal))}`);
    return `//XCUIElementTypeWindow${clauses.length ? `[${clauses.join(" and ")}]` : ""}`;
  }

  #parseElements(
    xml: string,
    observationId: string,
    selectedWindow?: WindowQuery,
  ): { elements: ElementSummary[]; allElements: ElementSummary[]; truncated: boolean } {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("unsafe xml");
    if (Buffer.byteLength(xml, "utf8") > 8_000_000) throw new Error("unsafe xml size");
    let depth = 0;
    let nodes = 0;
    for (const match of xml.matchAll(/<([^>]+)>/g)) {
      const tag = match[1] ?? "";
      if (tag.startsWith("?") || tag.startsWith("!")) continue;
      if (tag.startsWith("/")) depth -= 1;
      else {
        nodes += 1;
        if (!tag.endsWith("/")) depth += 1;
      }
      if (depth < 0 || depth > 128 || nodes > 20_000) throw new Error("unsafe xml bounds");
    }
    const parsed: unknown = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      allowBooleanAttributes: true,
    }).parse(xml);
    const output: ElementSummary[] = [];
    this.#previousLocators = new Map(this.#locators);
    this.#locators.clear();
    const visit = (
      value: unknown,
      roleHint?: string,
      inSelectedWindow = selectedWindow === undefined,
      parentElementId?: ElementId,
      logicalDepth = 0,
    ): void => {
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, roleHint, inSelectedWindow, parentElementId, logicalDepth));
        return;
      }
      const object = asObject(value);
      if (!object) return;
      const role = typeof object.type === "string" ? object.type : roleHint;
      if (selectedWindow && role === "XCUIElementTypeWindow") {
        const title =
          typeof object.title === "string"
            ? object.title
            : typeof object.label === "string"
              ? object.label
              : undefined;
        const focused = object.focused === "true" || object.focused === true;
        const main = object.main === undefined ? focused : object.main === "true" || object.main === true;
        const modal =
          object.modal === undefined ? undefined : object.modal === "true" || object.modal === true;
        if (
          (selectedWindow.title && (title === undefined || !this.#textMatch(title, selectedWindow.title))) ||
          (selectedWindow.role && selectedWindow.role !== "window") ||
          (selectedWindow.isMain !== undefined && selectedWindow.isMain !== main) ||
          (selectedWindow.isModal !== undefined && selectedWindow.isModal !== modal) ||
          (object.focused !== undefined && !focused)
        )
          return;
        inSelectedWindow = true;
      }
      let childParentId = parentElementId;
      let childDepth = logicalDepth;
      if (inSelectedWindow && role?.startsWith("XCUIElementType")) {
        const elementId = this.#nextId("element") as ElementId;
        const summary = ElementSummarySchema.parse({
          elementId,
          role: role.replace("XCUIElementType", "").toLowerCase() || "element",
          nativeRole: role,
          ...(parentElementId ? { parentElementId } : {}),
          depth: logicalDepth,
          ...(typeof object.identifier === "string" && object.identifier
            ? { identifier: object.identifier }
            : {}),
          ...(typeof object.title === "string"
            ? { name: object.title }
            : typeof object.name === "string"
              ? { name: object.name }
              : {}),
          ...(typeof object.label === "string" ? { label: object.label } : {}),
          ...(typeof object.value === "string" ? { value: object.value } : {}),
          ...(object.visible === "true" || object.visible === true
            ? { visible: true }
            : object.visible === "false" || object.visible === false
              ? { visible: false }
              : {}),
          ...(object.enabled === "true" || object.enabled === true
            ? { enabled: true }
            : object.enabled === "false" || object.enabled === false
              ? { enabled: false }
              : {}),
          ...(role === "XCUIElementTypeCheckBox" &&
          (object.value === "1" || object.value === 1 || object.value === true)
            ? { selected: true }
            : role === "XCUIElementTypeCheckBox" &&
                (object.value === "0" || object.value === 0 || object.value === false)
              ? { selected: false }
              : object.selected === "true" || object.selected === true
                ? { selected: true }
                : object.selected === "false" || object.selected === false
                  ? { selected: false }
                  : {}),
          ...(object.focused === "true" || object.focused === true
            ? { focused: true }
            : object.focused === "false" || object.focused === false
              ? { focused: false }
              : {}),
          ...(object.modal === "true" || object.modal === true
            ? { isModal: true }
            : object.modal === "false" || object.modal === false
              ? { isModal: false }
              : {}),
          ...(object.main === "true" || object.main === true
            ? { isMain: true }
            : object.main === "false" || object.main === false
              ? { isMain: false }
              : {}),
          ...(Number.isFinite(Number(object.x)) &&
          Number.isFinite(Number(object.y)) &&
          Number.isFinite(Number(object.width)) &&
          Number.isFinite(Number(object.height))
            ? {
                geometry: {
                  x: Number(object.x),
                  y: Number(object.y),
                  width: Number(object.width),
                  height: Number(object.height),
                },
              }
            : {}),
        });
        output.push(summary);
        childParentId = elementId;
        childDepth = logicalDepth + 1;
        this.#locators.set(elementId, {
          role,
          ...(summary.identifier ? { identifier: summary.identifier } : {}),
          ...(typeof object.title === "string"
            ? { title: object.title }
            : summary.name !== undefined
              ? { name: summary.name }
              : {}),
          ...(summary.label === undefined ? {} : { label: summary.label }),
          ...(summary.value === undefined ? {} : { value: summary.value }),
          ...(summary.enabled === undefined ? {} : { enabled: summary.enabled }),
          ...(summary.selected === undefined ? {} : { selected: summary.selected }),
          ...(summary.focused === undefined ? {} : { focused: summary.focused }),
          width: Number(object.width),
          height: Number(object.height),
          x: Number(object.x),
          y: Number(object.y),
        });
      }
      for (const [key, child] of Object.entries(object))
        if (
          ![
            "identifier",
            "name",
            "label",
            "value",
            "enabled",
            "visible",
            "selected",
            "focused",
            "modal",
            "main",
            "x",
            "y",
            "width",
            "height",
            "type",
          ].includes(key)
        )
          visit(child, key, inSelectedWindow, childParentId, childDepth);
    };
    visit(parsed);
    return { elements: output.slice(0, 5000), allElements: output, truncated: output.length > 5000 };
  }

  #windowMatches(xml: string, query: WindowQuery): boolean {
    const locators = new Map(this.#locators);
    const previous = new Map(this.#previousLocators);
    try {
      const elements = this.#parseElements(xml, "observation-window-probe").allElements.filter(
        (item) => item.role === "window",
      );
      const matches = elements.filter((window) => {
        const title = window.name ?? window.label ?? window.value;
        const textMatch = !query.title || (title !== undefined && this.#textMatch(title, query.title));
        const roleMatch = !query.role || window.role === query.role;
        const mainState = window.isMain ?? window.focused;
        const mainMatch = query.isMain === undefined || mainState === query.isMain;
        const modalMatch = query.isModal === undefined || window.isModal === query.isModal;
        const foregroundMatch = window.focused !== false;
        return textMatch && roleMatch && mainMatch && modalMatch && foregroundMatch;
      });
      return matches.length === 1;
    } finally {
      this.#locators = locators;
      this.#previousLocators = previous;
    }
  }

  #textMatch(actual: string, match: TextMatch): boolean {
    const source = match.caseSensitive ? actual : actual.toLocaleLowerCase();
    const raw = "exact" in match ? match.exact : match.contains;
    const expected = match.caseSensitive ? raw : raw.toLocaleLowerCase();
    return "exact" in match ? source === expected : source.includes(expected);
  }

  #textXpath(field: string, match: TextMatch): string {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const source = match.caseSensitive
      ? field
      : `translate(${field}, ${xpathLiteral(upper)}, ${xpathLiteral(lower)})`;
    const raw = "exact" in match ? match.exact : match.contains;
    const expected = match.caseSensitive ? raw : raw.toLocaleLowerCase();
    return "exact" in match
      ? `${source}=${xpathLiteral(expected)}`
      : `contains(${source}, ${xpathLiteral(expected)})`;
  }

  #sanitizeElement(element: ElementSummary): ElementSummary {
    if (!this.sensitive) return element;
    const result = { ...element };
    for (const key of ["identifier", "name", "label", "value"] as const) {
      const value = result[key];
      if (value !== undefined) result[key] = this.sensitive.sanitizeText(value);
    }
    return result;
  }

  #matchesSelector(element: ElementSummary, selector: ElementSelector): boolean {
    const text = (actual: string | undefined, match: TextMatch | undefined): boolean =>
      actual !== undefined && match !== undefined ? this.#textMatch(actual, match) : match === undefined;
    return (
      (!selector.role || element.role === selector.role) &&
      (!selector.identifier || element.identifier === selector.identifier) &&
      text(element.name, selector.name) &&
      text(element.label, selector.label) &&
      text(element.value, selector.value) &&
      (!selector.state ||
        Object.entries(selector.state).every(
          ([key, value]) => element[key as "enabled" | "selected" | "focused"] === value,
        ))
    );
  }

  #matches(
    element: ElementSummary,
    query: Exclude<AssertionSpec, { kind: "aiVisual" | "elementOrder" }>["query"],
    source: readonly ElementSummary[] = this.#allElements,
  ): boolean {
    const selector: ElementSelector = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.identifier ? { identifier: query.identifier } : {}),
      ...(query.name ? { name: query.name } : {}),
      ...(query.label ? { label: query.label } : {}),
      ...(query.value ? { value: query.value } : {}),
      ...(query.state ? { state: query.state } : {}),
    };
    if (!this.#matchesSelector(element, selector)) return false;
    const byId = new Map(source.map((item) => [item.elementId, item]));
    const hasAncestor = (candidate: ElementSummary, match: ElementSelector): boolean => {
      let parentId = candidate.parentElementId;
      while (parentId) {
        const parent = byId.get(parentId);
        if (!parent) return false;
        if (this.#matchesSelector(parent, match)) return true;
        parentId = parent.parentElementId;
      }
      return false;
    };
    const descendsFrom = (candidate: ElementSummary, ancestorId: ElementId): boolean => {
      let parentId = candidate.parentElementId;
      while (parentId) {
        if (parentId === ancestorId) return true;
        parentId = byId.get(parentId)?.parentElementId;
      }
      return false;
    };
    if (query.ancestor && !hasAncestor(element, query.ancestor)) return false;
    if (query.descendant)
      return source.some(
        (candidate) =>
          this.#matchesSelector(candidate, query.descendant as ElementSelector) &&
          descendsFrom(candidate, element.elementId),
      );
    return true;
  }
  #validateActionContext(action: DesktopAction): void {
    const refs: ElementRef[] =
      action.kind === "pressKey" || action.kind === "typeText"
        ? []
        : action.kind === "drag"
          ? [action.from.element, action.to.element]
          : "element" in action.target
            ? [action.target.element]
            : [];
    for (const ref of refs) {
      const context = this.#context;
      if (
        !context ||
        ref.runId !== context.runId ||
        ref.generation !== context.generation ||
        ref.sessionId !== context.sessionId ||
        ref.windowId !== context.windowId ||
        ref.observationId !== context.observationId ||
        !this.#locators.has(ref.elementId)
      )
        throw new Error("stale element");
    }
  }
  #inset(ratio: number, size: number): number {
    const inset = Math.min(1, size / 2);
    return Math.min(Math.max(ratio * size, inset), size - inset);
  }
  #modifierFlags(modifiers?: readonly string[]): number {
    const flags: Record<string, number> = {
      command: 1 << 4,
      shift: 1 << 1,
      option: 1 << 3,
      control: 1 << 2,
      function: 1 << 5,
    };
    return (modifiers ?? []).reduce((total, item) => total | (flags[item] ?? 0), 0);
  }
  #key(key: string): string {
    return (
      (
        {
          enter: "XCUIKeyboardKeyReturn",
          tab: "XCUIKeyboardKeyTab",
          escape: "XCUIKeyboardKeyEscape",
          delete: "XCUIKeyboardKeyForwardDelete",
          backspace: "XCUIKeyboardKeyDelete",
          space: "XCUIKeyboardKeySpace",
          arrowUp: "XCUIKeyboardKeyUpArrow",
          arrowDown: "XCUIKeyboardKeyDownArrow",
          arrowLeft: "XCUIKeyboardKeyLeftArrow",
          arrowRight: "XCUIKeyboardKeyRightArrow",
          home: "XCUIKeyboardKeyHome",
          end: "XCUIKeyboardKeyEnd",
          pageUp: "XCUIKeyboardKeyPageUp",
          pageDown: "XCUIKeyboardKeyPageDown",
        } as Record<string, string>
      )[key] ?? key
    );
  }
  #execute(script: string, payload: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    return this.#sessionRequest("POST", "/execute/sync", { script, args: [payload] }, signal);
  }
  #observationError(error: unknown, stage: string, signal?: AbortSignal): OperationError {
    const detail = error instanceof Error ? error.message : "unknown";
    const providerCategory = error instanceof WebDriverFailure ? error.category : undefined;
    const code = signal?.aborted
      ? "Cancelled"
      : providerCategory === "invalidSession"
        ? "SessionUnavailable"
        : detail.includes("ambiguous window")
          ? "AmbiguousWindowOwner"
          : detail.includes("window not found") || detail.includes("not foreground")
            ? "AppNotForeground"
            : detail.includes("session")
              ? "SessionUnavailable"
              : detail.includes("unsafe xml")
                ? "SnapshotIncomplete"
                : "ProviderFailure";
    return {
      code,
      phase: "observe",
      message: `Mac2 observation failed at ${stage}${providerCategory ? ` with provider category ${providerCategory}` : ""}.`,
      retryDisposition: "safe",
    };
  }
  async #pageSource(signal: AbortSignal): Promise<JsonObject> {
    try {
      return await this.#sessionRequest("GET", "/source", undefined, signal);
    } catch (firstError) {
      signal.throwIfAborted();
      try {
        return await this.#execute("macos: source", { format: "xml" }, signal);
      } catch {
        signal.throwIfAborted();
        throw firstError;
      }
    }
  }
  async #mainDisplayScreenshot(signal: AbortSignal): Promise<string> {
    const response = await this.#execute("macos: screenshots", {}, signal);
    const screenshots = asObject(response.value);
    if (!screenshots || Object.keys(screenshots).length > 16) throw new Error("invalid display screenshots");
    const main = Object.values(screenshots)
      .map((item) => asObject(item))
      .filter((item) => item?.isMain === true);
    if (main.length !== 1 || typeof main[0]?.payload !== "string")
      throw new Error("invalid main display screenshot");
    return main[0].payload;
  }
  #sessionRequest(method: string, path: string, body: unknown, signal: AbortSignal): Promise<JsonObject> {
    if (!this.#nativeSessionId) return Promise.reject(new Error("session"));
    return this.#request(method, `/session/${this.#nativeSessionId}${path}`, body, signal);
  }
  async #request(method: string, path: string, body: unknown, signal: AbortSignal): Promise<JsonObject> {
    if (!this.#endpoint) throw new Error("endpoint");
    const init: RequestInit = {
      method,
      signal,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    };
    const response = await this.fetcher(`${this.#endpoint}${path}`, init);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("webdriver body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes: unknown = chunk.value;
        if (!(bytes instanceof Uint8Array)) throw new Error("webdriver response type");
        size += bytes.byteLength;
        if (size > 16_000_000) {
          await reader.cancel();
          throw new Error("webdriver response size");
        }
        chunks.push(bytes);
      }
    } finally {
      reader.releaseLock();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const object = asObject(value);
    const providerValue = asObject(object?.value);
    const providerError = providerValue?.error;
    const providerMessage = providerValue?.message;
    if (!response.ok || !object || typeof providerError === "string")
      throw new WebDriverFailure(
        typeof providerError === "string"
          ? providerErrorCategory(
              providerError,
              typeof providerMessage === "string" ? providerMessage : undefined,
            )
          : "transport",
      );
    return object;
  }

  #nextId(prefix: string): string {
    return this.ids.next(prefix);
  }
}
