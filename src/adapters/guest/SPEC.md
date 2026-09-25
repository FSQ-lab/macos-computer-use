# Module: adapters.guest

## Purpose

Implement GuestPort through `tart exec`: prove Guest readiness, start/stop the Guest Appium process, inspect compatible Guest tooling, and export bounded diagnostic artifacts to Host.

## Dependencies

- Project: public `contracts`.
- External: Tart 2.35.x `exec` and `ip --resolver agent`; validated archive/stream primitives.
- Forbidden: arbitrary caller commands, Host filesystem exposure to Guest, Desktop action semantics, Evidence timeline writes.

## Public Interface

GuestPort exposes fixed typed operations for live probes, installed-application resolution, known service lifecycle, compatibility metadata, and diagnostic export. `resolveApplication` accepts only ApplicationTarget and returns one neutral ApplicationDescriptor. It never accepts a path, bundle ID, shell string, or arbitrary executable/arguments from Scenario or Public Client. Appium endpoint, application paths, Guest credentials, processes, and native identifiers remain private.

## Data And State Flow

- Guest readiness runs on the fresh disposable clone and proves the Guest Agent, desktop session, required executables, exact Appium 3.7.0, exact Mac2 4.3.5, the configured WDA source SHA-256, and fixed image compatibility metadata. Application resolution and later session/source/window readiness prove selected-application identity and automation permission before business work.
- `/etc/macos-computer-use/image-digest` contains independent image build identity. Guest readiness validates it and toolchain metadata against Host expectations. Fixture metadata is read only by Fixture-specific acceptance.
- Application resolution runs fixed bounded enumeration over declared standard application roots, accepts only regular `.app` bundle directories, performs exact normalized bundle-directory-name matching, reads the unique match's Info.plist through fixed argument-array commands, returns no path, and never launches an application.
- Appium starts in a Run-specific Guest temporary directory on fixed port 4723. Raw Appium request logging is disabled so SecretRef values are not written before sanitization; exported diagnostics contain only bounded, generated lifecycle summaries and sanitized Guest metadata.
- Host obtains the Guest address through Tart's Agent resolver; endpoint use is restricted to the active Run.
- Stop is attempted before VM destruction and is idempotent when the service is absent.
- Appium/WDA/Guest diagnostic files are exported during finalization as a bounded relative-path archive stream.

Export enforces allowed roots, file-count/single-file/total-size limits, regular files only, no symlinks/special files/path traversal, and Host-side SHA-256 recomputation. Host Evidence is never mounted read-write into Guest. Screenshots/UI snapshots already returned to Host are not exported again.

## Internal Structure

- Fixed-command Tart Exec runner.
- Guest readiness and compatibility probes.
- Bounded standard-root application inventory and Info.plist resolver.
- Appium process lifecycle and log ownership.
- Restricted archive enumeration/stream/export validation.

## Architecture

- Architecture level: Level 2 infrastructure Adapter.
- Runtime boundary: Host-to-Guest Tart Guest Agent channel.
- Dependency direction: Contracts plus bounded process/stream APIs.

## Error Handling

Malformed/oversized export, symlink, path escape, special file, unknown process state, or incompatible tooling returns a normalized safe error. Export failure marks Evidence incomplete through Kernel but does not suppress cleanup. Raw Guest output is controlled diagnostic material and is not returned directly.

## Verification Scope

Tests cover fixed-command enforcement, readiness parsing, exact Appium/Mac2/WDA compatibility rejection, inventory-result validation, exact normalized-name matching, standard-root confinement, missing/duplicate results, bounded Info.plist metadata, endpoint secrecy, Appium lifecycle, archive limits, traversal/symlink/special-file rejection, cancellation, and failure sanitization. Provisioned tests use the fixed Mac2 4.3.5 Golden Image.

## Current Invariants

- Public inputs cannot request arbitrary Guest execution.
- Guest temporary data is not a retention store.
- No Host user directory or writable Evidence directory is shared into Guest.

## Network Profile

GuestPort retains `configureNetwork` for Port compatibility. With the only valid configuration `network: []`, it returns the existing successful no-op receipt. Nonempty rules are rejected at GatewayConfig validation and are not applied. GuestPort still owns no arbitrary networking command and exposes no endpoint publicly.
