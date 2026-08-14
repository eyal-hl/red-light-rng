# Run Analysis

The analysis layer is where Red Light RNG becomes more than a stopwatch.

## Core result metrics

Every valid completed attempt should eventually support:

- official total time;
- Personal Best status/delta;
- previous-run delta;
- attempt rank among valid attempts;
- cumulative split times;
- segment times;
- segment deltas vs PB run;
- Gold segment detection;
- Sum of Best;
- moving time;
- stationary/waiting time;
- continuous position-based delta vs a reference run.

V0.1 does not need all of these at once; see `ROADMAP.md`.

## PB comparison

The simplest comparison is full-run delta:

```text
Today  12:57
PB     12:42
Delta  +0:15
```

But the more interesting question is **where the 15 seconds came from**.

Each segment should therefore be compared against the same segment in the PB run. A slower total attempt can contain faster individual segments.

## Gold splits

A Gold is the fastest historical segment time for that route/category.

Example:

```text
Split 1 today       1:48
Previous Gold       1:52
New Gold            -0:04
```

Golds should be celebrated even if the complete attempt is not a PB. This creates partial wins and makes ordinary attempts interesting.

## Sum of Best

Sum of Best is the sum of all current Gold segment times.

It represents a theoretical complete run assembled from the user's strongest historical segments.

Useful comparisons include:

- PB vs Sum of Best;
- which segments account for most of that gap;
- how many segments in the PB are already Golds;
- what a "perfect" or "God Run" would require.

## Continuous position-based delta

Splits are human-readable markers, but the underlying route is continuous.

For each progress position along the saved course, determine when:

- the current attempt reached that route progress;
- the reference/PB attempt reached the same progress.

The difference produces a continuous delta curve, conceptually:

```text
DELTA VS PB
+40s ┤                ╭─────
+30s ┤          ╭─────╯
+20s ┤          │
+10s ┤     ╭────╯
  0s ┼─────╯         ╭──────
-10s ┤               ╰─
     └────────────────────────
      Home              Work
```

This lets the app identify the exact location where an attempt began losing or gaining time, even when no checkpoint exists there.

A selected point/spike should eventually be explainable using facts such as:

- map location;
- current attempt timestamp;
- PB equivalent timestamp;
- local delta;
- current stopped time near that location;
- PB stopped time near that location.

## Moving vs waiting time

Official time includes everything between official start and finish, including red lights and waiting.

For analysis, decompose it into at least:

- moving time;
- stationary/waiting time.

Potential route-level statistics:

```text
Average               12:54
Median                 12:41
PB                     11:58
Typical moving time    11:19
Typical waiting time    1:27
```

This supports insights such as:

- "31s of today's loss occurred while stationary at the Park intersection."
- "Your riding time was PB pace; waiting time made the attempt slower."
- "Most of this route's time variance comes from two intersections."

The exact movement/stationary classification algorithm can evolve. Raw telemetry must remain available for reprocessing.

## Statistical comparisons

As history grows, useful reference values include:

- previous attempt;
- PB run;
- average;
- median;
- selected historical run;
- best segment values;
- time-of-day cohorts;
- weekday cohorts.

Median is especially useful for "typical" performance when occasional long waits create outliers.

## Delay hot spots

Repeated telemetry can reveal locations where time varies substantially between attempts.

Later versions should be able to identify recurring delay zones and quantify how much of total route variance they explain.

These zones can also become candidates for automatically proposed checkpoints.

## Deterministic highlights

Initial post-run summaries should be generated from structured rules rather than requiring an LLM.

Candidate rules include:

- new PB;
- new Gold(s);
- fastest/slowest segment relative to PB;
- biggest positive delta spike;
- biggest recovered time;
- rank among attempts;
- unusually high stopped time;
- a run whose moving time was exceptional but official time was hurt by waits;
- PB-to-Sum-of-Best gap narrowing.

The system should first calculate facts, then render them into concise human-readable highlights.

## Route variants

When repeated attempts consistently diverge onto a materially different course, future analysis may classify them as separate variants.

Examples:

- Park Route;
- Main Road Route.

Each variant should maintain its own PB/Gold/history rather than corrupting comparisons between different courses.

## Future playful layer

Potential achievements/titles include:

- Gold Rush — multiple Golds in one attempt;
- Perfect Run — PB containing an unusually high number of Golds;
- Frankenstein — Sum of Best assembled from many different attempts;
- Consistent / Metronome — unusually low time variance;
- God Run — PB unusually close to Sum of Best.

These are not MVP requirements, but the underlying statistics should make them possible later.
