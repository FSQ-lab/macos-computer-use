import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AssertionSpecSchema,
  DesktopActionSchema,
  ElementIdSchema,
  ElementQuerySchema,
  GatewayConfigSchema,
  RunIdSchema,
  ScenarioSchema,
  err,
  ok,
  type AssertionSpec,
  type OperationResult,
  type Scenario,
} from "../contracts/index.js";
import {
  LocalEvidenceAdapter,
  Mac2DesktopAdapter,
  TartAdapter,
  TartExecGuestAdapter,
} from "../adapters/index.js";
import { Gateway, type InteractiveRun } from "../kernel/index.js";
import { FileGatewayLock } from "./file-lock.js";
import { EnvironmentSecretResolver, SecureIdGenerator, Sha256Hasher, SystemClock } from "./runtime.js";

export type ClientRunResult = Awaited<ReturnType<Gateway["execute"]>>;

export interface MacOSComputerUseClient {
  run<T>(
    options: { finalAssertions: readonly AssertionSpec[]; signal?: AbortSignal },
    callback: (run: InteractiveRun) => Promise<T>,
  ): ReturnType<Gateway["executeInteractive"]>;
  runScenario(scenario: unknown, options?: { signal?: AbortSignal }): Promise<ClientRunResult>;
  loadScenario(path: string): Promise<OperationResult<Scenario>>;
  doctor(options?: {
    deep?: boolean;
    signal?: AbortSignal;
  }): Promise<
    OperationResult<{ checks: readonly { name: string; status: "passed" | "failed"; detail: string }[] }>
  >;
  recover(): Promise<OperationResult<{ status: "clean" | "recoveryRequired" }>>;
  listRuns(): ReturnType<LocalEvidenceAdapter["listRuns"]>;
  showRun(runId: unknown): ReturnType<LocalEvidenceAdapter["showRun"]>;
  exportEvidence(runId: unknown, destination: string): ReturnType<LocalEvidenceAdapter["exportRun"]>;
  applyRetention(): ReturnType<LocalEvidenceAdapter["applyRetention"]>;
}

