# Module: adapters

## Purpose

Adapters owns production translations between provider-neutral Ports and external Tart, Guest, Appium Mac2, and local Evidence mechanisms. This parent module defines shared isolation and conformance rules and navigates independently owned concrete Adapter modules.

## Dependencies

- Project: public `contracts`.
- External dependencies are owned only by the concrete child Adapter that uses them.
- Forbidden: Kernel business policy, CLI output, Client lifecycle, and direct child-to-child calls.

## Public Interface

Adapters exposes production Adapter factories only to the Client composition root. Concrete implementations satisfy Contracts-owned Ports. No concrete Adapter class, Provider handle, native ID, endpoint, command payload, or raw exception is part of the package public API.

Child ownership:

- `tart/`: ImagePort and VmPort.
- `guest/`: GuestPort.
- `mac2/`: DesktopPort.
- `evidence/`: EvidencePort.

## Internal Structure

The parent contains only shared secret-safe normalization utilities and explicit child exports needed by the production composition root. Utilities used by one Provider remain in that Provider module.

## Architecture

- Architecture level: parent navigation over Level 2 boundary Adapters.
- Dependency direction: child Adapters depend on Contracts and external providers; never on Kernel or one another.
- Model boundary: raw provider responses are parsed/normalized before crossing a Port.

## Error Handling

Adapters convert provider exceptions, exits, timeouts, cancellation observations, and malformed responses into stable neutral errors and receipts. Unknown dispatch/outcome remains unknown. Raw stderr, response bodies, stack traces, endpoints, absolute paths, and native IDs go only to controlled sanitized diagnostics.

## Verification Scope

Every Adapter runs the shared semantic Port profile. Real implementations additionally run provider conformance; image/VM/Guest lifecycle runs the destructive profile on a provisioned Host. Fake success is never provider-conformance evidence.

## Current Invariants

- An Adapter performs one provider operation per Port call and hides no retry.
- Concrete Provider vocabulary does not leak across Ports.
- Unsupported capabilities fail before effects.
