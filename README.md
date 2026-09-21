# macos-computer-use

An experimental TypeScript macOS computer-use runtime with ephemeral Tart VMs, Appium Mac2 automation, independent assertions, and auditable local Evidence.

## Status

The v1 runtime is implemented for Node.js 24 and pnpm. Deterministic TypeScript tests and the native Fixture AUT build run locally. Real provider/destructive execution requires a separately provisioned immutable Golden Image containing the Fixture AUT, Appium 3, Mac2 4.3.1, compatible Xcode/WDA Mac, Guest Agent, and Guest TCC permissions.

## Install and verify

```bash
pnpm install --frozen-lockfile
pnpm check
swift build --package-path fixtures/macos-test-app
```

## CLI

Set `MACOS_COMPUTER_USE_CONFIG` to a strict local configuration JSON file, then use:

```text
macos-computer-use doctor
macos-computer-use doctor --deep
macos-computer-use run examples/calculator.scenario.json
macos-computer-use recover
macos-computer-use runs list
macos-computer-use runs show RUN_ID
macos-computer-use evidence export RUN_ID DESTINATION
```

`doctor --deep` performs a real Diagnostic Run and therefore requires the configured Golden Image. Ordinary `doctor` does not create a VM.

## Safety model

- One active Run and one managed clone; competing work fails with `GatewayBusy`.
- Actions use ElementRefs and normalized element-local positions only. Absolute coordinates are unsupported.
- Provider success never confirms business effect. Only predeclared independent assertions can confirm it.
- Core Evidence is mandatory and write-ahead. Evidence and cleanup status remain separate from the business verdict.
- The runtime consumes trusted Golden Images; it is not a strong sandbox for malicious Guest code.

See [SPEC.md](SPEC.md) for the current project contract and [the v1 design](docs/superpowers/specs/2026-09-21-macos-computer-use-v1-design.md) for design rationale.
