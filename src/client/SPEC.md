# Module: client

## Purpose

Own the package's Public Client API and sole production composition root. Client converts validated configuration into one statically assembled Gateway, provides a structured Run scope, exposes logical observations/results/Run queries, and hides Kernel, Ports, Adapters, native IDs, endpoints, and storage paths.

## Dependencies

- Project: public Contracts, Kernel public internal entry, and explicit production Adapter factories.
- External: no Provider library directly; those remain in Adapters.
- Forbidden: CLI formatting and alternate dynamic composition.

## Public Interface

The package public export provides `createMacOSComputerUseClient(config)` and public Contract types/schemas. The client exposes:

- existing structured `run(options, callback)` lifecycle for configured-AUT callers, plus an internal Pi-run entry that supplies ApplicationTarget, returns the initial Observation, and exposes one runner-only assertion-freeze operation;
- Run-scope `observe`, compact/query/expand, and typed action/assertion operations;
- read-only Run list/show and Evidence export operations;
- explicit recovery and doctor application operations used by CLI.

Existing public `run` and `runScenario` retain configured-AUT behavior. The private Pi runner invokes a Client application-target entry that validates ApplicationTarget, then follows the same lock, recovery, allocation, readiness, callback, finalization, Evidence, and cleanup lifecycle while overriding only the selected AUT identity and using the one-time post-readiness assertion freeze for that Run. Pi performs the interactive target confirmation before calling Client. A closed handle returns `RunClosed`. Client and Pi never expose resolved bundle ID or application path.

## Composition Root

Production composition explicitly constructs TartImageAdapter, TartVmAdapter, TartExecGuestAdapter, Mac2DesktopAdapter, LocalEvidenceAdapter, SystemClock, SecureIdGenerator, FileGatewayLock, configured isolated Hook Workers, and Kernel. Startup validates Host/Node/Tart and exact OCI digest cache identity before Run allocation. Clone-local Guest/Appium/Mac2/WDA/permission compatibility is validated after allocation but before business work. There is one production path and no reflection, Service Locator, plugin scan, or caller-supplied production Adapter override.

Tests may use the internal, unexported Client construction boundary; deterministic Kernel tests inject Fake Ports, Clock, and IdGenerator directly without exposing them from the package public API.

## Data And State Flow

Untrusted configuration, Pi ApplicationTarget, Scenario, and operation inputs parse through Contracts schemas. Configured-AUT callers remain unchanged. For Pi-managed Runs, the resolved ApplicationDescriptor is frozen in Kernel state but is not added to a new public response or persisted snapshot schema in this increment. Client/Pi never return resolved bundle ID or application path.

## Internal Structure

- Public client factory and exported client/run-handle interfaces.
- Production composition root.
- Public-to-Kernel request/result adaptation.
- Read-only Run and export application operations.
- Internal test composition seam.

## Architecture

- Architecture level: Level 2 application facade.
- Runtime boundary: in-process Node API.
- Dependency direction: callers depend on Client; Client composes inward Contracts/Kernel and outward Adapter implementations.
- Public export boundary: `src/client/index.ts` plus explicitly re-exported Contracts.

## Error Handling

Expected failures return OperationResult. Once a Run is allocated, Client always attempts to return the complete RunResult even when business verdict fails, Evidence is incomplete, or cleanup fails. Internal invariant failures are the only thrown errors. Cancellation is normalized rather than leaking platform AbortError.

## Verification Scope

Tests cover public exports, strict config parsing, composition version failure before effects, structured-scope cleanup across callback outcomes, RunClosed behavior, logical-reference-only outputs, cancellation normalization, full result preservation, and CLI-equivalent application operations.

## Current Invariants

- Client is the only public programming entry and only production composition root.
- Public callers cannot bypass Kernel policy or cleanup.

## Explicit AI Visual Evaluation

AI visual evaluation is disabled by default. The Client factory accepts an optional caller-injected visual evaluator separately from serializable GatewayConfig; it is not a provider override. Only a predeclared aiVisual assertion with accepted=true may invoke it. It receives a copy of the current Observation display screenshot, logical observation identity and goal, plus cancellation. Its model identity and strict passed/failed/unverifiable response are validated. The result records the model and screenshot ArtifactRef with the Observation; missing, stale, cancelled or malformed evaluation is unverifiable. No model service, credential, upload destination or background evaluation is inferred.
