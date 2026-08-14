# User Flow

This document describes the intended product journey and run lifecycle. It is deliberately more behavioral than visual; screen design can evolve without changing these invariants.

## First-time route creation

1. User chooses to create a new route.
2. App records a real traversal and stores the raw GPS trace.
3. User names the route and chooses a transportation mode/category.
4. The recorded path becomes the initial reference course.
5. Start and finish boundaries are derived/confirmed.
6. The route is saved locally.
7. Checkpoints may be added immediately or later.

The onboarding should not require the user to perfectly design every split before useful data can be collected.

## Adding/editing checkpoints

From a saved route, the user can add, move, or remove geographic checkpoints on the map.

When checkpoints change, historical runs with sufficient telemetry should be reprocessed so the new split layout applies retroactively.

This is an important product property: collected runs should become more useful over time rather than being locked to the setup choices made on day one.

## Starting an attempt

A route detail screen should expose the useful pre-run context, for example:

```text
Home → Work
PB                  12:42
Last                 13:04
Attempts                28
Sum of Best          11:58

[ ARM RUN ]
```

Tapping **ARM RUN** does not start official timing.

The user should then be able to put the phone in their pocket and leave it there.

## Armed / waiting-for-start state

While armed, the app observes location/movement and waits for evidence of a genuine start.

Start detection should eventually combine signals such as:

- user is in/near the route start region;
- user exits the start region;
- movement becomes sustained rather than GPS drift;
- speed is plausible for the route category;
- heading/trajectory broadly follows the saved course.

The exact thresholds are implementation details and should be tuned from recorded data.

Important behaviors:

- GPS drift alone should not begin an attempt.
- Time spent locking a door, standing near the start, or unfolding the scooter should not count merely because the route was armed.
- Detection may confirm the start after the physical event; official `started_at` should be reconstructed from the recorded samples where possible.

## Active run

The active-run UI should be intentionally unimportant.

A minimal state is enough:

```text
RUN ACTIVE
Home → Work
Started automatically at 08:42:13

[ Cancel Run ]
```

Do not make the run depend on:

- reading a live timer;
- watching split deltas;
- operating checkpoint buttons;
- keeping a map visible;
- manually stopping the run.

The app records location in the background and detects checkpoints automatically.

## Checkpoint crossing

As route progress crosses a configured checkpoint, the timing engine records the crossing time from telemetry.

No user interaction is required.

Checkpoint detection should tolerate ordinary GPS noise and should not require touching an exact coordinate.

## Finish

The attempt ends automatically when the finish condition is crossed while following the expected course.

The official finish should correspond to completing the course, not to:

- slowing down afterward;
- parking the scooter;
- walking into a building;
- taking the phone out of a pocket;
- pressing a stop button.

After finish, background recording can stop once enough post-finish context exists to finalize the result safely.

## Post-run result

The result screen is the main reward surface.

A representative layout:

```text
HOME → WORK
12:57
+0:15 vs PB
4th fastest of 31 attempts

              TIME       Δ PB
Home
 ↓
Katznelson    1:48       -0:04
                         GOLD
 ↓
Park          2:31       +0:19
 ↓
Bridge        3:06       -0:07
 ↓
Office        5:32       +0:07

PB            12:42
Today         12:57
Sum of Best   11:58
```

The result should emphasize what happened, not merely present raw numbers.

Examples:

- "New Gold on split 1 by 4s."
- "Split 2 cost 19s vs your PB run."
- "Splits 1 + 3 were 11s faster than your PB."
- "You spent 31s stationary at this intersection."
- "Without stopped time, this would have been your fastest moving-time attempt."

## History

A route should expose both:

- chronological attempt history;
- ranked attempts by official time.

Selecting an attempt opens its full split/analysis detail and, later, its continuous delta/map view.

## Future passive flow

The long-term goal is to remove even the arming step when confidence is high enough:

1. App recognizes departure from a known route start.
2. Movement/course matches a known category.
3. Attempt starts automatically.
4. User opens the app only after arriving.

This is intentionally not required for V0.1. The armed workflow exists so real-world data can be collected before solving passive recognition.
