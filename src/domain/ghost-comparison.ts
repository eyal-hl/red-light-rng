import {
  finishTriggerProgressMeters,
  interpolateCrossingTime,
  replayAttemptTrace,
  type AcceptedProgressSample,
  type TimingCourse,
} from './attempt-timing';
import type { LatLng } from './geo';
import type { LocationSample } from './location-sample';
import {
  analyzeAttemptMovementTimeline,
  type ClassifiedMovementInterval,
} from './movement-analysis';
import { pointAtProgress } from './path-projection';

/**
 * Ghost-comparison version identity. Results are derived on read from raw
 * telemetry; this string exists so a later cache cannot mix algorithm revisions.
 */
export const GHOST_COMPARISON_VERSION = 'ghost-v1';

/** Inclusive progress containment for occupancy on a time-ordered polyline. */
export const GHOST_PROGRESS_EPSILON_METERS = 0.05;

/**
 * Radius used by query helpers when collecting comparison knots "around" a
 * route location. Distinct from wait-comparison's 40 m cluster radius.
 */
export const GHOST_NEAR_PROGRESS_METERS = 5;

export type GhostCoverage = 'trustworthy' | 'unavailable';

export type GhostKnotKind = 'start' | 'sample' | 'finish-trigger';

export type GhostUnavailableReason =
  | 'missing_comparison_target'
  | 'current_not_eligible'
  | 'reference_not_eligible'
  | 'current_polyline_unavailable'
  | 'reference_polyline_unavailable';

export type GhostComparisonAttempt = {
  attemptId: string;
  eligible: boolean;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  officialTimeMs: number | null;
};

export type GhostProgressKnot = {
  elapsedMs: number;
  progressMeters: number;
  recordedAtMs: number;
  knotKind: GhostKnotKind;
  coordinate: LatLng | null;
};

export type GhostPolylineSegment = {
  from: GhostProgressKnot;
  to: GhostProgressKnot;
  coverage: GhostCoverage;
  isStall: boolean;
};

export type GhostStallRun = {
  startElapsedMs: number;
  endElapsedMs: number;
  minProgressMeters: number;
  maxProgressMeters: number;
  coverage: GhostCoverage;
};

export type OfficialWindowPolyline = {
  analysisVersion: string;
  attemptId: string;
  startedAtMs: number;
  finishedAtMs: number;
  officialTimeMs: number;
  startProgressMeters: number;
  finishTriggerProgressMeters: number;
  paintedFinishProgressMeters: number;
  paintedFinishElapsedMs: number | null;
  knots: GhostProgressKnot[];
  segments: GhostPolylineSegment[];
  stallRuns: GhostStallRun[];
};

export type ElapsedOccupancyInterval = {
  startElapsedMs: number;
  endElapsedMs: number;
  coverage: GhostCoverage;
};

export type ElapsedOccupancyInstant = {
  elapsedMs: number;
  coverage: GhostCoverage;
};

/**
 * Multi-valued occupancy of a route-progress value on an official-window
 * polyline. A red-light wait is an interval (repeated progress while time
 * advances), not a unique first-passage instant.
 *
 * There is no single-valued `elapsedAt(progress)` helper. Callers must use:
 * - `intervals` for stall/wait occupancy,
 * - `increasingFlankInstants` for interpolated moving passages only,
 * - `queryElapsedForProgress` for ghost pairing at a known elapsed time.
 *
 * Using only `increasingFlankInstants` (or unique-first passage) can make a
 * 90 s vs 40 s stop at the same light appear as zero.
 */
export type ElapsedOccupancy = {
  progressMeters: number;
  intervals: ElapsedOccupancyInterval[];
  increasingFlankInstants: ElapsedOccupancyInstant[];
  decreasingFlankInstants: ElapsedOccupancyInstant[];
};

export type GhostElapsedQuery = {
  elapsedMs: number | null;
  coverage: GhostCoverage;
};

export type GhostComparisonKnot = {
  progressMeters: number;
  coordinate: LatLng | null;
  currentElapsedMs: number | null;
  referenceElapsedMs: number | null;
  deltaMs: number | null;
  coverage: GhostCoverage;
  knotKind: GhostKnotKind;
  source: 'start' | 'current' | 'reference' | 'finish-trigger';
};

