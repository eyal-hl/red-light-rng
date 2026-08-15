# Architecture

This document records product-level technical constraints and the foundational stack choices for Red Light RNG.

## Stack

- Client: **React Native + Expo + TypeScript**
- Target platforms: **Android and iOS**
- Development/runtime model: **Expo Development Builds**, not Expo Go for real background-location testing
- Background location: **`expo-location` + `expo-task-manager` initially**
- Persistence: **local SQLite via `expo-sqlite`**
- Server: **none for initial versions**
- Mapping SDK: **MapLibre React Native initially, isolated from route/timing/domain logic**
- Native escape hatch: **Expo Modules API**, using Kotlin on Android and Swift on iOS when platform-specific behavior is required
- External services: **none required for recording, persistence, timing, or analytics; basemap/style/tile requests may use network access**

Do not replace the selected mobile stack or add a backend/cloud dependency in unrelated feature work. Map rendering is replaceable behind the project-owned map boundary described below.

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
2. **Run/recording recorder** — background location sampling and lifecycle state for route creation and, later, attempts.
3. **Location adapter** — shared interface over Expo/native background location behavior.
4. **Course matching** — determines progress along a saved route and whether an attempt remains on-course.
5. **Timing engine** — detects start, checkpoint crossing, finish, segment times, and total time.
6. **Analytics engine** — PBs, Golds, Sum of Best, ranking, moving/waiting time, continuous deltas, and post-run highlights.
7. **Local persistence** — stores routes, checkpoints, runs/recordings, raw telemetry, and derived/cached results in SQLite.
8. **UI** — route management before a run and analysis/history after it. Active-run UI should remain minimal.
9. **Map rendering** — renders project-owned geometry through an isolated `RouteMap`-style boundary; map-SDK types must not leak into domain/persistence/timing code.

These are conceptual boundaries, not a requirement to create nine modules immediately.

## Data principles

Raw data is more durable than derived analytics. A completed run or route-source recording should preserve timestamped location samples rather than only saving aggregate or cleaned geometry.

A raw location sample should be able to represent at least:

- timestamp
- latitude
- longitude
- horizontal accuracy
- speed when available
- heading/course when available

Derived values such as a cleaned reference path, route distance, start/finish zones, checkpoint crossing time, segment time, stopped time, route progress, and PB delta should be reproducible from stored telemetry when practical.

Recording sessions should carry a purpose/kind discriminator so route-creation recordings are distinguishable from future official attempts. Route-source telemetry and the reusable route/reference course are separate concepts: deleting or reprocessing derived route data should not silently destroy the source telemetry.

SQLite schema evolution should use an explicit versioned migration mechanism once durable product data exists. Do not rely only on `CREATE TABLE IF NOT EXISTS` for future schema changes.

A conceptual domain model is:

```text
RecordingSession
├── kind / purpose
├── state
└── raw_points[]

Route
├── name
├── transportation_mode
├── source_recording_id
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

## Map rendering

Use MapLibre React Native initially for route review/detail, behind a project-owned component/interface such as `RouteMap`.

`RouteMap` should receive project-owned geometry such as:

- `LatLng[]` / reference path;
- start/end zones;
- later checkpoints;
- optional display metadata.

MapLibre coordinates, sources, layers, camera objects, and other SDK-specific types must remain UI implementation details.

Basemap/style/tile availability must not become a dependency of route recording, local persistence, route derivation, or analysis. V0.1 does not require offline tile packs. If map resources cannot load, route data must remain safe/saveable and the UI should clearly degrade rather than losing product state.

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

Route-creation start/end zones are provisional derived setup data, not official competitive timing decisions. They may use simple deterministic quality/movement filtering and should remain recomputable from preserved source telemetry until a later ticket adds explicit timing/editing behavior.

## Background-location constraints

Background location is the riskiest technical dependency and requires real-device validation for any platform-specific success claim.

Current architectural assumptions:

- Android locked/background recording has been field-validated for the current development phase.
- iOS remains an intended supported target but is explicitly unvalidated until a physical iPhone is available.
- V0.1 uses explicit foreground user actions (route recording now; `ARM` for timed attempts later) before the phone goes into a pocket/locks.
- The app then continues recording location while backgrounded/locked.
- The initial implementation should not depend on the OS relaunching an app that the user force-terminated.
- Fully passive detection from a terminated/not-opened app is a later problem and may require different platform-specific strategies.
- Expo Go is not an acceptable validation environment for background-location capability; use actual development/preview builds.

## Testing strategy

The architecture should make route/timing/analytics logic testable without physically riding a route.

Prefer:

- deterministic tests using recorded/synthetic GPS traces;
- fixtures for noisy GPS, pauses, detours, poor-accuracy points, and checkpoint crossings;
- replaying stored traces through newer route/timing/analytics logic;
- testing cleaned/reference geometry separately from immutable raw telemetry;
- separating pure route/timing calculations from OS location APIs;
- real-device field tests for background GPS and lifecycle behavior on Android now and iOS when hardware is available.

The initial Android background-location spike is complete enough to proceed with Android-first product work. iOS must remain labeled unvalidated until real-device evidence exists.

## Environment assumptions

- Initial product supports Android and iOS as product targets.
- No network connection should be required to record, persist, or analyze a run/route, aside from optional map basemap/style/tile behavior.
- Local persistence is SQLite.
- Real-device validation is part of the development process because background behavior varies by OS/device.
- Native Kotlin/Swift code is allowed when a small platform-specific adapter is demonstrably needed.
