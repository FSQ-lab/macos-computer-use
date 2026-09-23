import { resolve } from "node:path";
import type { MacOSComputerUseClient } from "../client/client.js";
import type { CliInvocation } from "./arguments.js";
import { runExitCode } from "./result-mapping.js";

export const executeCliInvocation = async (
  invocation: CliInvocation,
  client: MacOSComputerUseClient,
  signal: AbortSignal,
): Promise<{ output: unknown; exitCode: number }> => {
  if (invocation.command === "doctor") {
    const output = await client.doctor({ deep: invocation.deep, signal });
    return {
      output,
      exitCode: output.ok && output.value.checks.every((item) => item.status === "passed") ? 0 : 2,
    };
  }
  if (invocation.command === "recover") {
    const output = await client.recover({ signal });
    return {
      output,
      exitCode:
        output.ok && output.value.status === "clean"
          ? 0
          : !output.ok && output.error.code === "GatewayBusy"
            ? 3
            : 4,
    };
  }
  if (invocation.command === "runs-list") {
    const output = await client.listRuns();
    return { output, exitCode: output.ok ? 0 : 20 };
  }
  if (invocation.command === "runs-show") {
    const output = await client.showRun(invocation.runId);
    return { output, exitCode: output.ok ? 0 : output.error.code === "EvidenceCorrupted" ? 20 : 2 };
  }
  if (invocation.command === "evidence-export") {
    const output = await client.exportEvidence(invocation.runId, resolve(invocation.destination));
    return { output, exitCode: output.ok ? 0 : output.error.code === "EvidenceCorrupted" ? 20 : 2 };
  }
  const scenario = await client.loadScenario(resolve(invocation.scenarioPath));
  if (!scenario.ok) return { output: scenario, exitCode: 2 };
  const output = await client.runScenario(scenario.value, { signal });
  return { output, exitCode: runExitCode(output) };
};
