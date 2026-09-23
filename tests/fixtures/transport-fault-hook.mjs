import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
let injected = false;
export const onEvent = async (event) => {
  if (event.type !== "ActionPlanned" || injected) return [];
  injected = true;
  await execFileAsync("tart", [
    "exec",
    `mcu-${event.runId}`,
    "/bin/zsh",
    "-lc",
    `root=/tmp/macos-computer-use/${event.runId}; pid=$(cat $root/appium.pid); kill -KILL $pid`,
  ]);
  return [];
};
