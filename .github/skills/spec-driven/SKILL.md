---
name: spec-driven
description: "Required explicit project-modification workflow: establish current SPEC authority, implement, verify, and complete an independent diff-based audit."
---

# Spec-Driven Development

Turn an explicitly supplied confirmed design document or direct project change request into SPEC-grounded implementation, verification, and independent audit.

## Invocation Gate

Run only when the user explicitly invokes `/spec-driven <confirmed-design-document-path | direct-project-change-request>` or the client-equivalent `$spec-driven`. Do not infer invocation from ordinary discussion, editor state, natural-language edit requests, approval, or a skill-name mention. If invocation or non-empty input is absent, stop without writing and provide the required invocation form.

This skill is not needed for workflow-control-only maintenance.

## Authority

Root `SPEC.md` and relevant module `SPEC.md` files describe current facts and are the final authority for implementation. Design documents are inputs to the SPEC decision, not implementation authority.

Keep in SPEC: current behavior, public interfaces, ownership, dependencies, configuration, error semantics, architecture level, and present invariants.

Keep out of SPEC: rationale, rejected alternatives, plans, target-state language, migration narrative, future ideas, and exhaustive test matrices.

## Required Flow

```text
explicit invocation
  -> resolve input and inspect current evidence
  -> decide SPEC delta
  -> update and confirm SPEC, or record no-delta evidence
  -> implement against confirmed SPEC
  -> verify
  -> independent full diff audit
  -> batch repair findings
  -> repair-only audit rounds
  -> audited-snapshot identity check
  -> final report
```

## Input Resolution

If input is a path, require it to exist and be user-confirmed, then read it. Otherwise treat the full argument as the direct change request. Inspect enough implementation, tests, and documentation to resolve material ambiguity. Ask only focused questions where materially different implementations remain possible.

## SPEC Delta Decision

Before changing non-SPEC project files, read the root and relevant module specs plus implementation and verification evidence.

A no-SPEC-delta path is allowed only when all are proven:

- current SPEC already grounds the intended supported behavior and remains accurate;
- the change restores implementation conformance rather than changing a contract;
- public interfaces, configuration semantics, ownership, dependency direction, architecture level, and supported behavior remain unchanged;
- a failing focused test, reproduction, or concrete code evidence demonstrates the mismatch.

Record precise SPEC references, defect evidence, and unchanged boundaries before implementation. A user label such as “bugfix” is not proof.

Otherwise a SPEC delta is required. If the repository lacks a root `SPEC.md`, create an initial root specification. Update relevant root/module specs, show the delta, and obtain explicit user confirmation before modifying any non-SPEC project file. Never add artificial SPEC text merely to create a delta.

## SPEC Structure

Root SPEC normally owns project-wide purpose, module navigation, dependency direction, architecture diagram, development constraints, and invariants. Each independently owned module has one `SPEC.md` describing:

```text
# Module: {name}
## Purpose
## Dependencies
## Public Interface
## Internal Structure
## Architecture
## Data And State Flow       (when applicable)
## Error Handling            (when applicable)
## Verification Scope        (optional)
## Current Invariants        (optional)
```

Choose the simplest architecture that satisfies the confirmed contract. Do not introduce layers, frameworks, global state, repositories, service layers, or abstractions without a concrete SPEC-grounded need.

This repository is TypeScript. Before authoring SPEC, implementing, verifying, or auditing, read `../typescript-architecture/SKILL.md` and only the reference it routes for the active phase. The confirmed SPEC must own runtime, package manager, module format, build/output boundary, public exports, external-data validation, and applicable browser/native integration choices.

## Implementation

After SPEC confirmation or a recorded no-delta decision:

1. Re-read the confirmed specs.
2. Implement only what they require.
3. If implementation exposes a missing or wrong decision, stop and return to SPEC confirmation.
4. Keep edits scoped to affected modules and tests.
5. For behavior changes, prefer a failing test before production changes when practical.
6. Run focused checks first, then broader checks proportionate to shared impact.

## Audit Lifecycle

After verification, load `../spec-implementation-audit/SKILL.md`. Use an independent reviewer/context when supported.

Round 1 is `audit_mode=full`. Create complete diff artifacts directly through Git, including separate identities for in-scope untracked files. Record absolute path, SHA-256, byte size, `diff --git` entry count, and changed-path inventory. Missing, truncated, or mismatched evidence is `audit-blocked`. Do not edit in-scope project files while review is running.

After the complete report:

1. Resolve human/SPEC and environment blockers that could change repairs.
2. Batch-repair all implementation-owned blocking findings.
3. Re-run affected verification.
4. Create the complete repair delta from the previous audited snapshot.
5. Run `audit_mode=repair-only` against every previous finding; do not reopen unrelated passing items.

Allow at most two automatic repair rounds. If blockers remain, report the complete status and request a human decision. Only the independent reviewer may close findings.

Before completion, regenerate the diff identity and compare it with the audited snapshot chain. A mismatch blocks completion until the changed scope is reviewed.

## Final Report

Report:

- input type and resolved scope;
- specs updated and confirmed, or precise no-delta evidence;
- files implemented;
- verification commands and results;
- audited SPEC inputs, audit mode(s), artifact or commit identities, and post-audit identity result;
- cumulative finding status, repair rounds, and any accepted human decisions.

Do not claim completion while any blocking finding remains.
