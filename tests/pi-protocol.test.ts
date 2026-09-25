import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_PROTOCOL_VERSION,
  TaskRequestSchema,
  TaskResponseSchema,
} from "../src/pi-extension/runtime/index.js";

const envelope = {
  protocolVersion: AGENT_TASK_PROTOCOL_VERSION,
  taskId: "task-0123456789abcdef01234567",
  requestId: "req-0123456789abcdef",
  sequence: 1,
};

describe("Pi task protocol", () => {
  it("accepts strict versioned requests and rejects unknown fields and versions", () => {
    expect(
      TaskRequestSchema.parse({
        ...envelope,
        type: "begin",
        application: { name: "Fixture" },
      }),
    ).toBeTruthy();
    expect(() => TaskRequestSchema.parse({ ...envelope, protocolVersion: 1, type: "observe" })).toThrow();
    expect(() => TaskRequestSchema.parse({ ...envelope, protocolVersion: 2, type: "observe" })).toThrow();
    expect(() =>
      TaskRequestSchema.parse({
        ...envelope,
        type: "begin",
        application: { name: "Fixture" },
        finalAssertions: [{ kind: "visible", query: { role: "button" } }],
      }),
    ).toThrow();
    expect(
      TaskRequestSchema.parse({
        ...envelope,
        type: "freezeAssertions",
        assertions: [{ kind: "visible", query: { role: "button" } }],
      }),
    ).toBeTruthy();
    expect(() => TaskRequestSchema.parse({ ...envelope, type: "observe", extra: true })).toThrow();
  });

  it("requires a logical target for element actions and forbids coordinate payloads", () => {
    expect(() =>
      TaskRequestSchema.parse({ ...envelope, type: "action", action: { kind: "click" } }),
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({
        ...envelope,
        type: "action",
        target: { role: "button" },
        action: { kind: "click", x: 10, y: 20 },
      }),
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({
        ...envelope,
        type: "action",
        action: { kind: "pressKey", key: "enter" },
        assertions: [{ kind: "visible", query: { role: "button" } }],
      }),
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({
        ...envelope,
        type: "action",
        target: { role: "textfield" },
        action: { kind: "typeText", value: { literal: "hello" } },
      }),
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({
        ...envelope,
        type: "action",
        action: { kind: "replaceText", value: { literal: "hello" } },
      }),
    ).toThrow();
    expect(() =>
      TaskRequestSchema.parse({
        ...envelope,
        type: "action",
        target: { role: "textfield" },
        action: { kind: "pressKey", key: "enter" },
      }),
    ).toThrow();
  });

  it("does not allow response values to expose artifacts or native geometry", () => {
    expect(() =>
      TaskResponseSchema.parse({
        ...envelope,
        type: "query",
        ok: true,
        value: {
          kind: "query",
          element: {
            elementId: "element-00000001",
            role: "button",
            nativeRole: "AXButton",
            geometry: { x: 0, y: 0, width: 1, height: 1 },
          },
        },
      }),
    ).toThrow();
  });

  it("correlates successful response values with their operation type", () => {
    expect(() =>
      TaskResponseSchema.parse({
        ...envelope,
        type: "observe",
        ok: true,
        value: { kind: "heartbeat", alive: true },
      }),
    ).toThrow();
  });

  it("requires compact post-action feedback and preserves stable Client error codes", () => {
    expect(() =>
      TaskResponseSchema.parse({
        ...envelope,
        type: "action",
        ok: true,
        value: {
          kind: "action",
          result: {
            dispatch: "dispatched",
            providerOutcome: "succeeded",
            verification: "confirmed",
            retryDisposition: "unsafe",
          },
          sequence: 1,
        },
      }),
    ).toThrow();
    expect(
      TaskResponseSchema.parse({
        ...envelope,
        type: "observe",
        ok: false,
        error: {
          code: "ClientFailure",
          clientCode: "ReadinessExpired",
          message: "ReadinessExpired: expired",
        },
      }),
    ).toBeTruthy();
  });
});
