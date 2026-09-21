import {
  ElementRefSchema,
  err,
  ok,
  type ArtifactDescriptor,
  type ArtifactRef,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type ElementQuery,
  type EvidenceEvent,
  type EvidencePort,
  type GatewayConfig,
  type GuestPort,
  type ImagePort,
  type ElementRef,
  type ElementId,
  type ElementSummary,
  type LeaseId,
  type ManagedResourceRecord,
  type Observation,
  type ObservationId,
  type OperationId,
  type OperationError,
  type OperationResult,
  type RunId,
  type RunResult,
  type Scenario,
  type SessionId,
  type TimeoutConfig,
  type VmPort,
  type WindowId,
  type WindowQuery,
} from "../contracts/index.js";
import { ActionTransaction, type TransactionOutput } from "./action-transaction.js";
import { EnvironmentState } from "./environment-state.js";
import type { Clock, Hasher, IdGenerator, KernelHook, SecretResolver } from "./runtime.js";
import { StageTimeoutError, retrySafe, withStageSignal } from "./timeout.js";

export interface GatewayLock {
  acquire(): Promise<OperationResult<() => Promise<void>>>;
}
export type GatewayDependencies = {
  image: ImagePort;
  vm: VmPort;
  guest: GuestPort;
  desktop: DesktopPort;
  evidence: EvidencePort;
  clock: Clock;
  ids: IdGenerator;
  hasher: Hasher;
  secrets: SecretResolver;
  lock: GatewayLock;
  buildVersion: string;
  hooks?: readonly KernelHook[];
};
export type InteractiveRun = {
  readonly leaseId: LeaseId;
  observe(): Promise<OperationResult<Observation>>;
  query(query: ElementQuery): OperationResult<ElementRef>;
  compact(): OperationResult<string>;
  expand(elementId: ElementId): OperationResult<ElementSummary>;
  action(
    action: DesktopAction,
    assertions?: readonly AssertionSpec[],
  ): Promise<OperationResult<TransactionOutput>>;
};

export class Gateway {
  constructor(private readonly deps: GatewayDependencies) {}