export type GhostComparison = {
  analysisVersion: string;
  available: boolean;
  unavailableReason: GhostUnavailableReason | null;
  currentAttemptId: string;
  comparisonAttemptId: string | null;
  currentPolyline: OfficialWindowPolyline | null;
  referencePolyline: OfficialWindowPolyline | null;
  knots: GhostComparisonKnot[];
  startDeltaMs: number | null;
  finishTriggerDeltaMs: number | null;
  paintedFinishElapsedCurrentMs: number | null;
  paintedFinishElapsedReferenceMs: number | null;
};

export function unavailableGhostComparison(
  reason: GhostUnavailableReason,
  input: {
    currentAttemptId: string;
    comparisonAttemptId?: string | null;
    currentPolyline?: OfficialWindowPolyline | null;
    referencePolyline?: OfficialWindowPolyline | null;
  },
): GhostComparison {
  return {
    analysisVersion: GHOST_COMPARISON_VERSION,
    available: false,
    unavailableReason: reason,
    currentAttemptId: input.currentAttemptId,
    comparisonAttemptId: input.comparisonAttemptId ?? null,
    currentPolyline: input.currentPolyline ?? null,
    referencePolyline: input.referencePolyline ?? null,
    knots: [],
    startDeltaMs: null,
    finishTriggerDeltaMs: null,
    paintedFinishElapsedCurrentMs: input.currentPolyline?.paintedFinishElapsedMs ?? null,
    paintedFinishElapsedReferenceMs: input.referencePolyline?.paintedFinishElapsedMs ?? null,
  };
}

/**
 * Compare two eligible attempts along canonical route progress inside the
 * official timing window. Self-comparison is an identity invariant for the
 * pure function; product wiring must still use `comparisonPbRun` and must not
 * silently self-compare a first/current PB.
 */
export function compareAttemptGhost(input: {
  course: TimingCourse;
  current: GhostComparisonAttempt;
  currentSamples: LocationSample[];
  reference: GhostComparisonAttempt | null;
  referenceSamples: LocationSample[];
}): GhostComparison {
  const currentPolyline = input.current.eligible
    ? buildOfficialWindowPolyline({
        course: input.course,
        attemptId: input.current.attemptId,
        samples: input.currentSamples,
        startedAtMs: input.current.startedAtMs,
        finishedAtMs: input.current.finishedAtMs,
        officialTimeMs: input.current.officialTimeMs,
      })
    : null;

  if (!input.current.eligible || input.current.officialTimeMs == null) {
    return unavailableGhostComparison('current_not_eligible', {
      currentAttemptId: input.current.attemptId,
      comparisonAttemptId: input.reference?.attemptId ?? null,
      currentPolyline,
    });
  }
  if (currentPolyline == null) {
    return unavailableGhostComparison('current_polyline_unavailable', {
      currentAttemptId: input.current.attemptId,
      comparisonAttemptId: input.reference?.attemptId ?? null,
    });
  }
  if (input.reference == null) {
    return unavailableGhostComparison('missing_comparison_target', {
      currentAttemptId: input.current.attemptId,
      comparisonAttemptId: null,
      currentPolyline,
    });
  }

  const referencePolyline = input.reference.eligible
    ? buildOfficialWindowPolyline({
        course: input.course,
        attemptId: input.reference.attemptId,
        samples: input.referenceSamples,
        startedAtMs: input.reference.startedAtMs,
        finishedAtMs: input.reference.finishedAtMs,
        officialTimeMs: input.reference.officialTimeMs,
      })
    : null;

  if (!input.reference.eligible || input.reference.officialTimeMs == null) {
    return unavailableGhostComparison('reference_not_eligible', {
      currentAttemptId: input.current.attemptId,
      comparisonAttemptId: input.reference.attemptId,
      currentPolyline,
    });
  }
  if (referencePolyline == null) {
    return unavailableGhostComparison('reference_polyline_unavailable', {
      currentAttemptId: input.current.attemptId,
      comparisonAttemptId: input.reference.attemptId,
      currentPolyline,
    });
  }

  return compareGhostPolylines({
    course: input.course,
    currentPolyline,
    referencePolyline,
  });
}

