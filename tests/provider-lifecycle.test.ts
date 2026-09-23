import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMacOSComputerUseClient, GatewayConfigSchema, ScenarioSchema } from "../src/index.js";

const configPath = process.env.MCU_PROVIDER_CONFIG;
describe.skipIf(!configPath)("provisioned provider and destructive lifecycle", () => {
  it("clones immutable Fixture image, confirms text, verifies Evidence and destroys owned clone", async () => {
    if (!configPath) throw new Error("Explicit provisioned config required");
    const config = GatewayConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")) as unknown);
    const scenario = ScenarioSchema.parse(
      JSON.parse(await readFile("examples/fixture.scenario.json", "utf8")) as unknown,
    );
    const client = createMacOSComputerUseClient(config);
    if (!client.ok) throw new Error(client.error.message);
    const result = await client.value.runScenario(scenario);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toEqual({ verdict: "passed", evidence: "complete", cleanup: "completed" });
    expect((await client.value.showRun(result.value.runId)).ok).toBe(true);
    const doctor = await client.value.doctor();
    expect(doctor.ok && doctor.value.checks.find((check) => check.name === "managed-resources")?.status).toBe(
      "passed",
    );
  }, 600_000);
});
