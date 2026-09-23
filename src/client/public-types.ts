import type {
  ActionResult,
  ArtifactDescriptor,
  AssertionSpec,
  AssertionResult,
  DesktopAction,
  ElementId,
  ElementQuery,
  QueryPage,
  ElementRef,
  ElementSummary,
  LeaseId,
  Observation,
  OperationResult,
  RunId,
  RunResult,
} from "../contracts/public.js";

export type ClientRunResult = OperationResult<{ runId: RunId; result: RunResult }>;
export interface ClientRun {
  readonly leaseId: LeaseId;
  observe(): Promise<OperationResult<Observation>>;
  assert(assertion: AssertionSpec): Promise<OperationResult<AssertionResult>>;
  query(query: ElementQuery): OperationResult<ElementRef>;
  queryPage(query: ElementQuery, options?: { offset?: number; limit?: number }): OperationResult<QueryPage>;
  compact(): OperationResult<string>;
  expand(elementId: ElementId): OperationResult<ElementSummary>;
  action(
    action: DesktopAction,
    assertions?: readonly AssertionSpec[],
  ): Promise<
    OperationResult<{
      result: ActionResult;
      sequence: number;
      after?: Observation;
      artifacts?: ArtifactDescriptor[];
      evidenceComplete?: boolean;
    }>
  >;
}
