# Module: cli

## Purpose

Provide a local command-line adapter over the Public Client API for diagnosis, strict Scenario execution, conservative recovery, Run inspection, and verified Evidence export. CLI owns parsing, human/JSON rendering, and stable exit mapping; it owns no runtime semantics.

## Dependencies

- Project: public Client and Contracts only.
- Forbidden: Kernel internals, concrete Adapters, direct Tart/Appium calls, direct Evidence parsing outside Client operations.

## Public Interface

```text
macos-computer-use doctor
macos-computer-use doctor --deep
macos-computer-use run <scenario-file>
macos-computer-use recover
macos-computer-use runs list
macos-computer-use runs show <run-id>
macos-computer-use evidence export <run-id> <destination>
```

- Default doctor is read-only: it checks Host platform/architecture, Node/Tart compatibility, configuration, state/Evidence directory access, lock state, and cached image metadata. It does not create a VM, start Appium, change settings, or trigger permission workflows.
- `doctor --deep` explicitly creates one Diagnostic Run, verifies Guest Agent/Appium/Mac2 session/base Observation and cleanup, performs no input action, and records Evidence. It never installs or fixes prerequisites.
- `run` parses one strict Scenario JSON through Contracts and executes only through Client.
- `recover` invokes the same conservative Kernel path used at startup and never resumes business actions.
- `runs list/show` use verified Host Evidence projections.
- `evidence export` verifies integrity and writes a relative-path Run package to an explicitly supplied destination; it does not expose internal absolute paths.
- Commands support human output and stable JSON output.

## Exit Categories

Stable v1 exit codes are:

| Code | Meaning |
|---:|---|
| 0 | Run passed with complete Evidence and completed cleanup, or read-only command succeeded |
| 2 | Invalid invocation, Scenario, or configuration; no Run allocated |
| 3 | Gateway busy |
| 4 | Recovery required or recovery failed |
| 10 | Run business verdict failed with complete Evidence and cleanup |
| 11 | Run inconclusive with complete Evidence and cleanup |
| 12 | Run Evidence incomplete and cleanup completed |
| 13 | Run cleanup failed and Evidence complete |
| 14 | Run Evidence incomplete and cleanup failed |
| 20 | Evidence requested for show/export is corrupted |
| 70 | Unexpected internal invariant failure |

Codes 12-14 summarize operational integrity and may accompany any business verdict; JSON and Manifest retain the underlying verdict. Shell status is never the authoritative full Run result.

## Internal Structure

- Argument parsing and command dispatch.
- Human/JSON result renderers.
- Scenario file bounded read and Contracts parsing.
- Stable exit mapping.
- Executable entry point declared by package `bin`.

## Architecture

- Architecture level: Level 1 transport Adapter.
- Runtime boundary: local process stdio and explicitly named local files.
- Dependency direction: Client/Contracts only.

## Error Handling

Human output contains safe summaries and next actions. JSON output contains stable codes and logical references. CLI does not print raw stderr, Appium responses, secret values, Guest endpoints, stack traces, or internal absolute paths. Interrupts request Client cancellation and wait for bounded finalize/cleanup before mapping the returned result where possible.

## Verification Scope

Tests cover parsing, unknown commands, bounded Scenario read, human/JSON stability, every exit mapping, no direct provider imports, read-only doctor side-effect boundaries, deep-doctor routing, recovery routing, corrupt Evidence, and interrupt handling.

## Current Invariants

- CLI never bypasses Client.
- CLI offers no arbitrary Mac2, Tart, Guest command, interactive Agent, recorder, daemon, or remote control entry.