export function compareGhostPolylines(input: {
  course: TimingCourse;
  currentPolyline: OfficialWindowPolyline;
  referencePolyline: OfficialWindowPolyline;
}): GhostComparison {
  const coordinateAt = (progressMeters: number): LatLng | null =>
    input.course.referencePath.length > 0 ? pointAtProgress(input.course.referencePath, progressMeters) : null;

  const knots: GhostComparisonKnot[] = [];
  const seen = new Set<string>();
  const pushKnot = (knot: GhostComparisonKnot) => {
    const key = [
      knot.source,
      knot.knotKind,
      knot.progressMeters.toFixed(3),
      knot.currentElapsedMs ?? 'n',
      knot.referenceElapsedMs ?? 'n',
      knot.coverage,
      knot.deltaMs ?? 'n',
    ].join('|');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    knots.push(knot);
  };

  pushKnot({
    progressMeters: input.currentPolyline.startProgressMeters,
    coordinate: coordinateAt(input.currentPolyline.startProgressMeters),
    currentElapsedMs: 0,
    referenceElapsedMs: 0,
    deltaMs: 0,
    coverage: 'trustworthy',
    knotKind: 'start',
    source: 'start',
  });

  for (const knot of input.currentPolyline.knots) {
    if (knot.knotKind === 'start' || knot.knotKind === 'finish-trigger') {
      continue;
    }
    const paired = queryElapsedForProgress(
      input.referencePolyline,
      knot.progressMeters,
      knot.elapsedMs,
      knotIsStall(input.currentPolyline, knot),
    );
    pushKnot(toComparisonKnot({
      progressMeters: knot.progressMeters,
      coordinate: knot.coordinate,
      currentElapsedMs: knot.elapsedMs,
      referenceElapsedMs: paired.elapsedMs,
      coverage: combineCoverage('trustworthy', paired.coverage, paired.elapsedMs != null),
      knotKind: knot.knotKind,
      source: 'current',
    }));
  }

  for (const knot of input.referencePolyline.knots) {
    if (knot.knotKind === 'start' || knot.knotKind === 'finish-trigger') {
      continue;
    }
    const paired = queryElapsedForProgress(
      input.currentPolyline,
      knot.progressMeters,
      knot.elapsedMs,
      knotIsStall(input.referencePolyline, knot),
    );
    pushKnot(toComparisonKnot({
      progressMeters: knot.progressMeters,
      coordinate: knot.coordinate,
      currentElapsedMs: paired.elapsedMs,
      referenceElapsedMs: knot.elapsedMs,
      coverage: combineCoverage(paired.coverage, 'trustworthy', paired.elapsedMs != null),
      knotKind: knot.knotKind,
      source: 'reference',
    }));
  }

  const finishTriggerProgress = finishTriggerProgressMeters(input.course);
  const finishTriggerDeltaMs =
    input.currentPolyline.officialTimeMs - input.referencePolyline.officialTimeMs;
  pushKnot({
    progressMeters: finishTriggerProgress,
    coordinate: coordinateAt(finishTriggerProgress),
    currentElapsedMs: input.currentPolyline.officialTimeMs,
    referenceElapsedMs: input.referencePolyline.officialTimeMs,
    deltaMs: finishTriggerDeltaMs,
    coverage: 'trustworthy',
    knotKind: 'finish-trigger',
    source: 'finish-trigger',
  });

  knots.sort(compareGhostKnots);

  return {
    analysisVersion: GHOST_COMPARISON_VERSION,
    available: true,
    unavailableReason: null,
    currentAttemptId: input.currentPolyline.attemptId,
    comparisonAttemptId: input.referencePolyline.attemptId,
    currentPolyline: input.currentPolyline,
    referencePolyline: input.referencePolyline,
    knots,
    startDeltaMs: 0,
    finishTriggerDeltaMs,
    paintedFinishElapsedCurrentMs: input.currentPolyline.paintedFinishElapsedMs,
    paintedFinishElapsedReferenceMs: input.referencePolyline.paintedFinishElapsedMs,
  };
}

