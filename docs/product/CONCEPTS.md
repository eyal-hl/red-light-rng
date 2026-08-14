# Product Concepts

Canonical domain and speedrunning terminology. Future tickets and agents should use these definitions consistently.

## Route

A repeatedly traveled real-world course with a reference path, transportation mode/category, start condition, finish condition, and optional checkpoints.

A route is not an exact sequence of GPS coordinates. It represents an accepted course/corridor that real GPS traces can match approximately.

## Attempt / Run

One traversal of a saved route/category.

A run may be:

- armed but not started;
- active;
- completed and valid/ranked;
- completed but invalid/unranked because of material course deviation or unusable telemetry;
- cancelled.

## Transportation Mode / Category

The mode used for a route attempt, such as scooter, bicycle, walk, or run.

Competitive statistics are category-specific. Scooter and walking attempts on the same physical course do not share a PB.

## Start Zone

A geographic region/condition near the beginning of a saved route used as one signal for automatic start detection.

Being inside the start zone alone does not start timing.

## Finish Zone

A geographic region/condition near the end of a route. Official timing should finish when the course finish condition is crossed, not when the user later parks or stops interacting with the phone.

## Checkpoint

A geographic point/region along the course used to divide the route into segments.

Checkpoints are editable product definitions. They are not the durable source data for runs; raw telemetry is.

## Split

A timing result associated with reaching a checkpoint. In UI language, "split" may refer to either cumulative elapsed time at a checkpoint or the segment between two adjacent checkpoints; when ambiguity matters, use **split elapsed time** and **segment time** explicitly.

## Segment

The course interval between two adjacent timing boundaries: start → checkpoint, checkpoint → checkpoint, or final checkpoint → finish.

## Personal Best (PB)

The fastest valid completed attempt for a route/category.

## PB Run

The historical full attempt that currently owns the Personal Best.

Comparing "vs PB" means comparing against this run unless another reference is explicitly chosen.

## Gold Split / Gold Segment

The fastest-ever valid segment time for that route/category, regardless of which complete attempt produced it.

A run can set a new Gold while still being slower overall than the PB.

## Sum of Best

The sum of the best historical segment time for every segment of the route/category.

This is a theoretical best assembled from potentially different attempts. It answers: "What if every segment matched its best-ever performance in one run?"

It is not necessarily a physically achieved full-run time.

## Delta

The time difference between an attempt and a reference at the same comparison point.

Examples:

- total delta vs PB;
- split delta vs PB;
- continuous position-based delta vs PB;
- delta vs previous run;
- delta vs average/median.

Negative delta is faster than the reference; positive delta is slower.

## Ghost

A historical reference attempt, usually the PB, aligned to route progress so the current or completed run can be compared against where the reference run was at the same location.

The important concept is position-aligned comparison, not a literal on-screen avatar.

## Continuous Route Delta

A delta curve computed across progress along the route rather than only at checkpoints.

For a given route position, compare when the current run reached that position with when the reference run reached the same route progress. This creates a time-gained/time-lost curve across the whole course.

## Moving Time

Time classified as meaningful forward travel rather than stopped/waiting behavior. The exact threshold/algorithm is an implementation detail and may evolve.

## Stationary / Waiting Time

Time spent stopped or effectively stopped during the official run window, such as waiting at an intersection.

It is an analytic decomposition of official total time, not a replacement leaderboard time.

## Official Time

Elapsed time from detected official start to detected official finish for a valid attempt.

Waiting at a red light is part of official time. Parking after the finish is not.

## Attempt Rank

Where a completed valid attempt falls among the user's historical attempts for that route/category when sorted by official time.

Example: "4th fastest of 31 attempts."

## Route Variant

A recurring materially different course between broadly similar endpoints, such as Park Route vs Main Road.

Variants should eventually maintain separate competitive statistics if their geometry meaningfully changes the course.

## Valid Attempt

A completed run whose telemetry and course adherence are good enough to compare competitively with other attempts in that route/category.

## Invalid / Unranked Attempt

A recorded run retained for history/inspection but excluded from PB/Gold/ranking calculations because it did not represent the expected course/category reliably enough.
