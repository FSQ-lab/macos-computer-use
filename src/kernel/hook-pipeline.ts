import {
  HookContributionsSchema,
  parseEvidenceEvent,
  type ArtifactDescriptor,
  type EvidenceEvent,
  type EvidencePort,
  type EventHook,
  type OperationResult,
} from "../contracts/index.js";
import type { Clock } from "./runtime.js";

export const deliverHooks = async (input: {
  event: EvidenceEvent;
  hooks: readonly EventHook[];
  evidence: EvidencePort;
  artifacts: ArtifactDescriptor[];
  sequence: number;
  startedMono: number;
  clock: Clock;
  signal: AbortSignal;
}): Promise<OperationResult<number>> => {
  let sequence = input.sequence;
  for (const hook of input.hooks) {
    try {
      const hookController = new AbortController();
      const hookSignal = AbortSignal.any([input.signal, hookController.signal]);
      let cancelTimeout: (() => void) | undefined;
      try {
        cancelTimeout = input.clock.schedule(() => hookController.abort(new Error("Hook timeout.")), 5_000);
        const raw: unknown = await hook.deliver(structuredClone(input.event), hookSignal);
        if (hookSignal.aborted) throw hookSignal.reason;
        const contributions = HookContributionsSchema.parse(raw);
        for (const contribution of contributions) {
          const artifact = await input.evidence.commitArtifact(
            {
              runId: input.event.runId,
              type: `hook-${hook.name}-${contribution.type}`,
              mimeType: "application/octet-stream",
              sensitivity: "potentiallySensitive",
              bytes: contribution.bytes,
            },
            input.signal,
          );
          if (!artifact.ok) throw new Error("Hook Artifact failed");
          input.artifacts.push(artifact.value);
          const committed = await input.evidence.append(
            parseEvidenceEvent({
              schemaVersion: 1,
              runId: input.event.runId,
              sequence: ++sequence,
              recordedAt: input.clock.wallNow().toISOString(),
              elapsedMs: Math.max(0, input.clock.monotonicMs() - input.startedMono),
              type: "ArtifactCommitted",
              source: "hook",
              data: {
                artifactId: artifact.value.artifactId,
                type: artifact.value.type,
                sha256: artifact.value.sha256,
              },
            }),
            input.signal,
          );
          if (!committed.ok) return committed;
        }
      } finally {
        cancelTimeout?.();
      }
    } catch {
      const failed = await input.evidence.append(
        parseEvidenceEvent({
          schemaVersion: 1,
          runId: input.event.runId,
          sequence: ++sequence,
          recordedAt: input.clock.wallNow().toISOString(),
          elapsedMs: Math.max(0, input.clock.monotonicMs() - input.startedMono),
          type: "HookFailed",
          source: "hook",
          data: { hook: hook.name, code: "HookFailed" },
        }),
        input.signal,
      );
      if (!failed.ok) return failed;
    }
  }
  return { ok: true, value: sequence };
};
