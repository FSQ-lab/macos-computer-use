import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileGatewayLock } from "../src/client/file-lock.js";

it.skipIf(process.platform !== "darwin")(
  "rejects a second configured state root for the same user",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "mcu-lock-"));
    const first = await new FileGatewayLock(join(root, "one", "gateway.lock")).acquire();
    try {
      expect(first.ok).toBe(true);
      const second = await new FileGatewayLock(join(root, "two", "gateway.lock")).acquire();
      if (second.ok) await second.value();
      expect(!second.ok && second.error.code).toBe("GatewayBusy");
    } finally {
      if (first.ok) await first.value();
      await rm(root, { recursive: true, force: true });
    }
  },
);
