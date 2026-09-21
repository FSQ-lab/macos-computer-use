import {
  err,
  ok,
  type ActionResult,
  type ArtifactRef,
  type AssertionSpec,
  type DesktopAction,
  type DesktopPort,
  type EvidenceEvent,
  type ArtifactDescriptor,
  type EvidencePort,
  type Observation,
  type ObservationId,
  type OperationId,
  type OperationResult,
  type ProviderReceipt,
  type RunId,
  type SessionId,
  type WindowId,
} from "../contracts/index.js";
import type { Clock, IdGenerator } from "./runtime.js";
import { withStageSignal } from "./timeout.js";

export type TransactionContext = {
  runId: RunId;
  generation: number;
  sessionId: SessionId;
  windowId: WindowId;
  expectedObservationId: string;
  sequence: number;
  startedMono: number;
};
export type TransactionOutput = {
  result: ActionResult;
  sequence: number;
  after?: Observation;
  artifacts?: ArtifactDescriptor[];
  evidenceComplete?: boolean;
};

export class ActionTransaction {
  constructor(
    private readonly desktop: DesktopPort,
    private readonly evidence: EvidencePort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly timeouts: { actionMs: number; observeMs: number; assertionMs: number },
  ) {}

  async execute(
    context: TransactionContext,
    action: DesktopAction,
    assertions: readonly AssertionSpec[],
    signal: AbortSignal,
  ): Promise<OperationResult<TransactionOutput>> {
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
    const preflight = await this.evidence.preflight(context.runId);
    if (!preflight.ok) return preflight;
    const operationId = this.ids.next("operation") as OperationId;
    let sequence = context.sequence;
    const beforeCaptured = await withStageSignal(this.timeouts.observeMs, signal, (stageSignal) =>
      this.desktop.observe(
        {
          runId: context.runId,
          generation: context.generation,
          observationId: this.ids.next("observation") as ObservationId,
          sessionId: context.sessionId,
          windowId: context.windowId,
        },
        stageSignal,
      ),
    );
    if (!beforeCaptured.ok) return beforeCaptured;
    const beforeArtifacts = await this.#commitObservation(context, beforeCaptured.value, sequence);
    if (!beforeArtifacts.ok) return beforeArtifacts;
    sequence = beforeArtifacts.value.sequence;
    const rebound = this.desktop.rebind(action, beforeArtifacts.value.observation);
    if (!rebound.ok) return rebound;
    const planned = await this.#append(context, ++sequence, "ActionPlanned", {
      operationId,
      kind: action.kind,
    });
    if (!planned.ok) return planned;
    const receipt = await withStageSignal(this.timeouts.actionMs, signal, (stageSignal) =>
      this.desktop.dispatch(rebound.value, operationId, stageSignal),
    );
    if (!receipt.ok) {
      const disposition =
        receipt.error.dispatch === "notDispatched"
          ? "safe"
          : receipt.error.dispatch === "dispatched"
            ? "unsafe"
            : "reconcileRequired";
      return ok({
        result: {
          dispatch: receipt.error.dispatch ?? "unknown",
          providerOutcome: "unknown",
          verification: "unverifiable",
          retryDisposition: disposition,
        },
        sequence,
      });
    }
    const recorded = await this.#append(context, ++sequence, "ProviderReceiptRecorded", receipt.value);
    if (!recorded.ok) return this.#postDispatchEvidenceFailure(receipt.value, sequence);
    if (receipt.value.dispatch !== "dispatched" || receipt.value.outcome !== "succeeded") {
      const disposition =
        receipt.value.dispatch === "notDispatched"
          ? "safe"
          : receipt.value.dispatch === "unknown"
            ? "reconcileRequired"
            : "unsafe";
      return ok({
        result: {
          dispatch: receipt.value.dispatch,
          providerOutcome: receipt.value.outcome,
          verification: "unverifiable",
          retryDisposition: disposition,
        },
        sequence,
      });
    }
    const observed = await withStageSignal(this.timeouts.observeMs, signal, (stageSignal) =>
      this.desktop.observe(
        {
          runId: context.runId,
          generation: context.generation,
          observationId: this.ids.next("observation") as ObservationId,
          sessionId: context.sessionId,
          windowId: context.windowId,
        },
        stageSignal,
      ),
    );
    if (!observed.ok)
      return ok({
        result: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "unverifiable",
          retryDisposition: "unsafe",
        },
        sequence,
        evidenceComplete: false,
      });
    const screenshot = await this.evidence.commitArtifact({
      runId: context.runId,
      type: "window-screenshot",
      mimeType: "image/png",
      sensitivity: "potentiallySensitive",
      bytes: observed.value.screenshot,
    });
    const snapshot = await this.evidence.commitArtifact({
      runId: context.runId,
      type: "ui-snapshot",
      mimeType: "application/json",
      sensitivity: "potentiallySensitive",
      bytes: observed.value.snapshot,
    });
    if (!screenshot.ok || !snapshot.ok)
      return ok({
        result: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "unverifiable",
          retryDisposition: "unsafe",
        },
        sequence,
        evidenceComplete: false,
      });
    for (const artifact of [screenshot.value, snapshot.value]) {
      const committed = await this.#append(context, ++sequence, "ArtifactCommitted", {
        artifactId: artifact.artifactId,
        type: artifact.type,
        sha256: artifact.sha256,
      });
      if (!committed.ok) return this.#postDispatchEvidenceFailure(receipt.value, sequence);
    }
    const after: Observation = {
      ...observed.value.observation,
      screenshot: this.#artifactRef(screenshot.value),
      uiSnapshot: this.#artifactRef(snapshot.value),
    };
    const observationEvent = await this.#append(context, ++sequence, "ObservationCaptured", {
      observationId: after.observationId,
      coverage: after.coverage,
      screenshot: after.screenshot,
      uiSnapshot: after.uiSnapshot,
    });
    if (!observationEvent.ok) return this.#postDispatchEvidenceFailure(receipt.value, sequence);
    const committedArtifacts = [...beforeArtifacts.value.artifacts, screenshot.value, snapshot.value];
    if (assertions.length === 0)
      return ok({
        result: {
          dispatch: "dispatched",
          providerOutcome: "succeeded",
          verification: "notRequested",
          retryDisposition: "unsafe",
        },
        sequence,
        after,
        artifacts: committedArtifacts,
      });
    let failed = false;
    let unverifiable = false;
    for (const assertion of assertions) {
      const evaluated = await withStageSignal(this.timeouts.assertionMs, signal, (stageSignal) =>
        this.desktop.evaluate(assertion, after, stageSignal),
      );
      const status = evaluated.ok ? evaluated.value.status : "unverifiable";
      failed ||= status === "failed";
      unverifiable ||= status === "unverifiable";
      const assertionEvent = await this.#append(context, ++sequence, "AssertionEvaluated", {
        kind: assertion.kind,
        status,
        reason: evaluated.ok ? evaluated.value.reason : evaluated.error.code,
        observationId: after.observationId,
      });
      if (!assertionEvent.ok) return this.#postDispatchEvidenceFailure(receipt.value, sequence);
    }
    const verification = failed ? "contradicted" : unverifiable ? "unverifiable" : "confirmed";
    return ok({
      result: {
        dispatch: "dispatched",
        providerOutcome: "succeeded",
        verification,
        retryDisposition: "unsafe",
      },
      sequence,
      after,
      artifacts: committedArtifacts,
    });
  }

  #usesLatestObservation(action: DesktopAction, expected: string): boolean {
    if (action.kind === "pressKey") return true;
    if (action.kind === "drag")
      return action.from.element.observationId === expected && action.to.element.observationId === expected;
    if (action.kind === "appendText" || action.kind === "replaceText")
      return action.target.observationId === expected;
    return "element" in action.target && action.target.element.observationId === expected;
  }

  #artifactRef(descriptor: { artifactId: string; sha256: string }): ArtifactRef {
    return { artifactId: descriptor.artifactId as ArtifactRef["artifactId"], sha256: descriptor.sha256 };
  }

  #postDispatchEvidenceFailure(
    receipt: ProviderReceipt,
    sequence: number,
  ): OperationResult<TransactionOutput> {
    return ok({
      result: {
        dispatch: receipt.dispatch,
        providerOutcome: receipt.outcome,
        verification: "unverifiable",
        retryDisposition:
          receipt.dispatch === "notDispatched"
            ? "safe"
            : receipt.dispatch === "unknown"
              ? "reconcileRequired"
              : "unsafe",
      },
      sequence,
      evidenceComplete: false,
    });
  }

  async #commitObservation(
    context: TransactionContext,
    captured: Awaited<ReturnType<DesktopPort["observe"]>> extends OperationResult<infer T> ? T : never,
    initialSequence: number,
  ): Promise<
    OperationResult<{ observation: Observation; artifacts: ArtifactDescriptor[]; sequence: number }>
  > {
    let sequence = initialSequence;
    const screenshot = await this.evidence.commitArtifact({
      runId: context.runId,
      type: "window-screenshot",
      mimeType: "image/png",
      sensitivity: "potentiallySensitive",
      bytes: captured.screenshot,
    });
    if (!screenshot.ok) return screenshot;
    const snapshot = await this.evidence.commitArtifact({
      runId: context.runId,
      type: "ui-snapshot",
      mimeType: "application/json",
      sensitivity: "potentiallySensitive",
      bytes: captured.snapshot,
    });
    if (!snapshot.ok) return snapshot;
    for (const artifact of [screenshot.value, snapshot.value]) {
      const event = await this.#append(context, ++sequence, "ArtifactCommitted", {
        artifactId: artifact.artifactId,
        type: artifact.type,
        sha256: artifact.sha256,
      });
      if (!event.ok) return event;
    }
    const observation: Observation = {
      ...captured.observation,
      screenshot: this.#artifactRef(screenshot.value),
      uiSnapshot: this.#artifactRef(snapshot.value),
    };
    const event = await this.#append(context, ++sequence, "ObservationCaptured", {
      observationId: observation.observationId,
      coverage: observation.coverage,
      screenshot: observation.screenshot,
      uiSnapshot: observation.uiSnapshot,
    });
    if (!event.ok) return event;
    return ok({ observation, artifacts: [screenshot.value, snapshot.value], sequence });
  }

  #append(
    context: TransactionContext,
    sequence: number,
    type: EvidenceEvent["type"],
    data: Record<string, unknown>,
  ): Promise<OperationResult<void>> {
    return this.evidence.append({
      schemaVersion: 1,
      runId: context.runId,
      sequence,
      recordedAt: this.clock.wallNow().toISOString(),
      elapsedMs: Math.max(0, this.clock.monotonicMs() - context.startedMono),
      type,
      source: "kernel",
      data,
    });
  }
}
