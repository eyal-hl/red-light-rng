# Red Light RNG

A personal, local-first mobile app that treats repeated real-world routes like speedruns.

Record a route, repeat it, and compare each attempt against your own history using speedrunning concepts such as Personal Bests, Gold splits, Sum of Best, ghosts, and continuous route deltas.

The app is intentionally designed for **phone-in-pocket use**. Before leaving, the user arms a saved route. Red Light RNG detects the actual start, checkpoints, and finish automatically, records the raw GPS trace, and saves the interesting analysis for afterward.

## Why the name?

Because sometimes you are on PB pace and the next traffic light simply decides otherwise.

## Product principles

- **Personal-use first.** No accounts, social graph, backend, or cloud required initially.
- **Local-first.** Runs, routes, telemetry, and analytics live on the device.
- **Phone in pocket.** An active run must not depend on looking at or interacting with the screen.
- **Preserve raw telemetry.** Historical runs should become more useful as the analysis improves.
- **Speedrun the course, not the app.** Timing starts and ends on route events, not button presses.
- **Compare like with like.** Transportation modes and materially different route variants should not share a PB.
- **Analysis after the run.** The fun is discovering where time was gained or lost.

## Canonical product documentation

`docs/product/` is the source of truth for product behavior:

- `VISION.md` — product vision, goals, non-goals, and core loop
- `CONCEPTS.md` — canonical speedrunning/domain terminology
- `USER_FLOW.md` — user journeys and run lifecycle
- `RUN_ANALYSIS.md` — timing, splits, ghosts, deltas, and post-run insights
- `ROADMAP.md` — staged V0.1 → V0.3 roadmap
- `DECISIONS.md` — durable product decisions
- `ARCHITECTURE.md` — technical constraints and intentionally undecided choices

## Development workflow

This project uses the Agent Foundry workflow:

**brainstorm with ChatGPT → GitHub proposal → human approval → Cursor implementation → independent review/QA → human merge**

Implementation work should begin only from an approved GitHub issue/spec. Product decisions made during brainstorming should be reflected in the canonical docs when they are broader than a single ticket.

## Development

Stack: React Native + Expo SDK 57 + TypeScript. Background location is not valid in Expo Go; use a development build.

```text
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

Android development build (physical device or emulator with Play services):

```text
npx expo run:android
```

iOS development build requires macOS and Xcode and is currently **unvalidated** on a real iPhone:

```text
npx expo run:ios
```

The current product slice is local route creation: record a commute with the phone in a pocket, review the captured path on a map, name it, choose a transportation mode, and save it as a reusable route. Official timed attempts, checkpoints, and ARM RUN are not part of this slice.

### Platform validation status

- **Android locked-screen / background recording:** implementation is in place behind a shared `LocationTracker` / `LocationPlatform` boundary. Physical-device field validation of the V0.1 route-creation flow is still required.
- **iOS:** project config includes background location modes and Always permission copy, but iOS background behavior is **unvalidated**. Do not treat a successful compile as evidence that locked-screen tracking works on iPhone. Follow-up when a device is available: confirm Always permission, background indicator, and locked-screen samples; if Expo is insufficient, replace only `src/tracking/expo-location-platform.ts` (and the task registration) with a Swift Expo Module.