const buildMacOSComputerUseClient = (input: unknown): MacOSComputerUseClient => {
  const config = GatewayConfigSchema.parse(input);
  const tartVersion = execFileSync("tart", ["--version"], { encoding: "utf8" }).trim();
  const softnetReady = (() => {
    try {
      return (statSync("/opt/homebrew/bin/softnet").mode & 0o4000) !== 0;
    } catch {
      return false;
    }
  })();
  const compatibilityError =
    !process.versions.node.startsWith("24.") || process.platform !== "darwin" || process.arch !== "arm64"
      ? "Unsupported Host runtime."
      : !tartVersion.startsWith(config.compatibility.tart)
        ? "Unsupported Tart version."
        : !softnetReady
          ? "Tart Softnet is not prepared with its required SUID permission. Run Tart once and complete the operator-approved sudo setup."
          : undefined;
  const appEnvironment: Record<string, string> = {};
  for (const name of config.aut.allowedEnvironmentSecrets ?? []) {
    if (!config.secrets.allowedNames.includes(name) || process.env[name] === undefined)
      throw new Error("Configured AUT environment Secret is unavailable or not allowlisted.");
    appEnvironment[name] = process.env[name];
  }
  const evidence = new LocalEvidenceAdapter(
    config.evidence.root,
    config.state.root,
    config.evidence.maxArtifactBytes,
    config.evidence.maxRunBytes,
  );
  const tart = new TartAdapter();
  const guest = new TartExecGuestAdapter();
  const desktop = new Mac2DesktopAdapter();
  const gateway = new Gateway({
    image: tart,
    vm: tart,
    guest,
    desktop,
    evidence,
    clock: new SystemClock(),
    ids: new SecureIdGenerator(),
    hasher: new Sha256Hasher(),
    secrets: new EnvironmentSecretResolver(),
    lock: new FileGatewayLock(join(config.state.root, "gateway.lock")),
    buildVersion: "0.1.0",
  });
  return {
    run: async (options, callback) => {
      if (compatibilityError)
        return err({
          code: "UnsupportedRuntime",
          phase: "vm",
          message: compatibilityError,
          retryDisposition: "notApplicable",
        });
      const parsed = options.finalAssertions.map((item) => AssertionSpecSchema.safeParse(item));
      if (parsed.length === 0 || parsed.some((item) => !item.success))
        return err({
          code: "InvalidScenario",
          phase: "action",
          message: "At least one valid final assertion is required.",
          retryDisposition: "notApplicable",
        });
      const assertions = parsed.flatMap((item) => (item.success ? [item.data] : []));
      return gateway.executeInteractive(
        config,
        assertions,
        async (run) =>
          callback({
            leaseId: run.leaseId,
            observe: () => run.observe(),
            compact: () => run.compact(),
            query: (query) => {
              const parsed = ElementQuerySchema.safeParse(query);
              return parsed.success
                ? run.query(parsed.data)
                : err({
                    code: "InvalidScenario",
                    phase: "observe",
                    message: "Element query is invalid.",
                    retryDisposition: "safe",
                  });
            },
            expand: (elementId) => {
              const parsed = ElementIdSchema.safeParse(elementId);
              return parsed.success
                ? run.expand(parsed.data)
                : err({
                    code: "InvalidScenario",
                    phase: "observe",
                    message: "Element ID is invalid.",
                    retryDisposition: "safe",
                  });
            },
            action: (action, actionAssertions = []) => {
              const parsedAction = DesktopActionSchema.safeParse(action);
              const parsedAssertions = actionAssertions.map((item) => AssertionSpecSchema.safeParse(item));
              const validAssertions = parsedAssertions.flatMap((item) => (item.success ? [item.data] : []));
              return parsedAction.success && parsedAssertions.every((item) => item.success)
                ? run.action(parsedAction.data, validAssertions)
                : Promise.resolve(
                    err({
                      code: "InvalidScenario",
                      phase: "action",
                      message: "Interactive action or assertion is invalid.",
                      retryDisposition: "safe",
                      dispatch: "notDispatched",
                    }),
                  );
            },
          }),
        options.signal ?? new AbortController().signal,
        appEnvironment,
      );
    },
    runScenario: async (scenarioInput, options) => {
      if (compatibilityError)
        return err({
          code: "UnsupportedRuntime",
          phase: "vm",
          message: compatibilityError,
          retryDisposition: "notApplicable",
        });
      const parsed = ScenarioSchema.safeParse(scenarioInput);
      if (!parsed.success)
        return err({
          code: "InvalidScenario",
          phase: "action",
          message: "Scenario is invalid.",
          retryDisposition: "notApplicable",
        });
      return gateway.execute(
        config,
        parsed.data,
        options?.signal ?? new AbortController().signal,
        appEnvironment,
      );
    },
    loadScenario: async (path) => {
      try {
        if ((await stat(path)).size > 1_000_000) throw new Error("Scenario is too large.");
        return ok(ScenarioSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown));
      } catch {
        return err({
          code: "InvalidScenario",
          phase: "action",
          message: "Scenario file is invalid.",
          retryDisposition: "notApplicable",
        });
      }
    },
    doctor: async (options) => {
      const execFileAsync = promisify(execFile);
      const tartVersion = await execFileAsync("tart", ["--version"])
        .then(({ stdout }) => stdout.trim())
        .catch(() => "unavailable");
      const checks: { name: string; status: "passed" | "failed"; detail: string }[] = [
        {
          name: "node",
          status: process.versions.node.startsWith("24.") ? ("passed" as const) : ("failed" as const),
          detail: process.versions.node,
        },
        {
          name: "host",
          status:
            process.platform === "darwin" && process.arch === "arm64"
              ? ("passed" as const)
              : ("failed" as const),
          detail: `${process.platform}/${process.arch}`,
        },
        {
          name: "tart",
          status: tartVersion.startsWith(config.compatibility.tart) ? "passed" : "failed",
          detail: tartVersion,
        },
        {
          name: "softnet-suid",
          status: softnetReady ? "passed" : "failed",
          detail: softnetReady
            ? "Softnet SUID permission is ready."
            : "Run Tart once and complete its operator-approved sudo setup.",
        },
      ];
      for (const [name, path] of [
        ["state-root", config.state.root],
        ["evidence-root", config.evidence.root],
      ] as const) {
        const probe = join(path, `.doctor-${String(process.pid)}`);
        const writable = await mkdir(path, { recursive: true, mode: 0o700 })
          .then(() => open(probe, "wx", 0o600))
          .then(async (handle) => {
            await handle.close();
            await rm(probe, { force: true });
            return true;
          })
          .catch(() => false);
        checks.push({ name, status: writable ? "passed" : "failed", detail: path });
      }
      const managed = await tart.listManaged(options?.signal ?? new AbortController().signal);
      checks.push({
        name: "managed-resources",
        status: managed.ok && managed.value.length === 0 ? "passed" : "failed",
        detail: managed.ok ? `${String(managed.value.length)} managed clone(s)` : managed.error.code,
      });
      const imageReady = await tart.checkImage(
        config.image.reference,
        config.image.digest,
        options?.signal ?? new AbortController().signal,
      );
      checks.push({
        name: "golden-image",
        status: imageReady ? "passed" : "failed",
        detail: imageReady ? "Configured OCI digest is cached." : "Configured OCI digest is unavailable.",
      });
      if (options?.deep) {
        const scenario = ScenarioSchema.parse({
          schemaVersion: 1,
          name: "deep-doctor",
          actions: [],
          finalAssertions: [{ kind: "visible", query: { role: "window" } }],
        });
        const result = await gateway.execute(
          config,
          scenario,
          options.signal ?? new AbortController().signal,
          appEnvironment,
        );
        checks.push({
          name: "deep-runtime",
          status:
            result.ok &&
            result.value.result.verdict === "passed" &&
            result.value.result.cleanup === "completed"
              ? "passed"
              : "failed",
          detail: result.ok ? JSON.stringify(result.value.result) : result.error.code,
        });
      }
      return ok({ checks });
    },
    recover: async () => {
      const result = await gateway.recover(new AbortController().signal, config.timeouts.cleanupMs);
      return result.ok ? ok({ status: "clean" }) : ok({ status: "recoveryRequired" });
    },
    listRuns: () => evidence.listRuns(),
    showRun: async (runId) => {
      const parsed = RunIdSchema.safeParse(runId);
      return parsed.success
        ? evidence.showRun(parsed.data)
        : err({
            code: "InvalidConfiguration",
            phase: "evidence",
            message: "Run ID is invalid.",
            retryDisposition: "notApplicable",
          });
    },
    exportEvidence: async (runId, destination) => {
      const parsed = RunIdSchema.safeParse(runId);
      return parsed.success
        ? evidence.exportRun(parsed.data, destination)
        : err({
            code: "InvalidConfiguration",
            phase: "evidence",
            message: "Run ID is invalid.",
            retryDisposition: "notApplicable",
          });
    },
    applyRetention: () => evidence.applyRetention(config.evidence.retentionDays),
  };
};

export const createMacOSComputerUseClient = (input: unknown): OperationResult<MacOSComputerUseClient> => {
  try {
    return ok(buildMacOSComputerUseClient(input));
  } catch {
    return err({
      code: "InvalidConfiguration",
      phase: "vm",
      message: "Configuration or Host compatibility is invalid.",
      retryDisposition: "notApplicable",
    });
  }
};
export const tryCreateMacOSComputerUseClient = createMacOSComputerUseClient;
