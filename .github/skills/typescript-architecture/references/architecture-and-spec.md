# TypeScript Architecture And SPEC Rules

## Select The Lowest Viable Level

### Level 1: Single package, direct modules

Use for a focused runtime or library with one deployment unit and few integration boundaries. Organize by cohesive responsibility; do not add internal packages, dependency injection containers, or pass-through layers.

### Level 2: Layered single package

Use when domain/orchestration logic must be isolated from multiple adapters such as macOS automation, process control, persistence, or transport. Keep dependency direction explicit: entry/adapters depend inward on application contracts; core logic does not import platform frameworks.

### Level 3: Workspace with independently owned packages

Use only when components have genuinely independent public APIs, build/test boundaries, deployment lifecycles, or multiple consumers. Each package owns an entry point and a module SPEC; workspace packages do not reach into one another's private source.

## Required SPEC Facts

Before implementation, root or relevant module SPEC must state the current choices that apply:

- runtime and supported platform versions;
- package manager and lock-file authority;
- ESM/CommonJS format and module-resolution policy;
- source, build, generated-output, and packaging boundaries;
- architecture level, module/package ownership, and dependency direction;
- public entry points and exported contracts;
- external-data validation and error semantics;
- process, filesystem, IPC, HTTP, automation, and native-platform boundaries;
- verification obligations.

Do not put exact dependency versions in SPEC; the manifest and lock file own them. Do not describe a framework or build tool until it is confirmed and present.

## Module SPEC Shape

Use the repository's general module template and make the Architecture section concrete about TypeScript package/module boundaries, public exports, runtime boundary, allowed imports, state ownership, and validation boundary. List actual owned files or directories under Internal Structure without turning SPEC into a file-by-file manual.
