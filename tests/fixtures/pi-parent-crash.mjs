import process from "node:process";
import { PiTaskSupervisor } from "../../dist/pi-extension/runtime/index.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("Provider config path is required.");
const supervisor = new PiTaskSupervisor(configPath, process.cwd());
await supervisor.start(
  { name: "MacOSComputerUseFixture" },
  [{ kind: "visible", query: { identifier: "fixture.click" } }],
);
process.send?.({ ready: true });
await new Promise(() => undefined);
