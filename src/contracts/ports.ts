import type { DesktopAction, AssertionSpec } from "./actions.js";
import type { ApplicationDescriptor, ApplicationTarget } from "./application.js";
import type { ArtifactDescriptor, EvidenceEvent, ManagedResourceRecord, RunManifest } from "./evidence.js";
import type { ElementQuery, ElementRef, ElementSummary, Observation, QueryPage } from "./observation.js";
import type { ElementId, OperationId, RunId } from "./ids.js";
import type {
  OperationError,
  OperationResult,
  ProbeResult,
  ProviderReceipt,
  RunResult,
  VmStatus,
} from "./results.js";
import type {
  ArtifactCommitRequest,
  CloneRequest,
  CompatibilityProbe,
  ImageRequest,
  ManagedCloneRequest,
  ObserveRequest,
  SessionRequest,
  VmStartRequest,
} from "./port-schemas.js";

export interface ImagePort {
  ensureImage(request: ImageRequest, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
}
export interface VmPort {
  listManaged(signal: AbortSignal): Promise<OperationResult<readonly string[]>>;
  clone(
    request: CloneRequest,
    signal: AbortSignal,
  ): Promise<OperationResult<{ resourceId: string; receipt: ProviderReceipt }>>;
  start(request: VmStartRequest, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  inspect(resourceId: string, signal: AbortSignal): Promise<OperationResult<VmStatus>>;
  stop(resourceId: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  destroy(request: ManagedCloneRequest, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
}
export interface GuestPort {
  probe(
    resourceId: string,
    expected: CompatibilityProbe,
    signal: AbortSignal,
  ): Promise<OperationResult<ProbeResult>>;
  configureNetwork(
    resourceId: string,
    rules: readonly { cidr: string; ports: readonly number[]; protocol: "tcp" | "udp" }[],
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>>;
  resolveApplication(
    resourceId: string,
    target: ApplicationTarget,
    signal: AbortSignal,
  ): Promise<OperationResult<ApplicationDescriptor>>;
  startAppium(
    resourceId: string,
    signal: AbortSignal,
  ): Promise<OperationResult<{ channelId: OperationId; receipt: ProviderReceipt }>>;
  stopAppium(resourceId: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  exportDiagnostics(
    resourceId: string,
    limits: { maxFileBytes: number; maxTotalBytes: number },
    signal: AbortSignal,
  ): Promise<OperationResult<Uint8Array>>;
}
export interface DesktopPort {
  startSession(request: SessionRequest, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  observe(
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<
    OperationResult<{
      observation: Omit<Observation, "screenshot" | "uiSnapshot">;
      screenshot?: Uint8Array;
      screenshotError?: OperationError;
      snapshot: Uint8Array;
    }>
  >;
  dispatch(
    action: DesktopAction,
    operationId: OperationId,
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>>;
  rebind(action: DesktopAction, observation: Observation): OperationResult<DesktopAction>;
  evaluate(
    assertion: AssertionSpec,
    observation: Observation,
    signal: AbortSignal,
  ): Promise<OperationResult<{ status: "passed" | "failed" | "unverifiable"; reason: string }>>;
  preflightAssertion(
    assertion: AssertionSpec,
    observation: Observation,
  ): OperationResult<{ status: "admissible" | "unverifiable"; reason: string }>;
  compact(observation: Observation): string;
  query(observation: Observation, query: ElementQuery): OperationResult<ElementRef>;
  queryPage?(
    observation: Observation,
    query: ElementQuery,
    offset: number,
    limit: number,
  ): OperationResult<QueryPage>;
  expand(observation: Observation, elementId: ElementId): OperationResult<ElementSummary>;
  stopSession(signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
}
export interface EvidencePort {
  reconcileProjections(signal?: AbortSignal): Promise<OperationResult<void>>;
  recordDamagedRun(
    runId: RunId,
    buildVersion: string,
    cleanup: "completed" | "failed",
    signal?: AbortSignal,
  ): Promise<OperationResult<void>>;
  listUnfinishedRuns(signal?: AbortSignal): Promise<OperationResult<readonly RunId[]>>;
  preflight(runId: RunId, signal?: AbortSignal): Promise<OperationResult<void>>;
  recoverOrphans(runId: RunId, signal?: AbortSignal): Promise<OperationResult<number>>;
  append(event: EvidenceEvent, signal?: AbortSignal): Promise<OperationResult<void>>;
  commitArtifact(
    request: ArtifactCommitRequest,
    signal?: AbortSignal,
  ): Promise<OperationResult<ArtifactDescriptor>>;
  commitManifest(
    manifest: RunManifest,
    signal?: AbortSignal,
  ): Promise<OperationResult<{ relativePath: string; sha256: string }>>;
  commitRecoveryManifest(
    runId: RunId,
    buildVersion: string,
    result: RunResult,
    artifacts?: readonly ArtifactDescriptor[],
    signal?: AbortSignal,
  ): Promise<OperationResult<{ relativePath: string; sha256: string }>>;
  readTimeline(runId: RunId, signal?: AbortSignal): Promise<OperationResult<readonly EvidenceEvent[]>>;
  readManagedResource(signal?: AbortSignal): Promise<OperationResult<ManagedResourceRecord | null>>;
  writeManagedResource(record: ManagedResourceRecord, signal?: AbortSignal): Promise<OperationResult<void>>;
  clearManagedResource(signal?: AbortSignal): Promise<OperationResult<void>>;
}
