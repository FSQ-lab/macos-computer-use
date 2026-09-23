import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installTerminationHandlers } from "../src/cli/signals.js";

describe("CLI termination signals", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("aborts on %s and removes both handlers", (name) => {
    const events = new EventEmitter();
    const controller = new AbortController();
    const remove = installTerminationHandlers(controller, events);
    events.emit(name);
    expect(controller.signal.aborted).toBe(true);
    expect(String(controller.signal.reason)).toContain(name === "SIGINT" ? "Interrupted" : "Terminated");
    remove();
    expect(events.listenerCount("SIGINT")).toBe(0);
    expect(events.listenerCount("SIGTERM")).toBe(0);
  });
});
