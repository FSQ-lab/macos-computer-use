# Module: adapters.evidence

## Purpose

Implement EvidencePort as a mandatory local append-only event journal, content-addressed Artifact store, deterministic versioned Manifest projection, integrity verifier, and retention manager.

## Dependencies

- Project: public `contracts`.
- External: Node filesystem and cryptographic hash APIs.
- Forbidden: business verdict derivation, Provider calls, Hook policy, public exposure of absolute paths.

## Public Interface

EvidencePort appends one validated EvidenceEvent, commits a bounded ArtifactInput, commits a validated Manifest revision, reads/verifies logical Run data for Client operations, and performs retention under Kernel/Client coordination. It accepts logical Run-relative identities, never arbitrary output paths from Scenario or Agent input.

## Local Layout

```text
stateRoot/
  gateway.lock
  runs-index.jsonl
  recovery/
evidenceRoot/
  runs/<runId>/
    timeline.jsonl
    manifest.vN.json
    environment.json
    steps/
    artifacts/<sha256>
    diagnostics/
tempRoot/<runId>/
```

Run directories default to mode `0700` and files to `0600`. Manifest and events contain only Run-relative paths and logical references. V1 uses one configured Evidence root.

## Event Journal

Kernel is the only caller authorized to assign and append sequence. The Adapter validates that sequence is exactly the next durable value and appends/fyncs before acknowledging. Events are immutable. Timeline bytes are the state fact source; Step files and Manifest are deterministic projections.

## Artifact Commit

The Adapter writes a Run temporary regular file, enforces type/size policy, fsyncs it, computes SHA-256, atomically renames it to the content-addressed Run path, fsyncs the parent directory, and returns a descriptor for Kernel to append as an event. Existing hashes are reused only after size/content verification. Unreferenced temporary files are orphaned and isolated or removed during recovery.

Artifact descriptors contain type, relative path, MIME, byte size, SHA-256, and sensitivity (`normal` or `potentiallySensitive`). Artifact type/MIME pairs are closed to effective config, environment, lifecycle diagnostics, UI snapshot, display/window PNG screenshot, and Kernel-created `hook-*` binary contributions. Core JSON types use their strict owned schema, UI snapshots must be JSON objects, and screenshots require the PNG signature. Unknown types or mismatched MIME are rejected. Raw Driver, WDA, xcodebuild, and Guest process logs are not Artifact types and cannot be disguised under another type/MIME.

## Manifest And Integrity

A Manifest revision deterministically records Run/build/schema/config/environment/result, event count, complete timeline SHA-256, and Artifact descriptors. Commit uses the Artifact-style atomic/fsync procedure. Normal Run finalization stops ordinary event appends; recovery may append recovery events and create a higher immutable Manifest revision while preserving prior revisions.

Effective configuration and environment snapshots remain strictly validated version 2 records in this increment. Pi-selected application identity and fixed shared-network facts are not added to new snapshot schemas yet. The timeline adds `FinalAssertionsFrozen` with only assertion count and Observation ID; it does not duplicate assertion text. Existing snapshots, action/assertion Evidence, final result, and cleanup records remain unchanged and mandatory.

Read/show/export verifies Manifest, timeline, Artifact hashes, sizes, relative paths, and schema versions. Mismatch returns `EvidenceCorrupted`. SHA-256 detects accidental integrity loss but is not represented as a signature or malicious-tamper defense.

## Retention

Default retention is seven days; `null` disables automatic deletion. Active Runs are excluded. Kernel-recorded completion time, not mtime, controls eligibility. Incomplete/cleanup-failed Runs follow the same policy. Deletion audit is written outside the deleted Run. Failures are recorded and do not stop other eligible cleanup. The module promises ordinary deletion, not physical secure erase.

## Sensitive Data

The Adapter never receives secret plaintext as intended metadata. Structured inputs are sanitized before commit. Display screenshots and lifecycle diagnostics are marked potentially sensitive. Display screenshots are stored normally without secret masking or visual secret detection, even when the selected application displays a Secret value. This explicit image exception does not relax structured-data or diagnostic restrictions. Before committing a lifecycle diagnostic, EvidencePort parses the strict versioned schema and rejects forbidden/unknown fields; it never accepts a raw log Artifact under another type or MIME. Debug mode cannot relax these rules.

## Internal Structure

- Safe root and Run-relative path resolver.
- Append/fsync journal writer.
- Bounded atomic Artifact writer and SHA-256 verifier.
- Manifest projector/reader/verifier.
- Runs index and recovery record persistence.
- Retention planner and external management audit.

## Architecture

- Architecture level: Level 2 infrastructure Adapter.
- Runtime boundary: Host local filesystem.
- Dependency direction: Contracts and Node filesystem/crypto only.

## Error Handling

Before-Evidence failure rejects dispatch through Kernel. After/finalization failure preserves committed bytes, returns a normalized Evidence error, and allows bounded cleanup. Partial temporary writes are never advertised as committed. Unknown schema is preserved but not interpreted.

## Verification Scope

Tests cover modes, path traversal/symlink rejection, sequence enforcement, fsync/rename ordering through injected filesystem seams, hash reuse/collision mismatch, crash points, orphan recovery, deterministic Manifest revisions, corruption detection, retention selection, deletion audit, and sanitizer failure.

## Current Invariants

- Timeline is append-only and authoritative.
- Manifest never refers outside its Run.
- Evidence failure cannot manufacture or erase business facts.
