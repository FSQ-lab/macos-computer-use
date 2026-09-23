import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const invoke = (
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/cli/main.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.once("close", (code) => resolve({ code, out, err }));
  });

describe("CLI process contract", () => {
  it("returns JSON and exit 2 for an invalid invocation", async () => {
    const result = await invoke(["--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "InvalidConfiguration" } });
    expect(result.err).toBe("");
  });

  it("returns human output and exit 2 when configuration is absent", async () => {
    const result = await invoke(["doctor"], { MACOS_COMPUTER_USE_CONFIG: "" });
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("MACOS_COMPUTER_USE_CONFIG");
  });

  it("returns JSON and exit 2 for malformed configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-cli-"));
    roots.push(root);
    const path = join(root, "config.json");
    await writeFile(path, "not-json");
    const result = await invoke(["--json", "doctor"], { MACOS_COMPUTER_USE_CONFIG: path });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, error: { code: "InvalidConfiguration" } });
  });

  it("renders successful Run listing in JSON and human modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-cli-list-"));
    roots.push(root);
    const config = JSON.parse(await readFile("examples/config.example.json", "utf8")) as {
      state: { root: string; tempRoot: string };
      evidence: { root: string };
    };
    config.state.root = join(root, "state");
    config.state.tempRoot = join(root, "temp");
    config.evidence.root = join(root, "evidence");
    await mkdir(config.state.root, { recursive: true });
    await mkdir(config.evidence.root, { recursive: true });
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify(config));
    const jsonResult = await invoke(["--json", "runs", "list"], { MACOS_COMPUTER_USE_CONFIG: path });
    expect(jsonResult.code).toBe(0);
    expect(JSON.parse(jsonResult.out)).toEqual({ ok: true, value: [] });
    const human = await invoke(["runs", "list"], { MACOS_COMPUTER_USE_CONFIG: path });
    expect(human.code).toBe(0);
    expect(human.out.trim()).toBe("[]");
  });
});
