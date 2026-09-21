import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import {
  ElementSummarySchema,
  DesktopActionSchema,
  err,
  ok,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type ElementId,
  type ElementRef,
  type ElementQuery,
  type ElementSummary,
  type Observation,
  type OperationId,
  type OperationResult,
  type ProviderReceipt,
  ProviderReceiptSchema,
  type SessionRequest,
  type TextMatch,
  type WindowQuery,
} from "../../contracts/index.js";

type JsonObject = Record<string, unknown>;
type NativeLocator = {
  identifier?: string;
  role: string;
  name?: string;
  label?: string;
  value?: string;
  width?: number;
  height?: number;
};
const W3C_ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const hashId = (prefix: string, value: string): string =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
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

export class Mac2DesktopAdapter implements DesktopPort {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  #endpoint: string | undefined;
  #nativeSessionId: string | undefined;
  #locators = new Map<string, NativeLocator>();
  #previousLocators = new Map<string, NativeLocator>();
  #allElements: ElementSummary[] = [];
  #windowQuery: WindowQuery | undefined;
  #context:
    | Pick<Observation, "runId" | "generation" | "sessionId" | "windowId" | "observationId">
    | undefined;

  async startSession(
    request: SessionRequest,
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    try {
      this.#endpoint = request.endpoint.replace(/\/$/, "");
      const response = await this.#request(
        "POST",
        "/session",
        {
          capabilities: {
            alwaysMatch: {
              platformName: "mac",
              "appium:automationName": "Mac2",
              "appium:bundleId": request.bundleId,
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
      this.#windowQuery = request.window;
      const capabilities = asObject(value?.capabilities ?? value);
      const automationName = capabilities?.["appium:automationName"] ?? capabilities?.automationName;
      if (automationName !== undefined && automationName !== "Mac2")
        throw new Error("incompatible automation backend");
      const source = await this.#sessionRequest("GET", "/source", undefined, signal);
      if (typeof source.value !== "string" || !this.#windowMatches(source.value, request.window))
        throw new Error("window readiness");
      const windowElement = await this.#resolveWindow(request.window, signal);
      await this.#sessionRequest(
        "POST",
        "/actions",
        {
          actions: [
            {
              type: "pointer",
              id: "capability-probe",
              parameters: { pointerType: "mouse" },
              actions: [
                {
                  type: "pointerMove",
                  duration: 0,
                  origin: { [W3C_ELEMENT]: windowElement },
                  x: 0,
                  y: 0,
                },
              ],
            },
          ],
        },
        signal,
      );
      await this.#sessionRequest("DELETE", "/actions", undefined, signal);
      return ok(
        ProviderReceiptSchema.parse({
          provider: "appium-mac2",
          operationId: hashId("operation", startedAt) as OperationId,
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
    try {
      const sourceResponse = await this.#sessionRequest("GET", "/source", undefined, signal);
      const windowElementId = await this.#resolveWindow(request.window ?? this.#windowQuery, signal);
      const screenshotResponse = await this.#sessionRequest(
        "GET",
        `/element/${windowElementId}/screenshot`,
        undefined,
        signal,
      );
      if (typeof sourceResponse.value !== "string" || typeof screenshotResponse.value !== "string")
        throw new Error("invalid observation");
      if (request.window && !this.#windowMatches(sourceResponse.value, request.window))
        throw new Error("ambiguous window");
      const parsed = this.#parseElements(sourceResponse.value, request.observationId);
      const elements = parsed.elements;
      this.#allElements = parsed.allElements;
      const observation: Omit<Observation, "screenshot" | "uiSnapshot"> = {
        observationId: request.observationId,
        runId: request.runId,
        environmentId: "environment-active",
        generation: request.generation,
        sessionId: request.sessionId,
        windowId: request.windowId,
        capturedAt: new Date().toISOString(),
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
          coverage: parsed.truncated ? "truncated" : "complete",
          elements,
        }),
      );
      return ok({ observation, screenshot: Buffer.from(screenshotResponse.value, "base64"), snapshot });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      const code = signal.aborted
        ? "Cancelled"
        : detail.includes("ambiguous window")
          ? "AmbiguousWindowOwner"
          : detail.includes("window not found")
            ? "AppNotForeground"
            : detail.includes("session")
              ? "SessionUnavailable"
              : detail.includes("unsafe xml")
                ? "SnapshotIncomplete"
                : "ProviderFailure";
      return err({
        code,
        phase: "observe",
        message: "Mac2 observation could not be captured.",
        retryDisposition: "safe",
      });
    }
  }

  async dispatch(
    action: DesktopAction,
    operationId: OperationId,
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = new Date().toISOString();
    try {
      this.#validateActionContext(action);
      if (action.kind === "pressKey")
        await this.#execute(
          "macos: keys",
          { keys: [{ key: this.#key(action.key), modifierFlags: this.#modifierFlags(action.modifiers) }] },
          signal,
        );
      else if (action.kind === "appendText" || action.kind === "replaceText") {
        const elementId = await this.#resolve(action.target, signal);
        const text = "literal" in action.value ? action.value.literal : undefined;
        if (text === undefined)
          return err({
            code: "InvalidConfiguration",
            phase: "action",
            message: "Secret text must be resolved before the Adapter boundary.",
            retryDisposition: "safe",
            dispatch: "notDispatched",
          });
        if (action.kind === "replaceText")
          await this.#sessionRequest("POST", `/element/${elementId}/value`, { text }, signal);
        else await this.#execute("macos: keys", { keys: Array.from(text), elementId }, signal);
      } else if (action.kind === "drag") await this.#drag(action, signal);
      else {
        if (!("element" in action.target)) throw new Error("invalid target");
        const ref = action.target.element;
        const elementId = await this.#resolve(ref, signal);
        const point = action.target.point ?? { x: 0.5, y: 0.5 };
        const locator = this.#locators.get(ref.elementId);
        if (!locator?.width || !locator.height) throw new Error("geometry");
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
      const code = message.includes("stale")
        ? "StaleElementRef"
        : message.includes("ambiguous")
          ? "TargetAmbiguous"
          : message.includes("not found")
            ? "TargetNotFound"
            : signal.aborted
              ? "Cancelled"
              : "ProviderFailure";
      const beforeDispatch =
        code === "StaleElementRef" || code === "TargetAmbiguous" || code === "TargetNotFound";
      return err({
        code,
        phase: "action",
        message: beforeDispatch
          ? "Mac2 target could not be resolved safely."
          : "Mac2 action did not produce a reliable receipt.",
        retryDisposition: beforeDispatch ? "safe" : "reconcileRequired",
        dispatch: beforeDispatch ? "notDispatched" : "unknown",
      });
    }
  }

  rebind(action: DesktopAction, observation: Observation): OperationResult<DesktopAction> {
    const rebindRef = (ref: ElementRef): OperationResult<ElementRef> => {
      const locator = this.#previousLocators.get(ref.elementId) ?? this.#locators.get(ref.elementId);
      if (!locator)
        return err({
          code: "StaleElementRef",
          phase: "action",
          message: "Previous locator is unavailable.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        });
      const matches = this.#allElements.filter((element) =>
        locator.identifier
          ? element.identifier === locator.identifier
          : element.role === locator.role.replace("XCUIElementType", "").toLowerCase() &&
            (!locator.name || element.name === locator.name) &&
            (!locator.label || element.label === locator.label) &&
            (!locator.value || element.value === locator.value),
      );
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
    if (action.kind === "pressKey") return ok(action);
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
    if (action.kind === "appendText" || action.kind === "replaceText") {
      const target = rebindRef(action.target);
      return target.ok ? ok({ ...action, target: target.value }) : target;
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
  ): Promise<OperationResult<{ status: "passed" | "failed" | "unverifiable"; reason: string }>> {
    if (assertion.kind === "aiVisual")
      return ok({ status: "unverifiable", reason: "AI visual evaluator is not configured." });
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
          observation.coverage !== "complete" ? "unverifiable" : matches.length === 0 ? "passed" : "failed",
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
      return ok({ status: "passed", reason: "Unique element is present in the complete snapshot." });
    if (assertion.kind === "text" || assertion.kind === "value") {
      const actual =
        assertion.kind === "value" ? (element.value ?? "") : (element.name ?? element.label ?? "");
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
      this.#locators.clear();
      this.#allElements = [];
      this.#context = undefined;
      this.#windowQuery = undefined;
      return ok({
        provider: "appium-mac2",
        operationId: hashId("operation", startedAt) as OperationId,
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
      `snapshot=${observation.observationId} window=${observation.windowId} coverage=${coverage}`,
      ...visible.map(
        (e) =>
          `[${e.elementId}] ${e.role} ${JSON.stringify((e.name ?? e.label ?? e.value ?? "").slice(0, 120))}${e.enabled === undefined ? "" : e.enabled ? " enabled" : " disabled"}`,
      ),
      ...(observation.elements.length > 200
        ? [`... ${String(observation.elements.length - 200)} more elements`]
        : []),
    ].join("\n");
  }

  query(observation: Observation, query: ElementQuery): OperationResult<ElementRef> {
    const source =
      this.#context?.observationId === observation.observationId ? this.#allElements : observation.elements;
    const matches = source.filter((element) => this.#matches(element, query));
    if (matches.length === 0 && observation.coverage !== "complete")
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

  expand(observation: Observation, elementId: ElementId): OperationResult<ElementSummary> {
    const element = observation.elements.find((item) => item.elementId === elementId);
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
    const sourceLocator = this.#locators.get(action.from.element.elementId);
    const destinationLocator = this.#locators.get(action.to.element.elementId);
    if (
      !sourceLocator?.width ||
      !sourceLocator.height ||
      !destinationLocator?.width ||
      !destinationLocator.height
    )
      throw new Error("geometry");
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
                duration: 0,
                origin: { [W3C_ELEMENT]: source },
                x: (from.x - 0.5) * sourceLocator.width,
                y: (from.y - 0.5) * sourceLocator.height,
              },
              { type: "pointerDown", button: 0 },
              {
                type: "pointerMove",
                duration: action.durationMs ?? 500,
                origin: { [W3C_ELEMENT]: destination },
                x: (to.x - 0.5) * destinationLocator.width,
                y: (to.y - 0.5) * destinationLocator.height,
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
    const using = locator.identifier ? "accessibility id" : "xpath";
    const value =
      locator.identifier ??
      `//${locator.role}${locator.name ? `[@name=${xpathLiteral(locator.name)}]` : locator.label ? `[@label=${xpathLiteral(locator.label)}]` : ""}`;
    const response = await this.#sessionRequest("POST", "/elements", { using, value }, signal);
    const elements = Array.isArray(response.value) ? response.value : [];
    if (elements.length !== 1) throw new Error(elements.length === 0 ? "not found" : "ambiguous");
    const item = asObject(elements[0]);
    const id = typeof item?.[W3C_ELEMENT] === "string" ? item[W3C_ELEMENT] : undefined;
    if (!id) throw new Error("element id");
    return id;
  }

  async #resolveWindow(query: WindowQuery | undefined, signal: AbortSignal): Promise<string> {
    if (!query) throw new Error("ambiguous window");
    const clauses: string[] = [];
    if (query.title) {
      if ("exact" in query.title) clauses.push(`@name=${xpathLiteral(query.title.exact)}`);
      else clauses.push(`contains(@name, ${xpathLiteral(query.title.contains)})`);
    }
    const xpath = `//XCUIElementTypeWindow${clauses.length ? `[${clauses.join(" and ")}]` : ""}`;
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

  #parseElements(
    xml: string,
    observationId: string,
  ): { elements: ElementSummary[]; allElements: ElementSummary[]; truncated: boolean } {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("unsafe xml");
    const parsed: unknown = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      allowBooleanAttributes: true,
    }).parse(xml);
    const output: ElementSummary[] = [];
    this.#previousLocators = new Map(this.#locators);
    this.#locators.clear();
    const visit = (value: unknown, roleHint?: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, roleHint));
        return;
      }
      const object = asObject(value);
      if (!object) return;
      const role = typeof object.type === "string" ? object.type : roleHint;
      if (role?.startsWith("XCUIElementType")) {
        const identity = JSON.stringify([
          observationId,
          output.length,
          object.identifier,
          object.name,
          object.label,
          object.value,
        ]);
        const elementId = hashId("element", identity) as ElementId;
        const summary = ElementSummarySchema.parse({
          elementId,
          role: role.replace("XCUIElementType", "").toLowerCase() || "element",
          ...(typeof object.identifier === "string" && object.identifier
            ? { identifier: object.identifier }
            : {}),
          ...(typeof object.name === "string" && object.name ? { name: object.name } : {}),
          ...(typeof object.label === "string" && object.label ? { label: object.label } : {}),
          ...(typeof object.value === "string" && object.value ? { value: object.value } : {}),
          ...(object.enabled === "true" || object.enabled === true
            ? { enabled: true }
            : object.enabled === "false" || object.enabled === false
              ? { enabled: false }
              : {}),
          ...(object.selected === "true" || object.selected === true
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
        this.#locators.set(elementId, {
          role,
          ...(summary.identifier ? { identifier: summary.identifier } : {}),
          ...(summary.name ? { name: summary.name } : {}),
          ...(summary.label ? { label: summary.label } : {}),
          ...(summary.value ? { value: summary.value } : {}),
          width: Number(object.width),
          height: Number(object.height),
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
          visit(child, key);
    };
    visit(parsed);
    return { elements: output.slice(0, 5000), allElements: output, truncated: output.length > 5000 };
  }

  #windowMatches(xml: string, query: WindowQuery): boolean {
    const elements = this.#parseElements(xml, "observation-window-probe").elements.filter(
      (item) => item.role === "window",
    );
    const matches = elements.filter((window) => {
      const title = window.name ?? window.label ?? window.value;
      const textMatch = !query.title || (title !== undefined && this.#textMatch(title, query.title));
      const roleMatch = !query.role || window.role === query.role;
      const mainState = window.isMain ?? window.focused;
      const mainMatch = query.isMain === undefined || mainState === query.isMain;
      const modalMatch = query.isModal === undefined || window.isModal === query.isModal;
      const foregroundMatch = window.focused === true;
      return textMatch && roleMatch && mainMatch && modalMatch && foregroundMatch;
    });
    return matches.length === 1;
  }

  #textMatch(actual: string, match: TextMatch): boolean {
    const source = match.caseSensitive ? actual : actual.toLocaleLowerCase();
    const raw = "exact" in match ? match.exact : match.contains;
    const expected = match.caseSensitive ? raw : raw.toLocaleLowerCase();
    return "exact" in match ? source === expected : source.includes(expected);
  }

  #matches(
    element: ElementSummary,
    query: Exclude<AssertionSpec, { kind: "aiVisual" | "elementOrder" }>["query"],
  ): boolean {
    const text = (
      actual: string | undefined,
      match:
        | { exact: string; caseSensitive?: boolean | undefined }
        | { contains: string; caseSensitive?: boolean | undefined }
        | undefined,
    ): boolean => {
      if (!match) return true;
      if (actual === undefined) return false;
      const a = match.caseSensitive ? actual : actual.toLocaleLowerCase();
      const expected = "exact" in match ? match.exact : match.contains;
      const e = match.caseSensitive ? expected : expected.toLocaleLowerCase();
      return "exact" in match ? a === e : a.includes(e);
    };
    return (
      (!query.role || element.role === query.role) &&
      (!query.identifier || element.identifier === query.identifier) &&
      text(element.name, query.name) &&
      text(element.label, query.label) &&
      text(element.value, query.value) &&
      (!query.state ||
        Object.entries(query.state).every(
          ([key, value]) => element[key as "enabled" | "selected" | "focused"] === value,
        ))
    );
  }
  #validateActionContext(action: DesktopAction): void {
    const refs: ElementRef[] =
      action.kind === "pressKey"
        ? []
        : action.kind === "drag"
          ? [action.from.element, action.to.element]
          : action.kind === "appendText" || action.kind === "replaceText"
            ? [action.target]
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
    return Math.min(Math.max(ratio * size, 1), Math.max(1, size - 1));
  }
  #modifierFlags(modifiers?: readonly string[]): number {
    const flags: Record<string, number> = {
      command: 1 << 20,
      shift: 1 << 17,
      option: 1 << 19,
      control: 1 << 18,
      function: 1 << 23,
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
    const value: unknown = await response.json();
    const object = asObject(value);
    if (!response.ok || !object || asObject(object.value)?.error) throw new Error("webdriver");
    return object;
  }
}
