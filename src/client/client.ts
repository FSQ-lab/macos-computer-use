import { access, lstat, readFile, stat } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AssertionSpecSchema,
  ApplicationTargetSchema,
  HookDescriptorSchema,
  DesktopActionSchema,
  ElementIdSchema,
  ElementQuerySchema,
  GatewayConfigSchema,
  RunIdSchema,
  ScenarioSchema,
  err,
  ok,
  type AssertionSpec,
  type ApplicationTarget,
  type OperationResult,
  type Scenario,
} from "../contracts/index.js";
import {
  LocalEvidenceAdapter,
  MemorySensitiveDataPolicy,
  Mac2DesktopAdapter,
  TartAdapter,
  TartExecGuestAdapter,
} from "../adapters/index.js";
import { Gateway } from "../kernel/index.js";
import { FileGatewayLock } from "./file-lock.js";
import { EnvironmentSecretResolver, SecureIdGenerator, Sha256Hasher, SystemClock } from "./runtime.js";
import { WorkerEventHook } from "./worker-hook.js";

import type { ClientRun, ClientRunResult } from "./public-types.js";
import type {
  HookDescriptor,
  OperationId,
  RunId,
  RunManifest,
  RunResult,
  VisualEvaluator,
} from "../contracts/public.js";
export type { ClientRun, ClientRunResult } from "./public-types.js";

export interface MacOSComputerUseClient {
  run<T>(
    options: { finalAssertions: readonly AssertionSpec[]; signal?: AbortSignal },
    callback: (run: ClientRun) => Promise<T>,
  ): Promise<OperationResult<{ runId: RunId; result: RunResult; value?: T }>>;
  runScenario(scenario: unknown, options?: { signal?: AbortSignal }): Promise<ClientRunResult>;
  loadScenario(path: string): Promise<OperationResult<Scenario>>;
  doctor(options?: {
    deep?: boolean;
    signal?: AbortSignal;
  }): Promise<
    OperationResult<{ checks: readonly { name: string; status: "passed" | "failed"; detail: string }[] }>
  >;
  recover(options?: {
    signal?: AbortSignal;
  }): Promise<OperationResult<{ status: "clean" | "recoveryRequired" }>>;
  listRuns(): Promise<OperationResult<readonly RunId[]>>;
  showRun(runId: unknown): Promise<OperationResult<RunManifest>>;
  exportEvidence(runId: unknown, destination: string): Promise<OperationResult<{ exported: true }>>;
  applyRetention(): Promise<OperationResult<readonly RunId[]>>;
  listRetentionFailures(): Promise<OperationResult<readonly RunId[]>>;
}

export interface PiMacOSComputerUseClient extends MacOSComputerUseClient {
  runForApplication<T>(
    application: ApplicationTarget,
    options: { finalAssertions: readonly AssertionSpec[]; signal?: AbortSignal },
    callback: (run: ClientRun) => Promise<T>,
  ): Promise<OperationResult<{ runId: RunId; result: RunResult; value?: T }>>;
}

