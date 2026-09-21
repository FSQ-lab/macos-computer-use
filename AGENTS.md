# Agent Instructions

This repository uses Spec-Driven Development (SDD) for project development.

Root `SPEC.md` and relevant module `SPEC.md` files are the grounding truth for project code and project logic. They describe the current system; they do not define the SDD workflow.

This file and `.github/skills/` control write authorization and SDD phase transitions. Project `SPEC.md` files must not duplicate or override these workflow rules.

## Write Authorization

Ordinary discussion, explanation, investigation, review, and planning are read-only. Do not automatically invoke repository workflow skills.

Before creating, modifying, renaming, or deleting project-development files, require the user to explicitly invoke `/spec-driven <confirmed-design-document-path | direct-project-change-request>`. A platform-rendered explicit `$spec-driven` invocation is equivalent. Project development includes:

- root or module `SPEC.md` files;
- source code and behavior-defining tests;
- runtime, build, packaging, and deployment configuration;
- public interfaces, module ownership, and dependency direction;
- documentation of supported project behavior.

A natural-language edit request outside that explicit invocation is not authorization to write project-development files. Direct the user to `/spec-driven`.

`/requirements-to-design <request>` is an optional design aid. A platform-rendered explicit `$requirements-to-design` invocation is equivalent. It produces a confirmed design document, but is never a prerequisite for `/spec-driven`.

A clear ordinary request may directly authorize changes limited to workflow-control files: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/prompts/**`, and `.github/skills/**`. If such a change also changes product behavior, use `/spec-driven`.

A clear ordinary request may also authorize local-only writes without SDD only when every affected non-workflow path is both untracked and ignored by Git. Verify both conditions before writing. Tracked project files never qualify for this exemption.

## SDD Gates

During `/spec-driven`, determine whether the requested change requires a SPEC delta.

- If it does, update the relevant `SPEC.md` files and obtain user confirmation before changing non-SPEC project files.
- If it only restores behavior already grounded by current SPEC, record concrete no-SPEC-delta evidence before implementation.
- If the repository has no root `SPEC.md`, a project change requires an initial root SPEC and user confirmation before implementation.

After implementation, run proportionate verification and an independent diff-based SPEC implementation audit. Completion requires a passing audit chain and a final identity check that the audited diff still matches the worktree.

Run repository workflow skills only through explicit invocation. Keep current project facts in `SPEC.md`; keep workflow procedures in `.github/skills/`.

## TypeScript Architecture

This is a TypeScript project. During requirements, SPEC authoring, implementation, verification, and audit, apply `.github/skills/typescript-architecture/SKILL.md` and only the phase-specific references it identifies. Exact runtime, package manager, module format, framework, and deployment target remain project decisions that must be recorded in confirmed SPEC before implementation.
