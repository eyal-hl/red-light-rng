# User Flow

This document describes the intended product journey and run lifecycle. It is deliberately more behavioral than visual; screen design can evolve without changing these invariants.

## Saved places

The user configures named places once from a Places surface: create from current location or the map, name them, adjust center and radius, rename, archive, and permanently delete (including associated run history).

Creating or editing places is not part of START.

## Optional path-variant recording

The user may still record a GPS path and save it as a named path variant (formerly a competitive route). That geometry can later supply splits and ghost analysis for compatible journeys. It is not required before START, and it is not selected in the live flow.

Checkpoints may be added to a path variant immediately or later. Historical compatible attempts are reprocessed against the new layout, re-anchored to each attempt's journey timing window.

## Starting an attempt

Home exposes one global **START** and a list of journey pools that already have history.

```text
START
Walk (settings)

JOURNEYS
Home → Work          PB 12:42
Work → Home          PB 13:10
```

There is no pre-run route picker, destination picker, or mode chooser on START. Transportation mode is the persisted active mode from Settings.

Tapping **START** does not start official timing.

The user should then be able to put the phone in their pocket and leave it there.

## Armed / waiting-for-start state

While armed, the app observes location and evaluates active saved places.

```text
IN START ZONE — HOME
```

or

```text
OUTSIDE START ZONE
```

Overlapping places pick the nearest center, then the lowest stable place id. The candidate is re-evaluated on every accepted sample until a qualifying departure pins the origin.

Start detection is path-free:

- accepted samples must pass the 45 m accuracy gate;
- official `startedAtMs` is the interpolated outward radius crossing;
- confirmation requires at least 4 accepted samples after that crossing and radial distance of `origin_radius + 18 m`;
- returning inside the origin radius resets the candidate;
- there is no maximum confirmation-time or speed requirement, so walking qualifies.

GPS drift alone should not begin an attempt. Time spent locking a door near Home should not count merely because START was pressed. Detection may confirm the start after the physical event; official `started_at` is reconstructed from recorded samples.

If no qualifying departure occurs within 30 minutes of START, the attempt ends as `DID NOT START` with telemetry preserved for inspect.

## Active run

The active-run UI should be intentionally unimportant.

A minimal state is enough:

```text
RUN ACTIVE
Home → ?
Started automatically at 08:42:13

[ END & INSPECT ]  [ Cancel ]
```

No destination is predicted. Do not make the run depend on a live timer, split deltas, checkpoint buttons, a visible map, or a manual stop.

The app records location in the background. Path divergence must not fail the attempt as the wrong route.

An active attempt that lasts 2 hours from official start, or that returns to the origin and stays inside it for 30 seconds after previously reaching `max(50 m, 2 × origin_radius)`, ends as `DID NOT FINISH`.

## Finish

The attempt ends automatically when the first other saved place that has been seen at least `destination_radius + 10 m` outside is then crossed inbound and confirmed (3 inside samples spanning at least 2 seconds).

The origin is never a competitive destination.

The official finish corresponds to entering that place, not to parking, walking into a building, taking the phone out, or pressing stop.

After finish, background recording can stop once enough post-finish context exists to finalize the result safely.

## Post-run result

The result screen is the main reward surface. The headline is always the journey official time and journey-pool PB, never a separate path-variant clock.

```text
HOME → WORK
12:57
+0:15 vs PB
4th fastest of 31 attempts
```

If a compatible path variant exists, splits/Gold/Sum of Best/ghost may appear, re-anchored so displayed split durations sum to 12:57.

If the path does not match a variant:

```text
Path analytics unavailable — different/unmatched path
```

The attempt remains valid in the Home → Work pool.

The result screen can correct transportation mode. That reassigns the attempt to the matching journey pool without duplicating it.

## History

A journey pool exposes chronological and ranked attempt history. Selecting an attempt opens its analysis and debug trace.

Incomplete START sessions remain inspectable as DID NOT START / DID NOT FINISH.

## Future passive flow

The long-term goal is to remove even the START step when confidence is high enough:

1. App recognizes departure from a known saved place.
2. Movement matches a known transportation mode.
3. Attempt starts automatically.
4. User opens the app only after arriving at another saved place.

This is intentionally not required for V0.1. The armed START workflow exists so real-world data can be collected before solving passive recognition.
