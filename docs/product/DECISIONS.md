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
- The ARMED screen may show an interactive current-location map with saved places (pan, zoom, recenter). The ACTIVE screen may show an optional, passive, non-interactive, non-required map for glances only. It has no gestures or map controls, never obstructs status, Cancel or End & Inspect, and is unmounted while the app is backgrounded or the screen is locked. Recording, timing and automatic finish never depend on it.

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
- Amended by DEC-016: a separate, versioned **competitive checkpoint** type may time segments of a journey pool on their own boards. It does not change the path-free official time or the path-variant analytics above.

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

## DEC-009 — Owner authorization before coding and merge

**Status:** Accepted (updated 2026-10-27)  
**Date:** 2026-08-14

### Decision
Two owner decisions are preserved: authorization to implement a defined product goal, and approval to merge the resulting change. **Implementation authorization may be granted in the original explicit "implement this" request**, recorded as a genuine owner-authored `[AUTO-RUN AUTHORIZED]` GitHub issue comment before applying the `proposal` label. This delegates bounded specification reconciliation and later implementation only after an independent current-version Disagreer PASS. No second redundant approval is needed.

For ticket-only or brainstorming requests no implementation authority exists: the autonomous planning loop may challenge and reconcile safely but stops at READY FOR OWNER APPROVAL. New material scope, product choices, privacy/security risks or destructive changes require fresh owner authorization.

### Why
Keep autonomous delivery from creating unrequested code while removing unnecessary repeated approvals.

### Consequences
- `proposal` labels alone never authorize code; trusted author, time and issue-specific scope matter.
- A passed issue revision is identified with SHA-256 of the exact GitHub title and body.
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
- The ARMED/ACTIVE attempt map (`AttemptLiveMap`) uses the same basemap, so while it is displayed OpenFreeMap tile requests reveal the user's live vicinity (the map area around the current position) to that third-party service. The map is not shown while backgrounded or locked, and falls back to a local schematic of saved places when tiles are unavailable. It reads only the attempt engine's persisted samples and effective place set; it adds no location watcher, position poll or MapLibre user-location provider.
- If the style/tiles are unavailable, the review/detail surface should still render the route path and start/finish-zone geometry in a local fallback/no-basemap presentation when practical, and must still allow saving/deleting route data.
- Physical validation should include a tiles-unavailable/airplane-mode check proving that route data and local geometry remain usable even when the street basemap cannot load.
- Replacing MapLibre or the hosted style source later should not require rewriting domain logic.

---

## DEC-013 — Product-level portable backup, replace-only restore

