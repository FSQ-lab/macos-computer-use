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

- Guest readiness runs on the fresh disposable clone and proves the Guest Agent, user desktop session, required executables, Appium patch, Mac2/WDA identity, Fixture identity, and fixed compatibility metadata through live commands. Session/source/window readiness then proves usable automation permission before any business action. These live facts cannot be obtained before clone allocation; Host/static compatibility and exact OCI digest cache identity are the pre-allocation gate.
- `/etc/macos-computer-use/image-digest` contains an independent image build identity, not the final OCI manifest digest. Guest readiness validates it and Fixture/toolchain metadata against Host expectations bound to the configured immutable OCI digest; Host image verification owns final OCI digest validation.
- Appium starts in a Run-specific Guest temporary directory on fixed port 4723. Raw Appium request logging is disabled so SecretRef values are not written before sanitization; exported diagnostics contain only bounded, generated lifecycle summaries and sanitized Guest metadata.
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

## Host-only Network Rules

V1 NetworkRules constrain only destinations reachable inside the Host-only network. They do not provide Internet access or enable NAT, bridging, public forwarding, or Host-mediated egress. Nonempty rules preserve Tart Host-only mode and constrain Guest traffic by CIDR, port and protocol; the control channel and DHCP remain available. Effective filtering must be verified before business work. Rules never cause automatic network relaxation.
