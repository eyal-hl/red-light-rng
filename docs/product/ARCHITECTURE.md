# Architecture

This document records product-level technical constraints and the foundational stack choices for Red Light RNG.

## Stack

- Client: **React Native + Expo + TypeScript**
- Target platforms: **Android and iOS**
- Development/runtime model: **Expo Development Builds**, not Expo Go for real background-location testing
- Background location: **`expo-location` + `expo-task-manager` initially**
- Persistence: **local SQLite via `expo-sqlite`**
- Server: **none for initial versions**
- Mapping SDK: **TBD and intentionally isolated from route/timing logic**
- Native escape hatch: **Expo Modules API**, using Kotlin on Android and Swift on iOS when platform-specific behavior is required
- External services: **none required for the initial product**

Do not replace the selected mobile stack or add a backend/cloud dependency in unrelated feature work. Mapping remains intentionally undecided until the product needs it.

## Cross-platform principle

Most product logic should remain shared TypeScript. Platform-specific operating-system behavior must sit behind narrow interfaces rather than leaking throughout the domain model.

In particular, background location should be treated as a platform-sensitive adapter behind a shared abstraction such as:

```ts
interface LocationTracker {
  startTracking(): Promise<void>;
  stopTracking(): Promise<void>;
  getState(): TrackingState;
}
```

The exact interface can evolve with implementation, but route matching, timing, splits, PB calculations, and analytics should not directly depend on Android/iOS location APIs.

Start with Expo's location/task APIs. If field testing shows that one platform requires capabilities Expo does not expose reliably enough, add a small native module through Expo Modules API rather than rewriting the application.

## System boundaries

The initial application is a single local-first mobile system with several conceptual responsibilities:

1. **Route model** — saved reference path, transportation mode, start/end zones, checkpoints, and later route variants.
2. **Run recorder** — background location sampling and run lifecycle state (`idle`, `armed`, `active`, `finished`/`cancelled`).
3. **Location adapter** — shared interface over Expo/native background location behavior.
4. **Course matching** — determines progress along a saved route and whether an attempt remains on-course.
5. **Timing engine** — detects start, checkpoint crossing, finish, segment times, and total time.
6. **Analytics engine** — PBs, Golds, Sum of Best, ranking, moving/waiting time, continuous deltas, and post-run highlights.
7. **Local persistence** — stores routes, checkpoints, runs, raw telemetry, and derived/cached results in SQLite.
8. **UI** — route management before a run and analysis/history after it. Active-run UI should remain minimal.

These are conceptual boundaries, not a requirement to create eight modules immediately.

## Data principles

Raw data is more durable than derived analytics. A completed run should preserve timestamped location samples rather than only saving aggregate split times.

A raw location sample should be able to represent at least:

- timestamp
- latitude
- longitude
- horizontal accuracy
- speed when available
- heading/course when available

Derived values such as checkpoint crossing time, segment time, stopped time, route progress, and PB delta should be reproducible from stored telemetry when practical.

A conceptual domain model is:

```text
Route
├── name
├── transportation_mode
├── reference_path[]
├── start_zone
├── end_zone
└── checkpoints[]

Run
├── route_id
├── state / validity
├── started_at
├── finished_at
├── raw_points[]
└── derived_results
```

The final SQLite schema should be normalized appropriately rather than storing this literal nested shape.

## Route matching

A route is not an exact sequence of GPS coordinates. GPS measurements vary between attempts.

The system should eventually model:

- progress along a reference path;
- an accepted corridor/tolerance around that path;
- checkpoint crossing based on geography/progress rather than exact coordinate equality;
- invalidation or separate classification for material route deviations.

Continuous progress along the reference route is important because it enables position-based ghost/delta analysis, not just checkpoint-based comparison.

## Timing principles

- Arming a route does **not** start the timer.
- Arming may start the OS background-location tracking session while the app is foregrounded.
- Start timing is based on inferred physical departure along the course.
- Finish timing occurs when the course finish condition is crossed; parking/stopping afterward should not count.
- Detection may occur slightly after the true event; when possible, the event timestamp should be reconstructed from recorded samples rather than using the moment the software made the decision.

## Background-location constraints

Background location is the riskiest technical dependency and must be validated on real Android and iOS devices before building major product functionality on top of it.

Current architectural assumptions:

- V0.1 uses an explicit user action (`ARM`) while the app is foregrounded before the phone goes into a pocket/locks.
- The app then continues recording location while backgrounded/locked.
- The initial implementation should not depend on the OS relaunching an app that the user force-terminated.
- Fully passive detection from a terminated/not-opened app is a later problem and may require different platform-specific strategies.
- Expo Go is not an acceptable validation environment for this capability; use actual development builds.

## Testing strategy

The architecture should make timing/analytics logic testable without physically riding a route.

Prefer:

- deterministic tests using recorded/synthetic GPS traces;
- fixtures for noisy GPS, pauses, detours, and checkpoint crossings;
- replaying stored traces through newer analytics logic;
- separating pure route/timing calculations from OS location APIs;
- real-device field tests for background GPS and lifecycle behavior on **both Android and iOS**.

The first engineering spike should validate locked-screen/background location recording on both platforms before significant application UI or route logic is built.

## Environment assumptions

- Initial product supports Android and iOS.
- No network connection should be required to record or analyze a run, aside from any unavoidable map-tile behavior of the eventual map implementation.
- Local persistence is SQLite.
- Real-device validation is part of the development process because background behavior varies by OS/device.
- Native Kotlin/Swift code is allowed when a small platform-specific adapter is demonstrably needed.