export function buildOfficialWindowPolyline(input: {
  course: TimingCourse;
  attemptId: string;
  samples: LocationSample[];
  startedAtMs: number | null;
  finishedAtMs: number | null;
  officialTimeMs: number | null;
}): OfficialWindowPolyline | null {
  if (
    input.startedAtMs == null ||
    input.finishedAtMs == null ||
    input.officialTimeMs == null ||
    input.officialTimeMs < 0 ||
    input.finishedAtMs < input.startedAtMs
  ) {
    return null;
  }

  const engine = replayAttemptTrace(input.course, input.samples);
  const startedAtMs = input.startedAtMs;
  const finishedAtMs = input.finishedAtMs;
  const officialTimeMs = input.officialTimeMs;
  const triggerProgress = finishTriggerProgressMeters(input.course);
  const startProgress =
    interpolateProgressAtTime(engine.accepted, startedAtMs) ??
    progressAtOrBefore(engine.accepted, startedAtMs) ??
    input.course.startProgressMeters;

  const timeline = analyzeAttemptMovementTimeline({
    course: input.course,
    samples: input.samples,
    startedAtMs,
    finishedAtMs,
  });

  const coordinateAt = (progressMeters: number): LatLng | null =>
    input.course.referencePath.length > 0 ? pointAtProgress(input.course.referencePath, progressMeters) : null;

  const knots: GhostProgressKnot[] = [
    {
      elapsedMs: 0,
      progressMeters: startProgress,
      recordedAtMs: startedAtMs,
      knotKind: 'start',
      coordinate: coordinateAt(startProgress),
    },
  ];

  for (const sample of engine.accepted) {
    if (sample.recordedAtMs <= startedAtMs || sample.recordedAtMs >= finishedAtMs) {
      continue;
    }
    const elapsedMs = sample.recordedAtMs - startedAtMs;
    const previous = knots[knots.length - 1];
    if (
      previous &&
      previous.elapsedMs === elapsedMs &&
      Math.abs(previous.progressMeters - sample.progressMeters) <= GHOST_PROGRESS_EPSILON_METERS
    ) {
      continue;
    }
    knots.push({
      elapsedMs,
      progressMeters: sample.progressMeters,
      recordedAtMs: sample.recordedAtMs,
      knotKind: 'sample',
      coordinate: coordinateAt(sample.progressMeters),
    });
  }

  const terminal: GhostProgressKnot = {
    elapsedMs: officialTimeMs,
    progressMeters: triggerProgress,
    recordedAtMs: finishedAtMs,
    knotKind: 'finish-trigger',
    coordinate: coordinateAt(triggerProgress),
  };
  const last = knots[knots.length - 1];
  if (
    !last ||
    last.knotKind !== 'finish-trigger' ||
    last.elapsedMs !== terminal.elapsedMs ||
    Math.abs(last.progressMeters - terminal.progressMeters) > GHOST_PROGRESS_EPSILON_METERS
  ) {
    knots.push(terminal);
  }

  const segments: GhostPolylineSegment[] = [];
  for (let index = 1; index < knots.length; index += 1) {
    const from = knots[index - 1];
    const to = knots[index];
    if (!from || !to) {
      continue;
    }
    const coverage = spanCoverage(timeline.intervals, from.recordedAtMs, to.recordedAtMs);
    segments.push({
      from,
      to,
      coverage,
      isStall: coverage === 'trustworthy' && isWaitingSpan(timeline.intervals, from.recordedAtMs, to.recordedAtMs),
    });
  }

  return {
    analysisVersion: GHOST_COMPARISON_VERSION,
    attemptId: input.attemptId,
    startedAtMs,
    finishedAtMs,
    officialTimeMs,
    startProgressMeters: startProgress,
    finishTriggerProgressMeters: triggerProgress,
    paintedFinishProgressMeters: input.course.finishProgressMeters,
    paintedFinishElapsedMs: paintedFinishElapsed(input.course, knots, segments, startedAtMs),
    knots,
    segments,
    stallRuns: mergeStallRuns(segments),
  };
}

