# Module: kernel

## Purpose

Kernel owns all provider-neutral orchestration and policy: global serialization, Run allocation, environment lifecycle, readiness, leases/generations, action transactions, assertion coordination, mandatory Evidence sequencing, timeout/cancel/retry, Hook isolation, crash recovery, and final Run classification.

## Dependencies

- Project: public `contracts` only.
- Injected: ImagePort, VmPort, GuestPort, DesktopPort, EvidencePort, Clock, IdGenerator, GatewayLock, and configured Hooks. The retained network array is required to be empty; VmPort starts shared/NAT and GuestPort network configuration remains a no-op.
- Forbidden: concrete Adapter imports, Tart/Appium/Mac2 types, CLI formatting, direct filesystem/process/network access.

## Public Interface

Kernel exposes an internal application service consumed only by Client. It accepts validated configuration plus a per-Run ApplicationTarget and Scenario/callback operations, returns neutral OperationResults, logical observations/references, and complete RunResults, and provides recovery/read-only Run operations needed by Client. It does not expose Ports or provider instances.

## Environment And Run State

Environment lifecycle is `allocating`, `active`, `cleaningUp`, `closed`, or `failed`. Readiness is a separate aggregate of VM, Guest, Driver, and App probes with result time, expiry, duration, and diagnostic reference. Activation always requires every required probe to be successful and fresh. Configured Scenario/CLI operations continue to require aggregate freshness. A Pi-selected interactive Run instead treats the successful activation snapshot as startup readiness: subsequent operations are bounded by the exclusive Run lease and total deadline, while DesktopPort calls revalidate the live session, frozen application identity, owned window, and foreground state before provider work. An expired startup probe alone does not end a Pi-selected interactive Run.

A Pi-selected interactive Run begins without final assertions and returns its already captured initial Observation to the supervised runner. Its internal Run handle accepts one nonempty validated `freezeFinalAssertions` operation. Freeze is permitted exactly once, clones the assertions, appends durable `FinalAssertionsFrozen` Evidence, and makes them immutable for all later completion probes and final verdict evaluation. A second freeze fails without changing state. Normal finish without a successful freeze fails before cleanup; abort and fail-dead cleanup remain available. Configured Public Client, CLI, and Scenario Runs retain their existing predeclared-final-assertion contract.

VM, Guest, session, or selected-application reconstruction increments generation and invalidates all prior WindowRefs, Observations, and ElementRefs. Each Run has one exclusive lease. Expired/revoked/mismatched leases reject new operations before dispatch but never suppress finalization or cleanup.

After VM/Guest readiness, Kernel resolves the Run's ApplicationTarget through GuestPort. Zero or ambiguous matches fail before Appium/session creation. Kernel rejects the fixed protected bundle-ID denylist, freezes the allowed ApplicationDescriptor, and supplies it to DesktopPort. In this incremental version the selected application becomes callable only when readiness finds exactly one application-owned window; zero or multiple windows fail closed. Focus loss, system UI, another application, unknown windows, or permission prompts stop new business work; Kernel does not silently reactivate, switch, or operate them.

## Global Serialization

Kernel acquires the injected per-user OS lock before recovery or Run allocation and holds it through final state persistence and cleanup. Lock contention returns `GatewayBusy`; there is no queue. Before allocating a new clone, Kernel reconciles unfinished Run records with actual managed Tart resources.

## Action Transaction

For each action Kernel serially performs:

```text
validate lock, lease, generation, readiness, and latest observation
reuse the latest committed canonical Observation as before-Observation and evaluate preconditions
resolve one unique ElementRef
run Evidence preflight
append and fsync ActionPlanned
dispatch exactly once through DesktopPort
append validated ProviderReceipt
wait the configured Observation backoff, then capture/commit required after Observation with bounded safe retries
evaluate frozen assertions
derive ActionResult
append the Step projection events
```

Readiness, explicit observe, and every successful action-after capture already commit screenshot/UI-snapshot artifacts and an ObservationCaptured event. The immediately following action reuses that exact Observation and ArtifactRefs rather than issuing another full Provider capture. Before dispatch, Adapter live foreground, unique-window, hierarchy-aware target rebind, visibility, and geometry checks remain mandatory. Scenario/CLI and Pi-managed Runs share this rule.

Any failure before dispatch is `notDispatched`. A crash after durable ActionPlanned and before a reliable receipt leaves dispatch/outcome unknown and retry disposition `reconcileRequired`. Provider success without an independent passing assertion remains unverified. After-capture failure preserves known Provider facts, marks verification unverifiable and Evidence incomplete, stops further Scenario work, and continues bounded finalization.

