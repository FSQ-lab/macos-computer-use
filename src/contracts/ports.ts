import type { DesktopAction, AssertionSpec } from "./actions.js";
import type { ArtifactDescriptor, EvidenceEvent, ManagedResourceRecord, RunManifest } from "./evidence.js";
import type { ElementQuery, ElementRef, ElementSummary, Observation } from "./observation.js";
import type { ElementId, OperationId, RunId } from "./ids.js";
import type { OperationResult, ProbeResult, ProviderReceipt, RunResult, VmStatus } from "./results.js";
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
  ): Promise<OperationResult<{ cloneName: string; receipt: ProviderReceipt }>>;
  start(request: VmStartRequest, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  inspect(cloneName: string, signal: AbortSignal): Promise<OperationResult<VmStatus>>;
  stop(cloneName: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  destroy(request: ManagedCloneRequest, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
}
export interface GuestPort {
  probe(
    cloneName: string,
    expected: CompatibilityProbe,
    signal: AbortSignal,
  ): Promise<OperationResult<ProbeResult>>;
  configureNetwork(
    cloneName: string,
    rules: readonly { cidr: string; ports: readonly number[]; protocol: "tcp" | "udp" }[],
    signal: AbortSignal,
  ): Promise<OperationResult<ProviderReceipt>>;
  startAppium(
    cloneName: string,
    signal: AbortSignal,
  ): Promise<OperationResult<{ endpoint: string; receipt: ProviderReceipt }>>;
  stopAppium(cloneName: string, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  exportDiagnostics(cloneName: string, signal: AbortSignal): Promise<OperationResult<Uint8Array>>;
}
export interface DesktopPort {
  startSession(request: SessionRequest, signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
  observe(
    request: ObserveRequest,
    signal: AbortSignal,
  ): Promise<
    OperationResult<{
      observation: Omit<Observation, "screenshot" | "uiSnapshot">;
      screenshot: Uint8Array;
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
  compact(observation: Observation): string;
  query(observation: Observation, query: ElementQuery): OperationResult<ElementRef>;
  expand(observation: Observation, elementId: ElementId): OperationResult<ElementSummary>;
  stopSession(signal: AbortSignal): Promise<OperationResult<ProviderReceipt>>;
}
export interface EvidencePort {
  preflight(runId: RunId): Promise<OperationResult<void>>;
  recoverOrphans(runId: RunId): Promise<OperationResult<number>>;
  append(event: EvidenceEvent): Promise<OperationResult<void>>;
  commitArtifact(request: ArtifactCommitRequest): Promise<OperationResult<ArtifactDescriptor>>;
  commitManifest(manifest: RunManifest): Promise<OperationResult<{ relativePath: string; sha256: string }>>;
  commitRecoveryManifest(
    runId: RunId,
    buildVersion: string,
    result: RunResult,
    artifacts?: readonly ArtifactDescriptor[],
  ): Promise<OperationResult<{ relativePath: string; sha256: string }>>;
  readTimeline(runId: RunId): Promise<OperationResult<readonly EvidenceEvent[]>>;
  readManagedResource(): Promise<OperationResult<ManagedResourceRecord | null>>;
  writeManagedResource(record: ManagedResourceRecord): Promise<OperationResult<void>>;
  clearManagedResource(): Promise<OperationResult<void>>;
}
