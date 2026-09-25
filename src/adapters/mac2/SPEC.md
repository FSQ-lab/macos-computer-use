# Module: adapters.mac2

## Purpose

Implement DesktopPort through Appium 3.7.0 and Mac2 Driver 4.3.5 in the Guest. Own explicit session lifecycle, canonical window-scoped Observation, compact and structured views, safe element resolution, element-relative actions, deterministic assertions inputs, Provider Receipts, and capability/version checks.

## Dependencies

- Project: public `contracts`.
- External: a compatible Appium WebDriver client and W3C Actions support.
- Runtime: Guest Appium 3.7.0, Mac2 4.3.5, compatible WDA Mac/Xcode image metadata.
- Forbidden: Tart lifecycle, Evidence layout, Kernel result policy, arbitrary `macos:*` passthrough, AppleScript, absolute-coordinate action APIs.

## Public Interface

The DesktopPort implementation starts/stops one explicit session for either the configured AUT or a Kernel-frozen Pi-selected application, observes one owned window, queries/expands the latest canonical snapshot, dispatches one validated neutral DesktopAction, and returns a neutral ProviderReceipt. Public/Pi outputs never contain bundle IDs, Appium/WDA element/session/window IDs, endpoints, XPath, predicates, raw page source, or converted action pixel offsets.

## Session And Window Boundary

- Configured Runs retain the current bundle ID/window path. A Pi-managed session instead targets the Kernel-frozen ApplicationDescriptor bundle ID resolved by GuestPort; Pi input cannot supply or override it.
- Every Session requests Appium `newCommandTimeout` of 3,000 seconds. After creation the Adapter reads the effective timeout state and requires the command timeout to equal 3,000,000 ms; an absent, malformed, or different value fails Session readiness. This idle timeout resets after each Appium command and never extends the Kernel-owned Run or cleanup budgets.
- Readiness verifies a real session and base Observation, not a port or process alone.
- One selected application is active per Run. Its windows, sheets, popovers, and resolvable menu elements are allowed; system/permission/other-app UI is rejected.
- A per-step WindowQuery must uniquely identify an owned window. For Pi-selected application readiness the Kernel supplies a role-only window query, which succeeds only when exactly one owned window exists; zero or multiple windows fail closed. Focus loss returns `AppNotForeground`; the Adapter does not reactivate during business execution.

## Canonical Observation

Screenshots are captured normally, without secret masking or secret-content inspection, and remain potentiallySensitive Evidence. After the Adapter has freshly verified page source, frozen-application foreground state, and one unique owned target window, it calls only the provider-owned `macos: screenshots` command. The Adapter strictly parses the bounded result and accepts only one entry with `isMain=true` and valid nonempty base64 PNG payload. It never calls a window-element screenshot endpoint, standard WebDriver session screenshot, Host screenshot API, or another provider. If the Mac2 display command fails, the Adapter may return the already validated structured capture plus a bounded safe screenshot error; it cannot claim an image. Kernel rejects this during initial readiness but may use it for bounded structured-only action-before or action-after processing. The Observation records image scope as `display` or `unavailable`; unavailable has no screenshot ArtifactRef. The command cannot activate an application, change focus, or dismiss UI. Visual assertions require an image and are unverifiable when scope is unavailable. Structured UI text remains subject to known-secret sanitization.

One Observation captures one canonical Mac2 page source plus one Mac2 main-display screenshot within a stable capture window; the two are not represented as perfectly simultaneous. Successful image scope is always `display`. It records coverage/truncation diagnostics and creates logical element identities mapped privately to native handles.

Page source prefers standard Mac2/WDA `/source`. If it fails, the Adapter may invoke exactly one provider-owned `macos: source` with `format: xml`. Both paths feed the identical bounded XML parser and selected-window ownership checks; the fallback cannot activate the app, alter focus, or bypass sanitization. The action is never replayed.

Two deterministic projections share the same snapshot, logical Element IDs, and bounded logical parent/depth relationships:

- Compact view: bounded indented lines containing snapshot/app/window identity, logical Element ID, logical parent when present, depth, stable accessibility identifier when present, neutral role, primary text, key states, coverage and truncation. The identifier is a locator signal, not a provider-native ID.
- Structured query/expand view: complete usable locator signals, logical parent/depth, neutral/native type mapping, state, geometry, match cardinality, continuation and truncation diagnostics.

Compact absence never proves element absence. Structured queries scan the unabridged bounded internal source before display clipping. Incomplete scanning never returns an exhaustive notFound claim.

## Element Resolution

Target selector fields constrain the same element conjunctively. Optional flat ancestor and descendant selectors are evaluated against the canonical parsed hierarchy, transitively but only within the selected window; caller input never contains XPath, class-chain predicates, or native IDs. The Adapter safely generates and escapes a Mac2 class-chain locator for ordinary flat target rebind and a bounded Adapter-owned XPath only for relationship rebind; it never weakens a failed query. Action and assertion targets require a unique live target match. Ambiguity returns bounded candidate summaries and no effect. A latest-snapshot ElementRef is revalidated immediately before dispatch against generation/session and one live target query. Native geometry narrows duplicate provider representations without authorizing coordinate actions. Targetless keyboard actions instead use live application foreground state plus unique owned-window resolution. Dispatch does not fetch a second full page source or screenshot: the committed canonical before-Observation supplies structural authority, the lightweight live checks supply current ownership/target authority, and the mandatory after-Observation captures the next full source and display screenshot.

## Element-Relative Actions

