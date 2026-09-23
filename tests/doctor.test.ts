import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createMacOSComputerUseClient } from "../src/client/index.js";
import { GatewayConfigSchema } from "../src/contracts/index.js";
import { TartAdapter } from "../src/adapters/tart/index.js";
import { Gateway } from "../src/kernel/index.js";

describe("read-only doctor", () => {
  it("does not create missing roots or allocate a deep Run after preflight failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-doctor-"));
    const managed = vi.spyOn(TartAdapter.prototype, "listManaged").mockResolvedValue({ ok: true, value: [] });
    const image = vi.spyOn(TartAdapter.prototype, "checkImage").mockResolvedValue({ ok: true, value: false });
    const execute = vi.spyOn(Gateway.prototype, "execute");
    try {
      const config = GatewayConfigSchema.parse(
        JSON.parse(await readFile("examples/config.example.json", "utf8")) as unknown,
      );
      config.state.root = join(root, "state");
      config.evidence.root = join(root, "evidence");
      const client = createMacOSComputerUseClient(config);
      expect(client.ok).toBe(true);
      if (!client.ok) return;
      const result = await client.value.doctor({ deep: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.checks.find((item) => item.name === "state-root")?.status).toBe("failed");
      expect(JSON.stringify(result)).not.toContain(root);
      await expect(stat(config.state.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(config.evidence.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      managed.mockRestore();
      image.mockRestore();
      execute.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
