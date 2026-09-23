import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMacOSComputerUseClient, GatewayConfigSchema, ScenarioSchema } from "../src/index.js";

const configPath = process.env.MCU_PROVIDER_CONFIG;
const profile = process.env.MCU_PROVIDER_PROFILE;

describe.skipIf(!configPath || profile !== "extended")("provisioned Mac2 conformance", () => {
  it("executes the remaining v1 actions and assertions in one disposable clone", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    const result = await client.value.run(
      {
        finalAssertions: [
          { kind: "value", query: { identifier: "fixture.checkbox" }, expected: "1", match: "exact" },
          { kind: "notVisible", query: { identifier: "fixture.hide-target" } },
          {
            kind: "elementOrder",
            queries: [{ identifier: "fixture.order.first" }, { identifier: "fixture.order.second" }],
            direction: "leftToRight",
          },
        ],
      },
      async (run) => {
        const hoverTarget = run.query({ identifier: "fixture.hover" });
        if (!hoverTarget.ok) throw new Error(hoverTarget.error.code);
        const hovered = await run.action({ kind: "hover", target: { element: hoverTarget.value } }, [
          { kind: "text", query: { identifier: "fixture.status" }, expected: "Hovered", match: "exact" },
        ]);
        if (!hovered.ok || hovered.value.result.verification !== "confirmed")
          throw new Error("hover was not independently confirmed");
        const toggle = run.query({ identifier: "fixture.checkbox" });
        if (!toggle.ok) throw new Error(toggle.error.code);
        const clicked = await run.action({ kind: "click", target: { element: toggle.value } }, [
          { kind: "value", query: { identifier: "fixture.checkbox" }, expected: "1", match: "exact" },
        ]);
        if (!clicked.ok) throw new Error(clicked.error.code);
        const hide = run.query({ identifier: "fixture.hide" });
        if (!hide.ok) throw new Error(hide.error.code);
        const hidden = await run.action({ kind: "click", target: { element: hide.value } }, [
          { kind: "notVisible", query: { identifier: "fixture.hide-target" } },
        ]);
        if (!hidden.ok) throw new Error(hidden.error.code);
        return {
          hovered: hovered.value.result,
          clicked: clicked.value.result,
          hidden: hidden.value.result,
        };
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toEqual({ verdict: "passed", evidence: "complete", cleanup: "completed" });
    expect((await client.value.showRun(result.value.runId)).ok).toBe(true);
  }, 600_000);

  it("executes scroll, swipe, and modal window transitions in disposable clones", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    for (const action of [
      { kind: "scroll" as const, delta: { x: -1, y: 0 } },
      { kind: "swipe" as const, direction: "left" as const },
    ]) {
      const result = await client.value.runScenario(
        ScenarioSchema.parse({
          schemaVersion: 1,
          name: action.kind,
          actions: [
            {
              stepId: action.kind,
              target: { identifier: "fixture.scroll" },
              action,
              verification: { policy: "deferred" },
            },
          ],
          finalAssertions: [
            {
              kind: "value",
              query: { identifier: "fixture.scroll-state" },
              expected: "Scroll offset: 1",
              match: "contains",
            },
          ],
        }),
      );
      expect(result.ok && result.value.result.cleanup).toBe("completed");
      expect(result.ok && result.value.result.evidence).toBe("complete");
      expect(result.ok && result.value.result.verdict).not.toBe("inconclusive");
    }
    const opened = await client.value.runScenario(
      ScenarioSchema.parse({
        schemaVersion: 1,
        name: "modal-window",
        actions: [
          {
            stepId: "open-modal",
            target: { identifier: "fixture.open-modal" },
            action: { kind: "click" },
            verification: { policy: "deferred" },
          },
        ],
        finalAssertions: [
          {
            kind: "text",
            query: { identifier: "fixture.modal.title" },
            expected: "Fixture modal",
            match: "exact",
          },
        ],
      }),
    );
    expect(opened.ok && opened.value.result).toEqual({
      verdict: "passed",
      evidence: "complete",
      cleanup: "completed",
    });
  }, 600_000);

  it("executes pointer, text, keyboard, and drag capabilities in disposable clones", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    const status = (expected: string) => ({
      kind: "text" as const,
      query: { identifier: "fixture.status" },
      expected,
      match: "exact" as const,
    });
    const scenarios = [
      ScenarioSchema.parse({
        schemaVersion: 1,
        name: "pointer-actions",
        actions: [
          {
            stepId: "double",
            target: { identifier: "fixture.double-click" },
            action: { kind: "doubleClick" },
            verification: { policy: "immediate", assertions: [status("Double clicked")] },
          },
          {
            stepId: "right",
            target: { identifier: "fixture.right-click" },
            action: { kind: "rightClick" },
            verification: { policy: "immediate", assertions: [status("Right clicked")] },
          },
        ],
        finalAssertions: [status("Right clicked")],
      }),
      ScenarioSchema.parse({
        schemaVersion: 1,
        name: "drag-action",
        actions: [
          {
            stepId: "drag",
            target: { identifier: "fixture.drag-source" },
            action: {
              kind: "drag",
              destination: { identifier: "fixture.drop-target" },
              durationMs: 1000,
            },
            verification: { policy: "immediate", assertions: [status("Drag completed")] },
          },
        ],
        finalAssertions: [status("Drag completed")],
      }),
      ScenarioSchema.parse({
        schemaVersion: 1,
        name: "text-keyboard-actions",
        actions: [
          {
            stepId: "replace",
            target: { identifier: "fixture.text-input" },
            action: { kind: "replaceText", value: { literal: "Alpha" } },
            verification: {
              policy: "immediate",
              assertions: [
                {
                  kind: "value",
                  query: { identifier: "fixture.text-input" },
                  expected: "Alpha",
                  match: "exact",
                },
              ],
            },
          },
          {
            stepId: "append",
            target: { identifier: "fixture.text-input" },
            action: { kind: "appendText", value: { literal: " Beta" } },
            verification: {
              policy: "immediate",
              assertions: [
                {
                  kind: "value",
                  query: { identifier: "fixture.text-input" },
                  expected: "Alpha Beta",
                  match: "exact",
                },
              ],
            },
          },
          {
            stepId: "keyboard",
            target: { identifier: "fixture.keyboard" },
            action: { kind: "pressKey", key: "enter", modifiers: ["command"] },
            verification: { policy: "immediate", assertions: [status("Keyboard activated")] },
          },
        ],
        finalAssertions: [
          status("Keyboard activated"),
          {
            kind: "value",
            query: { identifier: "fixture.text-input" },
            expected: "Alpha Beta",
            match: "exact",
          },
        ],
      }),
    ];
    for (const scenario of scenarios) {
      const result = await client.value.runScenario(scenario);
      expect(result.ok && result.value.result).toEqual({
        verdict: "passed",
        evidence: "complete",
        cleanup: "completed",
      });
    }
  }, 600_000);
});
