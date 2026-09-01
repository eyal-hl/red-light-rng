# Product & Architecture Decisions

Durable decisions that future work should not silently revisit.

## DEC-001 — Local-first initial product

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
Initial versions store product data locally on the device and do not require a backend, account system, or cloud synchronization.

### Why
This is a personal-use project. A backend would add complexity without improving the core experiment: whether repeated-route speedrunning is useful and fun.

### Consequences
- Core recording and analytics must work offline.
- Multi-device sync, sharing, and remote backups are out of scope initially.
- The persistence choice should support substantial historical GPS telemetry locally.

---

## DEC-002 — No meaningful live-run UX

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
The phone is expected to remain in the user's pocket during an attempt. The active-run screen exists primarily for status/cancellation, not for live timing, navigation, or interaction.

### Why
The initial use case is travel by electric scooter. The product should not require looking at or operating the phone while moving.

### Consequences
- Start, splits, and finish must be detected automatically after arming.
- The main product reward happens in post-run analysis.
- Features must not rely on active-run button presses.

---

## DEC-003 — Armed automatic recording before passive detection

**Status:** Accepted  
**Date:** 2026-08-14  
**Updated:** 2026-09-01

### Decision
V0.1 requires an explicit **START** before travel. START begins observation but does not begin official timing. Actual start and finish are detected from saved-place geometry and location behavior, not from selecting a route, destination, or transportation mode in the live flow.

There is one global START. The app evaluates active saved places, shows `IN START ZONE — <PLACE>` or `OUTSIDE START ZONE`, and pins the origin only after a qualifying path-free departure. The destination is the first other saved place that becomes eligible and is then entered. Fully passive recognition with no START remains a later milestone.

### Why
This dramatically reduces ambiguity while preserving the phone-in-pocket experience. Fully passive route recognition can come later after real data exists. Requiring a pre-run route picker would fight the product goal: get from meaningful point A to meaningful point B as fast as possible, on any physical path.

### Consequences
- Run lifecycle includes an `armed/waiting for start` state.
- Arming time is not the run start time.
- Official competitive identity is a directional journey: origin place + destination place + transportation mode.
- Fully automatic recognition without START belongs to a later milestone.

---

## DEC-004 — Preserve raw location telemetry

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
Store raw timestamped GPS/location samples for historical runs rather than only storing aggregate timing results.

### Why
The most valuable analytics have not all been designed yet. Preserving telemetry allows new splits, moved checkpoints, continuous deltas, stop analysis, and future algorithms to be applied to old attempts.

### Consequences
- Historical derived values may be recalculated.
- Schema design should treat raw telemetry as durable source data.
- Storage efficiency matters, but premature deletion of source telemetry is undesirable for this personal project.

---

## DEC-005 — Splits can be retroactive

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
A user may add, remove, or move geographic checkpoints after runs already exist. When enough raw telemetry exists, historical split results should be recalculated for those attempts.

### Why
Users should not need to perfectly design a course before collecting useful data. Repeated travel should teach the product where interesting splits belong.

### Consequences
- Checkpoint definitions are separate from immutable raw run samples.
- Split results are derived data, not the only source of truth.

---

## DEC-006 — Transportation modes have separate competitive histories

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
Scooter, bicycle, walking, running, and other modes must not compete against one shared PB for the same geometry.

### Why
They are fundamentally different categories, analogous to separate speedrun categories.

### Consequences
- Transportation mode is part of journey/category identity (`origin_place_id + destination_place_id + transportation_mode`).
- PBs, Golds, rankings, and Sum of Best are calculated within the relevant category.
- The live START flow does not choose a mode; a persisted active mode is used and can be corrected after the run.

---

## DEC-007 — Path variants are optional analytics, not competitive identity

**Status:** Accepted  
**Date:** 2026-08-14  
**Updated:** 2026-09-01  
**Supersedes:** the earlier rule that material course deviation invalidates/unranks an otherwise valid A→B attempt.

### Decision
A materially different physical path between the same saved-place endpoints must still count in the same directional journey + mode PB/rank/history pool.

Existing route/course geometry remains as an optional **path variant**. Compatible-path analytics (splits, Gold, Sum of Best, ghost, wait/movement that require matched progress) may be attached when the path matches a known variant, re-anchored to the journey `startedAtMs`/`finishedAtMs`. Failure to match a variant means only **path-specific analytics unavailable**. It must never produce a user-facing wrong-route failure or remove the attempt from the journey leaderboard.

### Why
The competitive product is endpoint speedrunning: get from A to B as fast as possible. Comparing only traces that follow one polyline would punish ordinary street choice and GPS noise.

### Consequences
- Journey official time is always the path-free endpoint window.
- Path-variant analytics are secondary and must not use a second hidden timing clock.
- Automatic clustering of new path variants is out of scope until a later ticket.

---

## DEC-008 — Deterministic analytics before AI analytics

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
Initial post-run insights should be computed from deterministic rules/statistics. An LLM is not required for explanations such as biggest time loss, new Golds, or stopped-time effects.

