# Module: adapters.tart

## Purpose

Implement ImagePort and VmPort through Tart for immutable OCI Golden Images, one ephemeral managed clone, fixed shared/NAT networking, live VM inspection, and attribution-safe cleanup.

## Dependencies

- Project: public `contracts`.
- External: Tart 2.35.x CLI invoked as bounded child processes.
- Forbidden: Guest/Appium/Mac2 behavior, Evidence file writes, Kernel policy, shell interpolation of untrusted values.

## Public Interface

The production factory returns neutral ImagePort and VmPort implementations. Inputs are validated OCI reference/digest and Kernel-generated managed resource IDs. Outputs are neutral receipts/status; Tart names, paths, raw JSON/text, and process handles remain private.

Image behavior:

- Only Tart Registry/OCI sources are supported.
- An immutable digest is mandatory; mutable-only tags and HTTP downloads are rejected.
- Missing images may be pulled while the global lock is held and no Run is active. Registry and Tart own transfer-time immutable-digest verification and atomic cache registration.
- Before allocation the Adapter validates strict Tart inventory and requires the exact configured `reference@sha256` identity for the newly published Appium 3.7.0/Mac2 4.3.5 Golden Image. Tart 2.35.x exposes neither cached bytes nor quarantine; this runtime does not claim an independent byte rehash and fails closed instead of deleting, mutating, or silently re-pulling an inconsistent existing cache.
- Cleanup never removes the shared Golden Image cache.

VM behavior:

- Every formal Run clones the configured Golden Image; the Golden Image itself is never started or modified.
- When the retained GatewayConfig network array is empty, V1 starts the clone with Tart shared/NAT networking and disabled shared clipboard. Outbound Internet access is unrestricted for the early-stage profile. Nonempty rules fail validation; bridged networking and inbound/public forwarding are unsupported.
- Clone names are generated and validated internally.
- Stop and destroy are idempotent with respect to an already absent attributable clone.
- Destruction requires a trustworthy state record linking RunId and clone name. Non-project VMs are ignored.

## Data And State Flow

Before clone, the managed resource record durably enters `clonePlanned`; provider success advances it to `cloneCreated`, then `started`. Cleanup records `cleanupStarted` and `cleanupCompleted`. Startup recovery reconciles records with Tart's actual inventory while holding the global lock. Unattributed or multiple managed clones return `RecoveryRequired`; they are not deleted automatically.

## Internal Structure

- Bounded Tart process runner with argument-array invocation and cancellation observation.
- Exact-digest OCI image identity/cache inspection and fail-closed pull verification.
- Managed clone name/ownership mapping.
- VM clone/start/inspect/stop/destroy translations.
- Fixed shared-network and disabled-clipboard launch policy.

## Architecture

- Architecture level: Level 2 infrastructure Adapter.
- Runtime boundary: Host Tart CLI only.
- Dependency direction: Contracts and operating-system process APIs; no inward policy imports.

## Error Handling

CLI exits and timeouts are classified by operation stage and whether Tart proves no effect. Ambiguous clone/start/stop/destroy outcomes remain unknown and require reconciliation. Logs are bounded and sanitized before diagnostic persistence. Cancellation never claims rollback.

## Verification Scope

Offline tests cover argument safety, exact shared-network/disabled-clipboard arguments, absence of bridge/forward flags, parsing, digest validation, ownership reconciliation, non-project VM preservation, and error classification. Provisioned tests cover pull/cache, clone, Internet-capable shared start, Host control-channel reachability, inspect, idempotent stop/destroy, timeout/cancel, crash recovery, and failure cleanup.

## Current Invariants

- At most one managed clone exists.
- Formal Runs never mutate or delete Golden Images.
- No VM is deleted from name prefix alone.

## Network Profile

The Adapter always uses Tart's default shared/NAT network, never passes `--net-host`, `--net-bridged`, Softnet allow/block/expose options, or public forwarding options, and always passes `--no-clipboard`. This profile is static code policy, not caller configuration.
