import { randomBytes } from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayConfigSchema } from "../../contracts/public.js";
import {
  AGENT_TASK_PROTOCOL_VERSION,
  TaskResponseSchema,
  type TaskId,
  type TaskOperationInput,
  type TaskRequest,
  type TaskResponse,
  type TaskRuntimeError,
  type TaskValue,
} from "./protocol.js";

export class PiTaskRequestError extends Error {
  constructor(readonly details: TaskRuntimeError) {
    super(details.message);
    this.name = "PiTaskRequestError";
  }
}

export type PiTaskChild = {
  readonly connected: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  disconnect(): void;
  on(event: "message", listener: (message: unknown) => void): PiTaskChild;
  once(event: "disconnect" | "exit", listener: () => void): PiTaskChild;
};
type ChildLike = PiTaskChild;
export type SpawnPiTaskRunner = (configPath: string, cwd: string) => ChildLike;

const resolveRunnerNode = (): string => {
  const candidates = [
    process.env.MACOS_COMPUTER_USE_NODE,
    "/opt/homebrew/opt/node@24/bin/node",
    "/usr/local/opt/node@24/bin/node",
    process.versions.node.startsWith("24.") ? process.execPath : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      const version = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
      if (/^v24\./.test(version)) return candidate;
    } catch {
      // Try the next explicit Node candidate.
    }
  }
  throw new Error(
    "MCU requires Node.js 24 for its supervised runner. Install Homebrew node@24 or set MACOS_COMPUTER_USE_NODE.",
  );
};

const inheritedEnvironmentNames = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
] as const;

export const buildPiRunnerEnvironment = (
  configPath: string,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const parsed = GatewayConfigSchema.parse(config);
  const allowedSecrets = new Set([
    ...parsed.secrets.allowedNames,
    ...(parsed.aut.allowedEnvironmentSecrets ?? []),
  ]);
  const environment: NodeJS.ProcessEnv = { MACOS_COMPUTER_USE_CONFIG: configPath };
  for (const name of inheritedEnvironmentNames) {
    const value = hostEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of allowedSecrets) {
    const value = hostEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const defaultSpawn: SpawnPiTaskRunner = (configPath, cwd) => {
  const adjacentRunner = fileURLToPath(new URL("../task-runner.js", import.meta.url));
  const runner = existsSync(adjacentRunner)
    ? adjacentRunner
    : resolve(cwd, "dist/pi-extension/task-runner.js");
  return fork(runner, [], {
    execPath: resolveRunnerNode(),
    execArgv: [],
    cwd,
    env: buildPiRunnerEnvironment(configPath),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
};

type Pending = {
  sequence: number;
  type: TaskRequest["type"];
  resolve: (value: TaskValue) => void;
  reject: (error: Error) => void;
};

export class PiTaskSupervisor {
  readonly taskId: TaskId = `task-${randomBytes(12).toString("hex")}`;
  #child: ChildLike | undefined;
  #sequence = 0;
  #operationQueue: Promise<void> = Promise.resolve();
  #pending = new Map<string, Pending>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #shutdownInProgress = false;
  #terminalError: Error | undefined;

  constructor(
    private readonly configPath: string,
    private readonly cwd: string,
    private readonly spawnRunner: SpawnPiTaskRunner = defaultSpawn,
    private readonly shutdownMs = 120_000,
  ) {}

  async start(
    application: Extract<TaskOperationInput, { type: "begin" }>["application"],
  ): Promise<TaskValue> {
    if (this.#child || this.#closed) throw new Error("This task supervisor cannot be started again.");
    this.#child = this.spawnRunner(this.configPath, this.cwd);
    this.#child.on("message", (message: unknown) => this.#onMessage(message));
    this.#child.once("disconnect", () => this.#transportFailure("Pi task runner disconnected."));
    this.#child.once("exit", () => this.#transportFailure("Pi task runner exited."));
    this.#heartbeat = setInterval(() => {
      void this.#transmit({ type: "heartbeat" }).catch(() => undefined);
    }, 1_000);
    this.#heartbeat.unref();
    try {
      return await this.#transmit({ type: "begin", application });
    } catch (error) {
      if (!this.#shutdownInProgress)
        this.#close(error instanceof Error ? error : new Error("Pi task failed to start."));
      throw error;
    }
  }

  request(input: Exclude<TaskOperationInput, { type: "begin" | "heartbeat" }>): Promise<TaskValue> {
    let resolveResult: ((value: TaskValue) => void) | undefined;
    let rejectResult: ((error: Error) => void) | undefined;
    const result = new Promise<TaskValue>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const execute = async (): Promise<void> => {
      try {
        const value = await this.#transmit(input);
        resolveResult?.(value);
        if (input.type === "finish" || input.type === "abort") this.#close(new Error("Pi task completed."));
      } catch (error) {
        rejectResult?.(error instanceof Error ? error : new Error("Task request failed."));
      }
    };
    this.#operationQueue = this.#operationQueue.then(execute, execute);
    return result;
  }

  async shutdown(reason = "Agent owner shutdown"): Promise<void> {
    if (this.#closed) return;
    this.#shutdownInProgress = true;
    if (this.#child?.connected) {
      try {
        await this.#withShutdownDeadline(
          this.#transmit({
            type: "abort",
            reason: reason.slice(0, 200) || "Agent owner shutdown",
          }),
        );
      } catch {
        // Timeout or transport loss closes local dispatch authority below.
      }
    }
    this.#close(new Error(reason));
  }

  async #transmit(input: TaskOperationInput): Promise<TaskValue> {
    if (this.#closed || this.#terminalError || !this.#child?.connected)
      throw this.#terminalError ?? new Error("No supervised Pi task is active.");
    const sequence = ++this.#sequence;
    const requestId = `req-${randomBytes(12).toString("hex")}`;
    const request = {
      ...input,
      protocolVersion: AGENT_TASK_PROTOCOL_VERSION,
      taskId: this.taskId,
      requestId,
      sequence,
    } as TaskRequest;
    return new Promise<TaskValue>((resolve, reject) => {
      this.#pending.set(requestId, { sequence, type: request.type, resolve, reject });
      this.#child?.send(request, (error) => {
        if (!error) return;
        this.#pending.delete(requestId);
        this.#transportFailure("Pi task request transport failed.");
        reject(error);
      });
    });
  }

  #onMessage(message: unknown): void {
    const parsed = TaskResponseSchema.safeParse(message);
    if (!parsed.success || parsed.data.taskId !== this.taskId) {
      this.#transportFailure("Invalid Pi task runner response.");
      return;
    }
    const response: TaskResponse = parsed.data;
    const pending = this.#pending.get(response.requestId);
    if (!pending || response.sequence !== pending.sequence || response.type !== pending.type) {
      this.#transportFailure("Unexpected Pi task runner response.");
      return;
    }
    this.#pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.value);
    else {
      pending.reject(new PiTaskRequestError(response.error));
      if (
        response.error.code === "InvalidMessage" ||
        response.error.code === "UnsupportedProtocol" ||
        response.error.code === "IdentityMismatch" ||
        response.error.code === "SequenceViolation" ||
        (response.error.code === "SupervisionLost" && !this.#shutdownInProgress)
      )
        this.#transportFailure("Pi task runner rejected the protocol operation.");
    }
  }

  #transportFailure(message: string): void {
    if (this.#terminalError) return;
    this.#terminalError = new Error(message);
    this.#close(this.#terminalError);
  }

  async #withShutdownDeadline<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Pi task cleanup deadline expired.")), this.shutdownMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (this.#child?.connected) this.#child.disconnect();
    this.#child?.kill("SIGTERM");
  }
}