export function occupancyAtProgress(
  polyline: OfficialWindowPolyline,
  progressMeters: number,
): ElapsedOccupancy {
  const intervals: ElapsedOccupancyInterval[] = [];
  const increasingFlankInstants: ElapsedOccupancyInstant[] = [];
  const decreasingFlankInstants: ElapsedOccupancyInstant[] = [];

  for (const run of polyline.stallRuns) {
    if (progressInRange(progressMeters, run.minProgressMeters, run.maxProgressMeters)) {
      intervals.push({
        startElapsedMs: run.startElapsedMs,
        endElapsedMs: run.endElapsedMs,
        coverage: run.coverage,
      });
    }
  }

  for (const segment of polyline.segments) {
    const lo = Math.min(segment.from.progressMeters, segment.to.progressMeters);
    const hi = Math.max(segment.from.progressMeters, segment.to.progressMeters);
    if (!progressInRange(progressMeters, lo, hi)) {
      continue;
    }
    const span = segment.to.progressMeters - segment.from.progressMeters;
    if (Math.abs(span) <= GHOST_PROGRESS_EPSILON_METERS) {
      if (!segment.isStall) {
        intervals.push({
          startElapsedMs: segment.from.elapsedMs,
          endElapsedMs: segment.to.elapsedMs,
          coverage: segment.coverage,
        });
      }
      continue;
    }
    if (segment.isStall) {
      continue;
    }
    const elapsedMs = interpolateElapsed(segment.from, segment.to, progressMeters);
    const instant = { elapsedMs, coverage: segment.coverage };
    if (span > 0) {
      increasingFlankInstants.push(instant);
    } else {
      decreasingFlankInstants.push(instant);
    }
  }

  return {
    progressMeters,
    intervals: mergeOccupancyIntervals(intervals),
    increasingFlankInstants: uniqueInstants(increasingFlankInstants),
    decreasingFlankInstants: uniqueInstants(decreasingFlankInstants),
  };
}

/**
 * Interpolated elapsed times on strictly increasing, non-stall flanks only.
 * This is not the ghost pairing function and does not represent wait duration
 * at repeated progress.
 */
export function elapsedOnIncreasingFlanks(
  polyline: OfficialWindowPolyline,
  progressMeters: number,
): number[] {
  return occupancyAtProgress(polyline, progressMeters)
    .increasingFlankInstants.filter((instant) => instant.coverage === 'trustworthy')
    .map((instant) => instant.elapsedMs);
}

/**
 * Pair an elapsed time at `progressMeters` onto `polyline`.
 *
 * Stall queries keep occupancy intervals (so extra waiting at the same light
 * remains visible). Moving queries interpolate increasing flanks and, when the
 * other run waited here, use that wait's arrival rather than unique-last
 * passage.
 */
export function queryElapsedForProgress(
  polyline: OfficialWindowPolyline,
  progressMeters: number,
  queryElapsedMs: number,
  queryIsStall: boolean,
): GhostElapsedQuery {
  const occupancy = occupancyAtProgress(polyline, progressMeters);
  const containing = occupancy.intervals.filter(
    (interval) => queryElapsedMs >= interval.startElapsedMs && queryElapsedMs <= interval.endElapsedMs,
  );
  if (containing.length > 0) {
    const matched = preferTrustworthyInterval(containing);
    return { elapsedMs: queryElapsedMs, coverage: matched.coverage };
  }

  if (queryIsStall) {
    if (occupancy.intervals.length > 0) {
      const nearest = nearestInterval(occupancy.intervals, queryElapsedMs);
      const clamped = Math.min(nearest.endElapsedMs, Math.max(nearest.startElapsedMs, queryElapsedMs));
      return { elapsedMs: clamped, coverage: nearest.coverage };
    }
    const instant = nearestInstant(
      [...occupancy.increasingFlankInstants, ...occupancy.decreasingFlankInstants],
      queryElapsedMs,
    );
    return instant
      ? { elapsedMs: instant.elapsedMs, coverage: instant.coverage }
      : { elapsedMs: null, coverage: 'unavailable' };
  }

  if (occupancy.increasingFlankInstants.length > 0) {
    const instant = nearestInstant(occupancy.increasingFlankInstants, queryElapsedMs);
    return instant
      ? { elapsedMs: instant.elapsedMs, coverage: instant.coverage }
      : { elapsedMs: null, coverage: 'unavailable' };
  }
  if (occupancy.intervals.length > 0) {
    const nearest = nearestIntervalByArrival(occupancy.intervals, queryElapsedMs);
    return { elapsedMs: nearest.startElapsedMs, coverage: nearest.coverage };
  }
  if (occupancy.decreasingFlankInstants.length > 0) {
    const instant = nearestInstant(occupancy.decreasingFlankInstants, queryElapsedMs);
    return instant
      ? { elapsedMs: instant.elapsedMs, coverage: instant.coverage }
      : { elapsedMs: null, coverage: 'unavailable' };
  }
  return { elapsedMs: null, coverage: 'unavailable' };
}

