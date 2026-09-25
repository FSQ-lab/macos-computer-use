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
Pi-managed timelines include one `FinalAssertionsFrozen` event after initial readiness and before goal-changing actions. It records only the nonzero assertion count and the current Observation ID; assertion text remains in runner/Kernel state and is not duplicated into event data.

### Operation And Error Results

```typescript
type OperationResult<T> = { ok: true; value: T } | { ok: false; error: OperationError };

type RetryDisposition = "safe" | "unsafe" | "reconcileRequired" | "notApplicable";
```

`OperationError` contains a stable `code`, phase (`image`, `vm`, `guest`, `driver`, `observe`, `action`, `evidence`, or `cleanup`), safe message, retry disposition, optional dispatch fact, and optional logical diagnostic reference. Raw stderr, response bodies, stacks, native IDs, and absolute paths are not public error fields.

Stable error codes include at least `InvalidConfiguration`, `InvalidScenario`, `UnsupportedRuntime`, `GatewayBusy`, `RecoveryRequired`, `RunClosed`, `LeaseExpired`, `ReadinessExpired`, `ImageDigestMismatch`, `ApplicationNotFound`, `ApplicationAmbiguous`, `ProtectedApplication`, `GuestPermissionNotGranted`, `SessionUnavailable`, `AppNotForeground`, `AmbiguousWindowOwner`, `StaleWindowRef`, `StaleElementRef`, `TargetNotFound`, `TargetAmbiguous`, `SnapshotIncomplete`, `UnsupportedAction`, `UnsupportedKey`, `ProviderFailure`, `ProviderTimeout`, `EvidenceIncomplete`, `EvidenceCorrupted`, and `CleanupFailed`.

### Action And Run Results

