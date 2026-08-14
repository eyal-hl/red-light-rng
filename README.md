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
