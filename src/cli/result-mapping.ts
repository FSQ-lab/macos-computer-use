import type { OperationResult, RunResult } from "../contracts/index.js";

export const runExitCode = (result: OperationResult<{ result: RunResult }>): number => {
  if (!result.ok) {
    if (result.error.code === "GatewayBusy") return 3;
    if (result.error.code === "RecoveryRequired") return 4;
    if (
      result.error.code === "InvalidConfiguration" ||
      result.error.code === "InvalidScenario" ||
      result.error.code === "UnsupportedRuntime"
    )
      return 2;
    return 70;
  }
  const run = result.value.result;
  if (run.evidence === "incomplete" && run.cleanup === "failed") return 14;
  if (run.evidence === "incomplete") return 12;
  if (run.cleanup === "failed") return 13;
  return run.verdict === "passed" ? 0 : run.verdict === "failed" ? 10 : 11;
};

export const renderHuman = (value: unknown): string => {
  if (typeof value !== "object" || value === null || !("ok" in value)) return String(value);
  const result = value as { ok: boolean; value?: unknown; error?: { code: string; message: string } };
  if (!result.ok)
    return `Error ${result.error?.code ?? "Unknown"}: ${result.error?.message ?? "Unknown error"}`;
  if (typeof result.value === "object" && result.value !== null && "result" in result.value) {
    const run = (result.value as { result: RunResult }).result;
    return `Run ${run.verdict}; Evidence ${run.evidence}; cleanup ${run.cleanup}.`;
  }
  if (
    typeof result.value === "object" &&
    result.value !== null &&
    "checks" in result.value &&
    Array.isArray(result.value.checks)
  ) {
    return result.value.checks
      .map((check: unknown) => {
        if (
          typeof check !== "object" ||
          check === null ||
          !("name" in check) ||
          !("status" in check) ||
          !("detail" in check)
        )
          return "Invalid diagnostic check.";
        return `${String(check.name)}: ${String(check.status)} — ${String(check.detail)}`;
      })
      .join("\n");
  }
  return result.value === undefined ? "Success." : JSON.stringify(result.value, null, 2);
};
