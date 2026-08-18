import {
  createCourseMatchState,
  matchSampleToCourse,
} from './course-matching';
import type { TimingCourse } from './attempt-timing';
import { haversineMeters } from './geo';
import type { LocationSample } from './location-sample';

/**
 * Movement-analysis version identity. Results are derived on read from raw
 * telemetry; this string exists so a later cache cannot mix algorithm revisions.
 */
export const MOVEMENT_ANALYSIS_VERSION = 'movement-v1';

/**
 * Distinct from `MIN_MOVING_SPEED_MPS` in `route-derivation.ts` (0.8 m/s).
 * Route derivation uses that threshold to drop stationary points while building
 * reference geometry. This classifier decomposes official attempt time and uses
 * its own speed band plus windowed hysteresis so ordinary GPS jitter is not
 * treated as travel. The two definitions are not interchangeable.
 */
export const MOVING_SPEED_MPS = 0.55;
export const WAITING_SPEED_MPS = 0.3;

/** Samples worse than this are ignored as movement flanks (same 25 m cap as route-derivation accuracy). */
export const MAX_USABLE_ACCURACY_METERS = 25;

/** Intervals longer than this are gaps, not ordinary 1 Hz classification. */
export const DENSE_INTERVAL_MAX_MS = 8_000;

/** Product constant: bounded no-fix stationary gap, aligned with stale-fix UX. */
export const MAX_STATIONARY_GAP_MS = 120_000;
export const MAX_STATIONARY_GAP_ACCURACY_METERS = 25;
export const MAX_STATIONARY_GAP_DISPLACEMENT_METERS = 15;
export const MAX_STATIONARY_GAP_PROGRESS_METERS = 15;

/** Dense-window length used to resist GPS jitter. */
export const HYSTERESIS_WINDOW_MS = 4_000;
export const MIN_FORWARD_PROGRESS_METERS = 0.8;
export const MIN_SINGLE_INTERVAL_MOVE_METERS = 6;
export const MIN_MOVING_FORWARD_INTERVALS = 2;

/** Speeds above this in a dense interval are treated as an implausible GPS jump. */
export const MAX_PLAUSIBLE_SPEED_MPS = 25;

/** Display the two-way breakdown only when at least this fraction of official time is classified. */
export const MIN_DISPLAYABLE_COVERAGE_RATIO = 0.75;

/** `moving + waiting + unknown` must match official time within this many milliseconds. */
export const MOVEMENT_TOTAL_TOLERANCE_MS = 1;

export type MovementTrust = 'complete' | 'partial' | 'unavailable';

export type MovementBreakdown = {
  analysisVersion: string;
  officialTimeMs: number;
  movingMs: number;
  waitingMs: number;
  unknownMs: number;
  classifiedMs: number;
  coverageRatio: number;
  trust: MovementTrust;
};

type LocatedFix = {
  recordedAtMs: number;
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  progressMeters: number | null;
};

type DenseWindowEntry = {
  durationMs: number;
  signedProgressMeters: number;
  displacementMeters: number;
  start: LocatedFix;
  end: LocatedFix;
};

type IntervalLabel = 'moving' | 'waiting' | 'unknown';

export function emptyMovementBreakdown(officialTimeMs: number): MovementBreakdown {
  const total = Math.max(0, officialTimeMs);
  return finalizeBreakdown(total, 0, 0, total);
}