  async execute(
    config: GatewayConfig,
    scenario: Scenario,
    signal: AbortSignal,
    appEnvironment?: Readonly<Record<string, string>>,
  ): Promise<OperationResult<{ runId: RunId; result: RunResult }>> {
    const acquired = await this.deps.lock.acquire();
    if (!acquired.ok) return acquired;
    const release = acquired.value;
    const reconciled = await this.#reconcile(signal);
    if (!reconciled.ok) {
      await release();
      return reconciled;
    }
    const runId = this.deps.ids.next("run") as RunId;
    const startedMono = this.deps.clock.monotonicMs();
    const environment = new EnvironmentState(
      this.deps.ids.next("lease") as LeaseId,
      startedMono + config.timeouts.runTotalMs,
    );
    let sequence = 0;
    let cloneName: string | undefined;
    let appiumStarted = false;
    let sessionStarted = false;
    const evidenceState: { complete: boolean } = { complete: true };
    let cleanupCompleted = true;
    let verdict: RunResult["verdict"] = "inconclusive";
    const artifacts: ArtifactDescriptor[] = [];
    const append = async (type: EvidenceEvent["type"], data: Record<string, unknown>): Promise<boolean> => {
      const result = await this.deps.evidence.append({
        schemaVersion: 1,
        runId,
        sequence: ++sequence,
        recordedAt: this.deps.clock.wallNow().toISOString(),
        elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
        type,
        source: "kernel",
        data,
      });
      if (!result.ok) evidenceState.complete = false;
      if (result.ok)
        await this.#runHooks(
          {
            schemaVersion: 1,
            runId,
            sequence,
            recordedAt: this.deps.clock.wallNow().toISOString(),
            elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
            type,
            source: "kernel",
            data,
          },
          artifacts,
          async (hookType, hookData) => {
            const hookEvent = {
              schemaVersion: 1 as const,
              runId,
              sequence: ++sequence,
              recordedAt: this.deps.clock.wallNow().toISOString(),
              elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
              type: hookType,
              source: "hook" as const,
              data: hookData,
            };
            return (await this.deps.evidence.append(hookEvent)).ok;
          },
          signal,
        );
      return result.ok;
    };
    await append("RunStarted", {
      scenario: scenario.name,
      scenarioSha256: this.deps.hasher.sha256(JSON.stringify(scenario)),
    });
    const configArtifact = await this.#configArtifact(runId, config);
    if (configArtifact.ok) {
      artifacts.push(configArtifact.value);
      await append("ArtifactCommitted", {
        artifactId: configArtifact.value.artifactId,
        type: configArtifact.value.type,
        sha256: configArtifact.value.sha256,
      });
    } else evidenceState.complete = false;
    try {
      const image = this.#unwrap(
        await this.#stage(config.timeouts, "imagePullMs", startedMono, signal, (stageSignal) =>
          this.#retryResult(config.retry.imagePull, stageSignal, (attemptSignal) =>
            this.deps.image.ensureImage(config.image, attemptSignal),
          ),
        ),
      );
      void image;
      cloneName = `mcu-${runId.replace(/[^0-9a-z-]/g, "").slice(0, 48)}`;
      this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "clonePlanned"));
      const plannedCloneName = cloneName;
      const cloned = this.#unwrap(
        await this.#stage(config.timeouts, "cloneMs", startedMono, signal, (stageSignal) =>
          this.deps.vm.clone(
            {
              runId,
              cloneName: plannedCloneName,
              image: config.image.reference,
              digest: config.image.digest,
            },
            stageSignal,
          ),
        ),
      );
      cloneName = cloned.cloneName;
      this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "cloneCreated"));
      await append("EnvironmentAllocated", { clone: "managed" });
      this.#unwrap(
        await this.#stage(config.timeouts, "vmBootMs", startedMono, signal, (stageSignal) =>
          this.deps.vm.start({ cloneName: cloneName as string, network: config.network }, stageSignal),
        ),
      );
      this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "started"));
      this.#unwrap(
        await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
          this.deps.guest.configureNetwork(cloneName as string, config.network, stageSignal),
        ),
      );
      const guest = this.#unwrap(
        await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
          this.#retryResult(config.retry.readiness, stageSignal, (attemptSignal) =>
            this.deps.guest.probe(
              cloneName as string,
              {
                imageDigest: config.image.digest,
                bundleId: config.aut.bundleId,
                compatibility: config.compatibility,
              },
              attemptSignal,
            ),
          ),
        ),
      );
      if (guest.status !== "ready")
        throw new RunFailure({
          code: "ProviderFailure",
          phase: "guest",
          message: "Guest readiness did not pass.",
          retryDisposition: "safe",
        });
      const appium = this.#unwrap(
        await this.#stage(config.timeouts, "appiumStartMs", startedMono, signal, (stageSignal) =>
          this.deps.guest.startAppium(cloneName as string, stageSignal),
        ),
      );
      appiumStarted = true;
      this.#unwrap(
        await this.#stage(config.timeouts, "mac2SessionMs", startedMono, signal, (stageSignal) =>
          this.deps.desktop.startSession(
            {
              endpoint: appium.endpoint,
              bundleId: config.aut.bundleId,
              window: config.aut.window,
              ...(config.aut.arguments ? { arguments: config.aut.arguments } : {}),
              ...(appEnvironment ? { environment: appEnvironment } : {}),
            },
            stageSignal,
          ),
        ),
      );
      sessionStarted = true;
      const readyAt = this.deps.clock.monotonicMs();
      environment.recordReady("vm", readyAt, config.timeouts.vmBootMs);
      environment.recordReady("guest", readyAt, guest.validForMs);
      environment.recordReady("driver", readyAt, config.timeouts.mac2SessionMs);
      environment.recordReady("app", readyAt, config.timeouts.appReadyMs);
      environment.activate(readyAt);
      const environmentArtifact = await this.#environmentArtifact(runId, config, cloneName);
      if (environmentArtifact.ok) {
        artifacts.push(environmentArtifact.value);
        await append("ArtifactCommitted", {
          artifactId: environmentArtifact.value.artifactId,
          type: environmentArtifact.value.type,
          sha256: environmentArtifact.value.sha256,
        });
      } else evidenceState.complete = false;
      await append("ReadinessEvaluated", { vm: "ready", guest: "ready", driver: "ready", app: "ready" });
      const observationResult = this.#unwrap(
        await this.#stage(config.timeouts, "observeMs", startedMono, signal, (stageSignal) =>
          this.#retryResult(config.retry.observation, stageSignal, (attemptSignal) =>
            this.#observe(runId, environment.generation, artifacts, attemptSignal),
          ),
        ),
      );
      let observation = observationResult;
      const observedTimeline = this.#unwrap(await this.deps.evidence.readTimeline(runId));
      sequence = observedTimeline.length;
      const transaction = new ActionTransaction(
        this.deps.desktop,
        this.deps.evidence,
        this.deps.clock,
        this.deps.ids,
        config.timeouts,
      );
      let stopped = false;
      let executedSteps = 0;
      for (const step of scenario.actions) {
        if (stopped) break;
        if (step.window) {
          const windowObservation = await this.#observe(
            runId,
            environment.generation,
            artifacts,
            signal,
            step.window,
          );
          if (!windowObservation.ok) {
            await append("StepProjected", { stepId: step.stepId, status: "failed" });
            executedSteps += 1;
            verdict = "inconclusive";
            break;
          }
          observation = windowObservation.value;
          const latestTimeline = await this.deps.evidence.readTimeline(runId);
          if (latestTimeline.ok) sequence = latestTimeline.value.length;
        }
        if (step.preconditions && step.preconditions.length > 0) {
          const preconditions = await this.#evaluateAssertions(step.preconditions, observation, signal);
          for (let index = 0; index < step.preconditions.length; index += 1) {
            const assertion = step.preconditions[index];
            const evaluated = preconditions[index];
            await append("AssertionEvaluated", {
              kind: assertion?.kind ?? "unknown",
              status: evaluated?.ok ? evaluated.value.status : "unverifiable",
              reason: evaluated?.ok ? evaluated.value.reason : (evaluated?.error.code ?? "missing"),
              observationId: observation.observationId,
            });
          }
          if (preconditions.some((item) => !item.ok || item.value.status !== "passed")) {
            await append("StepProjected", { stepId: step.stepId, status: "failed" });
            executedSteps += 1;
            verdict = "inconclusive";
            stopped = true;
            break;
          }
        }
        const target = this.#unique(observation, step.target);
        if (!target.ok) {
          await append("StepProjected", { stepId: step.stepId, status: "failed" });
          executedSteps += 1;
          verdict = "inconclusive";
          break;
        }
        const action = this.#materialize(step.action, target.value, observation, config);
        if (!action.ok) {
          await append("StepProjected", { stepId: step.stepId, status: "failed" });
          executedSteps += 1;
          verdict = "inconclusive";
          break;
        }
        const assertions = step.verification.policy === "immediate" ? step.verification.assertions : [];
        const tx = await transaction.execute(
          {
            runId,
            generation: environment.generation,
            sessionId: observation.sessionId,
            windowId: observation.windowId,
            expectedObservationId: observation.observationId,
            sequence,
            startedMono,
          },
          action.value,
          assertions,
          signal,
        );
        if (!tx.ok) {
          await append("StepProjected", { stepId: step.stepId, status: "failed" });
          executedSteps += 1;
          verdict = "inconclusive";
          stopped = true;
          break;
        }
        executedSteps += 1;
        sequence = tx.value.sequence;
        if (tx.value.evidenceComplete === false) evidenceState.complete = false;
        observation = tx.value.after ?? observation;
        if (tx.value.artifacts) artifacts.push(...tx.value.artifacts);
        if (
          tx.value.result.dispatch !== "dispatched" ||
          tx.value.result.providerOutcome !== "succeeded" ||
          tx.value.result.verification === "contradicted" ||
          tx.value.result.verification === "unverifiable"
        )
          stopped = true;
        await append("StepProjected", {
          stepId: step.stepId,
          status: tx.value.result.verification === "contradicted" ? "failed" : "completed",
        });
        if (tx.value.result.verification === "contradicted") verdict = "failed";
      }
      for (const step of scenario.actions.slice(executedSteps))
        await append("StepProjected", { stepId: step.stepId, status: "notRun" });
      if (!stopped) {
        const statuses = await this.#evaluateAssertions(scenario.finalAssertions, observation, signal);
        for (let index = 0; index < scenario.finalAssertions.length; index += 1) {
          const assertion = scenario.finalAssertions[index];
          const evaluated = statuses[index];
          await append("AssertionEvaluated", {
            kind: assertion?.kind ?? "unknown",
            status: evaluated?.ok ? evaluated.value.status : "unverifiable",
            reason: evaluated?.ok ? evaluated.value.reason : (evaluated?.error.code ?? "missing"),
            observationId: observation.observationId,
          });
        }
        verdict = statuses.some((item) => !item.ok || item.value.status === "unverifiable")
          ? "inconclusive"
          : statuses.some((item) => item.ok && item.value.status === "failed")
            ? "failed"
            : "passed";
      }
    } catch (error) {
      const failure =
        error instanceof RunFailure
          ? error.operationError
          : error instanceof StageTimeoutError
            ? {
                code: "ProviderTimeout" as const,
                phase: "action" as const,
                message: "Run stage timed out.",
                retryDisposition: "reconcileRequired" as const,
              }
            : {
                code: "InternalError" as const,
                phase: "action" as const,
                message: "Run execution failed unexpectedly.",
                retryDisposition: "notApplicable" as const,
              };
      verdict = "inconclusive";
      await append("OperationFailed", { code: failure.code, phase: failure.phase, message: failure.message });
    } finally {
      environment.beginCleanup();
      await append("CleanupStarted", {});
      if (sessionStarted) {
        const closed = await this.#cleanupAttempt(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.desktop.stopSession(cleanupSignal),
        );
        if (!closed) cleanupCompleted = false;
      }
      if (cloneName && appiumStarted) {
        const diagnostics = await this.#cleanupValue(config.timeouts.evidenceFinalizeMs, (cleanupSignal) =>
          this.deps.guest.exportDiagnostics(cloneName as string, cleanupSignal),
        );
        if (diagnostics?.ok) {
          const artifact = await this.deps.evidence.commitArtifact({
            runId,
            type: "guest-diagnostics",
            mimeType: "application/json",
            sensitivity: "potentiallySensitive",
            bytes: diagnostics.value,
          });
          if (artifact.ok) {
            artifacts.push(artifact.value);
            await append("ArtifactCommitted", {
              artifactId: artifact.value.artifactId,
              type: artifact.value.type,
              sha256: artifact.value.sha256,
            });
          } else evidenceState.complete = false;
        } else evidenceState.complete = false;
        const appiumStopped = await this.#cleanupAttempt(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.guest.stopAppium(cloneName as string, cleanupSignal),
        );
        cleanupCompleted = cleanupCompleted && appiumStopped;
      }
      if (cloneName) {
        const cleanupRecorded = (
          await this.#resource(runId, cloneName, config.image.digest, "cleanupStarted")
        ).ok;
        cleanupCompleted = cleanupCompleted && cleanupRecorded;
        const vmStopped = await this.#cleanupAttempt(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.vm.stop(cloneName as string, cleanupSignal),
        );
        cleanupCompleted = cleanupCompleted && vmStopped;
        const destroyed = await this.#cleanupValue(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.vm.destroy({ cloneName: cloneName as string, runId }, cleanupSignal),
        );
        cleanupCompleted = cleanupCompleted && destroyed?.ok === true;
        if (destroyed?.ok) {
          const completionRecorded = (
            await this.#resource(runId, cloneName, config.image.digest, "cleanupCompleted")
          ).ok;
          cleanupCompleted = cleanupCompleted && completionRecorded;
          const cleared = (await this.deps.evidence.clearManagedResource()).ok;
          cleanupCompleted = cleanupCompleted && cleared;
        }
      }
      await append("CleanupFinished", { status: cleanupCompleted ? "completed" : "failed" });
      let result: RunResult = {
        verdict,
        evidence: evidenceState.complete ? "complete" : "incomplete",
        cleanup: cleanupCompleted ? "completed" : "failed",
      };
      const finished = await append("RunFinished", result);
      if (!finished) evidenceState.complete = false;
      const timeline = await this.deps.evidence.readTimeline(runId);
      if (!timeline.ok) evidenceState.complete = false;
      result = { ...result, evidence: evidenceState.complete ? "complete" : "incomplete" };
      const timelineBytes = timeline.ok
        ? new TextEncoder().encode(timeline.value.map((event) => JSON.stringify(event)).join("\n") + "\n")
        : new Uint8Array();
      const manifest = await this.deps.evidence.commitManifest({
        schemaVersion: 1,
        revision: 1,
        runId,
        buildVersion: this.deps.buildVersion,
        eventCount: timeline.ok ? timeline.value.length : 0,
        timelineSha256: this.deps.hasher.sha256(timelineBytes),
        result,
        artifacts,
        ...(artifacts.find((artifact) => artifact.type === "effective-config")
          ? {
              configArtifact: this.#artifactRef(
                artifacts.find((artifact) => artifact.type === "effective-config") as ArtifactDescriptor,
              ),
            }
          : {}),
        ...(artifacts.find((artifact) => artifact.type === "environment")
          ? {
              environmentArtifact: this.#artifactRef(
                artifacts.find((artifact) => artifact.type === "environment") as ArtifactDescriptor,
              ),
            }
          : {}),
      });
      if (!manifest.ok) evidenceState.complete = false;
      await release();
      environment.close(cleanupCompleted);
    }
    return ok({
      runId,
      result: {
        verdict,
        evidence: evidenceState.complete ? "complete" : "incomplete",
        cleanup: cleanupCompleted ? "completed" : "failed",
      },
    });
  }

  async executeInteractive<T>(
    config: GatewayConfig,
    finalAssertions: readonly AssertionSpec[],
    callback: (run: InteractiveRun) => Promise<T>,
    signal: AbortSignal,
    appEnvironment?: Readonly<Record<string, string>>,
  ): Promise<OperationResult<{ runId: RunId; result: RunResult; value?: T }>> {
    const acquired = await this.deps.lock.acquire();
    if (!acquired.ok) return acquired;
    const release = acquired.value;
    const reconciled = await this.#reconcile(signal);
    if (!reconciled.ok) {
      await release();
      return reconciled;
    }
    const runId = this.deps.ids.next("run") as RunId;
    const startedMono = this.deps.clock.monotonicMs();
    let sequence = 0;
    let cloneName: string | undefined;
    let appiumStarted = false;
    let sessionStarted = false;
    const evidenceState: { complete: boolean } = { complete: true };
    let cleanupCompleted = true;
    let verdict: RunResult["verdict"] = "inconclusive";
    let value: T | undefined;
    let closed = false;
    let operationActive = false;
    const environment = new EnvironmentState(
      this.deps.ids.next("lease") as LeaseId,
      this.deps.clock.monotonicMs() + config.timeouts.runTotalMs,
    );
    const leaseId = environment.lease.id;
    let observation: Observation | undefined;
    const artifacts: ArtifactDescriptor[] = [];
    const append = async (type: EvidenceEvent["type"], data: Record<string, unknown>): Promise<boolean> => {
      const result = await this.deps.evidence.append({
        schemaVersion: 1,
        runId,
        sequence: ++sequence,
        recordedAt: this.deps.clock.wallNow().toISOString(),
        elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
        type,
        source: "kernel",
        data,
      });
      if (!result.ok) evidenceState.complete = false;
      if (result.ok)
        await this.#runHooks(
          {
            schemaVersion: 1,
            runId,
            sequence,
            recordedAt: this.deps.clock.wallNow().toISOString(),
            elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
            type,
            source: "kernel",
            data,
          },
          artifacts,
          async (hookType, hookData) => {
            const hookEvent = {
              schemaVersion: 1 as const,
              runId,
              sequence: ++sequence,
              recordedAt: this.deps.clock.wallNow().toISOString(),
              elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
              type: hookType,
              source: "hook" as const,
              data: hookData,
            };
            return (await this.deps.evidence.append(hookEvent)).ok;
          },
          signal,
        );
      return result.ok;
    };
    await append("RunStarted", { mode: "interactive" });
    const configArtifact = await this.#configArtifact(runId, config);
    if (configArtifact.ok) {
      artifacts.push(configArtifact.value);
      await append("ArtifactCommitted", {
        artifactId: configArtifact.value.artifactId,
        type: configArtifact.value.type,
        sha256: configArtifact.value.sha256,
      });
    } else evidenceState.complete = false;
    try {
      this.#unwrap(
        await this.#stage(config.timeouts, "imagePullMs", startedMono, signal, (stageSignal) =>
          this.#retryResult(config.retry.imagePull, stageSignal, (attemptSignal) =>
            this.deps.image.ensureImage(config.image, attemptSignal),
          ),
        ),
      );
      cloneName = `mcu-${runId.replace(/[^0-9a-z-]/g, "").slice(0, 48)}`;
      this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "clonePlanned"));
      const plannedCloneName = cloneName;
      const cloned = this.#unwrap(
        await this.#stage(config.timeouts, "cloneMs", startedMono, signal, (stageSignal) =>
          this.deps.vm.clone(
            {
              runId,
              cloneName: plannedCloneName,
              image: config.image.reference,
              digest: config.image.digest,
            },
            stageSignal,
          ),
        ),
      );
      cloneName = cloned.cloneName;
      this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "cloneCreated"));
      await append("EnvironmentAllocated", { clone: "managed" });
      this.#unwrap(
        await this.#stage(config.timeouts, "vmBootMs", startedMono, signal, (stageSignal) =>
          this.deps.vm.start({ cloneName: cloneName as string, network: config.network }, stageSignal),
        ),
      );
      this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "started"));
      this.#unwrap(
        await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
          this.deps.guest.configureNetwork(cloneName as string, config.network, stageSignal),
        ),
      );
      const guest = this.#unwrap(
        await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
          this.#retryResult(config.retry.readiness, stageSignal, (attemptSignal) =>
            this.deps.guest.probe(
              cloneName as string,
              {
                imageDigest: config.image.digest,
                bundleId: config.aut.bundleId,
                compatibility: config.compatibility,
              },
              attemptSignal,
            ),
          ),
        ),
      );
      if (guest.status !== "ready")
        throw new RunFailure({
          code: "ProviderFailure",
          phase: "guest",
          message: "Guest readiness did not pass.",
          retryDisposition: "safe",
        });
      const appium = this.#unwrap(
        await this.#stage(config.timeouts, "appiumStartMs", startedMono, signal, (stageSignal) =>
          this.deps.guest.startAppium(cloneName as string, stageSignal),
        ),
      );
      appiumStarted = true;
      this.#unwrap(
        await this.#stage(config.timeouts, "mac2SessionMs", startedMono, signal, (stageSignal) =>
          this.deps.desktop.startSession(
            {
              endpoint: appium.endpoint,
              bundleId: config.aut.bundleId,
              window: config.aut.window,
              ...(config.aut.arguments ? { arguments: config.aut.arguments } : {}),
              ...(appEnvironment ? { environment: appEnvironment } : {}),
            },
            stageSignal,
          ),
        ),
      );
      sessionStarted = true;
      const readyAt = this.deps.clock.monotonicMs();
      environment.recordReady("vm", readyAt, config.timeouts.vmBootMs);
      environment.recordReady("guest", readyAt, guest.validForMs);
      environment.recordReady("driver", readyAt, config.timeouts.mac2SessionMs);
      environment.recordReady("app", readyAt, config.timeouts.appReadyMs);
      environment.activate(readyAt);
      const environmentArtifact = await this.#environmentArtifact(runId, config, cloneName);
      if (environmentArtifact.ok) {
        artifacts.push(environmentArtifact.value);
        await append("ArtifactCommitted", {
          artifactId: environmentArtifact.value.artifactId,
          type: environmentArtifact.value.type,
          sha256: environmentArtifact.value.sha256,
        });
      } else evidenceState.complete = false;
      await append("ReadinessEvaluated", { vm: "ready", guest: "ready", driver: "ready", app: "ready" });
      const run: InteractiveRun = {
        leaseId,
        observe: async () => {
          if (closed)
            return err({
              code: "RunClosed",
              phase: "action",
              message: "Run scope is closed.",
              retryDisposition: "notApplicable",
            });
          try {
            environment.requireLease(leaseId, this.deps.clock.monotonicMs());
            environment.requireReady(this.deps.clock.monotonicMs());
          } catch {
            return err({
              code:
                this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                  ? "LeaseExpired"
                  : "ReadinessExpired",
              phase: "action",
              message: "Run lease expired.",
              retryDisposition: "safe",
              dispatch: "notDispatched",
            });
          }
          if (operationActive)
            return err({
              code: "GatewayBusy",
              phase: "action",
              message: "Another Run operation is active.",
              retryDisposition: "safe",
              dispatch: "notDispatched",
            });
          operationActive = true;
          let observed: OperationResult<Observation>;
          try {
            observed = await this.#stage(config.timeouts, "observeMs", startedMono, signal, (stageSignal) =>
              this.#retryResult(config.retry.observation, stageSignal, (attemptSignal) =>
                this.#observe(runId, environment.generation, artifacts, attemptSignal),
              ),
            );
          } finally {
            operationActive = false;
          }
          if (observed.ok) {
            observation = observed.value;
            const timeline = await this.deps.evidence.readTimeline(runId);
            if (timeline.ok) sequence = timeline.value.length;
          }
          return observed;
        },
        query: (query) =>
          closed
            ? err({
                code: "RunClosed",
                phase: "action",
                message: "Run scope is closed.",
                retryDisposition: "notApplicable",
              })
            : operationActive
              ? err({
                  code: "GatewayBusy",
                  phase: "observe",
                  message: "Another Run operation is active.",
                  retryDisposition: "safe",
                })
              : this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                ? err({
                    code: "LeaseExpired",
                    phase: "observe",
                    message: "Run lease expired.",
                    retryDisposition: "safe",
                  })
                : !this.#isReady(environment)
                  ? err({
                      code: "ReadinessExpired",
                      phase: "observe",
                      message: "Environment readiness expired.",
                      retryDisposition: "safe",
                    })
                  : observation
                    ? this.deps.desktop.query(observation, query)
                    : err({
                        code: "SnapshotIncomplete",
                        phase: "observe",
                        message: "Observe before querying.",
                        retryDisposition: "safe",
                      }),
        compact: () =>
          closed
            ? err({
                code: "RunClosed",
                phase: "observe",
                message: "Run scope is closed.",
                retryDisposition: "notApplicable",
              })
            : operationActive
              ? err({
                  code: "GatewayBusy",
                  phase: "observe",
                  message: "Another Run operation is active.",
                  retryDisposition: "safe",
                })
              : this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                ? err({
                    code: "LeaseExpired",
                    phase: "observe",
                    message: "Run lease expired.",
                    retryDisposition: "safe",
                  })
                : !this.#isReady(environment)
                  ? err({
                      code: "ReadinessExpired",
                      phase: "observe",
                      message: "Environment readiness expired.",
                      retryDisposition: "safe",
                    })
                  : observation
                    ? ok(this.deps.desktop.compact(observation))
                    : err({
                        code: "SnapshotIncomplete",
                        phase: "observe",
                        message: "Observe before requesting a compact snapshot.",
                        retryDisposition: "safe",
                      }),
        expand: (elementId) =>
          closed
            ? err({
                code: "RunClosed",
                phase: "observe",
                message: "Run scope is closed.",
                retryDisposition: "notApplicable",
              })
            : operationActive
              ? err({
                  code: "GatewayBusy",
                  phase: "observe",
                  message: "Another Run operation is active.",
                  retryDisposition: "safe",
                })
              : this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                ? err({
                    code: "LeaseExpired",
                    phase: "observe",
                    message: "Run lease expired.",
                    retryDisposition: "safe",
                  })
                : !this.#isReady(environment)
                  ? err({
                      code: "ReadinessExpired",
                      phase: "observe",
                      message: "Environment readiness expired.",
                      retryDisposition: "safe",
                    })
                  : observation
                    ? this.deps.desktop.expand(observation, elementId)
                    : err({
                        code: "SnapshotIncomplete",
                        phase: "observe",
                        message: "Observe before expanding an element.",
                        retryDisposition: "safe",
                      }),
        action: async (action, assertions = []) => {
          if (closed)
            return err({
              code: "RunClosed",
              phase: "action",
              message: "Run scope is closed.",
              retryDisposition: "notApplicable",
            });
          if (!observation)
            return err({
              code: "SnapshotIncomplete",
              phase: "observe",
              message: "Observe before acting.",
              retryDisposition: "safe",
            });
          try {
            environment.requireLease(leaseId, this.deps.clock.monotonicMs());
            environment.requireReady(this.deps.clock.monotonicMs());
          } catch {
            return err({
              code:
                this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                  ? "LeaseExpired"
                  : "ReadinessExpired",
              phase: "action",
              message: "Run lease expired.",
              retryDisposition: "safe",
              dispatch: "notDispatched",
            });
          }
          if (operationActive)
            return err({
              code: "GatewayBusy",
              phase: "action",
              message: "Another Run operation is active.",
              retryDisposition: "safe",
              dispatch: "notDispatched",
            });
          operationActive = true;
          const transaction = new ActionTransaction(
            this.deps.desktop,
            this.deps.evidence,
            this.deps.clock,
            this.deps.ids,
            config.timeouts,
          );
          let result: OperationResult<TransactionOutput>;
          try {
            result = await transaction.execute(
              {
                runId,
                generation: environment.generation,
                sessionId: observation.sessionId,
                windowId: observation.windowId,
                expectedObservationId: observation.observationId,
                sequence,
                startedMono,
              },
              action,
              assertions,
              signal,
            );
          } finally {
            operationActive = false;
          }
          if (result.ok) {
            sequence = result.value.sequence;
            if (result.value.evidenceComplete === false) evidenceState.complete = false;
            observation = result.value.after;
            if (result.value.artifacts) artifacts.push(...result.value.artifacts);
          }
          return result;
        },
      };
      value = await callback(run);
      closed = true;
      environment.beginCleanup();
      if (!observation || finalAssertions.length === 0) verdict = "inconclusive";
      else {
        const statuses = await this.#evaluateAssertions(finalAssertions, observation, signal);
        for (let index = 0; index < finalAssertions.length; index += 1) {
          const assertion = finalAssertions[index];
          const evaluated = statuses[index];
          await append("AssertionEvaluated", {
            kind: assertion?.kind ?? "unknown",
            status: evaluated?.ok ? evaluated.value.status : "unverifiable",
            reason: evaluated?.ok ? evaluated.value.reason : (evaluated?.error.code ?? "missing"),
            observationId: observation.observationId,
          });
        }
        verdict = statuses.some((item) => !item.ok || item.value.status === "unverifiable")
          ? "inconclusive"
          : statuses.some((item) => item.ok && item.value.status === "failed")
            ? "failed"
            : "passed";
      }
    } catch (error) {
      closed = true;
      const failure =
        error instanceof RunFailure
          ? error.operationError
          : error instanceof StageTimeoutError
            ? {
                code: "ProviderTimeout" as const,
                phase: "action" as const,
                message: "Run stage timed out.",
                retryDisposition: "reconcileRequired" as const,
              }
            : {
                code: "InternalError" as const,
                phase: "action" as const,
                message: "Run execution failed unexpectedly.",
                retryDisposition: "notApplicable" as const,
              };
      await append("OperationFailed", { code: failure.code, phase: failure.phase, message: failure.message });
      verdict = "inconclusive";
    } finally {
      closed = true;
      await append("CleanupStarted", {});
      if (sessionStarted) {
        const closed = await this.#cleanupAttempt(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.desktop.stopSession(cleanupSignal),
        );
        if (!closed) cleanupCompleted = false;
      }
      if (cloneName && appiumStarted) {
        const diagnostics = await this.#cleanupValue(config.timeouts.evidenceFinalizeMs, (cleanupSignal) =>
          this.deps.guest.exportDiagnostics(cloneName as string, cleanupSignal),
        );
        if (diagnostics?.ok) {
          const artifact = await this.deps.evidence.commitArtifact({
            runId,
            type: "guest-diagnostics",
            mimeType: "application/json",
            sensitivity: "potentiallySensitive",
            bytes: diagnostics.value,
          });
          if (artifact.ok) {
            artifacts.push(artifact.value);
            await append("ArtifactCommitted", {
              artifactId: artifact.value.artifactId,
              type: artifact.value.type,
              sha256: artifact.value.sha256,
            });
          } else evidenceState.complete = false;
        } else evidenceState.complete = false;
        const appiumStopped = await this.#cleanupAttempt(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.guest.stopAppium(cloneName as string, cleanupSignal),
        );
        cleanupCompleted = cleanupCompleted && appiumStopped;
      }
      if (cloneName) {
        const cleanupRecorded = (
          await this.#resource(runId, cloneName, config.image.digest, "cleanupStarted")
        ).ok;
        cleanupCompleted = cleanupCompleted && cleanupRecorded;
        const vmStopped = await this.#cleanupAttempt(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.vm.stop(cloneName as string, cleanupSignal),
        );
        cleanupCompleted = cleanupCompleted && vmStopped;
        const destroyed = await this.#cleanupValue(config.timeouts.cleanupMs, (cleanupSignal) =>
          this.deps.vm.destroy({ cloneName: cloneName as string, runId }, cleanupSignal),
        );
        cleanupCompleted = cleanupCompleted && destroyed?.ok === true;
        if (destroyed?.ok) {
          const completionRecorded = (
            await this.#resource(runId, cloneName, config.image.digest, "cleanupCompleted")
          ).ok;
          cleanupCompleted = cleanupCompleted && completionRecorded;
          const cleared = (await this.deps.evidence.clearManagedResource()).ok;
          cleanupCompleted = cleanupCompleted && cleared;
        }
      }
      await append("CleanupFinished", { status: cleanupCompleted ? "completed" : "failed" });
      let result: RunResult = {
        verdict,
        evidence: evidenceState.complete ? "complete" : "incomplete",
        cleanup: cleanupCompleted ? "completed" : "failed",
      };
      const finished = await append("RunFinished", result);
      if (!finished) evidenceState.complete = false;
      const timeline = await this.deps.evidence.readTimeline(runId);
      if (!timeline.ok) evidenceState.complete = false;
      result = { ...result, evidence: evidenceState.complete ? "complete" : "incomplete" };
      const bytes = timeline.ok
        ? new TextEncoder().encode(timeline.value.map((event) => JSON.stringify(event)).join("\n") + "\n")
        : new Uint8Array();
      const manifest = await this.deps.evidence.commitManifest({
        schemaVersion: 1,
        revision: 1,
        runId,
        buildVersion: this.deps.buildVersion,
        eventCount: timeline.ok ? timeline.value.length : 0,
        timelineSha256: this.deps.hasher.sha256(bytes),
        result,
        artifacts,
        ...(artifacts.find((artifact) => artifact.type === "effective-config")
          ? {
              configArtifact: this.#artifactRef(
                artifacts.find((artifact) => artifact.type === "effective-config") as ArtifactDescriptor,
              ),
            }
          : {}),
        ...(artifacts.find((artifact) => artifact.type === "environment")
          ? {
              environmentArtifact: this.#artifactRef(
                artifacts.find((artifact) => artifact.type === "environment") as ArtifactDescriptor,
              ),
            }
          : {}),
      });
      if (!manifest.ok) evidenceState.complete = false;
      await release();
      environment.close(cleanupCompleted);
    }
    return ok({
      runId,
      result: {
        verdict,
        evidence: evidenceState.complete ? "complete" : "incomplete",
        cleanup: cleanupCompleted ? "completed" : "failed",
      },
      ...(value === undefined ? {} : { value }),
    });
  }

  #unwrap<T>(result: OperationResult<T>): T {
    if (!result.ok) throw new RunFailure(result.error);
    return result.value;
  }

  #isReady(environment: EnvironmentState): boolean {
    try {
      environment.requireReady(this.deps.clock.monotonicMs());
      return true;
    } catch {
      return false;
    }
  }

  async #evaluateAssertions(
    assertions: readonly AssertionSpec[],
    observation: Observation,
    signal: AbortSignal,
  ): Promise<OperationResult<{ status: "passed" | "failed" | "unverifiable"; reason: string }>[]> {
    const results: OperationResult<{ status: "passed" | "failed" | "unverifiable"; reason: string }>[] = [];
    for (const assertion of assertions)
      results.push(await this.deps.desktop.evaluate(assertion, observation, signal));
    return results;
  }

  async #runHooks(
    event: EvidenceEvent,
    artifacts: ArtifactDescriptor[],
    appendHookEvent: (
      type: "ArtifactCommitted" | "HookFailed",
      data: Record<string, unknown>,
    ) => Promise<boolean>,
    signal: AbortSignal,
  ): Promise<void> {
    for (const hook of this.deps.hooks ?? []) {
      try {
        const contributions = await withStageSignal(5_000, signal, (hookSignal) =>
          hook.onEvent(event, hookSignal),
        );
        for (const contribution of contributions) {
          const artifact = await this.deps.evidence.commitArtifact({
            runId: event.runId,
            type: `hook-${hook.name}-${contribution.type}`,
            mimeType: "application/octet-stream",
            sensitivity: "potentiallySensitive",
            bytes: contribution.bytes,
          });
          if (artifact.ok) {
            artifacts.push(artifact.value);
            await appendHookEvent("ArtifactCommitted", {
              artifactId: artifact.value.artifactId,
              type: artifact.value.type,
              sha256: artifact.value.sha256,
            });
          }
        }
      } catch {
        await appendHookEvent("HookFailed", { hook: hook.name, code: "HookFailed" });
      }
    }
  }

  #stage<T>(
    timeouts: TimeoutConfig,
    key: Exclude<keyof TimeoutConfig, "runTotalMs" | "cleanupMs">,
    startedMono: number,
    signal: AbortSignal,
    operation: (stageSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const remaining = Math.max(1, timeouts.runTotalMs - (this.deps.clock.monotonicMs() - startedMono));
    return withStageSignal(Math.min(timeouts[key], remaining), signal, operation);
  }

  #retryResult<T>(
    policy: { maxAttempts: number; backoffMs: number },
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<OperationResult<T>>,
  ): Promise<OperationResult<T>> {
    return retrySafe(
      policy,
      signal,
      () => operation(signal),
      (result) => !result.ok && result.error.retryDisposition === "safe",
    );
  }

  async #cleanupValue<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await withStageSignal(timeoutMs, new AbortController().signal, operation);
    } catch {
      return undefined;
    }
  }

  async #cleanupAttempt(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<OperationResult<unknown>>,
  ): Promise<boolean> {
    const result = await this.#cleanupValue(timeoutMs, operation);
    return result?.ok === true;
  }

  async recover(signal: AbortSignal, cleanupMs = 120_000): Promise<OperationResult<{ status: "clean" }>> {
    const acquired = await this.deps.lock.acquire();
    if (!acquired.ok) return acquired;
    try {
      return await withStageSignal(cleanupMs, signal, (recoverySignal) => this.#reconcile(recoverySignal));
    } finally {
      await acquired.value();
    }
  }

  async #reconcile(signal: AbortSignal): Promise<OperationResult<{ status: "clean" }>> {
    const record = await this.deps.evidence.readManagedResource();
    const managed = await this.deps.vm.listManaged(signal);
    if (!record.ok || !managed.ok)
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed resource state could not be reconciled.",
        retryDisposition: "notApplicable",
      });
    if (record.value === null && managed.value.length === 0) return ok({ status: "clean" });
    if (record.value === null || managed.value.length > 1)
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed resource attribution is ambiguous.",
        retryDisposition: "notApplicable",
      });
    const clonePresent = managed.value.length === 1 && managed.value[0] === record.value.cloneName;
    if (managed.value.length === 1 && !clonePresent)
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed clone does not match its ownership record.",
        retryDisposition: "notApplicable",
      });
    const timeline = await this.deps.evidence.readTimeline(record.value.runId);
    if (!timeline.ok) return timeline;
    const orphans = await this.deps.evidence.recoverOrphans(record.value.runId);
    if (!orphans.ok) return orphans;
    const recoveryStarted = await this.deps.evidence.append({
      schemaVersion: 1,
      runId: record.value.runId,
      sequence: timeline.value.length + 1,
      recordedAt: this.deps.clock.wallNow().toISOString(),
      elapsedMs: 0,
      type: "RunRecoveryStarted",
      source: "kernel",
      data: { cloneName: record.value.cloneName },
    });
    if (!recoveryStarted.ok) return recoveryStarted;
    const vmStatus = clonePresent
      ? await this.deps.vm.inspect(record.value.cloneName, signal)
      : ok({ exists: false, state: "stopped" as const });
    if (!vmStatus.ok) return vmStatus;
    const isRunning = vmStatus.value.exists && vmStatus.value.state === "running";
    const sessionClosed = isRunning
      ? await this.deps.desktop.stopSession(signal)
      : ok({
          provider: "recovery",
          operationId: this.deps.ids.next("operation") as OperationId,
          dispatch: "notDispatched",
          outcome: "succeeded",
          startedAt: this.deps.clock.wallNow().toISOString(),
        });
    const diagnostics = isRunning
      ? await this.deps.guest.exportDiagnostics(record.value.cloneName, signal)
      : err<Uint8Array>({
          code: "EvidenceIncomplete",
          phase: "evidence",
          message: "Guest is not running.",
          retryDisposition: "notApplicable",
        });
    const recoveryArtifacts: ArtifactDescriptor[] = [];
    if (diagnostics.ok) {
      const diagnosticArtifact = await this.deps.evidence.commitArtifact({
        runId: record.value.runId,
        type: "guest-diagnostics",
        mimeType: "application/json",
        sensitivity: "potentiallySensitive",
        bytes: diagnostics.value,
      });
      if (diagnosticArtifact.ok) recoveryArtifacts.push(diagnosticArtifact.value);
    }
    const appiumStopped = isRunning
      ? await this.deps.guest.stopAppium(record.value.cloneName, signal)
      : sessionClosed;
    const stopped = isRunning ? await this.deps.vm.stop(record.value.cloneName, signal) : sessionClosed;
    const destroyed = clonePresent
      ? await this.deps.vm.destroy({ cloneName: record.value.cloneName, runId: record.value.runId }, signal)
      : sessionClosed;
    if (!sessionClosed.ok || !appiumStopped.ok || !stopped.ok || !destroyed.ok)
      return err({
        code: "RecoveryRequired",
        phase: "cleanup",
        message: "Managed clone cleanup did not complete.",
        retryDisposition: "notApplicable",
      });
    const recoveryFinished = await this.deps.evidence.append({
      schemaVersion: 1,
      runId: record.value.runId,
      sequence: timeline.value.length + 2,
      recordedAt: this.deps.clock.wallNow().toISOString(),
      elapsedMs: 0,
      type: "RunRecoveryFinished",
      source: "kernel",
      data: { status: "completed" },
    });
    if (!recoveryFinished.ok) return recoveryFinished;
    const manifest = await this.deps.evidence.commitRecoveryManifest(
      record.value.runId,
      this.deps.buildVersion,
      {
        verdict: "inconclusive",
        evidence: "incomplete",
        cleanup: "completed",
      },
      recoveryArtifacts,
    );
    if (!manifest.ok) return manifest;
    const cleared = await this.deps.evidence.clearManagedResource();
    if (!cleared.ok) return cleared;
    return ok({ status: "clean" });
  }

  #resource(
    runId: RunId,
    cloneName: string,
    imageDigest: string,
    phase: ManagedResourceRecord["phase"],
  ): Promise<OperationResult<void>> {
    return this.deps.evidence.writeManagedResource({
      schemaVersion: 1,
      runId,
      cloneName,
      imageDigest,
      phase,
    });
  }

  #configArtifact(runId: RunId, config: GatewayConfig): Promise<OperationResult<ArtifactDescriptor>> {
    const sanitized = {
      image: config.image,
      aut: {
        bundleId: config.aut.bundleId,
        arguments: config.aut.arguments,
        allowedEnvironmentSecrets: config.aut.allowedEnvironmentSecrets,
      },
      timeouts: config.timeouts,
      evidence: {
        retentionDays: config.evidence.retentionDays,
        maxArtifactBytes: config.evidence.maxArtifactBytes,
        maxRunBytes: config.evidence.maxRunBytes,
      },
      network: config.network,
      secrets: { allowedNames: config.secrets.allowedNames },
      compatibility: config.compatibility,
    };
    return this.deps.evidence.commitArtifact({
      runId,
      type: "effective-config",
      mimeType: "application/json",
      sensitivity: "normal",
      bytes: new TextEncoder().encode(JSON.stringify(sanitized)),
    });
  }

  #environmentArtifact(
    runId: RunId,
    config: GatewayConfig,
    cloneName: string,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    return this.deps.evidence.commitArtifact({
      runId,
      type: "environment",
      mimeType: "application/json",
      sensitivity: "normal",
      bytes: new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          cloneName,
          imageDigest: config.image.digest,
          compatibility: config.compatibility,
          bundleId: config.aut.bundleId,
        }),
      ),
    });
  }

  #artifactRef(artifact: ArtifactDescriptor): ArtifactRef {
    return { artifactId: artifact.artifactId, sha256: artifact.sha256 };
  }

  async #observe(
    runId: RunId,
    generation: number,
    artifacts: ArtifactDescriptor[],
    signal: AbortSignal,
    window?: WindowQuery,
  ): Promise<OperationResult<Observation>> {
    const observationId = this.deps.ids.next("observation") as ObservationId;
    const sessionId = this.deps.ids.next("session") as SessionId;
    const windowId = this.deps.ids.next("window") as WindowId;
    const observed = await this.deps.desktop.observe(
      { runId, generation, observationId, sessionId, windowId, ...(window ? { window } : {}) },
      signal,
    );
    if (!observed.ok) return observed;
    const screenshot = await this.deps.evidence.commitArtifact({
      runId,
      type: "window-screenshot",
      mimeType: "image/png",
      sensitivity: "potentiallySensitive",
      bytes: observed.value.screenshot,
    });
    if (!screenshot.ok) return screenshot;
    artifacts.push(screenshot.value);
    const snapshot = await this.deps.evidence.commitArtifact({
      runId,
      type: "ui-snapshot",
      mimeType: "application/json",
      sensitivity: "potentiallySensitive",
      bytes: observed.value.snapshot,
    });
    if (!snapshot.ok) return snapshot;
    artifacts.push(snapshot.value);
    const timeline = await this.deps.evidence.readTimeline(runId);
    if (!timeline.ok) return timeline;
    for (const [index, artifact] of [screenshot.value, snapshot.value].entries()) {
      const committed = await this.deps.evidence.append({
        schemaVersion: 1,
        runId,
        sequence: timeline.value.length + index + 1,
        recordedAt: this.deps.clock.wallNow().toISOString(),
        elapsedMs: 0,
        type: "ArtifactCommitted",
        source: "kernel",
        data: { artifactId: artifact.artifactId, type: artifact.type, sha256: artifact.sha256 },
      });
      if (!committed.ok) return committed;
    }
    const event = await this.deps.evidence.append({
      schemaVersion: 1,
      runId,
      sequence: timeline.value.length + 3,
      recordedAt: this.deps.clock.wallNow().toISOString(),
      elapsedMs: 0,
      type: "ObservationCaptured",
      source: "kernel",
      data: { observationId },
    });
    if (!event.ok) return event;
    return ok({
      ...observed.value.observation,
      screenshot: { artifactId: screenshot.value.artifactId, sha256: screenshot.value.sha256 },
      uiSnapshot: { artifactId: snapshot.value.artifactId, sha256: snapshot.value.sha256 },
    });
  }

  #unique(observation: Observation, query: ElementQuery): OperationResult<ElementRef> {
    const matches = observation.elements.filter(
      (element) =>
        (!query.role || element.role === query.role) &&
        (!query.identifier || element.identifier === query.identifier) &&
        (!query.name || this.#text(element.name, query.name)) &&
        (!query.label || this.#text(element.label, query.label)) &&
        (!query.value || this.#text(element.value, query.value)) &&
        (!query.state ||
          Object.entries(query.state).every(
            ([key, value]) => element[key as "enabled" | "selected" | "focused"] === value,
          )),
    );
    if (matches.length !== 1)
      return err({
        code: matches.length === 0 ? "TargetNotFound" : "TargetAmbiguous",
        phase: "action",
        message: "Action target is not unique.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    return ok(
      ElementRefSchema.parse({
        runId: observation.runId,
        environmentId: observation.environmentId,
        generation: observation.generation,
        sessionId: observation.sessionId,
        windowId: observation.windowId,
        observationId: observation.observationId,
        elementId: matches[0]?.elementId,
      }),
    );
  }
  #text(
    actual: string | undefined,
    match:
      | { exact: string; caseSensitive?: boolean | undefined }
      | { contains: string; caseSensitive?: boolean | undefined },
  ): boolean {
    if (actual === undefined) return false;
    const a = match.caseSensitive ? actual : actual.toLowerCase();
    const raw = "exact" in match ? match.exact : match.contains;
    const expected = match.caseSensitive ? raw : raw.toLowerCase();
    return "exact" in match ? a === expected : a.includes(expected);
  }
  #materialize(
    template: Scenario["actions"][number]["action"],
    target: ElementRef,
    observation: Observation,
    config: GatewayConfig,
  ): OperationResult<DesktopAction> {
    if (template.kind === "drag") {
      const destination = this.#unique(observation, template.destination);
      if (!destination.ok) return destination;
      return ok({
        kind: "drag",
        from: { element: target, ...(template.point ? { point: template.point } : {}) },
        to: {
          element: destination.value,
          ...(template.destinationPoint ? { point: template.destinationPoint } : {}),
        },
        ...(template.durationMs ? { durationMs: template.durationMs } : {}),
      });
    }
    if (template.kind === "appendText" || template.kind === "replaceText") {
      if ("literal" in template.value) return ok({ kind: template.kind, target, value: template.value });
      const name = template.value.secret.name;
      if (template.value.secret.purpose !== "textInput" || !config.secrets.allowedNames.includes(name))
        return err({
          code: "InvalidConfiguration",
          phase: "action",
          message: "Secret reference is not allowlisted for text input.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        });
      const value = this.deps.secrets.resolve(name);
      if (value === undefined)
        return err({
          code: "InvalidConfiguration",
          phase: "action",
          message: "Secret reference could not be resolved.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        });
      return ok({ kind: template.kind, target, value: { literal: value } });
    }
    if (template.kind === "pressKey")
      return ok({
        kind: "pressKey",
        key: template.key,
        ...(template.modifiers ? { modifiers: template.modifiers } : {}),
      });
    if (template.kind === "scroll")
      return ok({
        kind: "scroll",
        target: { element: target, ...(template.point ? { point: template.point } : {}) },
        delta: template.delta,
      });
    if (template.kind === "swipe")
      return ok({
        kind: "swipe",
        target: { element: target, ...(template.point ? { point: template.point } : {}) },
        direction: template.direction,
        ...(template.velocity ? { velocity: template.velocity } : {}),
      });
    switch (template.kind) {
      case "click":
        return ok({
          kind: "click",
          target: { element: target, ...(template.point ? { point: template.point } : {}) },
          ...(template.modifiers ? { modifiers: template.modifiers } : {}),
        });
      case "doubleClick":
        return ok({
          kind: "doubleClick",
          target: { element: target, ...(template.point ? { point: template.point } : {}) },
          ...(template.modifiers ? { modifiers: template.modifiers } : {}),
        });
      case "rightClick":
        return ok({
          kind: "rightClick",
          target: { element: target, ...(template.point ? { point: template.point } : {}) },
          ...(template.modifiers ? { modifiers: template.modifiers } : {}),
        });
      case "hover":
        return ok({
          kind: "hover",
          target: { element: target, ...(template.point ? { point: template.point } : {}) },
          ...(template.modifiers ? { modifiers: template.modifiers } : {}),
        });
    }
  }
}

class RunFailure extends Error {
  constructor(readonly operationError: OperationError) {
    super(operationError.message);
  }
}
