import {
  err,
  ok,
  parseEvidenceEvent,
  type ActionResult,
  type ActionId,
  type ArtifactRef,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type EvidenceEvent,
  type ArtifactDescriptor,
  type EvidencePort,
  type Observation,
  type ObservationId,
  type OperationError,
  type OperationId,
  type OperationResult,
  type ProviderReceipt,
  type RunId,
  type SessionId,
  type WindowId,
  type WindowQuery,
  type EventHook,
} from "../contracts/index.js";
import type { Clock, IdGenerator } from "./runtime.js";
import { retrySafe, StageTimeoutError, withStageSignal } from "./timeout.js";
import { deliverHooks } from "./hook-pipeline.js";

export type TransactionContext = {
  runId: RunId;
  generation: number;
  sessionId: SessionId;
  windowId: WindowId;
  expectedObservationId: string;
  beforeObservation: Observation;
  sequence: number;
  startedMono: number;
  window?: WindowQuery;
  preconditions?: readonly AssertionSpec[];
  deadlineMs?: number;
  readyUntilMs?: number;
};
export type TransactionOutput = {
  result: ActionResult;
  sequence: number;
  after?: Observation;
  artifacts?: ArtifactDescriptor[];
  evidenceComplete?: boolean;
  failure?: OperationError;
};

export class ActionTransaction {
  #hookArtifacts: ArtifactDescriptor[] = [];