```typescript
type ActionResult = {
  dispatch: "notDispatched" | "dispatched" | "unknown";
  providerOutcome: "succeeded" | "failed" | "unknown";
  verification: "notRequested" | "confirmed" | "contradicted" | "unverifiable";
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

A canonical `Observation` binds Run, environment, generation, session, logical window, observation ID, captured time, optional screenshot ArtifactRef, required UI snapshot ArtifactRef, screenshot scope (`window`, `display`, or `unavailable`), completeness diagnostics, and logical element summaries. Each summary may include one same-Observation logical `parentElementId` plus bounded nonnegative `depth`; roots omit the parent. Parent references must resolve inside the same complete internal selected-window snapshot and never expose a native handle. The Mac2 Adapter produces only `display` through the bounded `macos: screenshots` command or `unavailable`; the shared schema retains `window` for provider-neutral compatibility but no current production Adapter emits it. `unavailable` is permitted after initial readiness for an action-before or action-after Observation whose structured UI capture and ownership checks succeeded while the Mac2 display image failed. Display scope may include other visible Guest UI. It never exposes Appium/WDA/native IDs.

Element summaries may expose observation-only geometry (`x`, `y`, `width`, `height`) as descriptive data. This does not authorize absolute-coordinate action inputs or fallback. Element-targeted actions still use ElementRefs and, where applicable, normalized relative positions; converted action pixel offsets remain Adapter-private.

`ElementSelector` is a strict nonempty flat conjunction of neutral role, identifier, exact/contains name, label, value, and enabled/selected/focused state filters. `ElementQuery` contains the target selector fields plus optional `ancestor` and `descendant` ElementSelectors. Relationship selectors cannot contain another relationship. `ancestor` means at least one transitive logical ancestor matches; `descendant` means at least one transitive logical descendant matches. Both relationships remain inside the selected window and latest bounded snapshot. Query results are `unique`, `ambiguous`, `notFound`, or `incomplete` and include at most 100 bounded safe candidates; unknown state is not false. Only a unique target result creates an `ElementRef`.

`WindowQuery` supports title text matching, role, main-window and modal filters. Window selection must be unique.

`ElementRef` binds Run, environment, generation, session, window, and latest observation. It is short-lived and cannot be authored in Scenario JSON.

### Element-Relative Actions

`RelativePoint` has finite `x` and `y` in the inclusive range 0..1. `ElementPoint` combines an ElementRef with an optional point defaulting to `(0.5, 0.5)`. No action schema accepts an absolute coordinate.

Desktop actions are a discriminated union:

- `click`, `doubleClick`, `rightClick`, and `hover` target an ElementPoint and optional neutral modifiers.
- `scroll` targets an ElementPoint and finite normalized x/y deltas relative to element dimensions.
- `swipe` targets an ElementPoint with direction and optional `slow`, `default`, or `fast` velocity profile.
- `drag` has source and destination ElementPoints plus optional bounded duration.
- `typeText` accepts literal text or SecretRef, accepts no public ElementRef, and rejects newline/return/control characters. It has one uniform provider-neutral meaning for native applications and WebView content: send ordered application-scoped keyboard input containing exactly one Unicode code point per Provider call to the application's current focus. It never queries or carries a focused/native element ID and never selects behavior by application or control type. It types at the existing focused control and caret without hidden focus, selection, clearing, replacement, append, caret movement, or submission. No Observation is captured between characters. A partial Provider failure never replays prior characters and remains an unknown final outcome. `appendText` and `replaceText` are invalid action kinds.
- `pressKey` accepts one stable special key or one printable Unicode character and zero or more unique modifiers from command/control/option/shift/function. It accepts no ElementRef and is always application-scoped through Mac2 `macos: keys`. Focusing a particular control is represented by a preceding independent click action; clearing/replacing/submitting is represented by separately evidenced key operations.

Unsupported or invalid actions fail before dispatch. Action contracts do not contain native IDs, arbitrary Mac2 payloads, XPath, predicate strings, AppleScript, clipboard, lifecycle, or recording commands.

### Application Selection

`ApplicationTarget` contains one trimmed display `name` of 1..200 Unicode characters. It rejects control characters, path separators, names equal to `.` or `..`, bundle-ID-shaped values, executable/path suffixes, globs, and fuzzy-search syntax. Ordinary punctuation inside a display name remains valid. Names are normalized to Unicode NFC for comparison.

`ApplicationDescriptor` is produced only by Guest resolution for Pi-managed application selection and contains the canonical display name, validated bundle ID, optional version/build, and a location class of `system` or `user`. It contains no Guest path. Pi input cannot author or override a descriptor or bundle ID.

Application resolution enumerates regular `.app` bundle directories under fixed standard Guest roots: `/Applications`, `/System/Applications`, `/System/Cryptexes/App/System/Applications`, and the automation user's `Applications`. It reads bounded Info.plist identity metadata from the unique match. Matching is locale-independent, case-insensitive, exact bundle-directory display-name matching after stripping one `.app` suffix. Zero matches return `ApplicationNotFound`; multiple matches return `ApplicationAmbiguous`; neither condition starts Appium or the application.

Kernel rejects a fixed bundle-ID denylist containing Passwords, Keychain Access, System Settings, Installer, Terminal, Script Editor, Automator, Shortcuts, SecurityAgent, and loginwindow. Configuration, Scenario, and Pi input cannot override this policy.

### Assertions And Scenario

Assertions are discriminated, predeclared schemas for visible, notVisible, text, value, state, elementOrder, and explicitly accepted AI visual evaluation. Assertion results are `passed`, `failed`, or `unverifiable` and reference the later Observation evidence used.

A strict `Scenario` retains `schemaVersion: 1` and the existing configured-AUT behavior in this increment. Pi-managed tasks carry ApplicationTarget through their private protocol instead of Scenario. Scenario cannot contain ApplicationTarget, bundle-ID override, application path, ElementRefs, native IDs, absolute paths, absolute coordinates, scripts, lifecycle operations, variables, loops, parallel branches, or sub-scenarios.

### Configuration And Secrets

`GatewayConfig` retains its existing immutable image, default AUT bundle/window/arguments/environment allowlist, timeout, Evidence, retry, compatibility, bounded Artifact, and NetworkRules fields for CLI/Scenario compatibility. `timeouts.runTotalMs` is fixed at 7,200,000 for every Pi, Public Client, CLI, and Scenario Run, and `timeouts.cleanupMs` is fixed at 120,000. Other values fail strict configuration validation. Pi application-name selection may override only the AUT identity/window for one Pi-managed Run after Guest resolution; it cannot override launch arguments, environment secrets, image, Evidence, or lifecycle policy. Unknown fields are rejected.

Image compatibility and Fixture metadata remain version 2 configuration facts in this increment. Pi application-name resolution happens after existing Guest readiness and before Appium session creation; it does not change image compatibility schemas.

Hook configuration is a strict serializable module descriptor containing a validated name and absolute module path. Hook modules execute only in terminable Worker isolation and export the documented async handler. Arbitrary in-process Hook callbacks are not a public contract.

`NetworkRule` remains in GatewayConfig for compatibility, but this early-stage profile accepts only an empty array. Nonempty rules fail validation as unsupported. Empty rules mean fixed shared/NAT Internet access.

`SecretRef` contains an allowlisted name and purpose `textInput` or `appEnvironment`. It never contains the secret value.

### Persistence

Persisted record schemas remain unchanged: effective configuration and environment snapshots stay at `schemaVersion: 2`. Pi-selected application identity is not added to a new snapshot version in this increment. Existing Run events, observations, action facts, result, Evidence finalization, and cleanup remain mandatory. Richer application/network Evidence is deferred.

### Ports

Contracts exports provider-neutral `ImagePort`, `VmPort`, `GuestPort`, `DesktopPort`, and `EvidencePort`. `GuestPort.resolveApplication` accepts ApplicationTarget and returns one ApplicationDescriptor without launching it. Kernel rejects protected Pi-selected descriptors and uses the frozen bundle ID for that Run's existing SessionRequest shape. Configured Runs keep their existing SessionRequest path. Resource and driver-channel handles are opaque logical identifiers; Provider endpoints, application paths, and native naming remain inside Adapter composition.

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

Schema failures return normalized safe validation issues without embedding secret or arbitrary source values. Type assertions do not substitute for parsing. Cross-field rules such as source/destination action completeness, timeout bounds, and required assertions are enforced by schemas; Run-context legality remains Kernel-owned.

## Verification Scope

Tests cover valid/invalid parsing, unknown-field rejection, brands, discriminated unions, cross-field constraints, secret-safe errors, schema-version rejection, and compile-time/public-export behavior.

## Current Invariants

- Static TypeScript types never establish runtime trust.
- Provider and Host implementation details never enter neutral Contracts.
- No action schema can encode absolute coordinates.
- Public IDs cannot be substituted for one another without validation.
- Pi/Agent input cannot encode a bundle ID or application path. Existing trusted configuration retains its default bundle ID for non-Pi compatibility.

## Network Profile

The existing NetworkRule contract remains parseable only for schema compatibility, but this early-stage runtime accepts `network: []` only. Empty rules select shared/NAT outbound Internet, disabled clipboard, and disabled public forwarding.

## Explicit AI Visual Evaluation

AI visual evaluation is disabled by default. The Client factory accepts an optional caller-injected visual evaluator separately from serializable GatewayConfig; it is not a provider override. Only a predeclared aiVisual assertion with accepted=true may invoke it. It receives a copy of the current Observation display screenshot, logical observation identity and goal, plus cancellation. Its model identity and strict passed/failed/unverifiable response are validated. The result records the model and screenshot ArtifactRef with the Observation; missing, stale, cancelled or malformed evaluation is unverifiable. No model service, credential, upload destination or background evaluation is inferred.
