# Copilot Instructions

This repository uses Spec-Driven Development. Root and module `SPEC.md` files are the grounding truth for current project behavior, while `AGENTS.md` and `.github/skills/` define write authorization and workflow transitions.

Ordinary discussion, investigation, review, and planning are read-only. Before changing project specifications, source, behavior-defining tests, runtime/build configuration, public interfaces, module ownership, dependency direction, or supported-behavior documentation, require an explicit `/spec-driven <confirmed-design-document-path | direct-project-change-request>` invocation. An explicit `$spec-driven` invocation is equivalent when rendered by the client.

`/requirements-to-design <request>` (or explicit `$requirements-to-design`) is optional and produces a confirmed design document without changing SPEC or implementation files.

Clear ordinary requests may directly authorize workflow-control-only maintenance in `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/prompts/**`, and `.github/skills/**`. Changes that also affect product behavior require `/spec-driven`.

During `/spec-driven`, update and confirm required SPEC deltas before implementation, or record concrete evidence that current SPEC already grounds a defect repair. If no root `SPEC.md` exists, create and confirm the initial project specification before implementation. Finish with verification and an independent diff-based SPEC implementation audit.

This is a TypeScript project. Apply `.github/skills/typescript-architecture/SKILL.md` during SDD phases. Do not assume a runtime, package manager, module format, framework, or deployment target until confirmed by project SPEC.
