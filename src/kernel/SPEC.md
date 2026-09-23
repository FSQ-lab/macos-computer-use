# Module: kernel

## Purpose

Kernel owns all provider-neutral orchestration and policy: global serialization, Run allocation, environment lifecycle, readiness, leases/generations, action transactions, assertion coordination, mandatory Evidence sequencing, timeout/cancel/retry, Hook isolation, crash recovery, and final Run classification.

## Dependencies

- Project: public `contracts` only.
- Injected: ImagePort, VmPort, GuestPort, DesktopPort, EvidencePort, Clock, IdGenerator, GatewayLock, and configured Hooks.
- Forbidden: concrete Adapter imports, Tart/Appium/Mac2 types, CLI formatting, direct filesystem/process/network access.

## Public Interface

Kernel exposes an internal application service consumed only by Client. It accepts validated configuration and Scenario/callback operations, returns neutral OperationResults, logical observations/references, and complete RunResults, and provides recovery/read-only Run operations needed by Client. It does not expose Ports or provider instances.

## Environment And Run State

Environment lifecycle is `allocating`, `active`, `cleaningUp`, `closed`, or `failed`. Readiness is a separate aggregate of VM, Guest, Driver, and App probes with result time, expiry, duration, and diagnostic reference. Overall ready requires every required probe to be successful and fresh.

VM, Guest, session, or AUT reconstruction increments generation and invalidates all prior WindowRefs, Observations, and ElementRefs. Each Run has one exclusive lease. Expired/revoked/mismatched leases reject new operations before dispatch but never suppress finalization or cleanup.

AUT becomes callable only after App readiness selects one unique target window. Kernel activates AUT once during readiness. Focus loss, system UI, unknown windows, or permission prompts stop new business work; Kernel does not silently reactivate or operate them.

## Global Serialization

Kernel acquires the injected per-user OS lock before recovery or Run allocation and holds it through final state persistence and cleanup. Lock contention returns `GatewayBusy`; there is no queue. Before allocating a new clone, Kernel reconciles unfinished Run records with actual managed Tart resources.

## Action Transaction

For each action Kernel serially performs:

```text
validate lock, lease, generation, readiness, and latest observation
capture/commit required before Observation and evaluate preconditions
resolve one unique ElementRef
run Evidence preflight and commit required before artifacts
append and fsync ActionPlanned
dispatch exactly once through DesktopPort
append validated ProviderReceipt
capture/commit required after Observation
evaluate frozen assertions
derive ActionResult
append the Step projection events
```

Any failure before dispatch is `notDispatched`. A crash after durable ActionPlanned and before a reliable receipt leaves dispatch/outcome unknown and retry disposition `reconcileRequired`. Provider success without an independent passing assertion remains unverified. After-capture failure preserves known Provider facts, marks verification unverifiable and Evidence incomplete, stops further Scenario work, and continues bounded finalization.

Every action invalidates ElementRefs for affected windows. Assertions resolve new queries against the after Observation; they never reuse before-action ElementRefs.

## Scenario And Verdict

Scenario steps execute in source order. Preconditions that fail or cannot be verified reject dispatch. Provider failure, unknown dispatch/outcome, failed/unverifiable required assertion, or after-Evidence failure stops subsequent business steps. Unexecuted steps are projected as `notRun`.

Immediate assertions determine an Action's verification. Deferred steps remain `notRequested`; later final assertions can establish the Run verdict but never retroactively confirm an individual deferred action. A Run is passed only when every required final assertion passes, failed when a required final assertion definitively fails, and inconclusive when required verification cannot be completed.

## Evidence Coordination

Kernel is the sole Evidence event writer and allocates strictly increasing per-Run sequence numbers. ActionPlanned is durable before dispatch. Kernel commits required artifacts and a deterministic Manifest projection through EvidencePort. Evidence failure never overwrites Provider or business facts and never blocks cleanup beyond its independent Evidence-finalization budget.

## Timeout, Cancellation, And Retry

Kernel uses injected monotonic time for durations, leases, freshness, backoff, and timeout. Stage budgets cannot exceed the remaining Run budget. Cleanup has an independent reserved budget. AbortSignal requests cancellation but does not prove provider cancellation or rollback.

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

Unit tests cover every legal/illegal transition, global lock behavior, readiness freshness, lease/generation invalidation, latest-snapshot enforcement, ActionResult classification, assertion rules, sequence, timeout/cancel/retry, Hook isolation, recovery reconciliation, and cleanup/verdict independence. Semantic Port tests exercise the same Kernel path with Fakes.

## Current Invariants

- Kernel never branches on Provider names.
- Kernel never guesses missing dispatch or execution facts.
- No second operation overlaps an active lifecycle/observe/action/assertion operation.
- Recovery and cleanup remain active after ordinary cancellation.
