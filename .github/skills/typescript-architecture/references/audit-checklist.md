# TypeScript SPEC Audit Checklist

Apply within the independent consolidated SPEC audit; do not start a separate review loop.

## Authority And Structure

- Runtime, package manager, lock file, module format, compiler/build settings, and output boundary match confirmed SPEC.
- Root/module navigation, package ownership, actual entry points, and exports match SPEC.
- Imports follow declared dependency direction with no private-path or circular-boundary violations.
- Generated, vendored, authored, test, and runtime artifacts remain in their owned boundaries.

## Runtime Correctness

- Untrusted runtime values are validated rather than trusted because of static types.
- Public contracts, discriminated states, errors, cancellation, timeouts, retries, and cleanup match SPEC.
- Platform/framework types do not leak across boundaries forbidden by SPEC.
- No `any`, assertion, mock, stub, hardcoded success, or ambient side effect bypasses required behavior.

## Toolchain And Evidence

- Manifest and lock file agree; imported dependencies are declared.
- Compiler, lint, format, test, build, packaging, and smoke commands required by SPEC were run.
- Tests exercise public behavior and failure invariants rather than only implementation details.
- Missing environment or platform checks are reported as blocking when SPEC requires them.

For each applicable item, cite concrete SPEC clauses and diff evidence. Passing type checking or tests alone does not establish implementation conformance.