- No action implementation accepts or falls back to absolute screen/window coordinates.
- Pointer, scroll, swipe, right-click, hover, and double-click use Mac2 element endpoints whose `x` and `y` values are offsets from the element's top-left corner. The Adapter fetches current element geometry immediately before dispatch and resolves each normalized axis as `ratio * currentSize`. These values remain element-relative offsets and never become public or fallback absolute coordinates. Exact edges are safely inset when necessary.
- Scroll normalized deltas are converted relative to current element dimensions.
- Swipe maps direction and controlled velocity profile to Mac2.
- Drag uses W3C pointer actions with source/destination element origins. W3C element-origin offsets are center-based, so each normalized axis resolves as `(ratio - 0.5) * currentSize`. Drag may not be implemented by calculating and sending absolute screen endpoints. Startup capability checks and provider conformance must prove this W3C path; otherwise drag fails as unsupported before dispatch.
- TypeText accepts no public ElementRef. After live foreground/window validation it sends the requested literal or in-memory resolved SecretRef through ordered application-scoped Mac2 `macos: keys` calls containing exactly one Unicode code point each. Every call omits `elementId`; the Adapter never calls `GET /element/active` and never branches by application, native control, or WebView control. It does not capture Observation between characters. Newline, return, control characters, and empty text are rejected before key dispatch. The caller establishes focus through a separate action; TypeText does not perform a separate focus probe. If a later character call fails after at least one successful dispatch, the Adapter stops, never replays prior characters, and returns unknown Provider outcome with reconcile-required disposition. TypeText neither focuses a control nor synthesizes clearing, selection, replacement, append, caret movement, or submission. The Adapter never issues POST, PUT, or PATCH to any WebDriver element-value endpoint; element value remains Observation/query/assertion input only.
- Double click is one native provider dispatch, not two Kernel actions.
- PressKey uses the application-scoped Mac2 `macos: keys` command exactly once and never uses WebDriver element-value. It accepts no ElementRef and maps either one supported special key or one printable Unicode character plus modifiers. A caller that needs a particular control focused must dispatch and independently verify a preceding element click; the Adapter does not synthesize click-plus-key or fall back between keyboard commands.

## Provider Receipt

The Adapter emits only what the provider proves: dispatch and outcome may be unknown. Receipt operation ID is Kernel-owned. Raw responses and native IDs stay in controlled diagnostics. Receipt never states business verification.

## Error Handling

Stable resolution reasons distinguish invalid query, not found, ambiguous, incomplete/stale snapshot, unsupported action/key, invalid element state, session unavailable, app not foreground, timeout, transport, and provider failure. For a rejected WebDriver command, the Adapter retains only a bounded allowlisted provider error category, operation family, and safe process-availability classification; raw response bodies, stacks, paths, native IDs, user text, and secrets remain excluded. A response stating that the Mac2/WebDriverAgentMac server process is not running, cannot proxy because the process exited, or otherwise proves the Provider session process unavailable maps to `SessionUnavailable`, not generic `ProviderFailure`. Observation errors remain normalized so Kernel can distinguish the finite safe transient retry set from application/window ownership loss. The earliest safe normalized Provider cause in an Observation attempt is preserved for Kernel retry diagnostics rather than being overwritten by a fallback failure. Timeout/cancellation never guesses whether an action occurred. Validation and unsupported capability failures happen before dispatch.

## Internal Structure

- Appium client/session and capability probe.
- Selected-application/window ownership and focus checks.
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

Offline tests cover parser bounds, standard-source and Mac2-source fallback gating/failure, compact determinism, query conjunction/escaping, ambiguity, incomplete coverage, latest-snapshot invalidation, native-ID containment, ratio validation/conversion, edge inset, capability and effective-timeout rejection, application-scoped one-call-per-code-point `typeText`, complete absence of active-element lookup and `elementId` in text-key payloads, partial-failure no-replay classification, special/printable `pressKey`, rejected text controls, total absence of element-value writes, exclusive Mac2 main-display screenshot scope/failure, absence of window/session screenshot calls, safe first-cause preservation, WDA process-unavailable classification, and receipt classification. Provider tests run against Mac2 4.3.5, verify the effective 3,000-second new-command timeout, and prove the Session remains usable after more than 60 seconds without an Appium command, in addition to click/double/right click/hover/scroll/swipe, supported element-relative drag, click-to-focus followed by Command+A, Backspace, uniform application-scoped character-by-character `typeText` in Fixture native input, TextEdit, Safari address bar, and Safari TodoMVC WebView input, End, printable/special keys, checkbox state, display screenshots, page source, focus/window behavior, timeout/cancel, cleanup, no element-value write, and no absolute-coordinate command path.

## Current Invariants

- Observation is not an assertion.
- Only the latest window Observation is actionable.
- Native IDs and converted action pixel offsets never cross the Adapter boundary. Observation-only geometry may cross the boundary, but actions accept only the declared element references and normalized relative positions, never absolute coordinates.
- A Driver success response never confirms business effect.

## Explicit AI Visual Evaluation

AI visual evaluation is disabled by default. The Client factory accepts an optional caller-injected visual evaluator separately from serializable GatewayConfig; it is not a provider override. Only a predeclared aiVisual assertion with accepted=true may invoke it. It receives a copy of the current Observation display screenshot, logical observation identity and goal, plus cancellation. Its model identity and strict passed/failed/unverifiable response are validated. The result records the model and screenshot ArtifactRef with the Observation; missing, stale, cancelled or malformed evaluation is unverifiable. No model service, credential, upload destination or background evaluation is inferred.
