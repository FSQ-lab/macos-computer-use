# Module: adapters.guest

## Purpose

Implement GuestPort through `tart exec`: prove Guest readiness, start/stop the Guest Appium process, inspect compatible Guest tooling, and export bounded diagnostic artifacts to Host.

## Dependencies

- Project: public `contracts`.
- External: Tart 2.35.x `exec` and `ip --resolver agent`; validated archive/stream primitives.
- Forbidden: arbitrary caller commands, Host filesystem exposure to Guest, Desktop action semantics, Evidence timeline writes.

## Public Interface

GuestPort exposes fixed typed operations for live probes, known service lifecycle, compatibility metadata, and diagnostic export. It never accepts a shell string or arbitrary executable/arguments from Scenario or Public Client. Appium endpoint, Guest credentials, processes, paths, and native identifiers remain private.

## Data And State Flow

- Guest readiness proves the Guest Agent, user desktop session, required executables, and fixed compatibility metadata through live commands.
- Appium starts in a Run-specific Guest temporary directory on fixed port 4723, with bounded sanitized logging.
- Host obtains the Guest address through Tart's Agent resolver; endpoint use is restricted to the active Run.
- Stop is attempted before VM destruction and is idempotent when the service is absent.
- Appium/WDA/Guest diagnostic files are exported during finalization as a bounded relative-path archive stream.

Export enforces allowed roots, file-count/single-file/total-size limits, regular files only, no symlinks/special files/path traversal, and Host-side SHA-256 recomputation. Host Evidence is never mounted read-write into Guest. Screenshots/UI snapshots already returned to Host are not exported again.

## Internal Structure

- Fixed-command Tart Exec runner.
- Guest readiness and compatibility probes.
- Appium process lifecycle and log ownership.
- Restricted archive enumeration/stream/export validation.

## Architecture

- Architecture level: Level 2 infrastructure Adapter.
- Runtime boundary: Host-to-Guest Tart Guest Agent channel.
- Dependency direction: Contracts plus bounded process/stream APIs.

## Error Handling

Malformed/oversized export, symlink, path escape, special file, unknown process state, or incompatible tooling returns a normalized safe error. Export failure marks Evidence incomplete through Kernel but does not suppress cleanup. Raw Guest output is controlled diagnostic material and is not returned directly.

## Verification Scope

Tests cover fixed-command enforcement, readiness parsing, endpoint secrecy, Appium start/stop classification, archive limits, traversal/symlink/special-file rejection, duplicate screenshot avoidance, cancellation, and failure sanitization. Provisioned tests use the fixed Golden Image.

## Current Invariants

- Public inputs cannot request arbitrary Guest execution.
- Guest temporary data is not a retention store.
- No Host user directory or writable Evidence directory is shared into Guest.
