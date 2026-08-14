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

### Decision
V0.1 requires the user to select/arm a route before travel. Arming begins observation but does not begin official timing. Actual start and finish are detected from route/location behavior.

### Why
This dramatically reduces ambiguity while preserving the important phone-in-pocket experience. Fully passive route recognition can come later after real data exists.

### Consequences
- Run lifecycle includes an `armed/waiting for start` state.
- Arming time is not the run start time.
- Fully automatic route recognition belongs to a later milestone.

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
- Transportation mode is part of route/category identity.
- PBs, Golds, rankings, and Sum of Best are calculated within the relevant category.

---

## DEC-007 — Materially different courses should not share a PB

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
A materially deviated course should not silently count against the same route PB. V0.1 may mark such attempts invalid/unranked; later versions may learn recurring route variants as separate categories.

### Why
Comparing different courses undermines the speedrun model.

### Consequences
- Course matching/tolerance is part of run validity.
- Route variants are explicitly a later product feature.

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
- Android and iOS are both first-class targets from the beginning.
- Expo Go must not be used as proof that background tracking works; real development builds and physical devices are required.
- Shared TypeScript should own route/timing/analytics logic where practical.
- OS-specific tracking behavior should remain behind a narrow adapter/interface.
- The map renderer remains an independent TBD decision.
- Replacing this stack should require an explicit architecture decision rather than happening inside unrelated feature work.

---

## DEC-011 — Validate background tracking before building the product around it

**Status:** Accepted  
**Date:** 2026-08-14

### Decision
The first engineering implementation will be a minimal technical spike that records raw location points while the phone is locked/backgrounded and validates the behavior on both a real Android device and a real iPhone.

### Why
Reliable background telemetry is the highest-risk technical assumption in the entire product. Discovering a platform limitation after building route creation, splits, PBs, and analytics would create avoidable rework.

### Consequences
- The first ticket is intentionally not a polished product feature.
- It should expose enough raw telemetry to judge quality: timestamp, coordinates, accuracy, speed, and heading/course when available.
- Success requires real-device evidence from both platforms.
- Major route/timing UI work should wait until this assumption has been validated.
