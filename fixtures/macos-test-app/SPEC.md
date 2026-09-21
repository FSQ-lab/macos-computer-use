# Module: fixtures.macos-test-app

## Purpose

Provide a deterministic native macOS Fixture AUT for Mac2 provider conformance and destructive end-to-end tests. It proves this runtime's automation contracts against one controlled application; it does not imply compatibility with arbitrary third-party applications.

## Dependencies

- Native macOS UI framework and Xcode toolchain fixed by the Golden Image compatibility metadata.
- No network, authentication, user files, external services, or main TypeScript package dependency.

## Public Interface

The Fixture exposes stable Accessibility identifiers and deterministic visible state for:

- single/double/right click targets;
- hover-observable target;
- appendable and replaceable text fields;
- checkbox/state target;
- keyboard shortcut result;
- scrollable/swipeable collection;
- element-relative draggable source and destination;
- visible, text, value, state, order, modal/window, and notVisible assertions.

Each supported action causes a uniquely assertable state change. A launch argument or explicit reset control restores the same initial state. The application has a fixed bundle ID and version/build identity recorded in Golden Image metadata and Run Evidence.

## Internal Structure

- Native app project and source.
- Accessibility identity definitions.
- Deterministic state model and reset path.
- UI surfaces for the declared capability matrix.
- Fixture-specific tests/build configuration.

Generated application products are not tracked as authored source; the validated build is installed into the immutable Golden Image.

## Architecture

- Architecture level: minimal native single application.
- Runtime boundary: Guest-only AUT.
- State boundary: process-local deterministic fixture state; no persistence or network.
- Dependency direction: standalone from the TypeScript runtime.

## Error Handling

The Fixture visibly reports invalid local operations without crashing and supports deterministic relaunch/reset. It never prompts for credentials, network, Host resources, or system permissions beyond the Golden Image's automation setup.

## Verification Scope

Native build/test verifies identifiers and deterministic reset. Provider conformance exercises every declared action and assertion. Destructive lifecycle verifies installation identity, launch/readiness, window ownership, and cleanup in a fresh clone.

## Current Invariants

- Fixture tests are offline and account-free.
- Accessibility identifiers remain stable across the supported Fixture build.
- Fixture source never contains automation-provider IDs or test-only backdoors that bypass real UI interaction.