export function knotsNearProgress(
  knots: GhostComparisonKnot[],
  progressMeters: number,
  radiusMeters: number = GHOST_NEAR_PROGRESS_METERS,
): GhostComparisonKnot[] {
  return knots.filter((knot) => Math.abs(knot.progressMeters - progressMeters) <= radiusMeters);
}

export function describeGhostUnavailable(reason: GhostUnavailableReason): string {
  switch (reason) {
    case 'missing_comparison_target':
      return 'No PB comparison run is available.';
    case 'current_not_eligible':
    case 'reference_not_eligible':
      return 'Ghost comparison is unavailable for this course layout.';
    case 'current_polyline_unavailable':
    case 'reference_polyline_unavailable':
      return 'Ghost comparison needs trustworthy route-progress coverage on both runs.';
  }
}

export function interpolateProgressAtTime(
  accepted: AcceptedProgressSample[],
  atMs: number,
): number | null {
  if (accepted.length === 0) {
    return null;
  }
  let previous: AcceptedProgressSample | null = null;
  for (const sample of accepted) {
    if (Math.abs(sample.recordedAtMs - atMs) <= 0.5) {
      return sample.progressMeters;
    }
    if (sample.recordedAtMs > atMs) {
      if (!previous) {
        return sample.progressMeters;
      }
      const span = sample.recordedAtMs - previous.recordedAtMs;
      if (span <= 0) {
        return sample.progressMeters;
      }
      const t = (atMs - previous.recordedAtMs) / span;
      return previous.progressMeters + t * (sample.progressMeters - previous.progressMeters);
    }
    previous = sample;
  }
  return previous?.progressMeters ?? null;
}

function progressAtOrBefore(accepted: AcceptedProgressSample[], atMs: number): number | null {
  let found: AcceptedProgressSample | null = null;
  for (const sample of accepted) {
    if (sample.recordedAtMs <= atMs) {
      found = sample;
    }
  }
  return found?.progressMeters ?? null;
}

function spanCoverage(
  intervals: ClassifiedMovementInterval[],
  startMs: number,
  endMs: number,
): GhostCoverage {
  if (endMs <= startMs) {
    return 'trustworthy';
  }
  const overlapping = overlappingIntervals(intervals, startMs, endMs);
  if (overlapping.length === 0) {
    return 'unavailable';
  }
  if (overlapping.some((interval) => interval.label === 'unknown')) {
    return 'unavailable';
  }
  return 'trustworthy';
}

function isWaitingSpan(intervals: ClassifiedMovementInterval[], startMs: number, endMs: number): boolean {
  if (endMs <= startMs) {
    return false;
  }
  const overlapping = overlappingIntervals(intervals, startMs, endMs);
  return overlapping.length > 0 && overlapping.every((interval) => interval.label === 'waiting');
}

function overlappingIntervals(
  intervals: ClassifiedMovementInterval[],
  startMs: number,
  endMs: number,
): ClassifiedMovementInterval[] {
  return intervals.filter((interval) => interval.endMs > startMs && interval.startMs < endMs);
}

