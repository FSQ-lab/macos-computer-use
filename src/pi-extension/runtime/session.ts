import {
  ActionTemplateSchema,
  type ActionTemplate,
  type AssertionSpec,
  type DesktopAction,
  type ElementQuery,
  type ElementRef,
  type ElementSummary,
  type OperationError,
} from "../../contracts/public.js";
import type { ClientRun, PiMacOSComputerUseClient } from "../../client/index.js";
import {
  SafeElementSummarySchema,
  invalidTaskProtocolResponse,
  TaskRequestSchema,
  TaskResponseSchema,
  TaskValueSchema,
  type TaskId,
  type TaskRequest,
  type TaskResponse,
  type TaskRuntimeError,
  type TaskValue,
} from "./protocol.js";

type Deferred = { resolve: () => void; reject: (error: Error) => void };
type SessionState = "starting" | "active" | "finalizing" | "closed" | "revoked";
type ClientLifecycle = Pick<PiMacOSComputerUseClient, "recover" | "runForApplication">;

const safeMessage = (message: string): string =>
  message
    .replace(/[\r\n\t]/g, " ")
    .replace(/(?:\/[^ ]+)+/g, "<path>")
    .replace(/[A-Za-z]:\\[^ ]+/g, "<path>")
    .slice(0, 500)
    .trim();

const runtimeError = (code: TaskRuntimeError["code"], message: string): TaskRuntimeError => ({
  code,
  message: safeMessage(message),
});

const clientFailure = (error: OperationError): TaskRuntimeError => ({
  ...runtimeError("ClientFailure", `${error.code}: ${error.message}`),
  clientCode: error.code,
});

const actionFailure = (result: TaskValue & { kind: "action" }): TaskRuntimeError => ({
  code: "ActionFailed",
  message: safeMessage(
    `Action failed: dispatch=${result.result.dispatch}, providerOutcome=${result.result.providerOutcome}, verification=${result.result.verification}.`,
  ),
  actionResult: result.result,
});

const safeElement = (element: ElementSummary): ReturnType<typeof SafeElementSummarySchema.parse> =>
  SafeElementSummarySchema.parse({
    elementId: element.elementId,
    role: element.role,
    ...(element.identifier === undefined ? {} : { identifier: element.identifier }),
    ...(element.name === undefined ? {} : { name: element.name }),
    ...(element.label === undefined ? {} : { label: element.label }),
    ...(element.value === undefined ? {} : { value: element.value }),
    ...(element.visible === undefined ? {} : { visible: element.visible }),
    ...(element.enabled === undefined ? {} : { enabled: element.enabled }),
    ...(element.selected === undefined ? {} : { selected: element.selected }),
    ...(element.focused === undefined ? {} : { focused: element.focused }),
    ...(element.isModal === undefined ? {} : { isModal: element.isModal }),
    ...(element.isMain === undefined ? {} : { isMain: element.isMain }),
  });

