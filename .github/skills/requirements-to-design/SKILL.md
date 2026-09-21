---
name: requirements-to-design
description: "Optional explicit workflow that clarifies a requested change and produces a user-confirmed design document without modifying project SPEC or implementation."
---

# Requirements To Design

Turn an explicitly supplied request into a reviewed design document. This workflow is optional upstream input for `spec-driven`; it is not implementation authorization.

## Invocation Gate

Run only when the user explicitly invokes `/requirements-to-design <request>` or the client-equivalent `$requirements-to-design`. Do not infer invocation from ordinary discussion, planning, approval, or a mention of the skill name. If explicit invocation or a non-empty request is absent, stop without writing.

## Hard Boundary

The confirmed design document is the only repository write allowed by this skill. Do not modify `SPEC.md`, source, tests, configuration, or supported-behavior documentation.

## Workflow

1. Read enough repository context to understand the current system, including root/module specs when present, workflow controls, relevant implementation, and tests.
2. If the request contains independent change areas, propose separate design cycles.
3. Resolve material ambiguity. Ask one focused question at a time only when reasonable inspection cannot settle it.
4. Present two or three viable approaches when meaningful alternatives exist, with trade-offs and a recommendation.
5. Present reviewable design sections scaled to the change: goal, scope and non-goals, ownership, interfaces, data/control flow, errors and edge cases, compatibility, and verification expectations.
6. Revise until the user confirms the design content.
7. Write the confirmed document to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
8. Self-review for placeholders, contradictions, hidden assumptions, and ambiguous requirements.
9. Ask the user to confirm the written document. Do not implement.

## Design Document Content

Include:

- goal, scope, and non-goals;
- proposed architecture and ownership boundaries;
- public behavior and interfaces;
- data/control flow and state ownership where applicable;
- error handling, edge cases, compatibility, and security constraints;
- resolved questions and verification expectations;
- SDD applicability and the root/module specs expected to change, or why later implementation is exempt.

Keep decisions and rationale here rather than in `SPEC.md`.

For TypeScript work, read `../typescript-architecture/SKILL.md` and its design-phase reference before choosing package boundaries, runtime, module format, public exports, or validation boundaries. Record the simplest viable architecture level and its rationale in the design.

## Handoff

For project development, finish with:

```text
Design document: docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
Next step: invoke /spec-driven with this confirmed design document path.
```

For workflow-control-only or verified ignored/untracked local work, state that a clear ordinary implementation request is sufficient.
