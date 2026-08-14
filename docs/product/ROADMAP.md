# Product Roadmap

The roadmap is staged around learning, not feature count. Each phase should prove a stronger version of the core idea before adding complexity.

## V0.1 — Does this feel fun?

Goal: prove that repeated-route speedrunning is enjoyable and that the basic timing model works in real life.

### Routes

- Record a new route from GPS/location telemetry.
- Name the route.
- Associate a transportation mode/category.
- Save everything locally.
- Show the saved route on a map.

### Checkpoints / splits

- Start and finish boundaries exist automatically.
- User can add, move, and delete geographic checkpoints on the saved route.
- Historical runs can be recalculated when checkpoints change, using retained raw telemetry.

### Attempts

- Select a saved route and tap `ARM RUN`.
- Arming does not begin official timing.
- Detect actual start semi-automatically from movement/course signals.
- Record location in the background while the phone remains in a pocket.
- Detect checkpoints automatically.
- Detect finish automatically.
- Cancel an armed/active attempt if needed.
- Persist the completed attempt and raw GPS trace.
- Material route deviation may make an attempt invalid/unranked rather than silently comparing a different course.

### Results

- Official total time.
- Personal Best.
- Delta vs PB.
- Delta vs previous attempt.
- Rank among historical attempts.
- Split/segment times.
- Segment comparison vs PB run.
- Gold segments.
- Sum of Best.

### History

- Chronological run history.
- Ranked run history.
- Open a run for full split breakdown.

### Explicitly not required for V0.1

- Fully passive automatic route detection.
- Continuous route delta chart.
- Moving/waiting-time analysis.
- Automatic checkpoint suggestions.
- Route variants.
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
- Distinguish opposite-direction routes/categories such as Home → Work and Work → Home.
- Avoid recording unrelated movement as a run.

### Smarter course model

- Detect recurring route deviations.
- Propose/learn route variants.
- Maintain separate PB/statistics for meaningful variants.

### Smart checkpoints

- Identify locations with high time variance or recurring waits.
- Propose checkpoints where they make analysis more useful.
- Allow user approval/editing before changing the canonical split layout.

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
