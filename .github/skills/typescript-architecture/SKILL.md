---
name: typescript-architecture
description: "Repository-local TypeScript architecture rules used by the explicit SDD workflow for design, SPEC authoring, implementation, verification, and audit."
---

# TypeScript Architecture

Apply these rules only inside an explicitly authorized repository workflow. They do not grant write permission or create another project-modification entry point.

## Core Rules

- TypeScript is the authored project language. Exceptions for generated code, configuration formats, shell integration, or vendored code must be narrow and SPEC-grounded.
- Choose the lowest architecture level that satisfies the current contract.
- Treat runtime values from files, processes, IPC, HTTP, automation backends, and environment variables as untrusted at their boundary; TypeScript types alone do not validate them.
- Public APIs flow through declared package/module entry points. Do not import another module's private implementation paths.
- Keep platform adapters and framework objects at boundaries; domain and orchestration logic should depend on project-owned types and interfaces.
- Do not hide ownership behind generic `utils`, `common`, or `shared` directories without a stable multi-consumer contract.
- Avoid `any`, unchecked assertions, ambient global state, and side-effectful import initialization unless current SPEC records a concrete need.

## Phase Routing

| Phase | Read |
|---|---|
| Requirements/design or SPEC ownership | [Architecture levels and SPEC rules](references/architecture-and-spec.md) |
| Implementation and verification | [Implementation rules](references/implementation-rules.md) |
| Independent audit | [Audit checklist](references/audit-checklist.md) |

Read only the reference needed for the active phase.
