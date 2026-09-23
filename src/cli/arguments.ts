export type CliInvocation =
  | { command: "doctor"; deep: boolean }
  | { command: "recover" }
  | { command: "run"; scenarioPath: string }
  | { command: "runs-list" }
  | { command: "runs-show"; runId: string }
  | { command: "evidence-export"; runId: string; destination: string };

export const parseCliInvocation = (args: readonly string[]): CliInvocation | undefined => {
  const command = args[0];
  if (command === "doctor" && (args.length === 1 || (args.length === 2 && args[1] === "--deep")))
    return { command, deep: args[1] === "--deep" };
  if (command === "recover" && args.length === 1) return { command };
  if (command === "run" && args.length === 2 && args[1] && !args[1].startsWith("--"))
    return { command, scenarioPath: args[1] };
  if (command === "runs" && args[1] === "list" && args.length === 2) return { command: "runs-list" };
  if (command === "runs" && args[1] === "show" && args.length === 3 && args[2])
    return { command: "runs-show", runId: args[2] };
  if (command === "evidence" && args[1] === "export" && args.length === 4 && args[2] && args[3])
    return { command: "evidence-export", runId: args[2], destination: args[3] };
  return undefined;
};