function mergeStallRuns(segments: GhostPolylineSegment[]): GhostStallRun[] {
  const runs: GhostStallRun[] = [];
  let open: GhostStallRun | null = null;
  for (const segment of segments) {
    if (!segment.isStall) {
      if (open) {
        runs.push(open);
        open = null;
      }
      continue;
    }
    if (!open) {
      open = {
        startElapsedMs: segment.from.elapsedMs,
        endElapsedMs: segment.to.elapsedMs,
        minProgressMeters: Math.min(segment.from.progressMeters, segment.to.progressMeters),
        maxProgressMeters: Math.max(segment.from.progressMeters, segment.to.progressMeters),
        coverage: segment.coverage,
      };
      continue;
    }
    open.endElapsedMs = segment.to.elapsedMs;
    open.minProgressMeters = Math.min(
      open.minProgressMeters,
      segment.from.progressMeters,
      segment.to.progressMeters,
    );
    open.maxProgressMeters = Math.max(
      open.maxProgressMeters,
      segment.from.progressMeters,
      segment.to.progressMeters,
    );
    if (segment.coverage === 'unavailable') {
      open.coverage = 'unavailable';
    }
  }
  if (open) {
    runs.push(open);
  }
  return runs;
}

function knotIsStall(polyline: OfficialWindowPolyline, knot: GhostProgressKnot): boolean {
  return polyline.stallRuns.some(
    (run) =>
      knot.elapsedMs >= run.startElapsedMs &&
      knot.elapsedMs <= run.endElapsedMs &&
      progressInRange(knot.progressMeters, run.minProgressMeters, run.maxProgressMeters),
  );
}

function paintedFinishElapsed(
  course: TimingCourse,
  knots: GhostProgressKnot[],
  segments: GhostPolylineSegment[],
  startedAtMs: number,
): number | null {
  const finishLine = course.finishProgressMeters;
  for (const segment of segments) {
    if (segment.isStall || segment.coverage !== 'trustworthy') {
      continue;
    }
    if (
      segment.from.progressMeters < finishLine &&
      segment.to.progressMeters >= finishLine
    ) {
      return (
        interpolateCrossingTime(
          {
            recordedAtMs: segment.from.recordedAtMs,
            progressMeters: segment.from.progressMeters,
          },
          {
            recordedAtMs: segment.to.recordedAtMs,
            progressMeters: segment.to.progressMeters,
          },
          finishLine,
        ) - startedAtMs
      );
    }
  }
  for (const knot of knots) {
    if (Math.abs(knot.progressMeters - finishLine) <= GHOST_PROGRESS_EPSILON_METERS) {
      return knot.elapsedMs;
    }
  }
  return null;
}

function interpolateElapsed(from: GhostProgressKnot, to: GhostProgressKnot, progressMeters: number): number {
  const span = to.progressMeters - from.progressMeters;
  if (span === 0) {
    return to.elapsedMs;
  }
  const t = (progressMeters - from.progressMeters) / span;
  const clamped = Math.min(1, Math.max(0, t));
  return from.elapsedMs + clamped * (to.elapsedMs - from.elapsedMs);
}

function progressInRange(progressMeters: number, minProgressMeters: number, maxProgressMeters: number): boolean {
  return (
    progressMeters + GHOST_PROGRESS_EPSILON_METERS >= minProgressMeters &&
    progressMeters - GHOST_PROGRESS_EPSILON_METERS <= maxProgressMeters
  );
}