export function analyzeAttemptMovement(input: {
  course: TimingCourse;
  samples: LocationSample[];
  startedAtMs: number;
  finishedAtMs: number;
}): MovementBreakdown {
  const officialTimeMs = Math.max(0, input.finishedAtMs - input.startedAtMs);
  if (officialTimeMs <= 0) {
    return emptyMovementBreakdown(officialTimeMs);
  }

  const usable = locateUsableFixes(input.course, input.samples);
  const startFix = boundFixAt(usable, input.startedAtMs);
  const finishFix = boundFixAt(usable, input.finishedAtMs);
  const inner = usable.filter(
    (fix) => fix.recordedAtMs > input.startedAtMs && fix.recordedAtMs < input.finishedAtMs,
  );

  const points: LocatedFix[] = [];
  if (startFix) {
    points.push(startFix);
  }
  points.push(...inner);
  if (finishFix) {
    points.push(finishFix);
  }

  let movingMs = 0;
  let waitingMs = 0;
  let unknownMs = 0;
  const add = (label: IntervalLabel, durationMs: number) => {
    if (durationMs <= 0) {
      return;
    }
    if (label === 'moving') {
      movingMs += durationMs;
    } else if (label === 'waiting') {
      waitingMs += durationMs;
    } else {
      unknownMs += durationMs;
    }
  };

  let cursorMs = input.startedAtMs;
  if (points.length === 0) {
    add('unknown', input.finishedAtMs - cursorMs);
    return finalizeBreakdown(officialTimeMs, movingMs, waitingMs, unknownMs);
  }

  const first = points[0];
  if (first && first.recordedAtMs > cursorMs) {
    add('unknown', first.recordedAtMs - cursorMs);
    cursorMs = first.recordedAtMs;
  }

  const denseWindow: DenseWindowEntry[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (!left || !right) {
      continue;
    }
    const durationMs = right.recordedAtMs - left.recordedAtMs;
    if (durationMs <= 0) {
      continue;
    }
    const label = classifyInterval(left, right, durationMs, denseWindow);
    add(label, durationMs);
    cursorMs = right.recordedAtMs;
  }

  if (input.finishedAtMs > cursorMs) {
    add('unknown', input.finishedAtMs - cursorMs);
  }

  return finalizeBreakdown(officialTimeMs, movingMs, waitingMs, unknownMs);
}

export function movementTotalsReconcile(
  breakdown: MovementBreakdown,
  toleranceMs: number = MOVEMENT_TOTAL_TOLERANCE_MS,
): boolean {
  return (
    Math.abs(breakdown.movingMs + breakdown.waitingMs + breakdown.unknownMs - breakdown.officialTimeMs) <=
    toleranceMs
  );
}

export function isMovementDisplayable(breakdown: MovementBreakdown): boolean {
  return breakdown.trust === 'complete' || breakdown.trust === 'partial';
}

function finalizeBreakdown(
  officialTimeMs: number,
  movingMs: number,
  waitingMs: number,
  unknownMs: number,
): MovementBreakdown {
  const classifiedMs = movingMs + waitingMs;
  const coverageRatio = officialTimeMs > 0 ? classifiedMs / officialTimeMs : 0;
  let trust: MovementTrust = 'unavailable';
  if (officialTimeMs > 0 && coverageRatio >= MIN_DISPLAYABLE_COVERAGE_RATIO) {
    trust = unknownMs <= MOVEMENT_TOTAL_TOLERANCE_MS ? 'complete' : 'partial';
  }
  return {
    analysisVersion: MOVEMENT_ANALYSIS_VERSION,
    officialTimeMs,
    movingMs,
    waitingMs,
    unknownMs,
    classifiedMs,
    coverageRatio,
    trust,
  };
}

function locateUsableFixes(course: TimingCourse, samples: LocationSample[]): LocatedFix[] {
  const usable: LocatedFix[] = [];
  let match = createCourseMatchState();
  let lastKeptAtMs: number | null = null;

  for (const sample of samples) {
    if (!Number.isFinite(sample.recordedAtMs) || !Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) {
      continue;
    }
    if (lastKeptAtMs != null && sample.recordedAtMs <= lastKeptAtMs) {
      continue;
    }

    const result = matchSampleToCourse(
      course.referencePath,
      sample,
      match,
      course.startProgressMeters,
    );
    if (result.accepted) {
      match = result.state;
    }

    lastKeptAtMs = sample.recordedAtMs;
    if (!isUsableAccuracy(sample.horizontalAccuracyMeters)) {
      continue;
    }

    usable.push({
      recordedAtMs: sample.recordedAtMs,
      latitude: sample.latitude,
      longitude: sample.longitude,
      horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
      speedMetersPerSecond: sample.speedMetersPerSecond,
      progressMeters: result.progressMeters,
    });
  }

  return usable;
}

function isUsableAccuracy(accuracyMeters: number | null): boolean {
  // Null accuracy matches route-derivation: treat as usable rather than discarding the fix.
  return accuracyMeters == null || accuracyMeters <= MAX_USABLE_ACCURACY_METERS;
}

