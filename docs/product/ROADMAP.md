# Product Roadmap

The roadmap is staged around learning, not feature count. Each phase should prove a stronger version of the core idea before adding complexity.

## V0.1 — Does this feel fun?

Goal: prove that repeated-route speedrunning is enjoyable and that the basic timing model works in real life.

### Optional path variants

- Record a GPS path, name it, and save it locally as optional geometry.
- Show it on a map and edit checkpoints.
- Historical compatible journeys can be recalculated when checkpoints change, using retained raw telemetry, re-anchored to journey start/finish.

### Places

- Create, name, recenter, resize, archive, and permanently delete saved places, including places still referenced by historical attempts.
- Seed places from existing route endpoints on migration.

### Journeys

- One global `START` with no route, destination, or mode picker in the live flow.
- Detect origin from saved places; pin after a path-free qualifying departure.
- Detect destination as the first other saved place entered after eligibility.
- Persist completed journeys and raw GPS traces.
- Competitive identity is origin + destination + transportation mode.
- Different physical paths between the same endpoints remain valid.
- Path divergence never produces a wrong-route failure.
- Armed attempts cap at 30 minutes (`DID NOT START`); active attempts cap at 2 hours or return-to-origin (`DID NOT FINISH`).

### Results

- Official total time from place-boundary crossings.
- Journey Personal Best, delta vs PB, delta vs previous, and rank.
- Split/segment times, Gold, and Sum of Best only for a compatible path variant, summing to the headline time.

### History

- Chronological and ranked journey history.
- Open a run for analysis and place-timing debug.

### Explicitly not required for V0.1

- Fully passive automatic detection with no START.
- Home → Home competitive loops.
- Automatic clustering/creation of new path variants.
- Cross-path ghost/progress normalization.
- Continuous route delta chart as a V0.1 requirement (already exists for compatible variants).
- Time-of-day/weekday analysis.
- Accounts/cloud/social features.
- AI narration.

### Success question

After several real commutes, does the user genuinely care whether a run was a PB, whether a segment went Gold, and where time was lost?

---

## V0.2 — Where did my time go?

Goal: turn the collected telemetry into explanations, not just timing tables.

### Movement analysis

- Moving time.
- Stationary/waiting time.
- Identify meaningful stop/delay locations.
- Compare waiting behavior with the PB/reference run.

### Continuous ghost comparison

- Align each attempt to progress along the reference course.
- Compute continuous position-based delta vs PB/reference.
- Render a delta-over-route-progress chart.
- Allow inspecting where a spike/gain occurred on the map.

### Post-run highlights

Deterministic insights such as:

- biggest segment loss;
- biggest recovered time;
- new Golds;
- unusual stopped time;
- "riding time was PB-level, but waiting time cost the run";
- PB vs Sum-of-Best opportunity.

### Route statistics

- Average attempt time.
- Median attempt time.
- Variance/consistency.
- Typical moving time.
- Typical waiting time.
- Segment-level distributions.

### Success question

Can the app explain an attempt well enough that the user understands **why** it was fast or slow without manually studying GPS data?

---

## V0.3 — The app knows my commute

Goal: reduce setup/interaction and learn patterns from historical runs.

### Passive recognition

- Recognize departure along a known route without requiring explicit arming when confidence is high.
- Distinguish opposite-direction journeys such as Home → Work and Work → Home (already separate journey pools; later work may start them without START).
- Avoid recording unrelated movement as a run.

### Smarter course model

- Detect recurring route deviations.
- Propose/learn route variants.
- Maintain separate PB/statistics for meaningful variants.

### Recommended splits / smart checkpoints

- After enough comparable runs exist for a route, analyze route-progress timing variance, recurring waits, and where time is commonly gained/lost.
- Recommend a split/checkpoint layout that makes the route easiest to understand and compare, including suggested checkpoint locations and an appropriate number of splits.
- Prefer stable, meaningful locations over noisy GPS-derived micro-segments.
- Explain why each suggested split is useful (for example: recurring stop, high-variance section, or natural transition between consistently different route sections).
- Recommendations are proposals only: the user approves, edits, or rejects them before the canonical split layout changes.
- Changing the split/checkpoint layout does **not** create a new route by itself. Existing historical attempts are re-derived against the new current split layout from retained raw telemetry, so old runs immediately receive recalculated segment times/Gold/Sum-of-Best data where coverage is sufficient.

### Pattern analysis

- Time-of-day comparisons.
- Weekday comparisons.
- Recurring delay hot spots.
- Identify which locations explain the largest fraction of route-time variance.

### Desired end state

**Travel normally → open Red Light RNG afterward → discover how the run went.**

### Success question

Can the app feel like it understands the repeated route well enough that recording is almost invisible and the useful part is entirely the post-run discovery?

---

## Beyond V0.3 — optional playground

Only after the core loop proves itself:

- achievements such as Gold Rush, God Run, Consistent, Metronome, etc.;
- richer ghost visualizations;
- category/variant comparisons;
- optional export/backup;
- optional cross-device sync if it becomes personally useful;
- additional route types beyond commuting.

These should not distract from validating the core route-speedrunning experience first.
