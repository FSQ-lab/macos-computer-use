#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tryCreateMacOSComputerUseClient } from "../client/index.js";
import { renderHuman } from "./result-mapping.js";
import { parseCliInvocation } from "./arguments.js";
import { executeCliInvocation } from "./application.js";
import { installTerminationHandlers } from "./signals.js";

const fail = (message: string, code: number): never => {
  if (json)
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "InvalidConfiguration", phase: "vm", message, retryDisposition: "notApplicable" } })}\n`,
    );
  else process.stderr.write(`${message}\n`);
  process.exit(code);
};
const json = process.argv.includes("--json");
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
try {
  const invocation = parseCliInvocation(args) ?? fail("Invalid command or arguments.", 2);
  const configPath = process.env.MACOS_COMPUTER_USE_CONFIG;
  if (!configPath) fail("MACOS_COMPUTER_USE_CONFIG must name a local configuration JSON file.", 2);
  let config: unknown;
  try {
    if ((await stat(resolve(configPath ?? ""))).size > 1_000_000) throw new Error("Config is too large.");
    config = JSON.parse(await readFile(resolve(configPath ?? ""), "utf8")) as unknown;
  } catch {
    fail("Configuration file is invalid.", 2);
  }
  const clientResult = tryCreateMacOSComputerUseClient(config);
  const client = clientResult.ok ? clientResult.value : fail(clientResult.error.message, 2);

  const output = (value: unknown): void => {
    if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
    else process.stdout.write(`${renderHuman(value)}\n`);
  };
  const runAbort = new AbortController();
  const removeSignals = installTerminationHandlers(runAbort);
  try {
    const result = await executeCliInvocation(invocation, client, runAbort.signal);
    output(result.output);
    process.exitCode = result.exitCode;
  } finally {
    removeSignals();
  }
} catch {
  const error = {
    ok: false,
    error: {
      code: "InternalError",
      phase: "cleanup",
      message: "Unexpected runtime failure; inspect Run Evidence and recover resources.",
      retryDisposition: "reconcileRequired",
    },
  };
  if (json) process.stdout.write(JSON.stringify(error) + String.fromCharCode(10));
  else process.stderr.write(error.error.message + String.fromCharCode(10));
  process.exitCode = 70;
}
