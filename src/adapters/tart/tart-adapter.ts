import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  err,
  ok,
  type ImagePort,
  type OperationId,
  type OperationResult,
  type ProviderReceipt,
  ProviderReceiptSchema,
  VmStatusSchema,
  type RunId,
  type VmPort,
  type VmStatus,
} from "../../contracts/index.js";
import { runProcess } from "../process-runner.js";

const now = (): string => new Date().toISOString();
const operationId = (input: string): OperationId =>
  `operation-${createHash("sha256").update(input).digest("hex").slice(0, 24)}` as OperationId;

export class TartAdapter implements ImagePort, VmPort {
  #runningProcess: ChildProcess | undefined;
  constructor(private readonly executable = "tart") {}

  checkImage(reference: string, digest: string, signal: AbortSignal): Promise<boolean> {
    return this.#ociPresent(`${reference}@${digest}`, signal);
  }

  async ensureImage(
    request: { reference: string; digest: string },
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = now();
    const name = `${request.reference}@${request.digest}`;
    const inspected = await this.#ociPresent(name, signal);
    if (inspected) return ok(this.#receipt("image-inspect", startedAt));
    const pulled = await runProcess(this.executable, ["pull", name], signal);
    if (pulled.aborted)
      return err({
        code: "Cancelled",
        phase: "image",
        message: "Image pull was cancelled.",
        retryDisposition: "safe",
        dispatch: "unknown",
      });
    if (pulled.code !== 0)
      return err({
        code: "ProviderFailure",
        phase: "image",
        message: "Tart could not obtain the configured image.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    if (!(await this.#ociPresent(name, signal)))
      return err({
        code: "ImageDigestMismatch",
        phase: "image",
        message: "Pulled Tart image does not match the configured digest.",
        retryDisposition: "notApplicable",
        dispatch: "dispatched",
      });
    return ok(this.#receipt("image-pull", startedAt));
  }

  async listManaged(signal: AbortSignal): Promise<OperationResult<readonly string[]>> {
    const listed = await runProcess(this.executable, ["list", "--format", "json"], signal);
    if (listed.code !== 0)
      return err({
        code: "ProviderFailure",
        phase: "vm",
        message: "Tart VM inventory is unavailable.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    try {
      const value: unknown = JSON.parse(listed.stdout);
      const names: string[] = [];
      if (Array.isArray(value))
        for (const item of value) {
          if (typeof item !== "object" || item === null) continue;
          const record = item as Record<string, unknown>;
          const name = record.Name;
          if (typeof name === "string" && name.startsWith("mcu-")) names.push(name);
        }
      return ok(names);
    } catch {
      return err({
        code: "ProviderFailure",
        phase: "vm",
        message: "Tart VM inventory response is invalid.",
        retryDisposition: "notApplicable",
      });
    }
  }

  async clone(
    request: { runId: RunId; cloneName: string; image: string; digest: string },
    signal: AbortSignal,
  ): Promise<OperationResult<{ cloneName: string; receipt: ProviderReceipt }>> {
    const startedAt = now();
    const cloneName = request.cloneName;
    const result = await runProcess(
      this.executable,
      ["clone", `${request.image}@${request.digest}`, cloneName],
      signal,
    );
    if (result.code !== 0)
      return err({
        code: result.aborted ? "Cancelled" : "ProviderFailure",
        phase: "vm",
        message: "Tart clone did not complete.",
        retryDisposition: result.aborted ? "reconcileRequired" : "safe",
        dispatch: result.aborted ? "unknown" : "notDispatched",
      });
    return ok({ cloneName, receipt: this.#receipt(`clone-${cloneName}`, startedAt) });
  }

  start(
    request: {
      cloneName: string;
      network: readonly { cidr: string; ports: readonly number[]; protocol: "tcp" | "udp" }[];
    },
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    if (signal.aborted)
      return Promise.resolve(
        err({
          code: "Cancelled",
          phase: "vm",
          message: "VM start was cancelled.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        }),
      );
    const startedAt = now();
    return new Promise((resolve) => {
      const networkArgs =
        request.network.length === 0
          ? ["--net-host"]
          : [
              "--net-softnet-block",
              "0.0.0.0/0",
              "--net-softnet-allow",
              [...new Set(request.network.map((rule) => rule.cidr))].join(","),
            ];
      const child = spawn(this.executable, ["run", ...networkArgs, "--no-clipboard", request.cloneName], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.#runningProcess = child;
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve(ok(this.#receipt("start", startedAt)));
      });
      child.once("error", () => {
        if (!settled)
          resolve(
            err({
              code: "ProviderFailure",
              phase: "vm",
              message: "Tart VM process could not start.",
              retryDisposition: "safe",
              dispatch: "notDispatched",
            }),
          );
      });
      child.once("exit", () => {
        if (this.#runningProcess === child) this.#runningProcess = undefined;
      });
      signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    });
  }
  async stop(cloneName: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>> {
    const result = await this.#command("stop", ["stop", cloneName], signal, true);
    this.#runningProcess?.kill("SIGTERM");
    this.#runningProcess = undefined;
    return result;
  }
  destroy(
    request: { cloneName: string; runId: RunId },
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    const expected = `mcu-${request.runId.replace(/[^0-9a-z-]/g, "").slice(0, 48)}`;
    if (request.cloneName !== expected)
      return Promise.resolve(
        err({
          code: "RecoveryRequired",
          phase: "cleanup",
          message: "VM attribution is invalid.",
          retryDisposition: "notApplicable",
        }),
      );
    return this.#command("destroy", ["delete", request.cloneName], signal, true);
  }

  async #ociPresent(name: string, signal: AbortSignal): Promise<boolean> {
    const listed = await runProcess(this.executable, ["list", "--source", "oci", "--format", "json"], signal);
    if (listed.code !== 0) return false;
    try {
      const value: unknown = JSON.parse(listed.stdout);
      return (
        Array.isArray(value) &&
        value.some((item) => {
          if (typeof item !== "object" || item === null) return false;
          return (item as Record<string, unknown>).Name === name;
        })
      );
    } catch {
      return false;
    }
  }

  async inspect(cloneName: string, signal: AbortSignal): Promise<OperationResult<VmStatus>> {
    const result = await runProcess(this.executable, ["get", cloneName, "--format", "json"], signal);
    if (result.code !== 0) return ok({ exists: false, state: "stopped" });
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      return ok(
        VmStatusSchema.parse({ exists: true, state: value.State === "running" ? "running" : "stopped" }),
      );
    } catch {
      return ok({ exists: true, state: "unknown" });
    }
  }

  async #command(
    label: string,
    args: string[],
    signal: AbortSignal,
    absentIsSuccess = false,
  ): Promise<OperationResult<ProviderReceipt>> {
    const startedAt = now();
    const result = await runProcess(this.executable, args, signal);
    if (result.code === 0 || (absentIsSuccess && /not found|does not exist/i.test(result.stderr)))
      return ok(this.#receipt(label, startedAt));
    return err({
      code: result.aborted ? "Cancelled" : "ProviderFailure",
      phase: label === "start" ? "vm" : "cleanup",
      message: `Tart ${label} did not complete.`,
      retryDisposition: result.aborted ? "reconcileRequired" : "safe",
      dispatch: result.aborted ? "unknown" : "notDispatched",
    });
  }

  #receipt(label: string, startedAt: string): ProviderReceipt {
    return ProviderReceiptSchema.parse({
      provider: "tart",
      operationId: operationId(`${label}-${startedAt}`),
      dispatch: "dispatched",
      outcome: "succeeded",
      startedAt,
      finishedAt: now(),
    });
  }
}
