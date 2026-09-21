#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tryCreateMacOSComputerUseClient } from "../client/index.js";
import { renderHuman, runExitCode } from "./result-mapping.js";

const fail = (message: string, code: number): never => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const json = process.argv.includes("--json");
const args = process.argv.slice(2).filter((arg) => arg !== "--json");
const command = args[0];
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
process.once("SIGINT", () => runAbort.abort(new Error("Interrupted by operator.")));
process.once("SIGTERM", () => runAbort.abort(new Error("Terminated by operator.")));
if (command === "doctor") {
  const result = await client.doctor({ deep: args.includes("--deep") });
  output(result);
  process.exit(result.ok && result.value.checks.every((item) => item.status === "passed") ? 0 : 2);
}
if (command === "recover") {
  const result = await client.recover();
  output(result);
  process.exit(result.ok && result.value.status === "clean" ? 0 : 4);
}
if (command === "runs" && args[1] === "list") {
  const result = await client.listRuns();
  output(result);
  process.exit(result.ok ? 0 : 20);
}
if (command === "runs" && args[1] === "show") {
  const result = await client.showRun(args[2]);
  output(result);
  process.exit(result.ok ? 0 : result.error.code === "EvidenceCorrupted" ? 20 : 2);
}
if (command === "evidence" && args[1] === "export") {
  const destination = args[3];
  if (!destination) fail("evidence export requires Run ID and destination.", 2);
  const result = await client.exportEvidence(args[2], resolve(destination ?? ""));
  output(result);
  process.exit(result.ok ? 0 : result.error.code === "EvidenceCorrupted" ? 20 : 2);
}
if (command === "run") {
  const path = args[1];
  if (!path) fail("run requires a Scenario file.", 2);
  const scenario = await client.loadScenario(resolve(path ?? ""));
  if (!scenario.ok) {
    output(scenario);
    process.exit(2);
  }
  const result = await client.runScenario(scenario.value, { signal: runAbort.signal });
  output(result);
  process.exit(runExitCode(result));
}
fail("Supported commands: doctor, run, recover, runs list, runs show, evidence export.", 2);