function boundFixAt(usable: LocatedFix[], atMs: number): LocatedFix | null {
  for (const fix of usable) {
    if (Math.abs(fix.recordedAtMs - atMs) <= 0.5) {
      return { ...fix, recordedAtMs: atMs };
    }
  }
  let left: LocatedFix | null = null;
  let right: LocatedFix | null = null;
  for (const fix of usable) {
    if (fix.recordedAtMs < atMs) {
      left = fix;
    } else if (fix.recordedAtMs > atMs) {
      right = fix;
      break;
    }
  }
  if (!left || !right) {
    return null;
  }
  if (right.recordedAtMs - left.recordedAtMs > MAX_STATIONARY_GAP_MS) {
    return null;
  }
  return interpolateFix(left, right, atMs);
}

function interpolateFix(left: LocatedFix, right: LocatedFix, atMs: number): LocatedFix {
  const span = right.recordedAtMs - left.recordedAtMs;
  const t = span === 0 ? 1 : Math.min(1, Math.max(0, (atMs - left.recordedAtMs) / span));
  const progressMeters =
    left.progressMeters != null && right.progressMeters != null
      ? left.progressMeters + t * (right.progressMeters - left.progressMeters)
      : null;
  const speedMetersPerSecond =
    left.speedMetersPerSecond != null && right.speedMetersPerSecond != null
      ? left.speedMetersPerSecond + t * (right.speedMetersPerSecond - left.speedMetersPerSecond)
      : null;
  const horizontalAccuracyMeters = interpolatedAccuracy(
    left.horizontalAccuracyMeters,
    right.horizontalAccuracyMeters,
  );
  return {
    recordedAtMs: atMs,
    latitude: left.latitude + t * (right.latitude - left.latitude),
    longitude: left.longitude + t * (right.longitude - left.longitude),
    horizontalAccuracyMeters,
    speedMetersPerSecond,
    progressMeters,
  };
}

function interpolatedAccuracy(left: number | null, right: number | null): number | null {
  if (left == null && right == null) {
    return null;
  }
  if (left == null) {
    return right;
  }
  if (right == null) {
    return left;
  }
  return Math.max(left, right);
}

function classifyInterval(
  left: LocatedFix,
  right: LocatedFix,
  durationMs: number,
  denseWindow: DenseWindowEntry[],
): IntervalLabel {
  if (durationMs > MAX_STATIONARY_GAP_MS) {
    denseWindow.length = 0;
    return 'unknown';
  }

  const displacementMeters = haversineMeters(left, right);
  const durationSec = durationMs / 1000;
  const impliedSpeed = durationSec > 0 ? displacementMeters / durationSec : 0;
  if (impliedSpeed > MAX_PLAUSIBLE_SPEED_MPS) {
    denseWindow.length = 0;
    return 'unknown';
  }

  const progressDelta =
    left.progressMeters != null && right.progressMeters != null
      ? Math.abs(right.progressMeters - left.progressMeters)
      : null;
  const stationaryGap = isStationaryGap(left, right, durationMs, displacementMeters, progressDelta);

  if (durationMs > DENSE_INTERVAL_MAX_MS) {
    denseWindow.length = 0;
    return stationaryGap ? 'waiting' : 'unknown';
  }

  const signedProgressMeters =
    left.progressMeters != null && right.progressMeters != null
      ? right.progressMeters - left.progressMeters
      : 0;
  denseWindow.push({
    durationMs,
    signedProgressMeters,
    displacementMeters,
    start: left,
    end: right,
  });
  trimDenseWindow(denseWindow);
  return classifyDenseWindow(denseWindow);
}

function isStationaryGap(
  left: LocatedFix,
  right: LocatedFix,
  durationMs: number,
  displacementMeters: number,
  progressDelta: number | null,
): boolean {
  if (durationMs > MAX_STATIONARY_GAP_MS) {
    return false;
  }
  if (!flankAccuracyOk(left) || !flankAccuracyOk(right)) {
    return false;
  }
  if (displacementMeters > MAX_STATIONARY_GAP_DISPLACEMENT_METERS) {
    return false;
  }
  if (progressDelta == null || progressDelta > MAX_STATIONARY_GAP_PROGRESS_METERS) {
    return false;
  }
  return true;
}

function flankAccuracyOk(fix: LocatedFix): boolean {
  return (
    fix.horizontalAccuracyMeters == null ||
    fix.horizontalAccuracyMeters <= MAX_STATIONARY_GAP_ACCURACY_METERS
  );
}

