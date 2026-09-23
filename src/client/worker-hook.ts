import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { HookDescriptorSchema, type EventHook, type EvidenceEvent } from "../contracts/index.js";

const workerSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  void (async () => {
    const module = await import(workerData.moduleUrl);
    if (typeof module.onEvent !== "function") throw new Error("Hook module must export onEvent.");
    parentPort.postMessage(await module.onEvent(workerData.event));
  })();
`;

export class WorkerEventHook implements EventHook {
  readonly name: string;
  readonly #moduleUrl: string;

  constructor(input: unknown) {
    const descriptor = HookDescriptorSchema.parse(input);
    this.name = descriptor.name;
    this.#moduleUrl = pathToFileURL(descriptor.modulePath).href;
  }

  deliver(event: EvidenceEvent, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Hook cancelled."));
        return;
      }
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { moduleUrl: this.#moduleUrl, event: structuredClone(event) },
      });
      let settled = false;
      const finish = async (error?: unknown, value?: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        await worker.terminate().catch(() => undefined);
        if (error === undefined) resolve(value);
        else reject(error instanceof Error ? error : new Error("Hook Worker failed."));
      };
      const abort = (): void => {
        void finish(signal.reason ?? new Error("Hook cancelled."));
      };
      worker.once("message", (value) => void finish(undefined, value));
      worker.once("error", (error) => void finish(error));
      worker.once("exit", (code) => {
        if (!settled && code !== 0) void finish(new Error("Hook Worker exited unexpectedly."));
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
