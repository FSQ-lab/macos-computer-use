import { readFile } from "node:fs/promises";
import { createPiMacOSComputerUseClient } from "../client/index.js";
import { PiTaskSession } from "./runtime/session.js";

export const runPiTaskChild = async (): Promise<void> => {
  const configPath = process.env.MACOS_COMPUTER_USE_CONFIG;
  if (!configPath || !process.send) throw new Error("Pi task runner requires configuration and IPC.");

  const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const clientResult = createPiMacOSComputerUseClient(config);
  if (!clientResult.ok) throw new Error(clientResult.error.message);
  const session = new PiTaskSession(clientResult.value);
  const leaseTimer = setInterval(() => session.expireLease(), 500);
  leaseTimer.unref();

  const revoke = (reason: string): void => {
    session.revoke(reason);
    void session.settled().finally(() => clearInterval(leaseTimer));
  };

  process.on("message", (message: unknown) => {
    session.accept(message, (response) => {
      if (process.connected) process.send?.(response);
    });
  });
  process.once("disconnect", () => revoke("Agent owner IPC disconnected."));
  process.once("SIGTERM", () => revoke("Pi task runner terminated."));
  process.once("SIGINT", () => revoke("Pi task runner interrupted."));
};

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await runPiTaskChild();