function plausibleReportedSpeed(speedMetersPerSecond: number | null): number | null {
  if (speedMetersPerSecond == null || !Number.isFinite(speedMetersPerSecond)) {
    return null;
  }
  if (speedMetersPerSecond < 0 || speedMetersPerSecond > MAX_PLAUSIBLE_SPEED_MPS) {
    return null;
  }
  return speedMetersPerSecond;
}

function meanPlausibleReportedSpeed(left: LocatedFix, right: LocatedFix): number | null {
  const speeds = [plausibleReportedSpeed(left.speedMetersPerSecond), plausibleReportedSpeed(right.speedMetersPerSecond)].filter(
    (speed): speed is number => speed != null,
  );
  if (speeds.length === 0) {
    return null;
  }
  return speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
}

function trimDenseWindow(window: DenseWindowEntry[]): void {
  let total = windowDuration(window);
  while (window.length > 1 && total - (window[0]?.durationMs ?? 0) >= HYSTERESIS_WINDOW_MS) {
    window.shift();
    total = windowDuration(window);
  }
}

function windowDuration(window: DenseWindowEntry[]): number {
  return window.reduce((sum, entry) => sum + entry.durationMs, 0);
}

function classifyDenseWindow(window: DenseWindowEntry[]): IntervalLabel {
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last) {
    return 'unknown';
  }

  const elapsedMs = last.end.recordedAtMs - first.start.recordedAtMs;
  const elapsedSec = elapsedMs / 1000;
  if (elapsedSec <= 0) {
    return 'waiting';
  }

  const haveProgress = window.every(
    (entry) => entry.start.progressMeters != null && entry.end.progressMeters != null,
  );
  const netProgressMeters = haveProgress
    ? Math.abs((last.end.progressMeters ?? 0) - (first.start.progressMeters ?? 0))
    : 0;
  const sumAbsProgress = window.reduce((sum, entry) => sum + Math.abs(entry.signedProgressMeters), 0);
  const progressConsistency = sumAbsProgress < 1e-6 ? 1 : netProgressMeters / sumAbsProgress;

  const pathLengthMeters = window.reduce((sum, entry) => sum + entry.displacementMeters, 0);
  const netDisplacementMeters = haversineMeters(first.start, last.end);
  const displacementConsistency =
    pathLengthMeters < 1e-6 ? 1 : Math.min(1, netDisplacementMeters / pathLengthMeters);

  const consistency = haveProgress ? progressConsistency : displacementConsistency;
  const geometricSpeedMps = haveProgress ? netProgressMeters / elapsedSec : netDisplacementMeters / elapsedSec;
  const reported = meanPlausibleReportedSpeed(last.start, last.end);
  const speedMps =
    !haveProgress && reported != null && geometricSpeedMps > WAITING_SPEED_MPS && geometricSpeedMps < MOVING_SPEED_MPS
      ? reported
      : geometricSpeedMps;
  const forwardIntervals = window.filter(
    (entry) => entry.signedProgressMeters > MIN_FORWARD_PROGRESS_METERS,
  ).length;

  if (consistency < 0.5) {
    return 'waiting';
  }
  if (speedMps <= WAITING_SPEED_MPS) {
    return 'waiting';
  }
  if (speedMps >= MOVING_SPEED_MPS && isSustainedMoving(window, netDisplacementMeters, forwardIntervals)) {
    return 'moving';
  }
  return 'waiting';
}

function isSustainedMoving(
  window: DenseWindowEntry[],
  netDisplacementMeters: number,
  forwardIntervals: number,
): boolean {
  const last = window[window.length - 1];
  if (window.length === 1 && last) {
    const elapsedSec = last.durationMs / 1000;
    const progressSpeed = elapsedSec > 0 ? Math.abs(last.signedProgressMeters) / elapsedSec : 0;
    if (Math.abs(last.signedProgressMeters) >= MIN_FORWARD_PROGRESS_METERS && progressSpeed >= MOVING_SPEED_MPS) {
      return true;
    }
    return (
      last.displacementMeters >= MIN_SINGLE_INTERVAL_MOVE_METERS &&
      elapsedSec > 0 &&
      last.displacementMeters / elapsedSec >= MOVING_SPEED_MPS
    );
  }
  if (forwardIntervals >= MIN_MOVING_FORWARD_INTERVALS) {
    return true;
  }
  return netDisplacementMeters >= MIN_SINGLE_INTERVAL_MOVE_METERS && window.length >= 2;
}