export const buildMacOSComputerUseClientForTesting = (
  input: unknown,
  options?: { visualEvaluator?: VisualEvaluator; hooks?: readonly HookDescriptor[] },
): PiMacOSComputerUseClient => {
  const config = GatewayConfigSchema.parse(input);
  const hooks = (options?.hooks ?? []).map((hook) => new WorkerEventHook(HookDescriptorSchema.parse(hook)));
  if (new Set(hooks.map((hook) => hook.name)).size !== hooks.length) throw new Error("Duplicate Hook names");
  const tartVersion = (() => {
    try {
      return execFileSync("tart", ["--version"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "unavailable";
    }
  })();
  const compatibilityError =
    !process.versions.node.startsWith("24.") || process.platform !== "darwin" || process.arch !== "arm64"
      ? "Unsupported Host runtime."
      : !/^2\.35\.\d+$/.test(tartVersion)
        ? "Unsupported Tart version."
        : undefined;
  const sensitive = new MemorySensitiveDataPolicy();
  const ids = new SecureIdGenerator();
  const appEnvironment: Record<string, string> = {};
  for (const name of config.aut.allowedEnvironmentSecrets ?? []) {
    if (!config.secrets.allowedNames.includes(name) || process.env[name] === undefined)
      throw new Error("Configured AUT environment Secret is unavailable or not allowlisted.");
    appEnvironment[name] = process.env[name];
    sensitive.remember(process.env[name]);
  }
  const evidence = new LocalEvidenceAdapter(
    config.evidence.root,
    config.state.root,
    config.evidence.maxArtifactBytes,
    config.evidence.maxRunBytes,
    undefined,
    config.state.tempRoot,
  );
  const tart = new TartAdapter("tart", ids);
  const driverChannels = new Map<OperationId, { endpoint: string; elementOriginActions: boolean }>();
  const guestAdapter = new TartExecGuestAdapter(
    "tart",
    sensitive,
    (channelId, channel) => driverChannels.set(channelId, channel),
    ids,
  );
  const guest = {
    probe: guestAdapter.probe.bind(guestAdapter),
    configureNetwork: guestAdapter.configureNetwork.bind(guestAdapter),
    resolveApplication: guestAdapter.resolveApplication.bind(guestAdapter),
    startAppium: guestAdapter.startAppium.bind(guestAdapter),
    stopAppium: async (...args: Parameters<TartExecGuestAdapter["stopAppium"]>) => {
      const result = await guestAdapter.stopAppium(...args);
      driverChannels.clear();
      return result;
    },
    exportDiagnostics: guestAdapter.exportDiagnostics.bind(guestAdapter),
  };
  const desktop = new Mac2DesktopAdapter(
    fetch,
    options?.visualEvaluator,
    sensitive,
    (channelId) => driverChannels.get(channelId),
    ids,
  );
  const lock = new FileGatewayLock(join(config.state.root, "gateway.lock"));
  const runtimeLock = {
    acquire: async () => {
      const acquired = await lock.acquire();
      if (!acquired.ok) return acquired;
      const retention = await evidence.applyRetention(config.evidence.retentionDays);
      if (!retention.ok) {
        await acquired.value();
        return retention;
      }
      return acquired;
    },
  };
  const gateway = new Gateway({
    image: tart,
    vm: tart,
    guest,
    desktop,
    evidence,
    clock: new SystemClock(),
    ids,
    hasher: new Sha256Hasher(),
    secrets: new EnvironmentSecretResolver(sensitive),
    lock: runtimeLock,
    buildVersion: "0.1.0",
    hooks,
  });
  const runInteractive = async <T>(
    options: { finalAssertions: readonly AssertionSpec[]; signal?: AbortSignal },
    callback: (run: ClientRun) => Promise<T>,
    applicationInput?: ApplicationTarget,
  ): Promise<OperationResult<{ runId: RunId; result: RunResult; value?: T }>> => {
    if (compatibilityError)
      return err({
        code: "UnsupportedRuntime",
        phase: "vm",
        message: compatibilityError,
        retryDisposition: "notApplicable",
      });
    const parsed = options.finalAssertions.map((item) => AssertionSpecSchema.safeParse(item));
    if ((!applicationInput && parsed.length === 0) || parsed.some((item) => !item.success))
      return err({
        code: "InvalidScenario",
        phase: "action",
        message: "Configured Runs require at least one valid final assertion.",
        retryDisposition: "notApplicable",
      });
    const assertions = parsed.flatMap((item) => (item.success ? [item.data] : []));
    const application = applicationInput ? ApplicationTargetSchema.safeParse(applicationInput) : undefined;
    if (application && !application.success)
      return err({
        code: "InvalidScenario",
        phase: "guest",
        message: "Application target is invalid.",
        retryDisposition: "notApplicable",
      });
    return gateway.executeInteractive(
      config,
      assertions,
      async (run) =>
        callback({
          leaseId: run.leaseId,
          currentObservation: () => run.currentObservation(),
          observe: () => run.observe(),
          assert: async (assertion) => {
            const parsed = AssertionSpecSchema.safeParse(assertion);
            return parsed.success
              ? run.assert(parsed.data)
              : err({
                  code: "InvalidScenario",
                  phase: "observe",
                  message: "Assertion is invalid.",
                  retryDisposition: "safe",
                });
          },
          assertCurrent: async (assertion) => {
            const parsed = AssertionSpecSchema.safeParse(assertion);
            return parsed.success
              ? run.assertCurrent(parsed.data)
              : err({
                  code: "InvalidScenario",
                  phase: "observe",
                  message: "Assertion is invalid.",
                  retryDisposition: "safe",
                });
          },
          freezeFinalAssertions: async (assertions) => {
            const parsed = assertions.map((item) => AssertionSpecSchema.safeParse(item));
            return parsed.length > 0 && parsed.every((item) => item.success)
              ? run.freezeFinalAssertions(parsed.map((item) => item.data))
              : err({
                  code: "InvalidScenario",
                  phase: "action",
                  message: "Final assertions are invalid.",
                  retryDisposition: "safe",
                });
          },
          compact: () => run.compact(),
          queryPage: (query, options) => {
            const parsed = ElementQuerySchema.safeParse(query);
            return parsed.success
              ? run.queryPage(parsed.data, options)
              : err({
                  code: "InvalidScenario",
                  phase: "observe",
                  message: "Query is invalid.",
                  retryDisposition: "safe",
                });
          },
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
      application?.data,
    );
  };
  return {
    run: (options, callback) => runInteractive(options, callback),
    runForApplication: (application, options, callback) => runInteractive(options, callback, application),
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
      const tartVersion = await execFileAsync("tart", ["--version"], {
        timeout: 5000,
        maxBuffer: 4096,
        signal: options?.signal,
      })
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
          status: /^2\.35\.\d+$/.test(tartVersion) ? "passed" : "failed",
          detail: tartVersion,
        },
      ];
      for (const [name, path] of [
        ["state-root", config.state.root],
        ["evidence-root", config.evidence.root],
      ] as const) {
        const writable = await lstat(path)
          .then(async (info) => {
            if (!info.isDirectory() || info.isSymbolicLink()) return false;
            await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
            return true;
          })
          .catch(() => false);
        checks.push({
          name,
          status: writable ? "passed" : "failed",
          detail: writable ? "Directory is accessible." : "Directory is missing or inaccessible.",
        });
      }
      const lockChecks = await Promise.all(
        [join(config.state.root, "gateway.lock"), FileGatewayLock.userLockPath()].map((path) =>
          lstat(path)
            .then(() => false)
            .catch(
              (error: unknown) =>
                typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
            ),
        ),
      );
      const lockAvailable = lockChecks.every(Boolean);
      checks.push({
        name: "gateway-lock",
        status: lockAvailable ? "passed" : "failed",
        detail: lockAvailable
          ? "No lock record exists."
          : "Lock record exists or is inaccessible; recovery may be required.",
      });
      const doctorSignal = AbortSignal.any([
        options?.signal ?? new AbortController().signal,
        AbortSignal.timeout(5000),
      ]);
      const managed = await tart.listManaged(doctorSignal);
      checks.push({
        name: "managed-resources",
        status: managed.ok && managed.value.length === 0 ? "passed" : "failed",
        detail: managed.ok ? `${String(managed.value.length)} managed clone(s)` : managed.error.code,
      });
      const imageReady = await tart.checkImage(config.image.reference, config.image.digest, doctorSignal);
      checks.push({
        name: "golden-image",
        status: imageReady.ok && imageReady.value ? "passed" : "failed",
        detail:
          imageReady.ok && imageReady.value
            ? "Configured OCI digest is cached."
            : imageReady.ok
              ? "Configured OCI digest is unavailable."
              : imageReady.error.code,
      });
      if (options?.deep && checks.every((check) => check.status === "passed")) {
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
            result.value.result.cleanup === "completed" &&
            result.value.result.evidence === "complete"
              ? "passed"
              : "failed",
          detail: result.ok ? JSON.stringify(result.value.result) : result.error.code,
        });
      }
      return ok({ checks });
    },
    recover: async (options) => {
      const result = await gateway.recover(
        options?.signal ?? new AbortController().signal,
        config.timeouts.cleanupMs,
        {
          maxFileBytes: config.evidence.maxArtifactBytes,
          maxTotalBytes: config.evidence.maxArtifactBytes,
        },
      );
      return result.ok ? ok({ status: "clean" }) : result;
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
        ? evidence
            .exportRun(parsed.data, destination)
            .then((result) => (result.ok ? ok({ exported: true as const }) : result))
        : err({
            code: "InvalidConfiguration",
            phase: "evidence",
            message: "Run ID is invalid.",
            retryDisposition: "notApplicable",
          });
    },
    applyRetention: async () => {
      const acquired = await lock.acquire();
      if (!acquired.ok) return acquired;
      try {
        return await evidence.applyRetention(config.evidence.retentionDays);
      } finally {
        await acquired.value();
      }
    },
    listRetentionFailures: () => evidence.listRetentionFailures(),
  };
};

export const createMacOSComputerUseClient = (
  input: unknown,
  options?: { visualEvaluator?: VisualEvaluator; hooks?: readonly HookDescriptor[] },
): OperationResult<MacOSComputerUseClient> => {
  try {
    return ok(buildMacOSComputerUseClientForTesting(input, options));
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

export const createPiMacOSComputerUseClient = (input: unknown): OperationResult<PiMacOSComputerUseClient> => {
  try {
    return ok(buildMacOSComputerUseClientForTesting(input));
  } catch {
    return err({
      code: "InvalidConfiguration",
      phase: "vm",
      message: "Configuration or Host compatibility is invalid.",
      retryDisposition: "notApplicable",
    });
  }
};
