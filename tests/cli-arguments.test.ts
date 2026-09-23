import { describe, expect, it } from "vitest";
import { parseCliInvocation } from "../src/cli/arguments.js";

describe("CLI argument parsing", () => {
  it.each([
    [["doctor"], { command: "doctor", deep: false }],
    [["doctor", "--deep"], { command: "doctor", deep: true }],
    [["recover"], { command: "recover" }],
    [["run", "scenario.json"], { command: "run", scenarioPath: "scenario.json" }],
    [["runs", "list"], { command: "runs-list" }],
    [["runs", "show", "run-00000001"], { command: "runs-show", runId: "run-00000001" }],
    [
      ["evidence", "export", "run-00000001", "out"],
      { command: "evidence-export", runId: "run-00000001", destination: "out" },
    ],
  ] as const)("parses %j", (args, expected) => {
    expect(parseCliInvocation(args)).toEqual(expected);
  });

  const invalid: readonly (readonly string[])[] = [
    [],
    ["unknown"],
    ["doctor", "--bad"],
    ["run"],
    ["run", "--bad"],
    ["runs", "show"],
  ];
  for (const args of invalid)
    it(`rejects ${JSON.stringify(args)}`, () => expect(parseCliInvocation(args)).toBeUndefined());
});
