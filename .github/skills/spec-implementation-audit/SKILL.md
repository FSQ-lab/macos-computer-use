---
name: spec-implementation-audit
description: "Internal independent audit of an SDD implementation against confirmed SPEC files and complete, identity-verified diff artifacts."
---

# SPEC Implementation Audit

Determine whether project changes made through `spec-driven` satisfy confirmed project specifications. This is a SPEC-centered, diff-based audit, not a general review or test-summary check.

## Invocation Gate

Load only when the explicitly invoked `spec-driven` workflow directs the agent here. Ordinary discussion, review requests, planning, or name mentions do not trigger this skill.

## Required Inputs

- root `SPEC.md` and all relevant module `SPEC.md` files;
- complete diff artifacts for the declared scope, with validated absolute paths, SHA-256 hashes, byte sizes, entry counts, and changed-path inventory, or an exact immutable commit range;
- separate complete artifacts for in-scope untracked files;
- `spec_delta_mode=confirmed-update|no-delta`;
- for repair-only mode, the prior independent report, prior snapshot identity, and complete repair delta;
- optional verification output as auxiliary evidence.

Do not accept an implementation summary as evidence. If required inputs are absent, unreadable, truncated, wrapped, or inconsistent, return `audit-blocked`.

## Independence

Use a fresh reviewer or independent context when supported. Limit reviewer input to the authority and evidence above plus minimal navigation information. Treat no-delta evidence as a claim to verify, not an accepted conclusion.

## Modes

### Full, round 1

1. Establish the complete applicable SPEC-item inventory before verdicts.
2. Read the entire diff and controlling implementation path for every item.
3. Check behavior, interfaces, configuration, ownership, dependencies, architecture, errors, invariants, and tests promised by SPEC.
4. Verify SPEC/code synchronization: module navigation, actual exports, dependencies, internal structure, and current-fact SPEC hygiene.
5. For TypeScript scope, apply `../typescript-architecture/references/audit-checklist.md`.
6. Record a verdict with concrete evidence for every item.
7. Consolidate duplicate symptoms under stable finding IDs and identify repair ownership.
8. Complete the pass even after finding blockers. Only invalid inputs permit early `audit-blocked`.

### Repair-only, later rounds

Audit every finding in the previous report against the complete repair delta and relevant controlling paths. Carry unresolved findings forward with the same IDs. Retain unaffected passing verdicts only when evidence outside repair scope is unchanged. Do not rebuild the full inventory or add unrelated discoveries to the repair batch. Scope expansion requires a human decision.

## No-Delta Validation

Independently prove that current SPEC already grounds the repaired behavior, the diff restores conformance without changing supported contracts, structural boundaries remain accurate, and concrete evidence demonstrates an implementation mismatch. If any condition is unproven, return a blocking `spec-delta-required` finding owned by SPEC/human decision.

## Verdicts

- `implemented`
- `incomplete`
- `missing`
- `diverged`
- `documentation-only`
- `interface-only`
- `mock-or-stub`
- `boundary-violation`
- `spec-delta-required`
- `needs-human-decision`

Every verdict except `implemented` is blocking unless the user explicitly accepts a `needs-human-decision` item as out of scope.

## Required Result

State `audit_mode`, `coverage_complete`, `spec_delta_mode`, audited SPEC inputs, and validated artifact identities or commit range.

For full mode:

```text
SPEC item | Boundaries | Diff evidence | Verdict | Notes
```

For every mode:

```text
Finding ID | Affected SPEC items | Root cause | Evidence | Verdict | Repair owner
```

For repair-only mode also include:

```text
Previous finding ID | Repair delta evidence | Verification evidence | Verdict | Remaining gap
```

Evidence must cite concrete files and, when possible, line numbers or changed symbols. Tests are supporting evidence, never a substitute for reading the diff and implementation path.

## Completion Gate

Completion requires complete full-mode coverage, complete repair-only coverage for every prior finding, no unresolved blocking finding, required verification, and a matching post-audit worktree identity check performed by `spec-driven`. The implementation agent cannot declare its own findings resolved.
