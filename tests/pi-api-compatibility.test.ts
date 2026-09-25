import { describe, expect, it } from "vitest";
import type { TSchema } from "typebox";
import { createPiExtension } from "../src/pi-extension/index.js";
import type { ExtensionAPI as McuExtensionAPI } from "../src/pi-extension/pi-types.js";

type OfficialPiSubset = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    executionMode?: "sequential" | "parallel";
    execute(
      id: string,
      params: unknown,
      signal: AbortSignal | undefined,
      update: unknown,
      ctx: unknown,
    ): Promise<unknown>;
  }): void;
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: unknown): Promise<void> },
  ): void;
  on(event: "session_shutdown", handler: (event: unknown, ctx: unknown) => Promise<void>): () => void;
};

describe("Pi API compatibility", () => {
  it("keeps the MCU Extension surface assignable to the official Pi subset", () => {
    const extension: (api: McuExtensionAPI) => void = createPiExtension();
    expect(typeof extension).toBe("function");
    const compileOnly = (api: OfficialPiSubset): void => void api;
    expect(typeof compileOnly).toBe("function");
  });
});