function mergeOccupancyIntervals(intervals: ElapsedOccupancyInterval[]): ElapsedOccupancyInterval[] {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort((a, b) => {
    if (a.startElapsedMs !== b.startElapsedMs) {
      return a.startElapsedMs - b.startElapsedMs;
    }
    return a.endElapsedMs - b.endElapsedMs;
  });
  const merged: ElapsedOccupancyInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.coverage === last.coverage && interval.startElapsedMs <= last.endElapsedMs + 0.5) {
      last.endElapsedMs = Math.max(last.endElapsedMs, interval.endElapsedMs);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

function uniqueInstants(instants: ElapsedOccupancyInstant[]): ElapsedOccupancyInstant[] {
  const seen = new Set<string>();
  const unique: ElapsedOccupancyInstant[] = [];
  for (const instant of instants) {
    const key = `${instant.elapsedMs.toFixed(3)}|${instant.coverage}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(instant);
  }
  return unique.sort((a, b) => a.elapsedMs - b.elapsedMs);
}

function preferTrustworthyInterval(intervals: ElapsedOccupancyInterval[]): ElapsedOccupancyInterval {
  return intervals.find((interval) => interval.coverage === 'trustworthy') ?? intervals[0]!;
}

function nearestInterval(intervals: ElapsedOccupancyInterval[], queryElapsedMs: number): ElapsedOccupancyInterval {
  return intervals.reduce((best, interval) => {
    const clamped = Math.min(interval.endElapsedMs, Math.max(interval.startElapsedMs, queryElapsedMs));
    const bestClamped = Math.min(best.endElapsedMs, Math.max(best.startElapsedMs, queryElapsedMs));
    const distance = Math.abs(queryElapsedMs - clamped);
    const bestDistance = Math.abs(queryElapsedMs - bestClamped);
    if (distance !== bestDistance) {
      return distance < bestDistance ? interval : best;
    }
    return interval.startElapsedMs < best.startElapsedMs ? interval : best;
  });
}

function nearestIntervalByArrival(
  intervals: ElapsedOccupancyInterval[],
  queryElapsedMs: number,
): ElapsedOccupancyInterval {
  return intervals.reduce((best, interval) => {
    const distance = Math.abs(queryElapsedMs - interval.startElapsedMs);
    const bestDistance = Math.abs(queryElapsedMs - best.startElapsedMs);
    if (distance !== bestDistance) {
      return distance < bestDistance ? interval : best;
    }
    return interval.startElapsedMs < best.startElapsedMs ? interval : best;
  });
}

function nearestInstant(
  instants: ElapsedOccupancyInstant[],
  queryElapsedMs: number,
): ElapsedOccupancyInstant | null {
  if (instants.length === 0) {
    return null;
  }
  return instants.reduce((best, instant) => {
    const distance = Math.abs(queryElapsedMs - instant.elapsedMs);
    const bestDistance = Math.abs(queryElapsedMs - best.elapsedMs);
    if (distance !== bestDistance) {
      return distance < bestDistance ? instant : best;
    }
    return instant.elapsedMs < best.elapsedMs ? instant : best;
  });
}

function combineCoverage(
  currentCoverage: GhostCoverage,
  referenceCoverage: GhostCoverage,
  paired: boolean,
): GhostCoverage {
  if (!paired || currentCoverage === 'unavailable' || referenceCoverage === 'unavailable') {
    return 'unavailable';
  }
  return 'trustworthy';
}

function toComparisonKnot(input: {
  progressMeters: number;
  coordinate: LatLng | null;
  currentElapsedMs: number | null;
  referenceElapsedMs: number | null;
  coverage: GhostCoverage;
  knotKind: GhostKnotKind;
  source: GhostComparisonKnot['source'];
}): GhostComparisonKnot {
  const comparable =
    input.coverage === 'trustworthy' &&
    input.currentElapsedMs != null &&
    input.referenceElapsedMs != null;
  return {
    progressMeters: input.progressMeters,
    coordinate: input.coordinate,
    currentElapsedMs: input.currentElapsedMs,
    referenceElapsedMs: input.referenceElapsedMs,
    deltaMs: comparable ? input.currentElapsedMs! - input.referenceElapsedMs! : null,
    coverage: comparable ? 'trustworthy' : 'unavailable',
    knotKind: input.knotKind,
    source: input.source,
  };
}

function compareGhostKnots(a: GhostComparisonKnot, b: GhostComparisonKnot): number {
  const aElapsed = a.currentElapsedMs ?? Number.MAX_SAFE_INTEGER;
  const bElapsed = b.currentElapsedMs ?? Number.MAX_SAFE_INTEGER;
  if (aElapsed !== bElapsed) {
    return aElapsed - bElapsed;
  }
  if (a.progressMeters !== b.progressMeters) {
    return a.progressMeters - b.progressMeters;
  }
  const aRef = a.referenceElapsedMs ?? Number.MAX_SAFE_INTEGER;
  const bRef = b.referenceElapsedMs ?? Number.MAX_SAFE_INTEGER;
  if (aRef !== bRef) {
    return aRef - bRef;
  }
  return a.source.localeCompare(b.source);
}
