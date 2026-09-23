import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers";
import process from "node:process";
export const onEvent = async () => {
  setTimeout(() => void writeFile(process.env.MCU_HOOK_SENTINEL, "late"), 5_500);
  return new Promise(() => undefined);
};
