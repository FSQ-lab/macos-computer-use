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
- Appium starts in a Run-specific Guest temporary directory on fixed port 4723. Its output and the Mac2 xcodebuild/WDA output are consumed through one streaming allowlist filter; no unfiltered byte is written to a file, terminal, Evidence stream, or later cleanup input. The filter recognizes only Session create/delete/remove/replace, unexpected-shutdown, Appium exit, and xcodebuild/WDA host-exit patterns, maintains raw Provider identifiers only transiently in process memory, and emits Run-local ordinal aliases. Unknown or partially matched lines are dropped rather than sanitized heuristically.
- Host obtains the Guest address through Tart's Agent resolver; endpoint use is restricted to the active Run.
- Stop is attempted before VM destruction and is idempotent when the service is absent.
- Diagnostic export first snapshots Appium readiness, WDA readiness, and process presence for Appium, xcodebuild, and WDA Runner through fixed commands. It obtains the bounded active-session count from Appium's safe discovery endpoint when available, otherwise from the allowlisted outer-Session create/remove state while Appium is alive, or zero after Appium exit. It then validates and returns one strict lifecycle-diagnostic document containing the snapshot, generated journal, safe Guest compatibility facts, and the earliest observed termination source. It never invokes a mutating Session endpoint or enables an insecure Appium feature.

Export enforces size/event-count/field bounds, regular generated journal state only, no symlinks/special files/path traversal, strict schema parsing, and Host-side SHA-256 recomputation. The returned document contains no filename/path field, request or response body, header, URL, bundle ID, command, UI/user text, secret, PID, stack, raw log line, raw Session/native ID, or hash derived from such an ID. Host Evidence is never mounted read-write into Guest. Screenshots/UI snapshots already returned to Host are not exported again.

## Internal Structure

- Fixed-command Tart Exec runner.
- Guest readiness and compatibility probes.
- Bounded standard-root application inventory and Info.plist resolver.
- Appium process lifecycle and streaming lifecycle-event projection.
- Restricted diagnostic snapshot and schema/export validation.

## Architecture

- Architecture level: Level 2 infrastructure Adapter.
- Runtime boundary: Host-to-Guest Tart Guest Agent channel.
- Dependency direction: Contracts plus bounded process/stream APIs.

## Error Handling

Malformed/oversized export, unknown lifecycle event, symlink, path escape, special file, unknown process state, or incompatible tooling returns a normalized safe error. Export failure marks Evidence incomplete through Kernel but does not suppress cleanup. Raw Guest output is never diagnostic material and is never returned or persisted.

## Verification Scope

Tests cover fixed-command enforcement, readiness parsing, exact Appium/Mac2/WDA compatibility rejection, inventory-result validation, exact normalized-name matching, standard-root confinement, missing/duplicate results, bounded Info.plist metadata, endpoint secrecy, Appium lifecycle, lifecycle-pattern allowlisting and alias rotation, duplicate/replace/delete ordering, unexpected shutdown and process exit, forbidden-content rejection, diagnostic limits, traversal/symlink/special-file rejection, cancellation, and failure sanitization. Provisioned tests use the fixed Mac2 4.3.5 Golden Image.

## Current Invariants

- Public inputs cannot request arbitrary Guest execution.
- Guest temporary data is not a retention store.
- No Host user directory or writable Evidence directory is shared into Guest.

## Network Profile

GuestPort retains `configureNetwork` for Port compatibility. With the only valid configuration `network: []`, it returns the existing successful no-op receipt. Nonempty rules are rejected at GatewayConfig validation and are not applied. GuestPort still owns no arbitrary networking command and exposes no endpoint publicly.