  #output(output: TransactionOutput): OperationResult<TransactionOutput> {
    const existing = output.artifacts ?? [];
    return ok({
      ...output,
      ...(existing.length > 0 || this.#hookArtifacts.length > 0
        ? {
            artifacts: [
              ...existing,
              ...this.#hookArtifacts.filter(
                (hookArtifact) =>
                  !existing.some((artifact) => artifact.artifactId === hookArtifact.artifactId),
              ),
            ],
          }
        : {}),
    });
  }
  constructor(
    private readonly desktop: DesktopPort,
    private readonly evidence: EvidencePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly timeouts: { actionMs: number; observeMs: number; assertionMs: number },
    private readonly hooks: readonly EventHook[] = [],
    private readonly observationRetry: { maxAttempts: number; backoffMs: number } = {
      maxAttempts: 1,
      backoffMs: 0,
    },
  ) {}

  async execute(
    context: TransactionContext,
    action: DesktopAction,
    assertions: readonly AssertionSpec[],
    signal: AbortSignal,
  ): Promise<OperationResult<TransactionOutput>> {
    this.#hookArtifacts = [];
    if (signal.aborted)
      return err({
        code: "Cancelled",
        phase: "action",
        message: "Action was cancelled before dispatch.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    if (!this.#usesLatestObservation(action, context.expectedObservationId))
      return err({
        code: "StaleElementRef",
        phase: "action",
        message: "Action target is not from the latest observation.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    action = structuredClone(action);
    assertions = structuredClone(assertions);
    context = structuredClone(context);
    const budget = (stageMs: number): number => {
      if (context.deadlineMs === undefined) return stageMs;
      const remaining = context.deadlineMs - this.clock.monotonicMs();
      if (remaining <= 0) throw new StageTimeoutError(0);
      return Math.min(stageMs, remaining);
    };
    const persist = <T>(operation: (evidenceSignal: AbortSignal) => Promise<T>): Promise<T> =>
      withStageSignal(budget(this.timeouts.observeMs), signal, operation, this.clock, true);
    const preflight = await persist((evidenceSignal) =>
      this.evidence.preflight(context.runId, evidenceSignal),
    );
    if (!preflight.ok) return preflight;
    const operationId = this.ids.next("operation") as OperationId;
    const actionId = this.ids.next("action") as ActionId;
    let sequence = context.sequence;
    const beforeObservation = context.beforeObservation;
    if (beforeObservation.observationId !== context.expectedObservationId)
      return err({
        code: "StaleElementRef",
        phase: "action",
        message: "Committed before-Observation is stale.",
        retryDisposition: "safe",
        dispatch: "notDispatched",
      });
    let transactionEvidenceComplete = beforeObservation.screenshotScope !== "unavailable";
    const retainedArtifacts: ArtifactDescriptor[] = [];
    for (const assertion of context.preconditions ?? []) {
      const evaluated = await withStageSignal(
        budget(this.timeouts.assertionMs),
        signal,
        (stageSignal) => this.desktop.evaluate(assertion, beforeObservation, stageSignal),
        this.clock,
      ).catch(() =>
        err({
          code: "ProviderTimeout",
          phase: "observe",
          message: "Precondition could not be evaluated.",
          retryDisposition: "notApplicable",
        }),
      );
      const status = evaluated.ok ? evaluated.value.status : "unverifiable";
      const committed = await this.#append(
        context,
        sequence + 1,
        "AssertionEvaluated",
        {
          kind: assertion.kind,
          status,
          reason: evaluated.ok ? evaluated.value.reason : evaluated.error.code,
          observationId: beforeObservation.observationId,
        },
        signal,
      );
      if (committed.ok) sequence = committed.value;
      if (!committed.ok || status !== "passed")
        return this.#output({
          result: {
            dispatch: "notDispatched",
            providerOutcome: "unknown",
            verification: "unverifiable",
            retryDisposition: "safe",
          },
          sequence,
          artifacts: retainedArtifacts,
          evidenceComplete: committed.ok,
        });
    }
    const rebound = this.desktop.rebind(action, beforeObservation);
    if (!rebound.ok)
      return this.#output({
        result: {
          dispatch: "notDispatched",
          providerOutcome: "unknown",
          verification: "unverifiable",
          retryDisposition: "safe",
        },
        sequence,
        artifacts: retainedArtifacts,
      });
    const planned = await this.#append(
      context,
      sequence + 1,
      "ActionPlanned",
      { actionId, operationId, kind: action.kind },
      signal,
    );
    if (planned.ok) sequence = planned.value;
    if (!planned.ok)
      return this.#output({
        result: {
          dispatch: "notDispatched",
          providerOutcome: "unknown",
          verification: "unverifiable",
          retryDisposition: "safe",
        },
        sequence: sequence - 1,
        artifacts: retainedArtifacts,
        evidenceComplete: false,
      });
    const finish = async (
      result: ActionResult,
      extra: Omit<TransactionOutput, "result" | "sequence"> = {},
    ): Promise<OperationResult<TransactionOutput>> => {
      const resultRecorded = await this.#append(
        context,
        sequence + 1,
        "ActionResultRecorded",
        {
          actionId,
          operationId,
          result,
        },
        signal,
      );
      if (resultRecorded.ok) sequence = resultRecorded.value;
      return this.#output({
        result,
        sequence,
        ...extra,
        ...(extra.artifacts || this.#hookArtifacts.length > 0
          ? {
              artifacts: [
                ...(extra.artifacts ?? []),
                ...this.#hookArtifacts.filter(
                  (hookArtifact) =>
                    !(extra.artifacts ?? []).some(
                      (artifact) => artifact.artifactId === hookArtifact.artifactId,
                    ),
                ),
              ],
            }
          : {}),
        ...(!resultRecorded.ok || extra.evidenceComplete === false || !transactionEvidenceComplete
          ? { evidenceComplete: false }
          : {}),
      });
    };
    if (
      ((current: AbortSignal) => current.aborted)(signal) ||
      this.clock.monotonicMs() > Math.min(context.readyUntilMs ?? Infinity, context.deadlineMs ?? Infinity)
    )
      return finish(
        {
          dispatch: "notDispatched",
          providerOutcome: "unknown",
          verification: "unverifiable",
          retryDisposition: "safe",
        },
        { artifacts: retainedArtifacts },
      );
    const receipt = await withStageSignal(
      budget(this.timeouts.actionMs),
      signal,
      (stageSignal) => this.desktop.dispatch(rebound.value, operationId, stageSignal),
      this.clock,
    ).catch(() =>
      err<ProviderReceipt>({
        code: "ProviderTimeout",
        phase: "action",
        message: "Action did not return a reliable receipt.",
        retryDisposition: "reconcileRequired",
        dispatch: "unknown",
      }),
    );
    if (!receipt.ok) {
      let failureEvidenceComplete = true;
      const afterAttempt = await withStageSignal(
        budget(this.timeouts.observeMs),
        signal,
        (stageSignal) =>
          this.desktop.observe(
            {
              runId: context.runId,
              generation: context.generation,
              observationId: this.ids.next("observation") as ObservationId,
              sessionId: context.sessionId,
              windowId: context.windowId,
              ...(context.window ? { window: context.window } : {}),
            },
            stageSignal,
          ),
        this.clock,
      ).catch(() => undefined);
      let after: Observation | undefined;
      if (afterAttempt?.ok) {
        const afterProgress = { sequence, artifacts: [] as ArtifactDescriptor[] };
        const committedAfter = await this.#commitObservation(
          context,
          afterAttempt.value,
          sequence,
          afterProgress,
          signal,
        );
        if (committedAfter.ok) {
          sequence = committedAfter.value.sequence;
          after = committedAfter.value.observation;
          retainedArtifacts.push(...committedAfter.value.artifacts);
        } else {
          failureEvidenceComplete = false;
          sequence = afterProgress.sequence;
          retainedArtifacts.push(...afterProgress.artifacts);
        }
      } else failureEvidenceComplete = false;
      const failureRecorded = await this.#append(
        context,
        sequence + 1,
        "OperationFailed",
        {
          code: receipt.error.code,
          phase: receipt.error.phase,
          message: receipt.error.message,
        },
        signal,
      );
      if (failureRecorded.ok) sequence = failureRecorded.value;
      else failureEvidenceComplete = false;
      const disposition =
        receipt.error.dispatch === "notDispatched"
          ? "safe"
          : receipt.error.dispatch === "dispatched"
            ? receipt.error.retryDisposition === "reconcileRequired"
              ? "reconcileRequired"
              : "unsafe"
            : "reconcileRequired";
      return finish(
        {
          dispatch: receipt.error.dispatch ?? "unknown",
          providerOutcome: "unknown",
          verification: "unverifiable",
          retryDisposition: disposition,
        },
        {
          artifacts: retainedArtifacts,
          ...(after ? { after } : {}),
          failure: receipt.error,
          ...(!failureEvidenceComplete ? { evidenceComplete: false } : {}),
        },
      );
    }
    const recorded = await this.#append(
      context,
      sequence + 1,
      "ProviderReceiptRecorded",
      receipt.value,
      signal,
    );
    if (recorded.ok) sequence = recorded.value;
    if (!recorded.ok)
      return finish(this.#postDispatchResult(receipt.value), {
        artifacts: retainedArtifacts,
        evidenceComplete: false,
      });
    const observed = await this.#observeForAction(context, signal, true);
    if (!observed.ok)
      return finish(
        {
          dispatch: receipt.value.dispatch,
          providerOutcome: receipt.value.outcome,
          verification: "unverifiable",
          retryDisposition:
            receipt.value.dispatch === "unknown"
              ? "reconcileRequired"
              : receipt.value.dispatch === "notDispatched"
                ? "safe"
                : "unsafe",
        },
        { artifacts: retainedArtifacts, evidenceComplete: false, failure: observed.error },
      );
    const screenshot = observed.value.screenshot
      ? await persist((evidenceSignal) =>
          this.evidence.commitArtifact(
            {
              runId: context.runId,
              type:
                observed.value.observation.screenshotScope === "display"
                  ? "display-screenshot"
                  : "window-screenshot",
              mimeType: "image/png",
              sensitivity: "potentiallySensitive",
              bytes: observed.value.screenshot as Uint8Array,
            },
            evidenceSignal,
          ),
        )
      : undefined;
    const snapshot = await persist((evidenceSignal) =>
      this.evidence.commitArtifact(
        {
          runId: context.runId,
          type: "ui-snapshot",
          mimeType: "application/json",
          sensitivity: "potentiallySensitive",
          bytes: observed.value.snapshot,
        },
        evidenceSignal,
      ),
    );
    if (screenshot?.ok) retainedArtifacts.push(screenshot.value);
    if (snapshot.ok) retainedArtifacts.push(snapshot.value);
    if (!observed.value.screenshot) transactionEvidenceComplete = false;
    if (!snapshot.ok || (screenshot !== undefined && !screenshot.ok))
      return finish(
        {
          dispatch: receipt.value.dispatch,
          providerOutcome: receipt.value.outcome,
          verification: "unverifiable",
          retryDisposition:
            receipt.value.dispatch === "unknown"
              ? "reconcileRequired"
              : receipt.value.dispatch === "notDispatched"
                ? "safe"
                : "unsafe",
        },
        { artifacts: retainedArtifacts, evidenceComplete: false },
      );
    for (const artifact of [...(screenshot?.ok ? [screenshot.value] : []), snapshot.value]) {
      const committed = await this.#append(
        context,
        sequence + 1,
        "ArtifactCommitted",
        {
          artifactId: artifact.artifactId,
          type: artifact.type,
          sha256: artifact.sha256,
        },
        signal,
      );
      if (committed.ok) sequence = committed.value;
      if (!committed.ok)
        return finish(this.#postDispatchResult(receipt.value), {
          artifacts: retainedArtifacts,
          evidenceComplete: false,
        });
    }
    const after: Observation = {
      ...observed.value.observation,
      ...(screenshot?.ok ? { screenshot: this.#artifactRef(screenshot.value) } : {}),
      uiSnapshot: this.#artifactRef(snapshot.value),
    };
    const observationEvent = await this.#append(
      context,
      sequence + 1,
      "ObservationCaptured",
      {
        observationId: after.observationId,
        screenshotScope: after.screenshotScope,
        coverage: after.coverage,
        screenshot: after.screenshot,
        uiSnapshot: after.uiSnapshot,
      },
      signal,
    );
    if (observationEvent.ok) sequence = observationEvent.value;
    if (!observationEvent.ok)
      return finish(this.#postDispatchResult(receipt.value), {
        artifacts: retainedArtifacts,
        evidenceComplete: false,
      });
    const committedArtifacts = [...(screenshot?.ok ? [screenshot.value] : []), snapshot.value];
    if (receipt.value.dispatch !== "dispatched" || receipt.value.outcome !== "succeeded") {
      const disposition =
        receipt.value.dispatch === "notDispatched"
          ? "safe"
          : receipt.value.dispatch === "unknown"
            ? "reconcileRequired"
            : "unsafe";
      return finish(
        {
          dispatch: receipt.value.dispatch,
          providerOutcome: receipt.value.outcome,
          verification: "unverifiable",
          retryDisposition: disposition,
        },
        { artifacts: committedArtifacts, after },
      );
    }
    if (assertions.length === 0)
      return finish(
        {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "notRequested",
          retryDisposition: "unsafe",
        },
        { after, artifacts: committedArtifacts },
      );
    let failed = false;
    let unverifiable = false;
    for (const assertion of assertions) {
      const evaluated = await withStageSignal(
        Math.max(
          0,
          Math.min(this.timeouts.assertionMs, (context.deadlineMs ?? Infinity) - this.clock.monotonicMs()),
        ),
        signal,
        (stageSignal) => this.desktop.evaluate(assertion, after, stageSignal),
        this.clock,
      ).catch(() =>
        err({
          code: "ProviderTimeout",
          phase: "observe",
          message: "Assertion could not be evaluated.",
          retryDisposition: "notApplicable",
        }),
      );
      const status = evaluated.ok ? evaluated.value.status : "unverifiable";
      failed ||= status === "failed";
      unverifiable ||= status === "unverifiable";
      const assertionEvent = await this.#append(
        context,
        sequence + 1,
        "AssertionEvaluated",
        {
          kind: assertion.kind,
          status,
          reason: evaluated.ok ? evaluated.value.reason : evaluated.error.code,
          observationId: after.observationId,
        },
        signal,
      );
      if (assertionEvent.ok) sequence = assertionEvent.value;
      if (!assertionEvent.ok)
        return finish(this.#postDispatchResult(receipt.value), {
          artifacts: retainedArtifacts,
          evidenceComplete: false,
        });
    }
    const verification = failed ? "contradicted" : unverifiable ? "unverifiable" : "confirmed";
    return finish(
      {
        dispatch: "dispatched",
        providerOutcome: "succeeded",
        verification,
        retryDisposition: "unsafe",
      },
      {
        after,
        artifacts: committedArtifacts,
        ...(!screenshot ? { evidenceComplete: false, failure: observed.value.screenshotError } : {}),
      },
    );
  }

  #usesLatestObservation(action: DesktopAction, expected: string): boolean {
    if (action.kind === "pressKey" || action.kind === "typeText") return true;
    if (action.kind === "drag")
      return action.from.element.observationId === expected && action.to.element.observationId === expected;
    return "element" in action.target && action.target.element.observationId === expected;
  }

  async #observeForAction(
    context: TransactionContext,
    signal: AbortSignal,
    settleBeforeFirst: boolean,
  ): Promise<Awaited<ReturnType<DesktopPort["observe"]>>> {
    const timeoutMs = Math.max(
      0,
      Math.min(this.timeouts.observeMs, (context.deadlineMs ?? Infinity) - this.clock.monotonicMs()),
    );
    let earliestError: OperationError | undefined;
    return withStageSignal(
      timeoutMs,
      signal,
      async (stageSignal) => {
        if (settleBeforeFirst && this.observationRetry.backoffMs > 0)
          await this.clock.sleep(this.observationRetry.backoffMs, stageSignal);
        const observed = await retrySafe(
          this.observationRetry,
          stageSignal,
          async () => {
            const result = await this.desktop.observe(
              {
                runId: context.runId,
                generation: context.generation,
                observationId: this.ids.next("observation") as ObservationId,
                sessionId: context.sessionId,
                windowId: context.windowId,
                ...(context.window ? { window: context.window } : {}),
              },
              stageSignal,
            );
            earliestError ??= result.ok ? result.value.screenshotError : result.error;
            return result;
          },
          (result) => {
            const error = result.ok ? result.value.screenshotError : result.error;
            return (
              error !== undefined &&
              ["ProviderFailure", "ProviderTimeout", "SessionUnavailable", "SnapshotIncomplete"].includes(
                error.code,
              )
            );
          },
          this.clock,
        );
        if (!earliestError) return observed;
        if (!observed.ok) return err(earliestError);
        if (!observed.value.screenshotError) return observed;
        return ok({ ...observed.value, screenshotError: earliestError });
      },
      this.clock,
    ).catch(() =>
      earliestError
        ? err(earliestError)
        : err({
            code: "ProviderTimeout",
            phase: "observe",
            message: "After Observation retry budget expired.",
            retryDisposition: "safe",
          }),
    );
  }

  #artifactRef(descriptor: { artifactId: string; sha256: string }): ArtifactRef {
    return { artifactId: descriptor.artifactId as ArtifactRef["artifactId"], sha256: descriptor.sha256 };
  }

  #postDispatchResult(receipt: ProviderReceipt): ActionResult {
    return {
      dispatch: receipt.dispatch,
      providerOutcome: receipt.outcome,
      verification: "unverifiable",
      retryDisposition:
        receipt.dispatch === "notDispatched"
          ? "safe"
          : receipt.dispatch === "unknown"
            ? "reconcileRequired"
            : "unsafe",
    };
  }

  async #commitObservation(
    context: TransactionContext,
    captured: Awaited<ReturnType<DesktopPort["observe"]>> extends OperationResult<infer T> ? T : never,
    initialSequence: number,
    progress: { sequence: number; artifacts: ArtifactDescriptor[] },
    signal?: AbortSignal,
    requireScreenshot = true,
  ): Promise<
    OperationResult<{
      observation: Observation;
      artifacts: ArtifactDescriptor[];
      sequence: number;
      screenshotError?: OperationError;
    }>
  > {
    let sequence = initialSequence;
    const remaining = (): number =>
      Math.max(
        0,
        Math.min(
          this.timeouts.observeMs,
          (context.deadlineMs ?? this.clock.monotonicMs() + this.timeouts.observeMs) -
            this.clock.monotonicMs(),
        ),
      );
    if (!captured.screenshot && requireScreenshot)
      return captured.screenshotError
        ? err(captured.screenshotError)
        : err({
            code: "EvidenceIncomplete",
            phase: "observe",
            message: "Required before-Observation screenshot is unavailable.",
            retryDisposition: "notApplicable",
          });
    const screenshot = captured.screenshot
      ? await withStageSignal(
          remaining(),
          signal ?? new AbortController().signal,
          (evidenceSignal) =>
            this.evidence.commitArtifact(
              {
                runId: context.runId,
                type:
                  captured.observation.screenshotScope === "display"
                    ? "display-screenshot"
                    : "window-screenshot",
                mimeType: "image/png",
                sensitivity: "potentiallySensitive",
                bytes: captured.screenshot as Uint8Array,
              },
              evidenceSignal,
            ),
          this.clock,
          false,
        )
      : undefined;
    if (screenshot && !screenshot.ok) return screenshot;
    if (screenshot?.ok) progress.artifacts.push(screenshot.value);
    const snapshot = await withStageSignal(
      remaining(),
      signal ?? new AbortController().signal,
      (evidenceSignal) =>
        this.evidence.commitArtifact(
          {
            runId: context.runId,
            type: "ui-snapshot",
            mimeType: "application/json",
            sensitivity: "potentiallySensitive",
            bytes: captured.snapshot,
          },
          evidenceSignal,
        ),
      this.clock,
      false,
    );
    if (!snapshot.ok) return snapshot;
    progress.artifacts.push(snapshot.value);
    for (const artifact of [...(screenshot?.ok ? [screenshot.value] : []), snapshot.value]) {
      const event = await this.#append(
        context,
        sequence + 1,
        "ArtifactCommitted",
        {
          artifactId: artifact.artifactId,
          type: artifact.type,
          sha256: artifact.sha256,
        },
        signal,
      );
      if (!event.ok) return event;
      sequence = event.value;
      progress.sequence = sequence;
    }
    const observation: Observation = {
      ...captured.observation,
      ...(screenshot?.ok ? { screenshot: this.#artifactRef(screenshot.value) } : {}),
      uiSnapshot: this.#artifactRef(snapshot.value),
    };
    if (!screenshot && captured.screenshotError) {
      const failed = await this.#append(
        context,
        sequence + 1,
        "EvidenceCollectionFailed",
        { stage: "screenshot", code: captured.screenshotError.code },
        signal,
      );
      if (!failed.ok) return failed;
      sequence = failed.value;
      progress.sequence = sequence;
    }
    const event = await this.#append(
      context,
      sequence + 1,
      "ObservationCaptured",
      {
        observationId: observation.observationId,
        screenshotScope: observation.screenshotScope,
        coverage: observation.coverage,
        screenshot: observation.screenshot,
        uiSnapshot: observation.uiSnapshot,
      },
      signal,
    );
    if (!event.ok) return event;
    sequence = event.value;
    progress.sequence = sequence;
    return ok({
      observation,
      artifacts: [...(screenshot?.ok ? [screenshot.value] : []), snapshot.value],
      sequence,
      ...(captured.screenshotError ? { screenshotError: captured.screenshotError } : {}),
    });
  }

  #append(
    context: TransactionContext,
    sequence: number,
    type: EvidenceEvent["type"],
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OperationResult<number>> {
    const event = parseEvidenceEvent({
      schemaVersion: 1,
      runId: context.runId,
      sequence,
      recordedAt: this.clock.wallNow().toISOString(),
      elapsedMs: Math.max(0, this.clock.monotonicMs() - context.startedMono),
      type,
      source: "kernel",
      data,
    });
    const remaining =
      context.deadlineMs === undefined
        ? this.timeouts.observeMs
        : Math.max(0, Math.min(this.timeouts.observeMs, context.deadlineMs - this.clock.monotonicMs()));
    return withStageSignal(
      remaining,
      signal ?? new AbortController().signal,
      (evidenceSignal) => this.evidence.append(event, evidenceSignal),
      this.clock,
      false,
    ).then(async (result) => {
      if (!result.ok) return result;
      const hookRemaining =
        context.deadlineMs === undefined
          ? this.timeouts.observeMs
          : Math.max(0, context.deadlineMs - this.clock.monotonicMs());
      return withStageSignal(
        Math.min(this.timeouts.observeMs, hookRemaining),
        signal ?? new AbortController().signal,
        (hookSignal) =>
          deliverHooks({
            event,
            hooks: this.hooks,
            evidence: this.evidence,
            artifacts: this.#hookArtifacts,
            sequence,
            startedMono: context.startedMono,
            clock: this.clock,
            signal: hookSignal,
          }),
        this.clock,
        true,
      );
    });
  }
}
