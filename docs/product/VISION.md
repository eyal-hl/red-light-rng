# Product Vision

## Product

Red Light RNG is a personal mobile app that applies speedrunning mechanics to repeated real-world routes.

A user saves meaningful places (Home, Work, Gym), then travels between them. Each completed A→B journey is compared against previous attempts in the same direction and transportation mode. Optional recorded paths can supply split/ghost analysis when they match, but any street between the same endpoints still counts. The product should make ordinary repeated travel feel like a personal speedrun without requiring the user to interact with the phone while moving.

The initial use case is a repeated electric-scooter commute, but the product model should support repeated routes by other transportation modes without making "commuting" a hard product boundary.

## Product promise

After traveling a familiar route, the user should be able to answer:

- Was this a good run?
- Where exactly did I gain or lose time?
- Did I set any new Gold splits even if the overall attempt was slower?
- How close is my current PB to my theoretical best?
- Was the difference caused by movement, waiting, or route conditions?

Eventually, the ideal experience is almost invisible during travel: **travel normally → open the app afterward → discover how the run went.**

## Core loop

1. Save places such as Home and Work, and optionally record a path variant.
2. Tap the single global START before leaving.
3. Put the phone away.
4. The app detects the actual start from a saved place, then the destination when another saved place is entered.
5. The app stores the raw GPS trace and derives the journey.
6. Afterward, inspect total time, journey PB/rank, and — when a compatible path exists — split performance and where time was gained or lost.
7. Repeat the journey and try again.

## Goals

- Make repeated travel fun through speedrunning language and mechanics.
- Give meaningful segment-level insight rather than only a total duration.
- Make timing fair by detecting route events instead of measuring button-press/parking overhead.
- Keep active-run interaction effectively unnecessary.
- Preserve enough raw data that better analytics can be applied retroactively.
- Keep the first versions small, local, and personal rather than turning into a social fitness platform.

## Non-goals for initial versions

- Social feeds, public leaderboards, followers, or friends.
- Accounts or cross-device identity.
- Cloud sync or a backend.
- Monetization or commercial product requirements.
- Live navigation.
- A large live dashboard, speedometer, or interaction-heavy run screen.
- AI-generated coaching as a prerequisite for useful insights.
- Fully automatic recognition with no START in V0.1.

## Product constraints

- The phone is expected to remain in the user's pocket while moving.
- The app must support background location recording during an armed/active attempt.
- Timing, splits, and analytics must be derivable locally.
- Raw GPS samples should be retained so splits and analytics can be recalculated later.
- Different transportation modes must not share the same competitive history.
- A materially different street/path between the same saved places still competes in that journey pool; path variants are optional analytics, not a second leaderboard.
