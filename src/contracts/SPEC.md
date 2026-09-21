# Module: contracts

## Purpose

Contracts owns every provider-neutral data shape that crosses a module or persistence boundary. Zod schemas are runtime authority; exported TypeScript types are inferred from those schemas. Contracts contains no workflow orchestration and no Tart, Appium, Mac2, filesystem, process, or CLI implementation type.

## Dependencies

- External: Zod only for runtime schema definition and branding.
- Project: none.
- Forbidden: Node filesystem/process APIs, Provider clients, Kernel, Client, CLI, and concrete Adapters.

## Public Interface

The module public entry point exports the following schema/type families. Unknown object fields are rejected at external and persistence boundaries.

### Identity And Time

`RunId`, `ActionId`, `ObservationId`, `AssertionId`, `ArtifactId`, `SessionId`, `WindowId`, `ElementId`, `LeaseId`, and `OperationId` are distinct validated branded strings. Kernel generates public IDs using UUIDv7 or an equivalently secure time-sortable format. IDs contain no user data, paths, Provider names, or secrets.

Events carry UTC `recordedAt`, monotonic `elapsedMs`, and a non-negative integer `sequence`. Sequence is the only ordering authority.

### Operation And Error Results

```typescript
type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OperationError };

type RetryDisposition =
  | "safe"
  | "unsafe"
  | "reconcileRequired"
  | "notApplicable";
```

`OperationError` contains a stable `code`, phase (`image`, `vm`, `guest`, `driver`, `observe`, `action`, `evidence`, or `cleanup`), safe message, retry disposition, optional dispatch fact, and optional logical diagnostic reference. Raw stderr, response bodies, stacks, native IDs, and absolute paths are not public error fields.

Stable v1 error codes include at least `InvalidConfiguration`, `InvalidScenario`, `UnsupportedRuntime`, `GatewayBusy`, `RecoveryRequired`, `RunClosed`, `LeaseExpired`, `ReadinessExpired`, `ImageDigestMismatch`, `GuestPermissionNotGranted`, `SessionUnavailable`, `AppNotForeground`, `AmbiguousWindowOwner`, `StaleWindowRef`, `StaleElementRef`, `TargetNotFound`, `TargetAmbiguous`, `SnapshotIncomplete`, `UnsupportedAction`, `UnsupportedKey`, `ProviderFailure`, `ProviderTimeout`, `EvidenceIncomplete`, `EvidenceCorrupted`, and `CleanupFailed`.

### Action And Run Results

```typescript
type ActionResult = {
  dispatch: "notDispatched" | "dispatched" | "unknown";
  providerOutcome: "succeeded" | "failed" | "unknown";
  verification:
    | "notRequested"
    | "confirmed"
    | "contradicted"
    | "unverifiable";
  retryDisposition: "safe" | "unsafe" | "reconcileRequired";
};

type RunResult = {
  verdict: "passed" | "failed" | "inconclusive";
  evidence: "complete" | "incomplete";
  cleanup: "completed" | "failed";
};
```

`Idempotency` is `idempotent`, `nonIdempotent`, or `unknown` and remains independent of retry disposition. Provider success alone never produces `confirmed`.

### Provider Receipt

`ProviderReceipt` contains Provider name, Kernel operation ID, dispatch (`notDispatched`, `dispatched`, `unknown`), outcome (`succeeded`, `failed`, `unknown`), start/end time, and optional diagnostic ArtifactRef. It cannot contain Provider-native identifiers or a business-verification verdict.

### Observation And Query

A canonical `Observation` binds Run, environment, generation, session, logical window, observation ID, captured time, screenshot/UI snapshot ArtifactRefs, completeness diagnostics, and logical element summaries. It never exposes Appium/WDA/native IDs.

`ElementQuery` supports conjunctive neutral role, identifier, exact/contains name, label, value, and enabled/selected/focused state filters. Query results are `unique`, `ambiguous`, `notFound`, or `incomplete`. Unknown state is not false. Only a unique result creates an `ElementRef`.

`WindowQuery` supports title text matching, role, main-window and modal filters. Window selection must be unique.

`ElementRef` binds Run, environment, generation, session, window, and latest observation. It is short-lived and cannot be authored in Scenario JSON.

### Element-Relative Actions