export class PiTaskSession {
  #taskId: TaskId | undefined;
  #expectedSequence = 1;
  #state: SessionState = "starting";
  #run: ClientRun | undefined;
  #runController: AbortController | undefined;
  #completion: Deferred | undefined;
  #runPromise: ReturnType<ClientLifecycle["runForApplication"]> | undefined;
  #finalAssertions: readonly AssertionSpec[] = [];
  #lastHeartbeat: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: ClientLifecycle,
    private readonly now: () => number = () => performance.now(),
    private readonly leaseMs = 3_500,
  ) {
    this.#lastHeartbeat = this.now();
  }

  get state(): SessionState {
    return this.#state;
  }

  #isRevoked(): boolean {
    return this.#state === "revoked";
  }

  accept(message: unknown, send: (response: TaskResponse) => void): void {
    const parsed = TaskRequestSchema.safeParse(message);
    if (!parsed.success) {
      send(invalidTaskProtocolResponse(message));
      this.revoke("Malformed task protocol message.");
      return;
    }
    const request = parsed.data;
    const envelopeError = this.#acceptEnvelope(request);
    if (envelopeError) {
      send(this.#failure(request, envelopeError));
      this.revoke(envelopeError.message);
      return;
    }
    if (request.type === "heartbeat") {
      this.#lastHeartbeat = this.now();
      send(this.#success(request, { kind: "heartbeat", alive: true }));
      return;
    }
    if (request.type === "abort") {
      this.revoke(request.reason);
      const complete = async (): Promise<void> => send(await this.#completeAbort(request));
      this.#queue = this.#queue.then(complete, complete);
      return;
    }
    const execute = async (): Promise<void> => {
      if (this.#state === "revoked" || this.#state === "closed" || this.#state === "finalizing") {
        send(this.#failure(request, runtimeError("SupervisionLost", "Task authority was revoked.")));
        return;
      }
      try {
        send(await this.#handle(request));
      } catch {
        if (request.type === "action") this.revoke("Mutating operation outcome became unknown.");
        send(this.#failure(request, runtimeError("InternalError", "Task operation failed safely.")));
      }
    };
    this.#queue = this.#queue.then(execute, execute);
  }

  expireLease(): boolean {
    if (this.#state === "closed" || this.#state === "revoked") return false;
    if (this.now() - this.#lastHeartbeat <= this.leaseMs) return false;
    this.revoke("Task heartbeat expired.");
    return true;
  }

  revoke(reason: string): void {
    if (this.#state === "closed" || this.#state === "revoked") return;
    this.#state = "revoked";
    this.#runController?.abort(new Error(safeMessage(reason)));
    this.#completion?.reject(new Error(safeMessage(reason)));
  }

  async settled(): Promise<void> {
    await this.#queue.catch(() => undefined);
    await this.#runPromise?.then(
      () => undefined,
      () => undefined,
    );
  }

  #acceptEnvelope(request: TaskRequest): TaskRuntimeError | undefined {
    if (request.sequence !== this.#expectedSequence)
      return runtimeError("SequenceViolation", "Task sequence is not the next expected value.");
    this.#expectedSequence += 1;
    if (this.#taskId !== undefined && request.taskId !== this.#taskId)
      return runtimeError("IdentityMismatch", "Task identity does not match the active task.");
    if (this.#taskId === undefined && request.type !== "begin")
      return runtimeError("TaskState", "The first task request must be begin.");
    if (this.#taskId !== undefined && request.type === "begin")
      return runtimeError("TaskState", "The task has already begun.");
    if (this.#state === "revoked" || this.#state === "closed")
      return runtimeError("TaskState", "The task no longer has dispatch authority.");
    return undefined;
  }

  async #handle(request: Exclude<TaskRequest, { type: "heartbeat" }>): Promise<TaskResponse> {
    if (request.type === "begin") return this.#begin(request);
    const run = this.#run;
    if (!run || !this.#taskId)
      return this.#failure(request, runtimeError("TaskState", "The Client Run is not active."));

    if (request.type === "observe") {
      const observed = await run.observe();
      if (!observed.ok) return this.#failure(request, clientFailure(observed.error));
      const compact = run.compact();
      if (!compact.ok) return this.#failure(request, clientFailure(compact.error));
      return this.#success(request, {
        kind: "observation",
        observationId: observed.value.observationId,
        compact: compact.value,
      });
    }
    if (request.type === "query") {
      const element = this.#resolve(request.query);
      if ("code" in element) return this.#failure(request, element);
      const expanded = run.expand(element.elementId);
      if (!expanded.ok) return this.#failure(request, clientFailure(expanded.error));
      return this.#success(request, { kind: "query", element: safeElement(expanded.value) });
    }
    if (request.type === "expand") {
      const expanded = run.expand(request.elementId);
      if (!expanded.ok) return this.#failure(request, clientFailure(expanded.error));
      return this.#success(request, { kind: "expanded", element: safeElement(expanded.value) });
    }
    if (request.type === "action") {
      const materialized = this.#materialize(request.target, request.action);
      if ("code" in materialized) return this.#failure(request, materialized);
      const action = await run.action(materialized, request.assertions);
      if (!action.ok) {
        if (action.error.dispatch === "unknown") this.revoke("Action dispatch became unknown.");
        return this.#failure(request, clientFailure(action.error));
      }
      if (action.value.failure) {
        this.#state = "finalizing";
        return this.#failure(request, clientFailure(action.value.failure));
      }
      if (this.#isRevoked())
        return this.#failure(request, runtimeError("SupervisionLost", "Task authority was revoked."));
      if (action.value.result.dispatch === "unknown" || action.value.result.providerOutcome === "unknown")
        this.revoke("Action outcome became unknown.");
      if (this.#isRevoked())
        return this.#failure(request, runtimeError("SupervisionLost", "Action outcome is unknown."));
      if (!action.value.after) {
        this.revoke("Action after-observation is unavailable.");
        return this.#failure(
          request,
          runtimeError("InternalError", "Action completed without observable post-action state."),
        );
      }
      const compact = run.compact();
      if (!compact.ok) {
        this.revoke("Action after-observation could not be projected.");
        return this.#failure(request, clientFailure(compact.error));
      }
      const value = TaskValueSchema.parse({
        kind: "action",
        result: action.value.result,
        sequence: action.value.sequence,
        observationId: action.value.after.observationId,
        compact: compact.value,
        finalAssertionsPassed: await this.#finalAssertionsPass(run),
        ...(action.value.evidenceComplete === undefined
          ? {}
          : { evidenceComplete: action.value.evidenceComplete }),
      });
      if (
        value.kind === "action" &&
        (value.result.dispatch !== "dispatched" ||
          value.result.providerOutcome !== "succeeded" ||
          (value.result.verification !== "confirmed" && value.result.verification !== "notRequested"))
      ) {
        this.#state = "finalizing";
        return this.#failure(request, actionFailure(value));
      }
      return this.#success(request, value);
    }
    if (request.type === "assert") {
      const assertion = await run.assert(request.assertion);
      if (!assertion.ok) return this.#failure(request, clientFailure(assertion.error));
      return this.#success(request, {
        kind: "assertion",
        assertionId: assertion.value.assertionId,
        status: assertion.value.status,
        observationId: assertion.value.observationId,
        reason: assertion.value.reason,
      });
    }
    if (request.type === "status") return this.#success(request, { kind: "status", state: this.#state });

    this.#state = "finalizing";
    this.#completion?.resolve();
    const result = await this.#runPromise;
    this.#state = "closed";
    this.#run = undefined;
    if (!result)
      return this.#failure(request, runtimeError("InternalError", "Run finalization did not complete."));
    if (!result.ok) return this.#failure(request, clientFailure(result.error));
    return this.#success(request, {
      kind: "finished",
      runId: result.value.runId,
      result: result.value.result,
    });
  }

  async #begin(request: Extract<TaskRequest, { type: "begin" }>): Promise<TaskResponse> {
    this.#taskId = request.taskId;
    this.#finalAssertions = request.finalAssertions;
    this.#runController = new AbortController();
    const recovery = await this.client.recover({ signal: this.#runController.signal });
    if (this.#state === "revoked")
      return this.#failure(request, runtimeError("SupervisionLost", "Task authority was revoked."));
    if (!recovery.ok) {
      this.#state = "revoked";
      return this.#failure(request, clientFailure(recovery.error));
    }

    let readyResolve: ((run: ClientRun) => void) | undefined;
    let readyReject: ((error: Error) => void) | undefined;
    const ready = new Promise<ClientRun>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const completion = new Promise<void>((resolve, reject) => {
      this.#completion = { resolve, reject };
    });
    this.#runPromise = this.client.runForApplication(
      request.application,
      {
        finalAssertions: request.finalAssertions,
        signal: this.#runController.signal,
      },
      async (run) => {
        if (this.#state === "revoked") throw new Error("Task authority was revoked.");
        this.#run = run;
        readyResolve?.(run);
        await completion;
      },
    );
    void this.#runPromise.then((result) => {
      if (!this.#run)
        readyReject?.(
          new Error(result.ok ? "Run closed before becoming ready." : safeMessage(result.error.message)),
        );
    });
    try {
      const run = await ready;
      if (this.#isRevoked())
        return this.#failure(request, runtimeError("SupervisionLost", "Task authority was revoked."));
      this.#state = "active";
      this.#lastHeartbeat = this.now();
      return this.#success(request, { kind: "begun", leaseId: run.leaseId });
    } catch (error) {
      this.#state = "revoked";
      return this.#failure(
        request,
        runtimeError("ClientFailure", error instanceof Error ? error.message : "Run did not start."),
      );
    }
  }

  async #finalAssertionsPass(run: ClientRun): Promise<boolean> {
    for (const assertion of this.#finalAssertions) {
      const evaluated = await run.assertCurrent(assertion);
      if (!evaluated.ok || evaluated.value.status !== "passed") return false;
    }
    return this.#finalAssertions.length > 0;
  }

  async #completeAbort(request: Extract<TaskRequest, { type: "abort" }>): Promise<TaskResponse> {
    const result = await this.#runPromise?.then(
      (value) => value,
      () => undefined,
    );
    this.#run = undefined;
    return this.#success(
      request,
      result?.ok
        ? { kind: "aborted", runId: result.value.runId, result: result.value.result }
        : { kind: "aborted" },
    );
  }

  #resolve(query: ElementQuery): ElementRef | TaskRuntimeError {
    const result = this.#run?.query(query);
    if (!result) return runtimeError("TaskState", "The Client Run is not active.");
    return result.ok ? result.value : clientFailure(result.error);
  }

  #materialize(
    targetQuery: ElementQuery | undefined,
    input: ActionTemplate,
  ): DesktopAction | TaskRuntimeError {
    const action = ActionTemplateSchema.parse(input);
    if (action.kind === "pressKey" || action.kind === "typeText") return action;
    if (!targetQuery) return runtimeError("InvalidMessage", "The action target is missing.");
    const target = this.#resolve(targetQuery);
    if ("code" in target) return target;
    if (action.kind === "drag") {
      const destination = this.#resolve(action.destination);
      if ("code" in destination) return destination;
      return {
        kind: "drag",
        from: { element: target, ...(action.point === undefined ? {} : { point: action.point }) },
        to: {
          element: destination,
          ...(action.destinationPoint === undefined ? {} : { point: action.destinationPoint }),
        },
        ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
      };
    }
    if (action.kind === "scroll")
      return {
        kind: "scroll",
        target: { element: target, ...(action.point === undefined ? {} : { point: action.point }) },
        delta: action.delta,
      };
    if (action.kind === "swipe")
      return {
        kind: "swipe",
        target: { element: target, ...(action.point === undefined ? {} : { point: action.point }) },
        direction: action.direction,
        ...(action.velocity === undefined ? {} : { velocity: action.velocity }),
      };
    return {
      kind: action.kind,
      target: {
        element: target,
        ...("point" in action && action.point !== undefined ? { point: action.point } : {}),
      },
      ...("modifiers" in action && action.modifiers !== undefined ? { modifiers: action.modifiers } : {}),
    };
  }

  #success(request: TaskRequest, value: TaskValue): TaskResponse {
    return TaskResponseSchema.parse({
      protocolVersion: request.protocolVersion,
      taskId: request.taskId,
      requestId: request.requestId,
      sequence: request.sequence,
      type: request.type,
      ok: true,
      value: TaskValueSchema.parse(value),
    });
  }

  #failure(request: TaskRequest, error: TaskRuntimeError): TaskResponse {
    return TaskResponseSchema.parse({
      protocolVersion: request.protocolVersion,
      taskId: request.taskId,
      requestId: request.requestId,
      sequence: request.sequence,
      type: request.type,
      ok: false,
      error,
    });
  }
}