**Status:** Accepted (issue #72)
**Date:** 2026-10-27

### Decision
Local history is exported to a single deterministic, versioned JSON file (`backup_format_version`, independent of the SQLite schema version) with a SHA-256 integrity check, and restored with a validate-first, replace-only, single-transaction flow. Details: `docs/specs/backup-format.md`.

### Consequences
- No cloud or account; the user chooses the destination through the OS share/save sheet. The file contains precise location history and the UI says so before export.
- Restore never trusts a backed-up armed/active attempt or active session as live: they are terminalized from stored evidence, leftover OS updates are stopped, and derived data is recomputed.
- Restore is refused while the current device has an open attempt or active tracking session.
- New durable columns must be added to the backup coverage map (a test enforces this).

## DEC-014 — Independent Place departure and arrival radii

**Status:** Accepted (issue #77)

### Decision
Each Place has a `departureRadiusMeters` (origin selection, outward-crossing start time, `+18 m` sustained departure) and an `arrivalRadiusMeters` (destination eligibility `+10 m`, inbound-crossing finish time, return-to-origin dwell). Both are 8-250 m and default to 30 m; existing Places migrate with the old radius in both fields (SQLite schema v12, backup format 2, with a 1 -> 2 backup adapter). The return-to-origin distance gate is `max(50 m, 2 × max(departure, arrival))`.

### Consequences
- Equal radii reproduce the previous single-radius behavior exactly.
- Saving a changed radius is refused while any attempt is armed or active (the engine replays the stored trace against current Place records); no per-attempt radius snapshot is stored. Restore terminalizes open attempts with the radii in the backup.
- Completed attempts keep stored official times; only the debug replay of a past run uses current radii and states that. Route/path-variant start/finish zones remain separate analytics configuration.

## DEC-015 — Manual, resumable historical recalculation

**Status:** Accepted (issue #77, owner-approved scope extension 2026-11-02; amends the DEC-014 "never rewrites" consequence)

### Decision
Past official times are never rewritten as a side effect of editing a radius, migrating or restoring. Instead the user may explicitly run **Recalculate history** (Places screen, offered after a radius change) after a confirmation that names the risks: official times, PBs, rankings, segments and statistics may change; runs without sufficient GPS cannot be updated; results use the CURRENT radii because no historical snapshot exists. The job replays each completed run's raw trace through the live place-timing engine with the run's stored endpoints, stages results in local SQLite tables (schema v13: `recalc_job`, `recalc_job_item`), and publishes them in a single transaction (memory store: an atomic swap) together with split/variant reassignment. Skips (endpoint/geometry changed, insufficient GPS), unchanged results and per-attempt errors preserve the original record. A Places fingerprint, an edit lock on Place centre/radii while a job exists, and a pause while a run is armed/active prevent stale or concurrent publication. At most one job exists; a duplicate trigger shows it.

### Consequences
- No elapsed-time cutoff: bounded chunks with yields, a persisted checkpoint, resume on relaunch (offered as an explicit button, not started automatically), cancel before publication, retry of failed runs as a follow-up job.
- Job tables are operational state outside the portable backup (see `docs/specs/backup-format.md`); restore deletes them.
- PBs/rankings are derived from attempts at read time, so publication plus cache invalidation keeps them consistent; no stored PB is rewritten separately.
- Archiving a Place does not change the fingerprint (centre/radii only); it can still change which Places compete as origins in a replay if done mid-job.

## DEC-016 — Competitive checkpoints and partial attempts (amends DEC-007)

**Status:** Accepted (issue #81, owner-approved resolution of Disagreer round 1, 2026-11-27)

### Decision
A **competitive checkpoint** is a new, versioned, user-defined point scoped to a directional journey pool (`origin_place_id + destination_place_id + transportation_mode`). It is separate from the path-variant analytics checkpoints of DEC-007 (which are progress-along-a-path, only exist with a matched variant, and still sum to the official time). Competitive checkpoints exist so one ride can qualify for several boards (Work → Office junction, Office junction → Home) without the junction becoming a Place: a checkpoint can never start, finish or cancel a journey and never changes official timing.

- **Derived only.** Segment times are computed from the retained raw GPS (DEC-004/005) into a derived table. The attempt's official start/finish, rank, PB and statistics are never read from or written by segment derivation. Missing or unusable checkpoints never invalidate an original full run.
- **Versioned configurations.** Every create/edit/reorder/delete writes a new immutable configuration version for the pool; superseded versions stay readable. A derived result carries the configuration version and the derivation algorithm version it was computed with and is stale when either no longer matches the current one. Stale results are never mixed into a board.
- **Attempt kind.** Every attempt is `full` (all pre-existing attempts) or `partial` (starts at a checkpoint; stores `start_checkpoint_id` and `checkpoint_config_version`). Every full-route ranking, PB, median, statistics, history, departure-grouping and reconciliation query defaults to `full` only; a partial is never a full-route DNF, rank or record. A partial DNF is retained as a clearly labeled non-result (`PARTIAL DID NOT START/FINISH`) with normal hide/delete behavior.
- **Segment times need not sum to the official time**, because the outbound edge of one checkpoint and the inbound edge of the next differ.
- **Segments generated** for a full attempt through ordered checkpoints `C1..Cn` between A and the destination: prefix `A->Ci`, adjacent `Ci->Ci+1` and suffix `Ci->finish`, deduplicated by endpoint pair, never `A->finish` (that is the existing official board). A partial starting at `Ck` only produces segments starting at `Ck` or later (adjacent and suffix).
- **Timing rules** are in `docs/product/CONCEPTS.md` (Competitive checkpoint) and implemented once, in `src/domain/segment-derivation.ts`, reusing the place-timing crossing interpolation, accuracy gate and departure/arrival margins.
- **No fabricated times.** If the evidence for a boundary is missing or ambiguous the segment is `unavailable` with a reason; a DNF or otherwise ineligible attempt yields no segments at all.
- **Manual backfill.** Historical raw tracks are only processed by an explicit, user-confirmed, resumable *Recalculate segments* job (a later stage; DEC-015 constraints apply: one job at a time, bounded chunks, no automatic run on save/migration/restore). Creating a competitive checkpoint or changing its geometry only makes results stale.
- **Edit lock.** Checkpoint configuration may not change while a run is armed/active or any recalculation job exists (`competitiveCheckpointEditBlockReason`).
- **Validation at save time.** Radius 8-250 m; no checkpoint circle may overlap any active Place footprint (the larger of its departure/arrival radius) or another checkpoint of the same pool; at most 8 checkpoints per pool.

### Consequences
- SQLite schema v14 and backup format 3 (additive; a 2 -> 3 adapter imports older backups with every attempt `full`). New tables/columns are in the backup coverage map (DEC-013).
- A place deletion removes that place's configurations (they only exist for pools of that place); attempts, partial included, are removed as before.
- Later stages build on these APIs: manual recalculation job (as a distinct job kind in the existing job store), checkpoint editor and segment leaderboards, partial arming, and the hypothetical potential-record estimate (calculated on display from eligible full-run prefix samples, never persisted as an official result).

### Stage 2 addendum (#81): live derivation and the segment recalculation job
- **Live derivation.** When a run finishes as a completed official result, a deferred hook (`AttemptRuntime.setOnAttemptCompleted`) derives and stores segment rows for the pool's CURRENT configuration version. It runs on a later tick, swallows its own failures and never touches the attempt, so back/done and the results screen are not delayed. A partial attempt only derives against the exact configuration version it started in.
- **Recalculate segments is a distinct job kind** (`recalc_job.kind = 'segments'`, schema v15) in the existing single job slot: at most one job of ANY kind exists, so a segments job and a #77 history job are mutually exclusive, and the existing Place-edit lock covers both. The job's scope (pools and configuration versions) and the Places fingerprint are fixed at start; a change to either before publication discards the staged rows. It is manual only, chunked, resumable after relaunch, pauses behind a live attempt, cancellable before publication, retries failures as a follow-up job, and publishes derived rows in one atomic step (`replaceSegmentResults`), pruning rows of superseded configuration versions. Runs without enough GPS get `unavailable` rows only for the affected segments.
- **History publication invalidates derived rows.** A #77 job that re-times a run deletes that run's segment rows (they were derived from the old official window); they show as stale until a manual segments recalculation.
- **Stale is a version comparison**, never a flag: a result is stale when its configuration or algorithm version is not the current one, stale rows are excluded from boards and reported through `getPoolStatus` (`staleAttemptCount`, `needsRecalculation`).
- **Edit lock** is enforced in `CompetitiveSegmentsService.saveCheckpoints`: rejected while a run is armed/active or any job (either kind) is running or awaiting publication.
- **Segment boards** use the full-route board's semantics (fastest first; ties by earlier start, arming, id; ordinal ranks; median needs two samples; same weekday/time-of-day filters on the attempt's departure; ranked or chronological sort). Full-run suffix results and partial results rank together; the full-route board remains a separate, unchanged path.
