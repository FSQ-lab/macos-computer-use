import {
  HookContributionsSchema,
  AssertionResultSchema,
  type AssertionResult,
  ConfigSnapshotSchema,
  EnvironmentSnapshotSchema,
  parseEvidenceEvent,
  RunResultSchema,
  err,
  ok,
  type ArtifactDescriptor,
  type ArtifactRef,
  type ApplicationTarget,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type ElementQuery,
  type QueryPage,
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
  type ProviderReceipt,
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
import { deliverHooks } from "./hook-pipeline.js";

const PROTECTED_APPLICATION_BUNDLE_IDS = new Set([
  "com.apple.Passwords",
  "com.apple.keychainaccess",
  "com.apple.systempreferences",
  "com.apple.installer",
  "com.apple.Terminal",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.shortcuts",
  "com.apple.SecurityAgent",
  "com.apple.loginwindow",
]);

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
  assert(assertion: AssertionSpec): Promise<OperationResult<AssertionResult>>;
  assertCurrent(assertion: AssertionSpec): Promise<OperationResult<AssertionResult>>;
  query(query: ElementQuery): OperationResult<ElementRef>;
  queryPage(query: ElementQuery, options?: { offset?: number; limit?: number }): OperationResult<QueryPage>;
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
    config = structuredClone(config);
    scenario = structuredClone(scenario);
    const acquired = await this.deps.lock.acquire();
    if (!acquired.ok) return acquired;
    try {
      const reconciled = await withStageSignal(
        config.timeouts.cleanupMs,
        new AbortController().signal,
        (recoverySignal) =>
          this.#reconcile(recoverySignal, {
            maxFileBytes: config.evidence.maxArtifactBytes,
            maxTotalBytes: config.evidence.maxArtifactBytes,
          }),
      ).catch(() =>
        err<{ status: "clean" }>({
          code: "RecoveryRequired",
          phase: "cleanup",
          message: "Startup reconciliation could not complete.",
          retryDisposition: "notApplicable",
        }),
      );
      if (!reconciled.ok) {
        return reconciled;
      }
      const image = await withStageSignal(
        config.timeouts.imagePullMs,
        signal,
        (imageSignal) =>
          this.#retryResult(config.retry.imagePull, imageSignal, (attemptSignal) =>
            this.deps.image.ensureImage(
              { reference: config.image.reference, digest: config.image.digest },
              attemptSignal,
            ),
          ),
        this.deps.clock,
      ).catch(() =>
        err<ProviderReceipt>({
          code: "ProviderTimeout",
          phase: "image",
          message: "Golden Image verification timed out before Run allocation.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        }),
      );
      if (!image.ok) return image;
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
      const projectedSteps = new Set<string>();
      let evidenceDeadline: number | undefined;
      const evidenceRemaining = (): number =>
        Math.max(
          0,
          evidenceDeadline === undefined
            ? config.timeouts.evidenceFinalizeMs
            : evidenceDeadline - this.deps.clock.monotonicMs(),
        );
      const append = async (type: EvidenceEvent["type"], data: Record<string, unknown>): Promise<boolean> => {
        const nextSequence = sequence + 1;
        const result = await withStageSignal(
          evidenceRemaining(),
          new AbortController().signal,
          (evidenceSignal) =>
            this.deps.evidence.append(
              parseEvidenceEvent({
                schemaVersion: 1,
                runId,
                sequence: nextSequence,
                recordedAt: this.deps.clock.wallNow().toISOString(),
                elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
                type,
                source: "kernel",
                data,
              }),
              evidenceSignal,
            ),
          this.deps.clock,
          true,
        ).catch(() =>
          err({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Evidence append did not complete within its budget.",
            retryDisposition: "notApplicable",
          }),
        );
        if (!result.ok) evidenceState.complete = false;
        if (result.ok) sequence = nextSequence;
        if (result.ok && type === "StepProjected" && typeof data.stepId === "string")
          projectedSteps.add(data.stepId);
        if (result.ok)
          await this.#runHooks(
            parseEvidenceEvent({
              schemaVersion: 1,
              runId,
              sequence,
              recordedAt: this.deps.clock.wallNow().toISOString(),
              elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
              type,
              source: "kernel",
              data,
            }),
            artifacts,
            async (hookType, hookData) => {
              const hookSequence = sequence + 1;
              const hookEvent = parseEvidenceEvent({
                schemaVersion: 1 as const,
                runId,
                sequence: hookSequence,
                recordedAt: this.deps.clock.wallNow().toISOString(),
                elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
                type: hookType,
                source: "hook" as const,
                data: hookData,
              });
              const appended = await withStageSignal(
                evidenceRemaining(),
                new AbortController().signal,
                (evidenceSignal) => this.deps.evidence.append(hookEvent, evidenceSignal),
                this.deps.clock,
                true,
              ).catch(() => undefined);
              if (appended?.ok) sequence = hookSequence;
              else evidenceState.complete = false;
              return appended?.ok === true;
            },
            signal,
          );
        return result.ok;
      };
      await append("RunStarted", {
        scenario: scenario.name,
        scenarioSha256: this.deps.hasher.sha256(JSON.stringify(scenario)),
      });
      const configArtifact = await withStageSignal(
        config.timeouts.evidenceFinalizeMs,
        new AbortController().signal,
        (evidenceSignal) => this.#configArtifact(runId, config, evidenceSignal),
        this.deps.clock,
        true,
      ).catch(() =>
        err<ArtifactDescriptor>({
          code: "EvidenceIncomplete",
          phase: "evidence",
          message: "Configuration Evidence did not complete.",
          retryDisposition: "notApplicable",
        }),
      );
      if (configArtifact.ok) {
        artifacts.push(configArtifact.value);
        await append("ArtifactCommitted", {
          artifactId: configArtifact.value.artifactId,
          type: configArtifact.value.type,
          sha256: configArtifact.value.sha256,
        });
      } else evidenceState.complete = false;
      try {
        if (!evidenceState.complete)
          throw new RunFailure({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Required initial Evidence could not be committed.",
            retryDisposition: "notApplicable",
            dispatch: "notDispatched",
          });
        cloneName = runId;
        this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "clonePlanned", signal));
        const cloned = this.#unwrap(
          await this.#stage(config.timeouts, "cloneMs", startedMono, signal, (stageSignal) =>
            this.deps.vm.clone(
              {
                runId,
                image: config.image.reference,
                digest: config.image.digest,
              },
              stageSignal,
            ),
          ),
        );
        cloneName = cloned.resourceId;
        this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "cloneCreated", signal));
        await append("EnvironmentAllocated", { clone: "managed" });
        this.#unwrap(
          await this.#stage(config.timeouts, "vmBootMs", startedMono, signal, (stageSignal) =>
            this.deps.vm.start({ resourceId: cloneName as string, network: config.network }, stageSignal),
          ),
        );
        this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "started", signal));
        this.#unwrap(
          await this.#stage(config.timeouts, "vmBootMs", startedMono, signal, (stageSignal) =>
            this.#retryResult(config.retry.readiness, stageSignal, async (attemptSignal) => {
              const status = await this.deps.vm.inspect(cloneName as string, attemptSignal);
              return status.ok && status.value.exists && status.value.state === "running"
                ? status
                : err({
                    code: "ProviderFailure",
                    phase: "vm",
                    message: "VM has not reached running state.",
                    retryDisposition: "safe",
                  });
            }),
          ),
        );
        const guest = this.#unwrap(
          await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
            this.#retryResult(config.retry.readiness, stageSignal, (attemptSignal) =>
              this.deps.guest
                .probe(
                  cloneName as string,
                  {
                    buildIdentity: config.image.buildIdentity,
                    bundleId: config.aut.bundleId,
                    compatibility: {
                      appiumMajor: config.compatibility.appiumMajor,
                      appium: config.compatibility.appium,
                      mac2: config.compatibility.mac2,
                      wdaSha256: config.compatibility.wdaSha256,
                      guestMacOS: config.compatibility.guestMacOS,
                      xcode: config.compatibility.xcode,
                      fixtureBuild: config.compatibility.fixtureBuild,
                    },
                  },
                  attemptSignal,
                )
                .then((probe) =>
                  probe.ok && probe.value.status !== "ready"
                    ? err({
                        code: "ProviderFailure",
                        phase: "guest",
                        message: "Guest readiness has not passed.",
                        retryDisposition: "safe",
                      })
                    : probe,
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
        this.#unwrap(
          await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
            this.deps.guest.configureNetwork(cloneName as string, config.network, stageSignal),
          ),
        );
        const appium = this.#unwrap(
          await this.#stage(config.timeouts, "appiumStartMs", startedMono, signal, (stageSignal) =>
            this.#retryResult(config.retry.readiness, stageSignal, (attemptSignal) =>
              this.deps.guest.startAppium(cloneName as string, attemptSignal),
            ),
          ),
        );
        appiumStarted = true;
        this.#unwrap(
          await this.#stage(config.timeouts, "mac2SessionMs", startedMono, signal, (stageSignal) =>
            this.deps.desktop.startSession(
              {
                channelId: appium.channelId,
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
        const environmentArtifact = await this.#environmentArtifact(
          runId,
          config,
          guest.actual,
          true,
          signal,
        );
        if (environmentArtifact.ok) {
          artifacts.push(environmentArtifact.value);
          const environmentRecorded = await append("ArtifactCommitted", {
            artifactId: environmentArtifact.value.artifactId,
            type: environmentArtifact.value.type,
            sha256: environmentArtifact.value.sha256,
          });
          if (!environmentRecorded)
            throw new RunFailure({
              code: "EvidenceIncomplete",
              phase: "evidence",
              message: "Environment Evidence could not be committed.",
              retryDisposition: "notApplicable",
              dispatch: "notDispatched",
            });
        } else evidenceState.complete = false;
        if (!environmentArtifact.ok)
          throw new RunFailure({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Environment Evidence could not be committed.",
            retryDisposition: "notApplicable",
            dispatch: "notDispatched",
          });
        const observationResult = this.#unwrap(
          await this.#stage(config.timeouts, "observeMs", startedMono, signal, (stageSignal) =>
            this.#retryResult(config.retry.observation, stageSignal, (attemptSignal) =>
              this.#observe(runId, environment.generation, artifacts, attemptSignal, startedMono),
            ),
          ),
        );
        let observation = observationResult;
        const observedTimeline = this.#unwrap(await this.deps.evidence.readTimeline(runId, signal));
        sequence = observedTimeline.length;
        environment.activate(this.deps.clock.monotonicMs());
        if (
          !(await append("ReadinessEvaluated", {
            vm: "ready",
            guest: "ready",
            driver: "ready",
            app: "ready",
          }))
        )
          throw new RunFailure({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Readiness Evidence could not be committed.",
            retryDisposition: "notApplicable",
            dispatch: "notDispatched",
          });
        const transaction = new ActionTransaction(
          this.deps.desktop,
          this.deps.evidence,
          this.deps.clock,
          this.deps.ids,
          config.timeouts,
          this.deps.hooks,
          config.retry.observation,
        );
        let stopped = false;
        let executedSteps = 0;
        for (const step of scenario.actions) {
          if (stopped) break;
          try {
            environment.requireLease(environment.lease.id, this.deps.clock.monotonicMs());
            environment.requireReady(this.deps.clock.monotonicMs());
          } catch {
            stopped = true;
            verdict = "inconclusive";
            break;
          }
          {
            const windowObservation = await this.#observe(
              runId,
              environment.generation,
              artifacts,
              signal,
              startedMono,
              step.window,
            );
            if (!windowObservation.ok) {
              await append("StepProjected", { stepId: step.stepId, status: "failed" });
              executedSteps += 1;
              verdict = "inconclusive";
              stopped = true;
              break;
            }
            observation = windowObservation.value;
            const latestTimeline = await this.deps.evidence.readTimeline(runId, signal);
            if (latestTimeline.ok) sequence = latestTimeline.value.length;
          }
          const target = step.target ? this.#unique(observation, step.target) : undefined;
          if (target && !target.ok) {
            await append("StepProjected", { stepId: step.stepId, status: "failed" });
            executedSteps += 1;
            verdict = "inconclusive";
            stopped = true;
            break;
          }
          const action = this.#materialize(step.action, target?.value, observation, config);
          if (!action.ok) {
            await append("StepProjected", { stepId: step.stepId, status: "failed" });
            executedSteps += 1;
            verdict = "inconclusive";
            stopped = true;
            break;
          }
          const assertions = step.verification.policy === "immediate" ? step.verification.assertions : [];
          if (!this.#isReady(environment)) {
            stopped = true;
            break;
          }
          const tx = await transaction.execute(
            {
              runId,
              generation: environment.generation,
              sessionId: observation.sessionId,
              windowId: observation.windowId,
              expectedObservationId: observation.observationId,
              deadlineMs: startedMono + config.timeouts.runTotalMs,
              readyUntilMs: Math.min(
                environment.lease.expiresAtMs,
                ...[...environment.readiness.values()].map((probe) => probe.observedAtMs + probe.validForMs),
              ),
              ...(step.window ? { window: step.window } : {}),
              ...(step.preconditions ? { preconditions: step.preconditions } : {}),
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
            status: stopped ? "failed" : "completed",
          });
          if (tx.value.result.verification === "contradicted") verdict = "failed";
        }
        for (const step of scenario.actions.slice(executedSteps))
          await append("StepProjected", { stepId: step.stepId, status: "notRun" });
        if (!stopped) {
          const statuses = await this.#stage(
            config.timeouts,
            "assertionMs",
            startedMono,
            signal,
            (assertionSignal) =>
              this.#evaluateAssertions(scenario.finalAssertions, observation, assertionSignal),
          );
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
          verdict = statuses.some((item) => item.ok && item.value.status === "failed")
            ? "failed"
            : statuses.some((item) => !item.ok || item.value.status === "unverifiable")
              ? "inconclusive"
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
        for (const step of scenario.actions)
          if (!projectedSteps.has(step.stepId))
            await append("StepProjected", { stepId: step.stepId, status: "notRun" });
        await append("OperationFailed", {
          code: failure.code,
          phase: failure.phase,
          message: failure.message,
        });
      } finally {
        environment.beginCleanup();
        evidenceDeadline = this.deps.clock.monotonicMs() + config.timeouts.evidenceFinalizeMs;
        await append("CleanupStarted", {});
        if (cloneName && appiumStarted) {
          const diagnostics = await this.#cleanupValue(evidenceRemaining(), (cleanupSignal) =>
            this.deps.guest.exportDiagnostics(
              cloneName as string,
              {
                maxFileBytes: config.evidence.maxArtifactBytes,
                maxTotalBytes: config.evidence.maxArtifactBytes,
              },
              cleanupSignal,
            ),
          );
          if (diagnostics?.ok) {
            const artifact = await this.#cleanupValue(evidenceRemaining(), (evidenceSignal) =>
              this.deps.evidence.commitArtifact(
                {
                  runId,
                  type: "guest-diagnostics",
                  mimeType: "application/json",
                  sensitivity: "potentiallySensitive",
                  bytes: diagnostics.value,
                },
                evidenceSignal,
              ),
            );
            if (artifact?.ok) {
              artifacts.push(artifact.value);
              await append("ArtifactCommitted", {
                artifactId: artifact.value.artifactId,
                type: artifact.value.type,
                sha256: artifact.value.sha256,
              });
            } else evidenceState.complete = false;
          } else evidenceState.complete = false;
        }
        const cleanupStarted = this.deps.clock.monotonicMs();
        const cleanupRemaining = (): number =>
          Math.max(0, config.timeouts.cleanupMs - (this.deps.clock.monotonicMs() - cleanupStarted));
        if (sessionStarted) {
          const closed = await this.#cleanupAttempt(cleanupRemaining(), (cleanupSignal) =>
            this.deps.desktop.stopSession(cleanupSignal),
          );
          if (!closed) cleanupCompleted = false;
        }
        if (cloneName && appiumStarted) {
          const appiumStopped = await this.#cleanupAttempt(cleanupRemaining(), (cleanupSignal) =>
            this.deps.guest.stopAppium(cloneName as string, cleanupSignal),
          );
          cleanupCompleted = cleanupCompleted && appiumStopped;
        }
        if (cloneName) {
          const cleanupRecorded =
            (
              await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
                this.#resource(
                  runId,
                  cloneName as string,
                  config.image.digest,
                  "cleanupStarted",
                  cleanupSignal,
                ),
              )
            )?.ok === true;
          cleanupCompleted = cleanupCompleted && cleanupRecorded;
          const vmStopped = await this.#cleanupAttempt(cleanupRemaining(), (cleanupSignal) =>
            this.deps.vm.stop(cloneName as string, cleanupSignal),
          );
          cleanupCompleted = cleanupCompleted && vmStopped;
          const destroyed = await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
            this.deps.vm.destroy({ resourceId: cloneName as string, runId }, cleanupSignal),
          );
          cleanupCompleted = cleanupCompleted && destroyed?.ok === true;
          if (destroyed?.ok) {
            const completionRecorded =
              (
                await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
                  this.#resource(
                    runId,
                    cloneName as string,
                    config.image.digest,
                    "cleanupCompleted",
                    cleanupSignal,
                  ),
                )
              )?.ok === true;
            cleanupCompleted = cleanupCompleted && completionRecorded;
            if (completionRecorded) {
              const cleared = await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
                this.deps.evidence.clearManagedResource(cleanupSignal),
              );
              cleanupCompleted = cleanupCompleted && cleared?.ok === true;
            }
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
        const timeline = await this.#cleanupValue(evidenceRemaining(), (evidenceSignal) =>
          this.deps.evidence.readTimeline(runId, evidenceSignal),
        );
        if (!timeline?.ok) evidenceState.complete = false;
        result = { ...result, evidence: evidenceState.complete ? "complete" : "incomplete" };
        const timelineBytes = timeline?.ok
          ? new TextEncoder().encode(timeline.value.map((event) => JSON.stringify(event)).join("\n") + "\n")
          : new Uint8Array();
        const manifest = await this.#cleanupValue(evidenceRemaining(), (evidenceSignal) =>
          this.deps.evidence.commitManifest(
            {
              schemaVersion: 1,
              revision: 1,
              runId,
              buildVersion: this.deps.buildVersion,
              eventCount: timeline?.ok ? timeline.value.length : 0,
              timelineSha256: this.deps.hasher.sha256(timelineBytes),
              result,
              artifacts,
              ...(artifacts.find((artifact) => artifact.type === "effective-config")
                ? {
                    configArtifact: this.#artifactRef(
                      artifacts.find(
                        (artifact) => artifact.type === "effective-config",
                      ) as ArtifactDescriptor,
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
            },
            evidenceSignal,
          ),
        );
        if (!manifest?.ok) evidenceState.complete = false;
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
    } finally {
      await acquired.value();
    }
  }

  async executeInteractive<T>(
    config: GatewayConfig,
    finalAssertions: readonly AssertionSpec[],
    callback: (run: InteractiveRun) => Promise<T>,
    signal: AbortSignal,
    appEnvironment?: Readonly<Record<string, string>>,
    application?: ApplicationTarget,
  ): Promise<OperationResult<{ runId: RunId; result: RunResult; value?: T }>> {
    config = structuredClone(config);
    finalAssertions = structuredClone(finalAssertions);
    application = application ? structuredClone(application) : undefined;
    const acquired = await this.deps.lock.acquire();
    if (!acquired.ok) return acquired;
    try {
      const reconciled = await withStageSignal(
        config.timeouts.cleanupMs,
        new AbortController().signal,
        (recoverySignal) =>
          this.#reconcile(recoverySignal, {
            maxFileBytes: config.evidence.maxArtifactBytes,
            maxTotalBytes: config.evidence.maxArtifactBytes,
          }),
      ).catch(() =>
        err<{ status: "clean" }>({
          code: "RecoveryRequired",
          phase: "cleanup",
          message: "Startup reconciliation could not complete.",
          retryDisposition: "notApplicable",
        }),
      );
      if (!reconciled.ok) {
        return reconciled;
      }
      const image = await withStageSignal(
        config.timeouts.imagePullMs,
        signal,
        (imageSignal) =>
          this.#retryResult(config.retry.imagePull, imageSignal, (attemptSignal) =>
            this.deps.image.ensureImage(
              { reference: config.image.reference, digest: config.image.digest },
              attemptSignal,
            ),
          ),
        this.deps.clock,
      ).catch(() =>
        err<ProviderReceipt>({
          code: "ProviderTimeout",
          phase: "image",
          message: "Golden Image verification timed out before Run allocation.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        }),
      );
      if (!image.ok) return image;
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
      let operationSettled: Promise<void> = Promise.resolve();
      let settleOperation: (() => void) | undefined;
      const operationController = new AbortController();
      let operationSignal = AbortSignal.any([signal, operationController.signal]);
      const environment = new EnvironmentState(
        this.deps.ids.next("lease") as LeaseId,
        this.deps.clock.monotonicMs() + config.timeouts.runTotalMs,
      );
      const leaseId = environment.lease.id;
      let observation: Observation | undefined;
      const artifacts: ArtifactDescriptor[] = [];
      let evidenceDeadline: number | undefined;
      const evidenceRemaining = (): number =>
        Math.max(
          0,
          evidenceDeadline === undefined
            ? config.timeouts.evidenceFinalizeMs
            : evidenceDeadline - this.deps.clock.monotonicMs(),
        );
      const append = async (type: EvidenceEvent["type"], data: Record<string, unknown>): Promise<boolean> => {
        const nextSequence = sequence + 1;
        const result = await withStageSignal(
          evidenceRemaining(),
          new AbortController().signal,
          (evidenceSignal) =>
            this.deps.evidence.append(
              parseEvidenceEvent({
                schemaVersion: 1,
                runId,
                sequence: nextSequence,
                recordedAt: this.deps.clock.wallNow().toISOString(),
                elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
                type,
                source: "kernel",
                data,
              }),
              evidenceSignal,
            ),
          this.deps.clock,
          true,
        ).catch(() =>
          err({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Evidence append did not complete within its budget.",
            retryDisposition: "notApplicable",
          }),
        );
        if (!result.ok) evidenceState.complete = false;
        if (result.ok) sequence = nextSequence;
        if (result.ok)
          await this.#runHooks(
            parseEvidenceEvent({
              schemaVersion: 1,
              runId,
              sequence,
              recordedAt: this.deps.clock.wallNow().toISOString(),
              elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
              type,
              source: "kernel",
              data,
            }),
            artifacts,
            async (hookType, hookData) => {
              const hookSequence = sequence + 1;
              const hookEvent = parseEvidenceEvent({
                schemaVersion: 1 as const,
                runId,
                sequence: hookSequence,
                recordedAt: this.deps.clock.wallNow().toISOString(),
                elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
                type: hookType,
                source: "hook" as const,
                data: hookData,
              });
              const appended = await withStageSignal(
                evidenceRemaining(),
                new AbortController().signal,
                (evidenceSignal) => this.deps.evidence.append(hookEvent, evidenceSignal),
                this.deps.clock,
                true,
              ).catch(() => undefined);
              if (appended?.ok) sequence = hookSequence;
              else evidenceState.complete = false;
              return appended?.ok === true;
            },
            signal,
          );
        return result.ok;
      };
      await append("RunStarted", { mode: "interactive" });
      const configArtifact = await withStageSignal(
        config.timeouts.evidenceFinalizeMs,
        new AbortController().signal,
        (evidenceSignal) => this.#configArtifact(runId, config, evidenceSignal),
        this.deps.clock,
        true,
      ).catch(() =>
        err<ArtifactDescriptor>({
          code: "EvidenceIncomplete",
          phase: "evidence",
          message: "Configuration Evidence did not complete.",
          retryDisposition: "notApplicable",
        }),
      );
      if (configArtifact.ok) {
        artifacts.push(configArtifact.value);
        await append("ArtifactCommitted", {
          artifactId: configArtifact.value.artifactId,
          type: configArtifact.value.type,
          sha256: configArtifact.value.sha256,
        });
      } else evidenceState.complete = false;
      try {
        if (!evidenceState.complete)
          throw new RunFailure({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Required initial Evidence could not be committed.",
            retryDisposition: "notApplicable",
            dispatch: "notDispatched",
          });
        cloneName = runId;
        this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "clonePlanned", signal));
        const cloned = this.#unwrap(
          await this.#stage(config.timeouts, "cloneMs", startedMono, signal, (stageSignal) =>
            this.deps.vm.clone(
              {
                runId,
                image: config.image.reference,
                digest: config.image.digest,
              },
              stageSignal,
            ),
          ),
        );
        cloneName = cloned.resourceId;
        this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "cloneCreated", signal));
        await append("EnvironmentAllocated", { clone: "managed" });
        this.#unwrap(
          await this.#stage(config.timeouts, "vmBootMs", startedMono, signal, (stageSignal) =>
            this.deps.vm.start({ resourceId: cloneName as string, network: config.network }, stageSignal),
          ),
        );
        this.#unwrap(await this.#resource(runId, cloneName, config.image.digest, "started", signal));
        this.#unwrap(
          await this.#stage(config.timeouts, "vmBootMs", startedMono, signal, (stageSignal) =>
            this.#retryResult(config.retry.readiness, stageSignal, async (attemptSignal) => {
              const status = await this.deps.vm.inspect(cloneName as string, attemptSignal);
              return status.ok && status.value.exists && status.value.state === "running"
                ? status
                : err({
                    code: "ProviderFailure",
                    phase: "vm",
                    message: "VM has not reached running state.",
                    retryDisposition: "safe",
                  });
            }),
          ),
        );
        const guest = this.#unwrap(
          await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
            this.#retryResult(config.retry.readiness, stageSignal, (attemptSignal) =>
              this.deps.guest
                .probe(
                  cloneName as string,
                  {
                    buildIdentity: config.image.buildIdentity,
                    bundleId: config.aut.bundleId,
                    compatibility: {
                      appiumMajor: config.compatibility.appiumMajor,
                      appium: config.compatibility.appium,
                      mac2: config.compatibility.mac2,
                      wdaSha256: config.compatibility.wdaSha256,
                      guestMacOS: config.compatibility.guestMacOS,
                      xcode: config.compatibility.xcode,
                      fixtureBuild: config.compatibility.fixtureBuild,
                    },
                  },
                  attemptSignal,
                )
                .then((probe) =>
                  probe.ok && probe.value.status !== "ready"
                    ? err({
                        code: "ProviderFailure",
                        phase: "guest",
                        message: "Guest readiness has not passed.",
                        retryDisposition: "safe",
                      })
                    : probe,
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
        this.#unwrap(
          await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
            this.deps.guest.configureNetwork(cloneName as string, config.network, stageSignal),
          ),
        );
        let effectiveBundleId = config.aut.bundleId;
        let effectiveWindow = config.aut.window;
        if (application) {
          const resolved = this.#unwrap(
            await this.#stage(config.timeouts, "guestReadyMs", startedMono, signal, (stageSignal) =>
              this.deps.guest.resolveApplication(cloneName as string, application, stageSignal),
            ),
          );
          if (PROTECTED_APPLICATION_BUNDLE_IDS.has(resolved.bundleId))
            throw new RunFailure({
              code: "ProtectedApplication",
              phase: "guest",
              message: "The selected application is protected.",
              retryDisposition: "notApplicable",
              dispatch: "notDispatched",
            });
          effectiveBundleId = resolved.bundleId;
          effectiveWindow = { role: "window" };
        }
        const appium = this.#unwrap(
          await this.#stage(config.timeouts, "appiumStartMs", startedMono, signal, (stageSignal) =>
            this.#retryResult(config.retry.readiness, stageSignal, (attemptSignal) =>
              this.deps.guest.startAppium(cloneName as string, attemptSignal),
            ),
          ),
        );
        appiumStarted = true;
        this.#unwrap(
          await this.#stage(config.timeouts, "mac2SessionMs", startedMono, signal, (stageSignal) =>
            this.deps.desktop.startSession(
              {
                channelId: appium.channelId,
                bundleId: effectiveBundleId,
                window: effectiveWindow,
                ...(!application && config.aut.arguments ? { arguments: config.aut.arguments } : {}),
                ...(!application && appEnvironment ? { environment: appEnvironment } : {}),
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
        const environmentArtifact = await this.#environmentArtifact(
          runId,
          config,
          guest.actual,
          true,
          signal,
        );
        if (environmentArtifact.ok) {
          artifacts.push(environmentArtifact.value);
          const environmentRecorded = await append("ArtifactCommitted", {
            artifactId: environmentArtifact.value.artifactId,
            type: environmentArtifact.value.type,
            sha256: environmentArtifact.value.sha256,
          });
          if (!environmentRecorded)
            throw new RunFailure({
              code: "EvidenceIncomplete",
              phase: "evidence",
              message: "Environment Evidence could not be committed.",
              retryDisposition: "notApplicable",
              dispatch: "notDispatched",
            });
        } else evidenceState.complete = false;
        if (!environmentArtifact.ok)
          throw new RunFailure({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Environment Evidence could not be committed.",
            retryDisposition: "notApplicable",
            dispatch: "notDispatched",
          });
        observation = this.#unwrap(
          await this.#stage(config.timeouts, "observeMs", startedMono, signal, (stageSignal) =>
            this.#observe(
              runId,
              environment.generation,
              artifacts,
              stageSignal,
              startedMono,
              effectiveWindow,
            ),
          ),
        );
        sequence = this.#unwrap(await this.deps.evidence.readTimeline(runId, signal)).length;
        environment.activate(this.deps.clock.monotonicMs());
        if (
          !(await append("ReadinessEvaluated", {
            vm: "ready",
            guest: "ready",
            driver: "ready",
            app: "ready",
          }))
        )
          throw new RunFailure({
            code: "EvidenceIncomplete",
            phase: "evidence",
            message: "Readiness Evidence could not be committed.",
            retryDisposition: "notApplicable",
            dispatch: "notDispatched",
          });
        const run: InteractiveRun = {
          leaseId,
          queryPage: (query, options) => {
            if (closed)
              return err({
                code: "RunClosed",
                phase: "observe",
                message: "Run scope is closed.",
                retryDisposition: "notApplicable",
              });
            if (operationActive)
              return err({
                code: "GatewayBusy",
                phase: "observe",
                message: "Another operation is active.",
                retryDisposition: "safe",
              });
            try {
              environment.requireLease(leaseId, this.deps.clock.monotonicMs());
              if (!application) environment.requireReady(this.deps.clock.monotonicMs());
            } catch {
              return err({
                code:
                  this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                    ? "LeaseExpired"
                    : "ReadinessExpired",
                phase: "observe",
                message: "Run readiness or lease expired.",
                retryDisposition: "safe",
              });
            }
            if (!observation || !this.deps.desktop.queryPage)
              return err({
                code: "SnapshotIncomplete",
                phase: "observe",
                message: "Structured snapshot unavailable.",
                retryDisposition: "safe",
              });
            return this.deps.desktop.queryPage(
              observation,
              query,
              options?.offset ?? 0,
              options?.limit ?? 50,
            );
          },
          assert: async (assertion) => {
            if (closed)
              return err({
                code: "RunClosed",
                phase: "observe",
                message: "Run scope is closed.",
                retryDisposition: "notApplicable",
              });
            if (operationActive)
              return err({
                code: "GatewayBusy",
                phase: "observe",
                message: "Another Run operation is active.",
                retryDisposition: "safe",
              });
            try {
              environment.requireLease(leaseId, this.deps.clock.monotonicMs());
              if (!application) environment.requireReady(this.deps.clock.monotonicMs());
            } catch {
              return err({
                code:
                  this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                    ? "LeaseExpired"
                    : "ReadinessExpired",
                phase: "observe",
                message: "Run readiness or lease expired.",
                retryDisposition: "safe",
              });
            }
            const frozen = structuredClone(assertion);
            operationActive = true;
            operationSettled = new Promise<void>((resolve) => {
              settleOperation = resolve;
            });
            try {
              const captured = await this.#stage(
                config.timeouts,
                "observeMs",
                startedMono,
                operationSignal,
                (stageSignal) =>
                  this.#observe(runId, environment.generation, artifacts, stageSignal, startedMono),
              );
              if (!captured.ok) return captured;
              observation = captured.value;
              sequence = this.#unwrap(await this.deps.evidence.readTimeline(runId, operationSignal)).length;
              const evaluated = await this.#stage(
                config.timeouts,
                "assertionMs",
                startedMono,
                signal,
                (stageSignal) => this.deps.desktop.evaluate(frozen, captured.value, stageSignal),
              );
              const status = evaluated.ok ? evaluated.value.status : "unverifiable";
              const reason = evaluated.ok ? evaluated.value.reason : evaluated.error.code;
              const recorded = await append("AssertionEvaluated", {
                kind: frozen.kind,
                status,
                reason,
                observationId: captured.value.observationId,
              });
              if (!recorded)
                return err({
                  code: "EvidenceIncomplete",
                  phase: "evidence",
                  message: "Assertion Evidence could not be committed.",
                  retryDisposition: "notApplicable",
                });
              return ok(
                AssertionResultSchema.parse({
                  assertionId: this.deps.ids.next("assertion"),
                  status,
                  reason,
                  observationId: captured.value.observationId,
                  observationRef:
                    frozen.kind === "aiVisual" ? captured.value.screenshot : captured.value.uiSnapshot,
                }),
              );
            } finally {
              operationActive = false;
              settleOperation?.();
            }
          },
          assertCurrent: async (assertion) => {
            if (closed)
              return err({
                code: "RunClosed",
                phase: "observe",
                message: "Run scope is closed.",
                retryDisposition: "notApplicable",
              });
            if (operationActive)
              return err({
                code: "GatewayBusy",
                phase: "observe",
                message: "Another Run operation is active.",
                retryDisposition: "safe",
              });
            try {
              environment.requireLease(leaseId, this.deps.clock.monotonicMs());
              if (!application) environment.requireReady(this.deps.clock.monotonicMs());
            } catch {
              return err({
                code:
                  this.deps.clock.monotonicMs() > environment.lease.expiresAtMs
                    ? "LeaseExpired"
                    : "ReadinessExpired",
                phase: "observe",
                message: "Run readiness or lease expired.",
                retryDisposition: "safe",
              });
            }
            if (!observation)
              return err({
                code: "SnapshotIncomplete",
                phase: "observe",
                message: "No current Observation is available.",
                retryDisposition: "safe",
              });
            const frozen = structuredClone(assertion);
            operationActive = true;
            operationSettled = new Promise<void>((resolve) => {
              settleOperation = resolve;
            });
            try {
              const evaluated = await this.#stage(
                config.timeouts,
                "assertionMs",
                startedMono,
                operationSignal,
                (stageSignal) => this.deps.desktop.evaluate(frozen, observation as Observation, stageSignal),
              );
              const status = evaluated.ok ? evaluated.value.status : "unverifiable";
              const reason = evaluated.ok ? evaluated.value.reason : evaluated.error.code;
              const recorded = await append("AssertionEvaluated", {
                kind: frozen.kind,
                status,
                reason,
                observationId: observation.observationId,
              });
              if (!recorded)
                return err({
                  code: "EvidenceIncomplete",
                  phase: "evidence",
                  message: "Assertion Evidence could not be committed.",
                  retryDisposition: "notApplicable",
                });
              return ok(
                AssertionResultSchema.parse({
                  assertionId: this.deps.ids.next("assertion"),
                  status,
                  reason,
                  observationId: observation.observationId,
                  observationRef:
                    frozen.kind === "aiVisual" ? observation.screenshot : observation.uiSnapshot,
                }),
              );
            } finally {
              operationActive = false;
              settleOperation?.();
            }
          },
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
              if (!application) environment.requireReady(this.deps.clock.monotonicMs());
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
            operationSettled = new Promise<void>((resolve) => {
              settleOperation = resolve;
            });
            let observed: OperationResult<Observation>;
            try {
              observed = await this.#stage(
                config.timeouts,
                "observeMs",
                startedMono,
                operationSignal,
                (stageSignal) =>
                  this.#retryResult(config.retry.observation, stageSignal, (attemptSignal) =>
                    this.#observe(runId, environment.generation, artifacts, attemptSignal, startedMono),
                  ),
              );
              if (observed.ok) {
                observation = observed.value;
                const timeline = await this.deps.evidence.readTimeline(runId, operationSignal);
                if (timeline.ok) sequence = timeline.value.length;
              }
              return observed;
            } finally {
              operationActive = false;
              settleOperation?.();
            }
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
                  : !application && !this.#isReady(environment)
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
                  : !application && !this.#isReady(environment)
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
                  : !application && !this.#isReady(environment)
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
              if (!application) environment.requireReady(this.deps.clock.monotonicMs());
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
            operationSettled = new Promise<void>((resolve) => {
              settleOperation = resolve;
            });
            const transaction = new ActionTransaction(
              this.deps.desktop,
              this.deps.evidence,
              this.deps.clock,
              this.deps.ids,
              config.timeouts,
              this.deps.hooks,
              config.retry.observation,
            );
            if (action.kind === "typeText" && "secret" in action.value) {
              const materialized = this.#materialize(
                { kind: action.kind, value: action.value },
                undefined,
                observation,
                config,
              );
              if (!materialized.ok) {
                operationActive = false;
                settleOperation?.();
                return materialized;
              }
              action = materialized.value;
            }
            let result: OperationResult<TransactionOutput>;
            try {
              result = await transaction.execute(
                {
                  runId,
                  generation: environment.generation,
                  sessionId: observation.sessionId,
                  windowId: observation.windowId,
                  expectedObservationId: observation.observationId,
                  deadlineMs: startedMono + config.timeouts.runTotalMs,
                  readyUntilMs: application
                    ? environment.lease.expiresAtMs
                    : Math.min(
                        environment.lease.expiresAtMs,
                        ...[...environment.readiness.values()].map(
                          (probe) => probe.observedAtMs + probe.validForMs,
                        ),
                      ),
                  sequence,
                  startedMono,
                },
                action,
                assertions,
                operationSignal,
              );
              if (result.ok) {
                sequence = result.value.sequence;
                if (result.value.evidenceComplete === false) evidenceState.complete = false;
                observation = result.value.after;
                if (result.value.artifacts) artifacts.push(...result.value.artifacts);
              }
              return result;
            } finally {
              operationActive = false;
              settleOperation?.();
            }
          },
        };
        try {
          value = await withStageSignal(
            Math.max(1, config.timeouts.runTotalMs - (this.deps.clock.monotonicMs() - startedMono)),
            signal,
            (callbackSignal) => {
              operationSignal = AbortSignal.any([signal, operationController.signal, callbackSignal]);
              return callback(run);
            },
          );
        } finally {
          closed = true;
          operationController.abort(new Error("Run scope closed."));
          await operationSettled;
        }
        environment.beginCleanup();
        if (
          ((current: Observation | undefined) => current === undefined)(observation) ||
          finalAssertions.length === 0
        )
          verdict = "inconclusive";
        else {
          const statuses = await this.#stage(
            config.timeouts,
            "assertionMs",
            startedMono,
            signal,
            (assertionSignal) =>
              this.#evaluateAssertions(finalAssertions, observation as Observation, assertionSignal),
          );
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
          verdict = statuses.some((item) => item.ok && item.value.status === "failed")
            ? "failed"
            : statuses.some((item) => !item.ok || item.value.status === "unverifiable")
              ? "inconclusive"
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
        await append("OperationFailed", {
          code: failure.code,
          phase: failure.phase,
          message: failure.message,
        });
        verdict = "inconclusive";
      } finally {
        closed = true;
        environment.beginCleanup();
        evidenceDeadline = this.deps.clock.monotonicMs() + config.timeouts.evidenceFinalizeMs;
        await append("CleanupStarted", {});
        if (cloneName && appiumStarted) {
          const diagnostics = await this.#cleanupValue(evidenceRemaining(), (cleanupSignal) =>
            this.deps.guest.exportDiagnostics(
              cloneName as string,
              {
                maxFileBytes: config.evidence.maxArtifactBytes,
                maxTotalBytes: config.evidence.maxArtifactBytes,
              },
              cleanupSignal,
            ),
          );
          if (diagnostics?.ok) {
            const artifact = await this.#cleanupValue(evidenceRemaining(), (evidenceSignal) =>
              this.deps.evidence.commitArtifact(
                {
                  runId,
                  type: "guest-diagnostics",
                  mimeType: "application/json",
                  sensitivity: "potentiallySensitive",
                  bytes: diagnostics.value,
                },
                evidenceSignal,
              ),
            );
            if (artifact?.ok) {
              artifacts.push(artifact.value);
              await append("ArtifactCommitted", {
                artifactId: artifact.value.artifactId,
                type: artifact.value.type,
                sha256: artifact.value.sha256,
              });
            } else evidenceState.complete = false;
          } else evidenceState.complete = false;
        }
        const cleanupStarted = this.deps.clock.monotonicMs();
        const cleanupRemaining = (): number =>
          Math.max(0, config.timeouts.cleanupMs - (this.deps.clock.monotonicMs() - cleanupStarted));
        if (sessionStarted) {
          const closed = await this.#cleanupAttempt(cleanupRemaining(), (cleanupSignal) =>
            this.deps.desktop.stopSession(cleanupSignal),
          );
          if (!closed) cleanupCompleted = false;
        }
        if (cloneName && appiumStarted) {
          const appiumStopped = await this.#cleanupAttempt(cleanupRemaining(), (cleanupSignal) =>
            this.deps.guest.stopAppium(cloneName as string, cleanupSignal),
          );
          cleanupCompleted = cleanupCompleted && appiumStopped;
        }
        if (cloneName) {
          const cleanupRecorded =
            (
              await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
                this.#resource(
                  runId,
                  cloneName as string,
                  config.image.digest,
                  "cleanupStarted",
                  cleanupSignal,
                ),
              )
            )?.ok === true;
          cleanupCompleted = cleanupCompleted && cleanupRecorded;
          const vmStopped = await this.#cleanupAttempt(cleanupRemaining(), (cleanupSignal) =>
            this.deps.vm.stop(cloneName as string, cleanupSignal),
          );
          cleanupCompleted = cleanupCompleted && vmStopped;
          const destroyed = await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
            this.deps.vm.destroy({ resourceId: cloneName as string, runId }, cleanupSignal),
          );
          cleanupCompleted = cleanupCompleted && destroyed?.ok === true;
          if (destroyed?.ok) {
            const completionRecorded =
              (
                await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
                  this.#resource(
                    runId,
                    cloneName as string,
                    config.image.digest,
                    "cleanupCompleted",
                    cleanupSignal,
                  ),
                )
              )?.ok === true;
            cleanupCompleted = cleanupCompleted && completionRecorded;
            if (completionRecorded) {
              const cleared = await this.#cleanupValue(cleanupRemaining(), (cleanupSignal) =>
                this.deps.evidence.clearManagedResource(cleanupSignal),
              );
              cleanupCompleted = cleanupCompleted && cleared?.ok === true;
            }
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
        const timeline = await this.#cleanupValue(evidenceRemaining(), (evidenceSignal) =>
          this.deps.evidence.readTimeline(runId, evidenceSignal),
        );
        if (!timeline?.ok) evidenceState.complete = false;
        result = { ...result, evidence: evidenceState.complete ? "complete" : "incomplete" };
        const bytes = timeline?.ok
          ? new TextEncoder().encode(timeline.value.map((event) => JSON.stringify(event)).join("\n") + "\n")
          : new Uint8Array();
        const manifest = await this.#cleanupValue(evidenceRemaining(), (evidenceSignal) =>
          this.deps.evidence.commitManifest(
            {
              schemaVersion: 1,
              revision: 1,
              runId,
              buildVersion: this.deps.buildVersion,
              eventCount: timeline?.ok ? timeline.value.length : 0,
              timelineSha256: this.deps.hasher.sha256(bytes),
              result,
              artifacts,
              ...(artifacts.find((artifact) => artifact.type === "effective-config")
                ? {
                    configArtifact: this.#artifactRef(
                      artifacts.find(
                        (artifact) => artifact.type === "effective-config",
                      ) as ArtifactDescriptor,
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
            },
            evidenceSignal,
          ),
        );
        if (!manifest?.ok) evidenceState.complete = false;
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
    } finally {
      await acquired.value();
    }
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
        const contributions = HookContributionsSchema.parse(
          await withStageSignal(
            5_000,
            signal,
            (hookSignal) => hook.deliver(structuredClone(event), hookSignal),
            this.deps.clock,
          ),
        );
        for (const contribution of contributions) {
          if (
            !/^[A-Za-z0-9._-]{1,40}$/.test(contribution.type) ||
            !(contribution.bytes instanceof Uint8Array)
          )
            throw new Error("Invalid Hook contribution");
          const artifact = await withStageSignal(
            5_000,
            signal,
            (evidenceSignal) =>
              this.deps.evidence.commitArtifact(
                {
                  runId: event.runId,
                  type: `hook-${hook.name}-${contribution.type}`,
                  mimeType: "application/octet-stream",
                  sensitivity: "potentiallySensitive",
                  bytes: contribution.bytes,
                },
                evidenceSignal,
              ),
            this.deps.clock,
            true,
          );
          if (artifact.ok) {
            artifacts.push(artifact.value);
            await appendHookEvent("ArtifactCommitted", {
              artifactId: artifact.value.artifactId,
              type: artifact.value.type,
              sha256: artifact.value.sha256,
            });
          } else throw new Error("Hook artifact could not be committed");
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
    const remaining = timeouts.runTotalMs - (this.deps.clock.monotonicMs() - startedMono);
    if (remaining <= 0) return Promise.reject(new StageTimeoutError(timeouts.runTotalMs));
    return withStageSignal(Math.min(timeouts[key], remaining), signal, operation, this.deps.clock);
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
      this.deps.clock,
    );
  }

  async #cleanupValue<T>(
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (timeoutMs <= 0) return undefined;
    try {
      return await withStageSignal(timeoutMs, new AbortController().signal, operation, this.deps.clock);
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

  async recover(
    signal: AbortSignal,
    cleanupMs = 120_000,
    diagnosticLimits = { maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 },
  ): Promise<OperationResult<{ status: "clean" }>> {
    const acquired = await this.deps.lock.acquire();
    if (!acquired.ok) return acquired;
    try {
      if (signal.aborted)
        return err({
          code: "Cancelled",
          phase: "cleanup",
          message: "Recovery was cancelled before reconciliation.",
          retryDisposition: "safe",
        });
      return await withStageSignal(
        cleanupMs,
        new AbortController().signal,
        (recoverySignal) => this.#reconcile(recoverySignal, diagnosticLimits),
        this.deps.clock,
      ).catch(() =>
        err<{ status: "clean" }>({
          code: "RecoveryRequired",
          phase: "cleanup",
          message: "Recovery did not complete within its reserved budget.",
          retryDisposition: "notApplicable",
        }),
      );
    } finally {
      await acquired.value();
    }
  }

  async #reconcile(
    signal: AbortSignal,
    diagnosticLimits = { maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 },
  ): Promise<OperationResult<{ status: "clean" }>> {
    const recoveryStartedMono = this.deps.clock.monotonicMs();
    const projections = await this.deps.evidence.reconcileProjections(signal);
    if (!projections.ok) return projections;
    const record = await this.deps.evidence.readManagedResource(signal);
    const managed = await this.deps.vm.listManaged(signal);
    if (!record.ok || !managed.ok)
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed resource state could not be reconciled.",
        retryDisposition: "notApplicable",
      });
    if (record.value === null && managed.value.length === 0) {
      const unfinished = await this.deps.evidence.listUnfinishedRuns(signal);
      if (!unfinished.ok) return unfinished;
      let damagedRun = false;
      for (const runId of unfinished.value) {
        const timeline = await this.deps.evidence.readTimeline(runId, signal);
        if (!timeline.ok) {
          damagedRun = true;
          const recorded = await this.deps.evidence.recordDamagedRun(
            runId,
            this.deps.buildVersion,
            "completed",
            signal,
          );
          if (!recorded.ok) return recorded;
          continue;
        }
        const prior = [...timeline.value].reverse().find((event) => event.type === "RunFinished");
        const priorResult = prior ? RunResultSchema.safeParse(prior.data) : undefined;
        const result: RunResult = {
          verdict: priorResult?.success ? priorResult.data.verdict : "inconclusive",
          evidence: "incomplete",
          cleanup: "completed",
        };
        const finished = await this.deps.evidence.append(
          {
            schemaVersion: 1,
            runId,
            sequence: timeline.value.length + 1,
            recordedAt: this.deps.clock.wallNow().toISOString(),
            elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - recoveryStartedMono),
            type: "RunFinished",
            source: "kernel",
            data: result,
          },
          signal,
        );
        if (!finished.ok) return finished;
        const manifest = await this.deps.evidence.commitRecoveryManifest(
          runId,
          this.deps.buildVersion,
          result,
          [],
          signal,
        );
        if (!manifest.ok) return manifest;
      }
      if (damagedRun)
        return err({
          code: "RecoveryRequired",
          phase: "evidence",
          message: "One or more damaged Runs require manual Evidence preservation.",
          retryDisposition: "notApplicable",
        });
      return ok({ status: "clean" });
    }
    if (record.value === null || managed.value.length > 1)
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed resource attribution is ambiguous.",
        retryDisposition: "notApplicable",
      });
    const clonePresent = managed.value.length === 1 && managed.value[0] === record.value.resourceId;
    if (managed.value.length === 1 && !clonePresent)
      return err({
        code: "RecoveryRequired",
        phase: "vm",
        message: "Managed clone does not match its ownership record.",
        retryDisposition: "notApplicable",
      });
    const timeline = await this.deps.evidence.readTimeline(record.value.runId, signal);
    const orphans = await this.deps.evidence.recoverOrphans(record.value.runId, signal);
    const recoveryStarted = timeline.ok
      ? await this.deps.evidence.append(
          {
            schemaVersion: 1,
            runId: record.value.runId,
            sequence: timeline.value.length + 1,
            recordedAt: this.deps.clock.wallNow().toISOString(),
            elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - recoveryStartedMono),
            type: "RunRecoveryStarted",
            source: "kernel",
            data: { resourceId: record.value.resourceId },
          },
          signal,
        )
      : timeline;
    const vmStatus = clonePresent
      ? await this.deps.vm.inspect(record.value.resourceId, signal)
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
      ? await this.deps.guest.exportDiagnostics(record.value.resourceId, diagnosticLimits, signal)
      : err<Uint8Array>({
          code: "EvidenceIncomplete",
          phase: "evidence",
          message: "Guest is not running.",
          retryDisposition: "notApplicable",
        });
    const recoveryArtifacts: ArtifactDescriptor[] = [];
    if (diagnostics.ok) {
      const diagnosticArtifact = await this.deps.evidence.commitArtifact(
        {
          runId: record.value.runId,
          type: "guest-diagnostics",
          mimeType: "application/json",
          sensitivity: "potentiallySensitive",
          bytes: diagnostics.value,
        },
        signal,
      );
      if (diagnosticArtifact.ok) recoveryArtifacts.push(diagnosticArtifact.value);
    }
    const appiumStopped = isRunning
      ? await this.deps.guest.stopAppium(record.value.resourceId, signal)
      : sessionClosed;
    const stopped = isRunning ? await this.deps.vm.stop(record.value.resourceId, signal) : sessionClosed;
    const destroyed = clonePresent
      ? await this.deps.vm.destroy({ resourceId: record.value.resourceId, runId: record.value.runId }, signal)
      : sessionClosed;
    if (!sessionClosed.ok || !appiumStopped.ok || !stopped.ok || !destroyed.ok)
      return err({
        code: "RecoveryRequired",
        phase: "cleanup",
        message: "Managed clone cleanup did not complete.",
        retryDisposition: "notApplicable",
      });
    if (!timeline.ok || !orphans.ok || !recoveryStarted.ok) {
      const cleared = await this.deps.evidence.clearManagedResource(signal);
      if (!cleared.ok) return cleared;
      if (!timeline.ok) {
        const recorded = await this.deps.evidence.recordDamagedRun(
          record.value.runId,
          this.deps.buildVersion,
          "completed",
          signal,
        );
        if (!recorded.ok) return recorded;
      }
      return err({
        code: "RecoveryRequired",
        phase: "evidence",
        message: "Managed resources were cleaned, but damaged Run Evidence could not be finalized.",
        retryDisposition: "notApplicable",
      });
    }
    const recoveryFinished = await this.deps.evidence.append(
      {
        schemaVersion: 1,
        runId: record.value.runId,
        sequence: timeline.value.length + 2,
        recordedAt: this.deps.clock.wallNow().toISOString(),
        elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - recoveryStartedMono),
        type: "RunRecoveryFinished",
        source: "kernel",
        data: { status: "completed" },
      },
      signal,
    );
    if (!recoveryFinished.ok) return recoveryFinished;
    const recoveredRunId = record.value.runId;
    const recoveredEvent = parseEvidenceEvent({
      schemaVersion: 1,
      runId: recoveredRunId,
      sequence: timeline.value.length + 2,
      recordedAt: this.deps.clock.wallNow().toISOString(),
      elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - recoveryStartedMono),
      type: "RunRecoveryFinished",
      source: "kernel",
      data: { status: "completed" },
    });
    const hookResult = await deliverHooks({
      event: recoveredEvent,
      hooks: this.deps.hooks ?? [],
      evidence: this.deps.evidence,
      artifacts: recoveryArtifacts,
      sequence: timeline.value.length + 2,
      startedMono: recoveryStartedMono,
      clock: this.deps.clock,
      signal,
    });
    if (!hookResult.ok) return hookResult;
    const priorFinished = [...timeline.value].reverse().find((event) => event.type === "RunFinished");
    const priorResult = priorFinished ? RunResultSchema.safeParse(priorFinished.data) : undefined;
    const recoveryResult = {
      verdict: priorResult?.success ? priorResult.data.verdict : ("inconclusive" as const),
      evidence: "incomplete" as const,
      cleanup: "completed" as const,
    };
    const resultRecorded = await this.deps.evidence.append(
      {
        schemaVersion: 1,
        runId: record.value.runId,
        sequence: hookResult.value + 1,
        recordedAt: this.deps.clock.wallNow().toISOString(),
        elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - recoveryStartedMono),
        type: "RunFinished",
        source: "kernel",
        data: recoveryResult,
      },
      signal,
    );
    if (!resultRecorded.ok) return resultRecorded;
    const manifest = await this.deps.evidence.commitRecoveryManifest(
      record.value.runId,
      this.deps.buildVersion,
      recoveryResult,
      recoveryArtifacts,
      signal,
    );
    if (!manifest.ok) return manifest;
    const cleared = await this.deps.evidence.clearManagedResource(signal);
    if (!cleared.ok) return cleared;
    return ok({ status: "clean" });
  }

  #resource(
    runId: RunId,
    cloneName: string,
    imageDigest: string,
    phase: ManagedResourceRecord["phase"],
    signal?: AbortSignal,
  ): Promise<OperationResult<void>> {
    return this.deps.evidence.writeManagedResource(
      {
        schemaVersion: 1,
        runId,
        resourceId: cloneName,
        imageDigest,
        phase,
      },
      signal,
    );
  }

  #configArtifact(
    runId: RunId,
    config: GatewayConfig,
    signal?: AbortSignal,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    const sanitized = ConfigSnapshotSchema.parse({
      schemaVersion: 2,
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
    });
    return this.deps.evidence.commitArtifact(
      {
        runId,
        type: "effective-config",
        mimeType: "application/json",
        sensitivity: "normal",
        bytes: new TextEncoder().encode(JSON.stringify(sanitized)),
      },
      signal,
    );
  }

  #environmentArtifact(
    runId: RunId,
    config: GatewayConfig,
    actual: NonNullable<
      Awaited<ReturnType<GuestPort["probe"]>> extends OperationResult<infer T> ? T : never
    >["actual"],
    automationPermissionReady: boolean,
    signal?: AbortSignal,
  ): Promise<OperationResult<ArtifactDescriptor>> {
    return this.deps.evidence.commitArtifact(
      {
        runId,
        type: "environment",
        mimeType: "application/json",
        sensitivity: "normal",
        bytes: new TextEncoder().encode(
          JSON.stringify(
            EnvironmentSnapshotSchema.parse({
              schemaVersion: 2,
              buildIdentity: config.image.buildIdentity,
              imageDigest: config.image.digest,
              compatibility: config.compatibility,
              bundleId: config.aut.bundleId,
              actual: actual ? { ...actual, automationPermissionReady } : undefined,
            }),
          ),
        ),
      },
      signal,
    );
  }

  #artifactRef(artifact: ArtifactDescriptor): ArtifactRef {
    return { artifactId: artifact.artifactId, sha256: artifact.sha256 };
  }

  async #observe(
    runId: RunId,
    generation: number,
    artifacts: ArtifactDescriptor[],
    signal: AbortSignal,
    startedMono: number,
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
    if (!observed.value.screenshot)
      return observed.value.screenshotError
        ? err(observed.value.screenshotError)
        : err({
            code: "EvidenceIncomplete",
            phase: "observe",
            message: "Required Observation screenshot is unavailable.",
            retryDisposition: "notApplicable",
          });
    const observedScreenshot = observed.value.screenshot;
    const persisted = async <T>(operation: (stageSignal: AbortSignal) => Promise<T>): Promise<T> =>
      withStageSignal(30_000, signal, operation, this.deps.clock, true);
    const screenshot = await persisted((evidenceSignal) =>
      this.deps.evidence.commitArtifact(
        {
          runId,
          type:
            observed.value.observation.screenshotScope === "display"
              ? "display-screenshot"
              : "window-screenshot",
          mimeType: "image/png",
          sensitivity: "potentiallySensitive",
          bytes: observedScreenshot,
        },
        evidenceSignal,
      ),
    );
    if (!screenshot.ok) return screenshot;
    artifacts.push(screenshot.value);
    const snapshot = await persisted((evidenceSignal) =>
      this.deps.evidence.commitArtifact(
        {
          runId,
          type: "ui-snapshot",
          mimeType: "application/json",
          sensitivity: "potentiallySensitive",
          bytes: observed.value.snapshot,
        },
        evidenceSignal,
      ),
    );
    if (!snapshot.ok) return snapshot;
    artifacts.push(snapshot.value);
    const timeline = await persisted((evidenceSignal) =>
      this.deps.evidence.readTimeline(runId, evidenceSignal),
    );
    if (!timeline.ok) return timeline;
    for (const [index, artifact] of [screenshot.value, snapshot.value].entries()) {
      const committed = await persisted((evidenceSignal) =>
        this.deps.evidence.append(
          {
            schemaVersion: 1,
            runId,
            sequence: timeline.value.length + index + 1,
            recordedAt: this.deps.clock.wallNow().toISOString(),
            elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
            type: "ArtifactCommitted",
            source: "kernel",
            data: { artifactId: artifact.artifactId, type: artifact.type, sha256: artifact.sha256 },
          },
          evidenceSignal,
        ),
      );
      if (!committed.ok) return committed;
    }
    const event = await persisted((evidenceSignal) =>
      this.deps.evidence.append(
        {
          schemaVersion: 1,
          runId,
          sequence: timeline.value.length + 3,
          recordedAt: this.deps.clock.wallNow().toISOString(),
          elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
          type: "ObservationCaptured",
          source: "kernel",
          data: { observationId, screenshotScope: observed.value.observation.screenshotScope },
        },
        evidenceSignal,
      ),
    );
    if (!event.ok) return event;
    const capturedEvent = parseEvidenceEvent({
      schemaVersion: 1,
      runId,
      sequence: timeline.value.length + 3,
      recordedAt: this.deps.clock.wallNow().toISOString(),
      elapsedMs: Math.max(0, this.deps.clock.monotonicMs() - startedMono),
      type: "ObservationCaptured",
      source: "kernel",
      data: { observationId, screenshotScope: observed.value.observation.screenshotScope },
    });
    const hookResult = await deliverHooks({
      event: capturedEvent,
      hooks: this.deps.hooks ?? [],
      evidence: this.deps.evidence,
      artifacts,
      sequence: timeline.value.length + 3,
      startedMono,
      clock: this.deps.clock,
      signal,
    });
    if (!hookResult.ok) return hookResult;
    return ok({
      ...observed.value.observation,
      screenshot: { artifactId: screenshot.value.artifactId, sha256: screenshot.value.sha256 },
      uiSnapshot: { artifactId: snapshot.value.artifactId, sha256: snapshot.value.sha256 },
    });
  }

  #unique(observation: Observation, query: ElementQuery): OperationResult<ElementRef> {
    return this.deps.desktop.query(observation, query);
  }
  #materialize(
    template: Scenario["actions"][number]["action"],
    target: ElementRef | undefined,
    observation: Observation,
    config: GatewayConfig,
  ): OperationResult<DesktopAction> {
    if (template.kind === "drag") {
      if (!target)
        return err({
          code: "TargetNotFound",
          phase: "action",
          message: "Drag requires a unique source target.",
          retryDisposition: "safe",
          dispatch: "notDispatched",
        });
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
    if (template.kind === "typeText") {
      if ("literal" in template.value) return ok({ kind: "typeText", value: template.value });
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
      return ok({ kind: "typeText", value: { literal: value } });
    }
    if (template.kind === "pressKey")
      return ok({
        kind: "pressKey",
        key: template.key,
        ...(template.modifiers ? { modifiers: template.modifiers } : {}),
      });
    if (!target)
      return err({
        code: "TargetNotFound",
        phase: "action",
        message: "Element-targeted action requires a unique target.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
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