`RelativePoint` has finite `x` and `y` in the inclusive range 0..1. `ElementPoint` combines an ElementRef with an optional point defaulting to `(0.5, 0.5)`. No action schema accepts an absolute coordinate.

Desktop actions are a discriminated union:

- `click`, `doubleClick`, `rightClick`, and `hover` target an ElementPoint and optional neutral modifiers.
- `scroll` targets an ElementPoint and finite normalized x/y deltas relative to element dimensions.
- `swipe` targets an ElementPoint with direction and optional `slow`, `default`, or `fast` velocity profile.
- `drag` has source and destination ElementPoints plus optional bounded duration.
- `appendText` and `replaceText` target an ElementRef and accept literal text or SecretRef.
- `pressKey` accepts one stable supported key and zero or more unique modifiers from command/control/option/shift/function.

Unsupported or invalid actions fail before dispatch. Action contracts do not contain native IDs, arbitrary Mac2 payloads, XPath, predicate strings, AppleScript, clipboard, lifecycle, or recording commands.

### Assertions And Scenario

Assertions are discriminated, predeclared schemas for visible, notVisible, text, value, state, elementOrder, and explicitly accepted AI visual evaluation. Assertion results are `passed`, `failed`, or `unverifiable` and reference the later Observation evidence used.

A strict `Scenario` has `schemaVersion: 1`, a safe non-empty name, ordered unique step IDs, at least one final assertion, and no control flow. Each step has optional WindowQuery and preconditions, an ElementQuery target, one ActionSpec, and explicit `immediate` assertions or `deferred` verification. Scenario cannot contain ElementRefs, native IDs, absolute paths, absolute coordinates, scripts, lifecycle operations, variables, loops, parallel branches, or sub-scenarios.

### Configuration And Secrets

`GatewayConfig` strictly owns immutable OCI reference/digest, AUT bundle ID and allowlisted arguments/environment keys, phase/Run/cleanup timeouts, Evidence root/retention, retry profiles, compatible runtime versions, bounded Artifact policies, and frozen NetworkRules. Unknown fields are rejected.

`NetworkRule` contains a non-open CIDR, non-empty bounded port list, and TCP/UDP protocol. Domain rules and unrestricted CIDRs are invalid.

`SecretRef` contains an allowlisted name and purpose `textInput` or `appEnvironment`. It never contains the secret value.

### Persistence

Each persisted record family carries independent `schemaVersion: 1`. Writers emit only current versions. Readers reject interpretation of unknown or higher versions while preserving the bytes. Persisted contracts include typed Evidence events, resource ownership records, Run index entries, Artifact descriptors, Step projections, Manifest revisions, and sanitized effective configuration snapshots.

### Ports

Contracts exports provider-neutral `ImagePort`, `VmPort`, `GuestPort`, `DesktopPort`, and `EvidencePort`. Every asynchronous provider operation accepts an `AbortSignal` and returns validated neutral results or normalized errors. Ports perform one provider operation per call and contain no retry or orchestration contract.

## Internal Structure

- Public schema modules are organized by the owned families above and re-exported through `src/contracts/index.ts`.
- Shared schema primitives remain internal unless consumers require them as a public contract.
- There is no generic untyped metadata dictionary in public or persisted contracts.

## Architecture

- Architecture level: Level 1 inside the module, serving the repository's Level 2 boundary.
- Runtime boundary: pure schema/type definitions and parsing.
- Dependency direction: leaf module imported by Kernel, Adapters, Client, and CLI.
- Validation boundary: external and persisted values are parsed once on entry; internal code receives validated values.

## Error Handling

Schema failures return normalized safe validation issues without embedding secret or arbitrary source values. Type assertions do not substitute for parsing. Cross-field rules such as source/destination action completeness, timeout bounds, non-open CIDRs, and required assertions are enforced by schemas; Run-context legality remains Kernel-owned.

## Verification Scope

Tests cover valid/invalid parsing, unknown-field rejection, brands, discriminated unions, cross-field constraints, secret-safe errors, schema-version rejection, and compile-time/public-export behavior.

## Current Invariants

- Static TypeScript types never establish runtime trust.
- Provider and Host implementation details never enter neutral Contracts.
- No action schema can encode absolute coordinates.
- Public IDs cannot be substituted for one another without validation.
