import type { TSchema } from "typebox";

export type ToolResult = { content: { type: "text"; text: string }[]; details: unknown };
export type ToolContext = {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: string): void;
  };
};
export type ToolDefinition = {
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
    ctx: ToolContext,
  ): Promise<ToolResult>;
};
export type ExtensionAPI = {
  registerTool(tool: ToolDefinition): void;
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: ToolContext): Promise<void> },
  ): void;
  on(event: "session_shutdown", handler: (event: unknown, ctx: ToolContext) => Promise<void>): () => void;
  on(
    event: "before_agent_start",
    handler: (
      event: {
        prompt: string;
        systemPromptOptions: { selectedTools: string[]; promptGuidelines: string[] };
      },
      ctx: ToolContext,
    ) =>
      | Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined>
      | undefined,
  ): () => void;
  on(
    event: "tool_call",
    handler: (
      event: { toolName: string; input: Record<string, unknown> },
      ctx: ToolContext,
    ) => Promise<{ block: boolean; reason: string; terminate?: boolean } | undefined> | undefined,
  ): () => void;
};
