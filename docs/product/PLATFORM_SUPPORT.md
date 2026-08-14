# Platform Support Strategy

## Current development reality

Red Light RNG is architected as a cross-platform Android + iOS application, but current real-device development and field validation are **Android-first** because an iPhone is not presently available for testing.

This is a validation constraint, not a decision to make the product Android-only.

## Required architecture boundary

Platform-sensitive background location behavior must remain behind a narrow adapter/service boundary.

Shared code should own:

- route models and geometry;
- run lifecycle/domain state;
- raw telemetry data shape;
- persistence interfaces and shared SQLite logic where practical;
- start/finish/checkpoint algorithms;
- PB/Gold/Sum-of-Best calculations;
- analytics and post-run explanations;
- most UI and navigation.

Platform adapters should own only behavior that genuinely differs by operating system, such as:

- requesting and interpreting location permissions;
- starting/stopping background location services/tasks;
- OS lifecycle handling needed for locked/background operation;
- native foreground-service/session configuration;
- platform-specific location quirks.

The first implementation may use one shared Expo-backed adapter if it works. If Android later needs Kotlin or iOS later needs Swift, those should be alternative implementations of the same conceptual boundary rather than reasons to rewrite shared product code.

## Android status

Android is the platform that must be field-tested during the current development phase. Background/locked-screen tracking claims require real Android-device evidence.

## iOS status

iOS is an intended supported platform but remains **unvalidated** until a physical iPhone is available.

Until then:

- keep the project build/config structure compatible with iOS;
- do not claim iOS background tracking works merely because shared Expo APIs compile;
- do not prematurely add iOS-specific workarounds without device evidence;
- preserve the platform adapter boundary so later iOS validation/fixes stay localized.

When an iPhone becomes available, create a dedicated iOS validation ticket. Any required iOS-specific fix should be implemented in the platform layer whenever practical, followed by regression testing of shared behavior.
