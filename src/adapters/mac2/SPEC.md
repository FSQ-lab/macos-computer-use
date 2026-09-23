# Module: adapters.mac2

## Purpose

Implement DesktopPort through Appium 3 and Mac2 Driver 4.3.1 in the Guest. Own explicit session lifecycle, canonical window-scoped Observation, compact and structured views, safe element resolution, element-relative actions, deterministic assertions inputs, Provider Receipts, and capability/version checks.

## Dependencies

- Project: public `contracts`.
- External: a compatible Appium WebDriver client and W3C Actions support.
- Runtime: Guest Appium 3, Mac2 4.3.1, compatible WDA Mac/Xcode image metadata.
- Forbidden: Tart lifecycle, Evidence layout, Kernel result policy, arbitrary `macos:*` passthrough, AppleScript, absolute-coordinate action APIs.

## Public Interface

The DesktopPort implementation starts/stops one explicit session, observes a selected AUT window, queries/expands the latest canonical snapshot, dispatches one validated neutral DesktopAction, and returns a neutral ProviderReceipt. Public outputs never contain Appium/WDA element/session/window IDs, endpoints, XPath, predicates, raw page source, or converted action pixel offsets. Observation-only element geometry (`x`, `y`, `width`, `height`) may be exposed as descriptive data; it is not an action target or an absolute-coordinate fallback.

## Session And Window Boundary

- The session targets the configured preinstalled AUT bundle ID.
- Readiness verifies a real session and base Observation, not a port or process alone.
- One AUT is active per Run. AUT-owned windows, sheets, popovers, and resolvable menu elements are allowed; system/permission/other-app UI is rejected.
- WindowQuery must uniquely identify the current window. Focus loss returns `AppNotForeground`; the Adapter does not reactivate the app during business execution.

## Canonical Observation

Window screenshots are captured normally, without secret masking or secret-content inspection, and remain potentiallySensitive Evidence. Displayed secret text does not by itself make capture incomplete or disable an explicitly accepted visual assertion. Structured UI text remains subject to known-secret sanitization.

One Observation captures one canonical Mac2 page source plus a window-scoped screenshot within a stable capture window; the two are not represented as perfectly simultaneous. It records coverage/truncation diagnostics and creates logical element identities mapped privately to native handles.

Two deterministic projections share the same snapshot and logical Element IDs:

- Compact view: bounded lines containing snapshot/app/window identity, neutral role, primary text, key states, coverage and truncation.
- Structured query/expand view: complete usable locator signals, neutral/native type mapping, state, geometry, match cardinality, continuation and truncation diagnostics.

Compact absence never proves element absence. Structured queries scan the unabridged bounded internal source before display clipping. Incomplete scanning never returns an exhaustive notFound claim.

## Element Resolution

Query fields constrain the same element conjunctively. The Adapter safely encodes literal values and never weakens a failed query. Action and assertion targets require a unique live match. Ambiguity returns bounded candidate summaries and no effect. A latest-snapshot ElementRef is revalidated against generation/session/window and live state immediately before dispatch.

## Element-Relative Actions

- No action implementation accepts or falls back to absolute screen/window coordinates.
- Pointer, scroll, swipe, right-click, hover, and double-click use Mac2 element endpoints whose `x` and `y` values are offsets from the element's top-left corner. The Adapter fetches current element geometry immediately before dispatch and resolves each normalized axis as `ratio * currentSize`. These values remain element-relative offsets and never become public or fallback absolute coordinates. Exact edges are safely inset when necessary.
- Scroll normalized deltas are converted relative to current element dimensions.
- Swipe maps direction and controlled velocity profile to Mac2.
- Drag uses W3C pointer actions with source/destination element origins. W3C element-origin offsets are center-based, so each normalized axis resolves as `(ratio - 0.5) * currentSize`. Drag may not be implemented by calculating and sending absolute screen endpoints. Startup capability checks and provider conformance must prove this W3C path; otherwise drag fails as unsupported before dispatch.
- Replace text uses element set-value and never degrades to a multi-action keyboard sequence. Append text and pressKey use Mac2 keys with neutral key/modifier mapping.
- Double click is one native provider dispatch, not two Kernel actions.

## Provider Receipt

The Adapter emits only what the provider proves: dispatch and outcome may be unknown. Receipt operation ID is Kernel-owned. Raw responses and native IDs stay in controlled diagnostics. Receipt never states business verification.

## Error Handling

Stable resolution reasons distinguish invalid query, not found, ambiguous, incomplete/stale snapshot, unsupported action/key, session unavailable, app not foreground, timeout, transport, and provider failure. Timeout/cancellation never guesses whether an action occurred. Validation and unsupported capability failures happen before dispatch.

## Internal Structure

- Appium client/session and capability probe.
- AUT/window ownership and focus checks.
- Bounded page-source parser and canonical snapshot store.
- Compact renderer and structured query/expand engine.
- Private logical-to-native element mapping.
- Element-relative action translator and key mapping.
- Provider response/receipt/error normalization.

## Architecture

- Architecture level: Level 2 infrastructure Adapter.
- Runtime boundary: Host WebDriver client to Guest Appium Mac2.
- State boundary: provider-native session/element handles are Adapter-private and generation-bound.
- Dependency direction: Contracts plus WebDriver client only.

## Verification Scope

Offline tests cover parser bounds, compact determinism, query conjunction/escaping, ambiguity, incomplete coverage, latest-snapshot invalidation, native-ID containment, ratio validation/conversion, edge inset, capability rejection, text/key semantics, and receipt classification. Provider tests verify Mac2 4.3.1 click/double/right click/hover/scroll/swipe, supported element-relative drag, append/replace text, keys, screenshots, page source, focus/window behavior, timeout/cancel, and no absolute-coordinate command path.

## Current Invariants

- Observation is not an assertion.
- Only the latest window Observation is actionable.
- Native IDs and converted action pixel offsets never cross the Adapter boundary. Observation-only geometry may cross the boundary, but actions accept only the declared element references and normalized relative positions, never absolute coordinates.
- A Driver success response never confirms business effect.

## Explicit AI Visual Evaluation

AI visual evaluation is disabled by default. The Client factory accepts an optional caller-injected visual evaluator separately from serializable GatewayConfig; it is not a provider override. Only a predeclared aiVisual assertion with accepted=true may invoke it. It receives a copy of the current Observation window screenshot, logical observation identity and goal, plus cancellation. Its model identity and strict passed/failed/unverifiable response are validated. The result records the model and screenshot ArtifactRef with the Observation; missing, stale, cancelled or malformed evaluation is unverifiable. No model service, credential, upload destination or background evaluation is inferred.
