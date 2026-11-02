# Product Concepts

Canonical domain and speedrunning terminology. Future tickets and agents should use these definitions consistently.

## Place

A first-class saved endpoint with a stable id, user-visible name, center coordinate, two independent detection radii (a **departure radius** and an **arrival radius**, 8-250 m each, both defaulting to 30 m), and active/archived state. The same Place uses its departure radius when it is the origin and its arrival radius when it is the destination, so Home -> Work uses Home departure and Work arrival, and Work -> Home uses Work departure and Home arrival.

Examples: Home, Work, Gym. Places are configured from a management surface, not during START. Archiving a place keeps its history but removes it from live start/finish detection. Permanent deletion removes the place and every attempt whose origin or destination is that place, including related GPS/debug data. A live armed or active attempt blocks deletion until that run ends or is cancelled.

## Journey / Journey pool

A directional trip between two saved places in one transportation mode:

```text
JourneyPool = origin_place_id + destination_place_id + transportation_mode
```

Home → Work and Work → Home are distinct. Scooter Home → Work and walking Home → Work are distinct. Any physical path between those endpoints is eligible for the same pool.

Official journey time is `finishedAtMs - startedAtMs` from path-free place-boundary crossings.

## Route / path variant

A recorded reference path, checkpoints, and corridor used only as optional **path-variant** context for a journey.

Matching a variant enables splits, Gold, Sum of Best, ghost, and progress-based wait/movement analysis, re-anchored to the journey timing window. Not matching a variant never invalidates the journey.

## Attempt / Run

One START-to-finish (or incomplete) observation.

A run may be:

- armed but not started;
- active (`Origin → ?` until a destination is pinned);
- completed and competitive in its journey pool;
- completed with path analytics unavailable because no compatible variant matched;
- cancelled;
- ended without a competitive result (`DID NOT START` / `DID NOT FINISH`).

## Transportation Mode / Category

The mode used for a journey attempt, such as scooter, bicycle, walk, or run.

Competitive statistics are category-specific. Scooter and walking attempts between the same places do not share a PB. START uses one persisted active mode; the result screen can correct it.

## Start Zone

The **departure radius** of a saved origin place, used as one signal for automatic start detection. The official start time is the interpolated outward crossing of this radius, and sustained departure is confirmed at `departure_radius + 18 m`. Route/path-variant start zones are separate optional analytics configuration and are not the authority for Place-to-Place timing.

Being inside a start zone alone does not start timing. Overlapping places pick the nearest center, then the lowest stable place id.

## Finish Zone

The **arrival radius** of a saved destination place. A place cannot finish the attempt until the trace has first been seen at least `arrival_radius + 10 m` outside it, then crossed inbound with confirmation; the official finish is the interpolated inward crossing of the arrival radius. The origin is never a competitive destination.

Return to origin: while a run is active, "inside origin" uses the origin Place's arrival radius, and a return can only end the run (DID NOT FINISH) after the run has been at least `max(50 m, 2 × max(origin departure, origin arrival))` from the origin and then stays inside for 30 seconds. With equal radii this is the original single-radius rule.

Editing a Place's departure or arrival radius is blocked while a run is armed or active, because the engine replays the stored trace against the current Place records. Completed runs keep their stored official times; editing or migrating a radius never rewrites them automatically (the debug replay on a past run uses the current radii and says so). The only way to apply new radii to past runs is the explicit, user-confirmed **Recalculate history** action (next section).

## Recalculate history

