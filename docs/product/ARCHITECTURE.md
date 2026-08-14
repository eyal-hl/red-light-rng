# Architecture

This document records constraints that are already product decisions while keeping implementation choices explicitly open until they are actually selected.

## Stack

- Client platform/framework: **TBD**
- Server: **none for initial versions**
- Persistence: **local on-device database/storage; exact technology TBD**
- Mapping/location SDK: **TBD**
- External services: **none required for the initial product**

Do not silently choose a mobile framework, database, mapping provider, or target OS in unrelated feature work. Those choices should be made explicitly and recorded in `DECISIONS.md`.

## System boundaries

The initial application is a single local-first mobile system with several conceptual responsibilities:

1. **Route model** — saved reference path, transportation mode, start/end zones, checkpoints, and later route variants.
2. **Run recorder** — background location sampling and run lifecycle state (`idle`, `armed`, `active`, `finished`/`cancelled`).
3. **Course matching** — determines progress along a saved route and whether an attempt remains on-course.
4. **Timing engine** — detects start, checkpoint crossing, finish, segment times, and total time.
5. **Analytics engine** — PBs, Golds, Sum of Best, ranking, moving/waiting time, continuous deltas, and post-run highlights.
6. **Local persistence** — stores routes, checkpoints, runs, raw telemetry, and derived/cached results.
7. **UI** — route management before a run and analysis/history after it. Active-run UI should remain minimal.

These are conceptual boundaries, not a requirement to create seven modules immediately.

## Data principles

Raw data is more durable than derived analytics. A completed run should preserve timestamped location samples rather than only saving aggregate split times.

Conceptually, a raw location sample should be able to represent at least:

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

The final persistence schema should be normalized appropriately for the selected local database rather than storing this literal nested shape.

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
- Start timing is based on inferred physical departure along the course.
- Finish timing occurs when the course finish condition is crossed; parking/stopping afterward should not count.
- Detection may occur slightly after the true event; when possible, the event timestamp should be reconstructed from recorded samples rather than using the moment the software made the decision.

## Testing strategy

Exact tooling is TBD with the stack, but the architecture should make the timing/analytics logic testable without physically riding a route.

Prefer:

- deterministic tests using recorded/synthetic GPS traces;
- fixtures for noisy GPS, pauses, detours, and checkpoint crossings;
- replaying stored traces through newer analytics logic;
- separating pure route/timing calculations from OS location APIs where practical.

Real-device field tests will still be necessary for background GPS and lifecycle behavior.

## Environment assumptions

- Initial product is for one user and one device.
- No network connection should be required to record or analyze a run, aside from any unavoidable map-tile behavior of the chosen map implementation.
- Background location behavior and permissions are platform-sensitive and must be validated once the target mobile platform is chosen.