Every action invalidates ElementRefs for affected windows. Assertions resolve new queries against the after Observation; they never reuse before-action ElementRefs. After Provider dispatch, Kernel never retries or reconstructs the action. Action-before and action-after Observation capture use `retry.observation.maxAttempts` and `retry.observation.backoffMs` within one `observeMs` stage deadline and the remaining Run deadline. Retry is limited to safe transient `ProviderFailure`, `ProviderTimeout`, `SessionUnavailable`, and `SnapshotIncomplete` errors; cancellation, application/window ownership failure, or any other error stops immediately. The retry chain retains the earliest safe normalized Provider cause, including a screenshot failure returned alongside a structured capture, and later source/session failures caused by the same degradation cannot replace it in the terminal result or diagnostic Evidence. After initial readiness, if retries exhaust solely because the Mac2 display screenshot failed while a current canonical UI snapshot and ownership facts are available, Kernel commits a structured-only Observation and marks Evidence incomplete. Before dispatch, this path permits only nonvisual actions with a unique live target and passing nonvisual preconditions; any visual precondition prevents dispatch. After dispatch, deterministic nonvisual assertions continue and screenshot diagnostics are preserved. Other exhaustion remains unverifiable and stops business work.

## Scenario And Verdict

Scenario steps execute in source order. Preconditions that fail or cannot be verified reject dispatch. Provider failure, unknown dispatch/outcome, failed/unverifiable required assertion, or after-Evidence failure stops subsequent business steps. Unexecuted steps are projected as `notRun`.

Immediate assertions determine an Action's verification. Deferred steps remain `notRequested`; later final assertions can establish the Run verdict but never retroactively confirm an individual deferred action. A Run is passed only when every required final assertion passes, failed when a required final assertion definitively fails, and inconclusive when required verification cannot be completed.

## Evidence Coordination

Kernel is the sole Evidence event writer and allocates strictly increasing per-Run sequence numbers. ActionPlanned is durable before dispatch. Kernel commits required artifacts and a deterministic Manifest projection through EvidencePort. Evidence failure never overwrites Provider or business facts and never blocks cleanup beyond its independent Evidence-finalization budget.

## Timeout, Cancellation, And Retry

Kernel uses injected monotonic time for durations, leases, freshness, backoff, and timeout. Every entry path uses the validated fixed 7,200,000 ms Run budget. Stage budgets cannot exceed the remaining Run budget. Cleanup has an independent fixed 120,000 ms reserved budget. AbortSignal requests cancellation but does not prove provider cancellation or rollback.

Only operations whose normalized retry disposition is `safe` may be retried, under operation-specific max attempts and the original stage budget. V1 never automatically retries Desktop action dispatch. Backoff is cancellable. Adapters do not retry internally.

## Recovery

While holding the global lock, Kernel validates state storage, loads unfinished Runs, enumerates managed clones, reconciles attribution, closes recoverable Mac2/Appium resources, attempts bounded Guest diagnostic export, destroys attributable clones, appends recovery events, and commits a new Manifest revision. Recovery never resumes business steps.

Unknown schema, damaged ownership state, unattributed/multiple managed clones, or failed cleanup returns `RecoveryRequired` and prevents a new Run. Unknown action dispatch/outcome remains unknown and makes the original Run inconclusive.

## Hooks

Hooks are ordered optional extensions over sanitized events. Configuration supplies serializable Hook module descriptors, not in-process callbacks. Each delivery executes in a fresh terminable Worker with cloned event input and AbortSignal-equivalent cancellation messaging. Workers return only strictly validated bounded contributions; they cannot provide required Evidence, write timeline/Manifest directly, change actions/state/results, access raw diagnostics, or decide dispatch. Timeout/cancellation terminates and awaits the Worker before Kernel appends `HookFailed` and continues; Hook JavaScript or handles cannot survive delivery return. Upload Hooks are disabled unless explicitly configured.

## Internal Structure

- Run/environment state machines and invariant guards.
- Readiness and lease/generation services.
- Action transaction and assertion orchestration.
- Evidence event/Manifest projection coordination.
- Timeout/retry/cancel helpers over injected Clock.
- Recovery and managed-resource reconciliation.
- Hook execution boundary.

## Architecture

- Architecture level: Level 2 application/domain core within the repository's layered package.
- Runtime boundary: provider-neutral in-process service.
- State ownership: Kernel owns all mutable Run workflow state; Adapters own only provider-local transient handles.
- Dependency direction: Contracts and injected Ports only.

## Error Handling

Expected failures are normalized OperationResults. Kernel preserves distinct dispatch, provider outcome, verification, retry, Evidence, cleanup, and verdict facts. Only violated internal invariants may throw. Cleanup failures are recorded separately and cannot replace an established verdict.

## Verification Scope

Unit tests cover every legal/illegal transition, application-resolution ordering, protected-application rejection before session creation, descriptor freezing, application-switch rejection, global lock behavior, configured-Run readiness freshness, Pi-selected interaction beyond initial probe expiry, lease/generation invalidation, latest-snapshot enforcement, ActionResult classification, assertion rules, post-dispatch settle/retry without action replay, earliest safe retry-cause preservation, sequence, timeout/cancel/retry, Hook isolation, recovery reconciliation, and cleanup/verdict independence. Semantic Port tests exercise the same Kernel path with Fakes.

## Current Invariants

- Kernel never branches on Provider names.
- Kernel never guesses missing dispatch or execution facts.
- No second operation overlaps an active lifecycle/observe/action/assertion operation.
- Recovery and cleanup remain active after ordinary cancellation.
- A Run has exactly one Kernel-frozen ApplicationDescriptor and cannot change application identity after resolution.
