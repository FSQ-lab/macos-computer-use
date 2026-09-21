# TypeScript Implementation Rules

Implement only against confirmed root and module specs.

## Types And Boundaries

- Use `unknown` for untrusted inputs and narrow or validate before use.
- Keep runtime schemas or parsers at I/O boundaries; infer internal types from them where practical.
- Prefer discriminated unions for finite states and exhaustive handling for meaningful state machines.
- Avoid non-null assertions and broad type assertions that bypass contract checks.
- Keep errors structured across module boundaries and preserve actionable causes without leaking secrets.

## Modules And Dependencies

- Export public symbols through declared entry points; keep internal files private.
- Use type-only imports where required by the configured compiler/module semantics.
- Prevent circular dependencies and cross-package private-path imports.
- Keep OS, automation-driver, transport, filesystem, and process APIs behind their owning adapters.
- Add abstractions only when they own policy, lifecycle, translation, or multiple implementations.

## Async And Resources

- Propagate cancellation where operations can block or outlive their caller.
- Clean up processes, sessions, sockets, timers, listeners, temporary resources, and native handles on success and failure.
- Make concurrency limits, retry policy, timeout semantics, and idempotency explicit where external effects occur.
- Do not swallow rejected promises or rely on unobserved background work for required behavior.

## Verification

Use repository-declared commands. Run focused tests first, then applicable type checking, lint/format checks, builds, broader tests, and package/runtime smoke checks. Verify generated outputs are reproducible and not treated as authored source. Report unavailable checks rather than inventing commands or treating them as passing.