A manual, confirmed, resumable batch (issue #77) that re-times past COMPLETED runs from their stored raw GPS using the CURRENT departure radius of the run's original origin Place and the CURRENT arrival radius of its original destination Place. Earlier radii were never saved, so results are explicitly "under current settings".

- Each stored trace is replayed through the same place-timing engine as live timing (accuracy gate, sustained confirmation, interpolation). A result is accepted only if the engine selects the stored origin and confirms a completed finish at the stored destination, with both crossings observed between real fixes (never extrapolated). Anything else is reported as `skipped — endpoint/geometry changed` or `skipped — insufficient GPS` and the original record, Place IDs, mode, ID and raw GPS stay untouched. A result equal to the stored time is `unchanged`; per-attempt failures are `errors` that keep the original.
- Candidates are fixed at job start: completed runs with a stored trace whose origin and destination Places both exist (archived Places count, using their saved radii). Completed runs with a missing Place or no trace are counted as skipped up front.
- Updated results are staged and published in ONE atomic step together with split/path-variant reassignment; personal bests, rankings and statistics are derived from attempts, so they are consistent after publication and caches are invalidated.
- A job fingerprints every Place's ID, centre and both radii. A mismatch on resume or just before publication discards staged results and cancels the job. While a job is running or unpublished, changing a Place's centre or radii (and creating or deleting Places) is refused; the user cancels the job to edit.
- A job cannot start while a run is armed or active, and pauses (neither processing nor publishing) if one opens; it resumes when none is open. There is no time limit; progress is checkpointed so a relaunch resumes without redoing completed work. It is never run automatically on save, migration, restore or browsing.
- Job, staging and checkpoint tables are local operational state, not part of the portable backup; restore discards any job.

## Checkpoint

A geographic point/region along an optional path variant used to divide that variant into segments.

Checkpoints are editable product definitions. They are not the durable source data for runs; raw telemetry is. Checkpoint splits only appear when a compatible path variant is attached.

## Split

A timing result associated with reaching a checkpoint on a compatible path variant. In UI language, "split" may refer to either cumulative elapsed time at a checkpoint or the segment between two adjacent checkpoints; when ambiguity matters, use **split elapsed time** and **segment time** explicitly.

Displayed split durations for a compatible variant must sum to the journey official time.

## Segment

The course interval between two adjacent timing boundaries on a compatible path variant: journey start → checkpoint, checkpoint → checkpoint, or final checkpoint → journey finish. The first and last boundaries are the journey endpoint times, not a second route-engine clock.

## Personal Best (PB)

The fastest valid completed attempt for a journey pool (origin + destination + mode).

## PB Run

The historical full attempt that currently owns the Personal Best.

Comparing "vs PB" means comparing against this run unless another reference is explicitly chosen.

## Gold Split / Gold Segment

The fastest-ever valid segment time for that path variant, regardless of which complete attempt produced it.

A run can set a new Gold while still being slower overall than the journey PB. Golds are variant-scoped.

## Sum of Best

The sum of the best historical segment time for every segment of the compatible path variant.

This is a theoretical best assembled from potentially different attempts. It answers: "What if every segment matched its best-ever performance in one run?"

It is not necessarily a physically achieved full-run time.

## Delta

The time difference between an attempt and a reference at the same comparison point.

Examples:

- total delta vs journey PB;
- split delta vs PB on a compatible variant;
- continuous position-based delta vs PB on a compatible variant;
- delta vs previous run;
- delta vs average/median.

Negative delta is faster than the reference; positive delta is slower.

## Ghost

A historical reference attempt, usually the PB, aligned to path-variant progress so the current or completed run can be compared against where the reference run was at the same location.

Ghost comparison is variant-scoped. Incompatible paths must not produce a misleading progress-space comparison.

## Continuous Route Delta

A delta curve computed across progress along a compatible path variant rather than only at checkpoints.

## Moving Time

Time classified as meaningful forward travel rather than stopped/waiting behavior. The exact threshold/algorithm is an implementation detail and may evolve. Current movement analysis that requires matched route progress is variant-scoped.

## Stationary / Waiting Time

Time spent stopped or effectively stopped during the official run window, such as waiting at an intersection.

It is an analytic decomposition of official total time, not a replacement leaderboard time.

## Official Time

Elapsed time from detected official start to detected official finish for a valid journey attempt.

Waiting at a red light is part of official time. Parking after the finish is not. Path choice does not change which clock is official.

## Attempt Rank

Where a completed valid attempt falls among the user's historical attempts for that journey pool when sorted by official time.

Example: "4th fastest of 31 attempts."

## Route Variant

An optional recorded path between the same journey endpoints, such as Park Route vs Main Road.

In this product stage, variants do not split the competitive pool. They only gate path-specific analytics.

## Valid Attempt

A completed journey whose origin, destination, and official times were detected. Path divergence alone does not make an attempt invalid.

## Invalid / Unranked Attempt

A recorded run retained for history/inspection but excluded from PB/Gold/ranking calculations because it did not complete a competitive journey (cancelled, DID NOT START, DID NOT FINISH, or abandoned).