### Why
The data is structured and the useful first insights are deterministic. AI would add cost and complexity without being necessary for the core experience.

### Consequences
- Analytics should expose structured facts that could later feed richer narration if desired.

---

## DEC-009 — Human gates remain before build and merge

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
The autonomous development workflow keeps two explicit human gates: approve the product ticket before Cursor implementation begins, and approve/merge the resulting PR after automated review and QA.

### Why
The goal is autonomous execution, not autonomous product direction or uncontrolled merging.

### Consequences
- Brainstorming in ChatGPT can become a GitHub proposal without immediately triggering code.
- An explicit approval action/label/comment is required to start implementation.
- Automated agents must not merge to the default branch.

---

## DEC-010 — React Native + Expo cross-platform foundation

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
Red Light RNG will target both Android and iOS using React Native + Expo + TypeScript. Real background-location work will use Expo Development Builds. Initial local persistence will use `expo-sqlite`; initial background location will use `expo-location` and `expo-task-manager`. Platform-specific gaps may be implemented through Expo Modules API using Kotlin/Swift.

### Why
The product needs to run on both Android and iOS while sharing the majority of UI, domain, and analytics logic. Expo provides a practical shared foundation for location, task management, and SQLite while preserving an escape hatch to native code for the background-location behavior that is most likely to differ by OS.

### Consequences
- Android and iOS are both first-class product targets.
- Expo Go must not be used as proof that background tracking works; real development builds and physical devices are required for platform-specific claims.
- Shared TypeScript should own route/timing/analytics logic where practical.
- OS-specific tracking behavior should remain behind a narrow adapter/interface.
- Mapping is selected separately under DEC-012 and remains isolated from route/timing/domain logic.
- Replacing this stack should require an explicit architecture decision rather than happening inside unrelated feature work.

---

## DEC-011 — Validate background tracking before building the product around it

**Status:** Accepted  
**Date:** 2026-08-14  
**Updated:** 2026-08-15

### Decision
The first engineering implementation is a minimal technical spike that records raw location points while the phone is locked/backgrounded. During the current development phase, real-device validation is Android-first because an iPhone is not available. Android background tracking must be proven on a physical Android device before Android product work builds on it. iOS remains an intended supported platform but stays explicitly unvalidated until a physical iPhone is available.

### Why
Reliable background telemetry is the highest-risk technical assumption in the product. Requiring evidence on the platform we can actually test prevents avoidable rework without falsely claiming iOS support or blocking all Android progress on unavailable hardware.

### Consequences
- The first ticket is intentionally not a polished product feature.
- It should expose enough raw telemetry to judge quality: timestamp, coordinates, accuracy, speed, and heading/course when available.
- Android background/locked-screen claims require real Android-device evidence.
- iOS background behavior must remain behind the platform boundary and must be described as unvalidated until a real iPhone test occurs.
- A dedicated iOS validation/fix ticket should be created when an iPhone becomes available.
- Android product work may proceed after Android validation succeeds without treating successful shared builds as iOS evidence.

---

## DEC-012 — Use MapLibre with OpenFreeMap behind an isolated route-map boundary

**Status:** Accepted  
**Date:** 2026-08-15  
**Updated:** 2026-08-15

### Decision
Use **MapLibre React Native** as the initial map renderer for route review/detail, with the **OpenFreeMap Liberty** hosted style as the initial street-level basemap source:

`https://tiles.openfreemap.org/styles/liberty`

Map rendering must sit behind a project-owned UI boundary such as `RouteMap` that accepts project-owned route geometry (`LatLng`, paths, zones, later checkpoints). MapLibre-specific types must not become route, timing, course-matching, or persistence domain types.

### Why
Route review is the first feature that genuinely needs a street-level map. Choosing both renderer and initial style source avoids leaving a blocking infrastructure decision to an agent mid-ticket. OpenFreeMap's public instance is keyless and intended for MapLibre/mobile use, so the first route-recording slice does not require provisioning a Google Maps/API-provider credential or signing-key restriction.

### Consequences
- The initial route review/detail UI should use MapLibre React Native with the OpenFreeMap Liberty style URL above.
- No map API key or EAS map secret is required for the initial provider.
- Preserve the attribution rendered by MapLibre/OpenFreeMap; do not intentionally hide required OpenStreetMap/OpenMapTiles attribution.
- OpenFreeMap is an external best-effort basemap service with no SLA; it must remain replaceable behind `RouteMap`.
- Route recording, persistence, reference-course derivation, save/delete behavior, and analysis must not depend on map availability or network access.
- V0.1 does **not** require offline basemap/tile-pack management.
- If the style/tiles are unavailable, the review/detail surface should still render the route path and start/finish-zone geometry in a local fallback/no-basemap presentation when practical, and must still allow saving/deleting route data.
- Physical validation should include a tiles-unavailable/airplane-mode check proving that route data and local geometry remain usable even when the street basemap cannot load.
- Replacing MapLibre or the hosted style source later should not require rewriting domain logic.
