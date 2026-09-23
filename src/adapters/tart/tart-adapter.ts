import { spawn, type ChildProcess } from "node:child_process";
import {
  err,
  ok,
  type ImagePort,
  type OperationResult,
  type ProviderReceipt,
  ProviderReceiptSchema,
  ImageRequestSchema,
  CloneRequestSchema,
  VmStartRequestSchema,
  ManagedCloneRequestSchema,
  VmStatusSchema,
  type RunId,
  RunIdSchema,
  type IdGenerator,
  type VmPort,
  type VmStatus,
  CloneResultSchema,
} from "../../contracts/index.js";
import { runProcess } from "./process-runner.js";

const now = (): string => new Date().toISOString();
export class TartAdapter implements ImagePort, VmPort {
  #runningProcess: ChildProcess | undefined;
  constructor(
    private readonly executable = "tart",
    private readonly ids: IdGenerator = {
      next: () => {
        throw new Error("Tart logical ID generator is unavailable.");
      },
    },
  ) {}

  checkImage(reference: string, digest: string, signal: AbortSignal): Promise<OperationResult<boolean>> {
    return this.#ociPresent(`${reference}@${digest}`, signal);
  }

  async ensureImage(
    request: { reference: string; digest: string },
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    request = ImageRequestSchema.parse(request);
    const startedAt = now();
    const name = `${request.reference}@${request.digest}`;
    const inspected = await this.#ociPresent(name, signal);
    if (!inspected.ok) return inspected;
    if (inspected.value) return ok(this.#receipt("image-inspect", startedAt));
    const pulled = await runProcess(this.executable, ["pull", name], signal);
    if (pulled.aborted)
      return err({
        code: "Cancelled",
        phase: "image",
        message: "Image pull was cancelled.",
        retryDisposition: "reconcileRequired",
        dispatch: "unknown",
      });
    if (pulled.code !== 0)
      return err({
        code: "ProviderFailure",
        phase: "image",
        message: "Tart could not obtain the configured image.",
        retryDisposition: "reconcileRequired",
        dispatch: "unknown",
      });
    const verified = await this.#ociPresent(name, signal);
    if (!verified.ok) return verified;
    if (!verified.value)
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
      if (!Array.isArray(value)) throw new Error("inventory shape");
      if (Array.isArray(value))
        for (const item of value) {
          if (typeof item !== "object" || item === null) throw new Error("inventory entry");
          const record = item as Record<string, unknown>;
          const name = record.Name;
          if (typeof name !== "string") throw new Error("inventory name");
          if (name.startsWith("mcu-run-")) names.push(RunIdSchema.parse(name.slice(4)));
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
    request: { runId: RunId; image: string; digest: string },
    signal: AbortSignal,
  ): Promise<OperationResult<{ resourceId: string; receipt: ProviderReceipt }>> {
    request = CloneRequestSchema.parse(request);
    const startedAt = now();
    const resourceId = request.runId;
    const cloneName = this.#nativeName(resourceId);
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
        retryDisposition: "reconcileRequired",
        dispatch: "unknown",
      });
    return ok(
      CloneResultSchema.parse({ resourceId, receipt: this.#receipt(`clone-${cloneName}`, startedAt) }),
    );
  }

  start(
    request: {
      resourceId: string;
      network: readonly { cidr: string; ports: readonly number[]; protocol: "tcp" | "udp" }[];
    },
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    request = VmStartRequestSchema.parse(request);
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
      const networkArgs = ["--net-host"];
      const child = spawn(
        this.executable,
        ["run", ...networkArgs, "--no-clipboard", this.#nativeName(request.resourceId)],
        {
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      this.#runningProcess = child;
      child.stderr.resume();
      let settled = false;
      child.once("spawn", () => {
        settled = true;
        resolve(ok({ ...this.#receipt("start", startedAt), outcome: "unknown" }));
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
      const abort = (): void => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", abort));
    });
  }
  async stop(cloneName: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>> {
    const result = await this.#command("stop", ["stop", this.#nativeName(cloneName)], signal, true);
    this.#runningProcess?.kill("SIGTERM");
    this.#runningProcess = undefined;
    return result;
  }
  destroy(
    request: { resourceId: string; runId: RunId },
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>> {
    request = ManagedCloneRequestSchema.parse(request);
    if (request.resourceId !== request.runId)
      return Promise.resolve(
        err({
          code: "RecoveryRequired",
          phase: "cleanup",
          message: "VM attribution is invalid.",
          retryDisposition: "notApplicable",
        }),
      );
    return this.#command("destroy", ["delete", this.#nativeName(request.resourceId)], signal, true);
  }

  async #ociPresent(name: string, signal: AbortSignal): Promise<OperationResult<boolean>> {
    const listed = await runProcess(this.executable, ["list", "--source", "oci", "--format", "json"], signal);
    if (listed.code !== 0)
      return err({
        code: listed.aborted ? "Cancelled" : "ProviderFailure",
        phase: "image",
        message: "OCI image inventory is unavailable.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    try {
      const value: unknown = JSON.parse(listed.stdout);
      if (!Array.isArray(value)) throw new Error("inventory shape");
      const names = value.map((item) => {
        if (typeof item !== "object" || item === null) throw new Error("inventory entry");
        const record = item as Record<string, unknown>;
        if (record.Source !== "OCI" || typeof record.Name !== "string") throw new Error("inventory identity");
        return record.Name;
      });
      return ok(names.includes(name));
    } catch {
      return err({
        code: "ProviderFailure",
        phase: "image",
        message: "OCI image inventory is invalid.",
        retryDisposition: "notApplicable",
        dispatch: "notDispatched",
      });
    }
  }

  async inspect(cloneName: string, signal: AbortSignal): Promise<OperationResult<VmStatus>> {
    const result = await runProcess(
      this.executable,
      ["get", this.#nativeName(cloneName), "--format", "json"],
      signal,
    );
    if (result.code !== 0)
      return err({
        code: "ProviderFailure",
        phase: "vm",
        message: "VM inspection did not establish resource state.",
        retryDisposition: "reconcileRequired",
      });
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      return ok(
        VmStatusSchema.parse({
          exists: true,
          state: value.State === "running" ? "running" : value.State === "stopped" ? "stopped" : "unknown",
        }),
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
      retryDisposition: "reconcileRequired",
      dispatch: "unknown",
    });
  }

  #receipt(label: string, startedAt: string): ProviderReceipt {
    return ProviderReceiptSchema.parse({
      provider: "tart",
      operationId: this.ids.next("operation"),
      dispatch: "dispatched",
      outcome: "succeeded",
      startedAt,
      finishedAt: now(),
    });
  }

  #nativeName(resourceId: string): string {
    return `mcu-${RunIdSchema.parse(resourceId)}`;
  }
}
