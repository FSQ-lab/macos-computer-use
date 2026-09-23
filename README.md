# macos-computer-use

An experimental TypeScript macOS computer-use runtime with ephemeral Tart VMs, Appium Mac2 automation, independent assertions, and auditable local Evidence.

## Status

The v1 runtime is work in progress for Node.js 24 and pnpm; independent SPEC audit findings remain open. Deterministic TypeScript tests and the native Fixture AUT build run locally. Real provider/destructive execution requires a separately provisioned immutable Golden Image containing the Fixture AUT, Appium 3, Mac2 4.3.1, compatible Xcode/WDA Mac, Guest Agent, and Guest TCC permissions.

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm check
swift test --package-path fixtures/macos-test-app
fixtures/macos-test-app/build-app.sh
```

## CLI

Set `MACOS_COMPUTER_USE_CONFIG` to a strict local configuration JSON file, then use:

```text
macos-computer-use doctor
macos-computer-use doctor --deep
macos-computer-use run examples/fixture.scenario.json
macos-computer-use recover
macos-computer-use runs list
macos-computer-use runs show RUN_ID
macos-computer-use evidence export RUN_ID DESTINATION
```

The image configuration requires the final OCI `digest` and a separate `buildIdentity`. The Guest file `/etc/macos-computer-use/image-digest` contains that build identity, not its own final OCI digest. Example configuration values are placeholders.

`doctor --deep` performs a real Diagnostic Run and therefore requires the configured Golden Image. Ordinary `doctor` does not create a VM.

## Safety model

- One active Run and one managed clone; competing work fails with `GatewayBusy`.
- Actions use ElementRefs and normalized element-local positions only. Absolute coordinates are unsupported.
- Provider success never confirms business effect. Only predeclared independent assertions can confirm it.
- Core Evidence is mandatory and write-ahead. Evidence and cleanup status remain separate from the business verdict.
- The runtime consumes trusted Golden Images; it is not a strong sandbox for malicious Guest code.

See [SPEC.md](SPEC.md) for the current project contract and [the v1 design](docs/superpowers/specs/2026-09-21-macos-computer-use-v1-design.md) for design rationale.

## Optional visual evaluator

The client factory accepts a second argument `{ visualEvaluator }` with a stable `model` name and an async `evaluate(input, signal)` callback. Visual evaluation is disabled when omitted. Only predeclared `aiVisual` assertions with `accepted: true` invoke it; input contains the current window screenshot bytes, Observation ID and goal. Return a strict `{ status, reason }` object, where status is `passed`, `failed` or `unverifiable`. Invalid, stale or cancelled responses remain unverifiable. The caller owns any model service, credentials and data transmission; no service is selected automatically. This integration is WIP pending independent audit.
