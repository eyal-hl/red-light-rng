import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  analyzeFocusAttempt,
  deriveCurrentLayoutAttempt,
  timingCourseFromRoute,
  type AttemptTrace,
} from '../src/domain/attempt-analysis';
import type { Attempt } from '../src/domain/attempt';
import {
  finishTriggerProgressMeters,
  interpolateCrossingTime,
  replayAttemptTrace,
  type TimingCourse,
} from '../src/domain/attempt-timing';
import { pathDistanceMeters } from '../src/domain/geo';
import {
  compareAttemptGhost,
  elapsedOnIncreasingFlanks,
  GHOST_COMPARISON_VERSION,
  knotsNearProgress,
  occupancyAtProgress,
  type GhostComparison,
} from '../src/domain/ghost-comparison';
import { MAX_STATIONARY_GAP_MS } from '../src/domain/movement-analysis';
import { pointAtProgress } from '../src/domain/path-projection';
import type { LocationSample } from '../src/domain/location-sample';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample, traceAlongPath } from './helpers/samples';

function longPath() {
  return northPath({ points: 41, stepMeters: 20 });
}

function courseFromPath(path = longPath(), overrides: Partial<TimingCourse> = {}): TimingCourse {
  return timingCourseFromRoute(
    makeRoute({
      referencePath: path,
      checkpoints: overrides.checkpoints ?? [],
      ...overrides,
    }),
  );
}

function makeAttempt(overrides: Partial<Attempt> & Pick<Attempt, 'id' | 'sessionId'>): Attempt {
  return {
    routeId: 'route-1',
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 5_000,
    finishedAtMs: 200_000,
    resultAcknowledged: true,
    crossings: [],
    ...overrides,
  };
}

function coveringTrace(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    startProgressMeters?: number;
    stepMeters?: number;
    intervalMs?: number;
  },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const startProgress = options.startProgressMeters ?? 0;
  const stepMeters = options.stepMeters ?? 4;
  const intervalMs = options.intervalMs ?? 1000;
  const count = Math.ceil((length - startProgress) / stepMeters) + 16;
  return traceAlongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    startProgressMeters: startProgress,
    stepMeters,
    intervalMs,
    count,
  }).map((item, index) =>
    sample({
      ...item,
      id: `${options.sessionId}-${index}`,
    }),
  );
}

function stretchAfterDeparture(samples: LocationSample[], factor: number, afterIndex = 10): LocationSample[] {
  if (samples.length === 0) {
    return samples;
  }
  const pivot = Math.min(afterIndex, samples.length - 1);
  const out = samples.slice(0, pivot + 1).map((item) => sample({ ...item }));
  const pivotSample = samples[pivot];
  if (!pivotSample) {
    return out;
  }
  let timeMs = pivotSample.recordedAtMs;
  for (let index = pivot + 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (!previous || !current) {
      continue;
    }
    timeMs += Math.max(1, Math.round((current.recordedAtMs - previous.recordedAtMs) * factor));
    out.push(
      sample({
        ...current,
        recordedAtMs: timeMs,
      }),
    );
  }
  return out;
}

function commuteWithStop(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    stopProgressMeters: number;
    stopDurationMs: number;
    mode: 'dense-jitter' | 'zero-fix';
    jitterMeters?: number;
    preStartStandMs?: number;
    stepMeters?: number;
    intervalMs?: number;
  },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const stepMeters = options.stepMeters ?? 4;
  const intervalMs = options.intervalMs ?? 1000;
  const samples: LocationSample[] = [];
  let timeMs = options.startMs;
  let id = 0;
  const pushAt = (
    progressMeters: number,
    recordedAtMs: number,
    extra: Partial<LocationSample> = {},
  ) => {
    const point = pointAtProgress(path, Math.min(Math.max(progressMeters, 0), length));
    samples.push(
      sample({
        id: `${options.sessionId}-${id}`,
        sessionId: options.sessionId,
        recordedAtMs,
        latitude: extra.latitude ?? point.latitude,
        longitude: extra.longitude ?? point.longitude,
        speedMetersPerSecond: extra.speedMetersPerSecond ?? 4,
        horizontalAccuracyMeters: extra.horizontalAccuracyMeters ?? 6,
        headingDegrees: extra.headingDegrees,
      }),
    );
    id += 1;
  };

  if ((options.preStartStandMs ?? 0) > 0) {
    const standMs = options.preStartStandMs ?? 0;
    for (let elapsed = 0; elapsed <= standMs; elapsed += intervalMs) {
      pushAt(0, timeMs, { speedMetersPerSecond: 0 });
      timeMs += intervalMs;
    }
  }

  let progress = 0;
  let stopped = false;
  while (progress <= length + stepMeters * 4) {
    if (!stopped && progress + stepMeters > options.stopProgressMeters) {
      const stop = options.stopProgressMeters;
      if (options.mode === 'zero-fix') {
        pushAt(stop, timeMs, { speedMetersPerSecond: 0 });
        timeMs += options.stopDurationMs;
        pushAt(stop, timeMs, { speedMetersPerSecond: 0 });
      } else {
        const jitter = options.jitterMeters ?? 2;
        const ticks = Math.max(1, Math.round(options.stopDurationMs / intervalMs));
        for (let tick = 0; tick <= ticks; tick += 1) {
          const phase = tick % 4;
          const east = phase === 1 ? jitter : phase === 3 ? -jitter : 0;
          const along = phase === 2 ? jitter * 0.25 : 0;
          const point = pointAtProgress(path, stop);
          const jittered = offsetLatLng(point.latitude, point.longitude, along, east);
          pushAt(stop, timeMs, {
            latitude: jittered.latitude,
            longitude: jittered.longitude,
            speedMetersPerSecond: 0,
          });
          timeMs += intervalMs;
        }
      }
      stopped = true;
      progress = stop;
    }
    pushAt(progress, timeMs);
    progress += stepMeters;
    timeMs += intervalMs;
  }
  return samples;
}

function tracesFor(
  course: TimingCourse,
  rows: { id: string; armedAtMs: number; samples: LocationSample[] }[],
): AttemptTrace[] {
  return rows.map((row) => ({
    attempt: makeAttempt({
      id: row.id,
      sessionId: row.id,
      armedAtMs: row.armedAtMs,
    }),
    samples: row.samples,
  }));
}

function derived(course: TimingCourse, id: string, samples: LocationSample[]) {
  return deriveCurrentLayoutAttempt(
    course,
    makeAttempt({ id, sessionId: id, armedAtMs: samples[0]?.recordedAtMs ?? 1_000 }),
    samples,
  );
}

function ghostOf(course: TimingCourse, currentId: string, traces: AttemptTrace[]): GhostComparison {
  const focus = analyzeFocusAttempt(course, traces, currentId);
  assert.ok(focus);
  return focus.ghostComparison;
}

describe('official-window ghost polyline', () => {
  it('builds a time-ordered polyline that may repeat progress and starts at elapsed 0', () => {
    const course = courseFromPath();
    const samples = commuteWithStop(course.referencePath, {
      sessionId: 'wait',
      startMs: 5_000,
      stopProgressMeters: 400,
      stopDurationMs: 40_000,
      mode: 'zero-fix',
    });
    const attempt = derived(course, 'wait', samples);
    assert.equal(attempt.eligible, true);
    const comparison = compareAttemptGhost({
      course,
      current: attempt,
      currentSamples: samples,
      reference: attempt,
      referenceSamples: samples,
    });
    assert.equal(comparison.available, true);
    const polyline = comparison.currentPolyline;
    assert.ok(polyline);
    assert.equal(polyline.analysisVersion, GHOST_COMPARISON_VERSION);
    assert.equal(polyline.knots[0]?.elapsedMs, 0);
    assert.equal(polyline.knots[0]?.knotKind, 'start');
    const terminal = polyline.knots[polyline.knots.length - 1];
    assert.equal(terminal?.knotKind, 'finish-trigger');
    assert.equal(terminal?.elapsedMs, attempt.officialTimeMs);
    assert.ok(
      Math.abs((terminal?.progressMeters ?? 0) - finishTriggerProgressMeters(course)) < 0.01,
    );
    assert.ok(polyline.knots.every((knot) => knot.elapsedMs >= 0 && knot.elapsedMs <= (attempt.officialTimeMs ?? 0)));
    const repeats = polyline.knots.some(
      (knot, index) =>
        index > 0 &&
        Math.abs(knot.progressMeters - (polyline.knots[index - 1]?.progressMeters ?? -1)) < 1 &&
        knot.elapsedMs > (polyline.knots[index - 1]?.elapsedMs ?? 0) + 1_000,
    );
    assert.equal(repeats, true);
  });

  it('keeps a bounded zero-fix wait comparable instead of marking it unavailable', () => {
    const course = courseFromPath();
    const samples = commuteWithStop(course.referencePath, {
      sessionId: 'gap',
      startMs: 5_000,
      stopProgressMeters: 400,
      stopDurationMs: 90_000,
      mode: 'zero-fix',
    });
    const attempt = derived(course, 'gap', samples);
    const comparison = compareAttemptGhost({
      course,
      current: attempt,
      currentSamples: samples,
      reference: attempt,
      referenceSamples: samples,
    });
    assert.equal(comparison.available, true);
    const wait = attempt.waitEvents.find((event) => Math.abs((event.progressMeters ?? 0) - 400) < 20);
    assert.ok(wait?.progressMeters != null);
    const occupancy = occupancyAtProgress(comparison.currentPolyline!, wait.progressMeters);
    assert.ok(occupancy.intervals.length >= 1);
    const span = occupancy.intervals.reduce(
      (longest, interval) => Math.max(longest, interval.endElapsedMs - interval.startElapsedMs),
      0,
    );
    assert.ok(span >= 80_000, `expected ~90s occupancy, got ${span}`);
    assert.equal(occupancy.intervals.every((interval) => interval.coverage === 'trustworthy'), true);
    const around = knotsNearProgress(comparison.knots, wait.progressMeters, 8);
    assert.ok(around.some((knot) => knot.coverage === 'trustworthy' && knot.deltaMs === 0));
    assert.equal(
      around.some((knot) => knot.coverage === 'unavailable' && (knot.currentElapsedMs ?? 0) > 0),
      false,
    );
  });
});

describe('ghost pairing invariants', () => {
  it('is exactly zero for a pure self-comparison wherever comparable', () => {
    const course = courseFromPath();
    const samples = commuteWithStop(course.referencePath, {
      sessionId: 'self',
      startMs: 8_000,
      stopProgressMeters: 360,
      stopDurationMs: 25_000,
      mode: 'dense-jitter',
    });
    const attempt = derived(course, 'self', samples);
    const comparison = compareAttemptGhost({
      course,
      current: attempt,
      currentSamples: samples,
      reference: attempt,
      referenceSamples: samples,
    });
    assert.equal(comparison.available, true);
    const comparable = comparison.knots.filter((knot) => knot.coverage === 'trustworthy');
    assert.ok(comparable.length > 10);
    for (const knot of comparable) {
      assert.equal(knot.deltaMs, 0);
      assert.equal(knot.currentElapsedMs, knot.referenceElapsedMs);
    }
    assert.equal(comparison.startDeltaMs, 0);
    assert.equal(comparison.finishTriggerDeltaMs, 0);
  });

  it('grows a positive delta for a uniformly slower run and reconciles at the finish trigger', () => {
    const course = courseFromPath();
    const fast = coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 1_000 });
    const slow = stretchAfterDeparture(
      coveringTrace(course.referencePath, { sessionId: 'slow', startMs: 50_000 }),
      2,
    );
    const traces = tracesFor(course, [
      { id: 'fast', armedAtMs: 1_000, samples: fast },
      { id: 'slow', armedAtMs: 50_000, samples: slow },
    ]);
    const focus = analyzeFocusAttempt(course, traces, 'slow');
    assert.equal(focus?.focus.eligible, true);
    assert.equal(focus?.ghostComparison.available, true);
    const comparison = focus.ghostComparison;
    assert.equal(comparison.comparisonAttemptId, 'fast');
    assert.ok((comparison.finishTriggerDeltaMs ?? 0) > 50_000);
    assert.equal(
      comparison.finishTriggerDeltaMs,
      (focus.focus.officialTimeMs ?? 0) - (focus.summary.pbTimeMs ?? 0),
    );
    const mid = knotsNearProgress(
      comparison.knots.filter((knot) => knot.coverage === 'trustworthy'),
      400,
      20,
    );
    assert.ok(mid.some((knot) => (knot.deltaMs ?? 0) > 10_000));
    const terminal = comparison.knots.find((knot) => knot.knotKind === 'finish-trigger');
    assert.ok(terminal);
    assert.equal(terminal.deltaMs, comparison.finishTriggerDeltaMs);
    assert.equal(terminal.currentElapsedMs, focus.focus.officialTimeMs);
  });

  it('grows a negative delta for a uniformly faster run', () => {
    const course = courseFromPath();
    const slow = stretchAfterDeparture(
      coveringTrace(course.referencePath, { sessionId: 'slow', startMs: 1_000 }),
      2,
    );
    const fast = coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 800_000 });
    const traces = tracesFor(course, [
      { id: 'slow', armedAtMs: 1_000, samples: slow },
      { id: 'fast', armedAtMs: 800_000, samples: fast },
    ]);
    const focus = analyzeFocusAttempt(course, traces, 'fast');
    assert.ok(focus?.ghostComparison.available);
    assert.equal(focus.isPb, true);
    assert.equal(focus.comparisonPbAttemptId, 'slow');
    assert.ok((focus.ghostComparison.finishTriggerDeltaMs ?? 0) < -50_000);
  });

  it('stays stable across different GPS sampling frequencies of the same motion', () => {
    const course = courseFromPath();
    const oneHz = coveringTrace(course.referencePath, {
      sessionId: 'one',
      startMs: 1_000,
      stepMeters: 4,
      intervalMs: 1000,
    });
    const twoHz = coveringTrace(course.referencePath, {
      sessionId: 'two',
      startMs: 40_000,
      stepMeters: 2,
      intervalMs: 500,
    });
    const current = derived(course, 'one', oneHz);
    const reference = derived(course, 'two', twoHz);
    const comparison = compareAttemptGhost({
      course,
      current,
      currentSamples: oneHz,
      reference,
      referenceSamples: twoHz,
    });
    assert.equal(comparison.available, true);
    const comparable = comparison.knots.filter((knot) => knot.coverage === 'trustworthy' && knot.deltaMs != null);
    assert.ok(comparable.length > 10);
    for (const knot of comparable) {
      assert.ok(Math.abs(knot.deltaMs ?? 999_999) < 2_500, `delta ${knot.deltaMs} at ${knot.progressMeters}`);
    }
    assert.ok(Math.abs(comparison.finishTriggerDeltaMs ?? 999_999) < 1_500);
  });

  it('ignores a 30 s pre-start stand after official start', () => {
    const course = courseFromPath();
    const standing = commuteWithStop(course.referencePath, {
      sessionId: 'stand',
      startMs: 1_000,
      stopProgressMeters: 520,
      stopDurationMs: 1_000,
      mode: 'zero-fix',
      preStartStandMs: 30_000,
    });
    const immediate = commuteWithStop(course.referencePath, {
      sessionId: 'go',
      startMs: 80_000,
      stopProgressMeters: 520,
      stopDurationMs: 1_000,
      mode: 'zero-fix',
    });
    const current = derived(course, 'stand', standing);
    const reference = derived(course, 'go', immediate);
    assert.equal(current.eligible, true);
    assert.equal(reference.eligible, true);
    assert.ok(Math.abs((current.officialTimeMs ?? 0) - (reference.officialTimeMs ?? 0)) < 2_000);
    const comparison = compareAttemptGhost({
      course,
      current,
      currentSamples: standing,
      reference,
      referenceSamples: immediate,
    });
    assert.equal(comparison.available, true);
    assert.equal(comparison.startDeltaMs, 0);
    assert.ok(comparison.currentPolyline?.knots[0]?.elapsedMs === 0);
    assert.equal(
      comparison.currentPolyline?.knots.some((knot) => knot.elapsedMs < 0),
      false,
    );
    const comparable = comparison.knots.filter((knot) => knot.coverage === 'trustworthy' && knot.deltaMs != null);
    for (const knot of comparable) {
      assert.ok(Math.abs(knot.deltaMs ?? 999_999) < 3_000, `pre-start leaked as ${knot.deltaMs} at ${knot.progressMeters}`);
    }
  });

  it('retains a ~50 s wait difference around the wait location, not only after a later progress bin', () => {
    const course = courseFromPath();
    const longer = commuteWithStop(course.referencePath, {
      sessionId: 'long-wait',
      startMs: 1_000,
      stopProgressMeters: 400,
      stopDurationMs: 90_000,
      mode: 'dense-jitter',
      jitterMeters: 2,
    });
    const shorter = commuteWithStop(course.referencePath, {
      sessionId: 'short-wait',
      startMs: 50_000,
      stopProgressMeters: 400,
      stopDurationMs: 40_000,
      mode: 'dense-jitter',
      jitterMeters: 2,
    });
    const current = derived(course, 'long-wait', longer);
    const reference = derived(course, 'short-wait', shorter);
    assert.equal(current.eligible, true);
    assert.equal(reference.eligible, true);
    const officialDelta = (current.officialTimeMs ?? 0) - (reference.officialTimeMs ?? 0);
    assert.ok(Math.abs(officialDelta - 50_000) < 4_000, `official delta ${officialDelta}`);
    const comparison = compareAttemptGhost({
      course,
      current,
      currentSamples: longer,
      reference,
      referenceSamples: shorter,
    });
    const wait = current.waitEvents.find((event) => Math.abs((event.progressMeters ?? 0) - 400) < 25);
    assert.ok(wait?.progressMeters != null);
    const aroundWait = knotsNearProgress(comparison.knots, wait.progressMeters, 8).filter(
      (knot) => knot.coverage === 'trustworthy' && knot.deltaMs != null,
    );
    assert.ok(aroundWait.length > 0);
    const maxAroundWait = Math.max(...aroundWait.map((knot) => knot.deltaMs ?? 0));
    assert.ok(maxAroundWait > 35_000, `wait-location max delta ${maxAroundWait}`);
    const later = knotsNearProgress(comparison.knots, 430, 8).filter(
      (knot) => knot.coverage === 'trustworthy' && knot.deltaMs != null,
    );
    const firstLater = later[0]?.deltaMs ?? 0;
    assert.ok(
      maxAroundWait >= firstLater - 8_000,
      `wait delta ${maxAroundWait} should not appear only later (${firstLater})`,
    );

    const occupancy = occupancyAtProgress(comparison.currentPolyline!, wait.progressMeters);
    const waitSpan = occupancy.intervals.reduce(
      (longest, interval) => Math.max(longest, interval.endElapsedMs - interval.startElapsedMs),
      0,
    );
    assert.ok(waitSpan >= 70_000);
    const currentFirst = elapsedOnIncreasingFlanks(comparison.currentPolyline!, wait.progressMeters)[0];
    const referenceFirst = elapsedOnIncreasingFlanks(comparison.referencePolyline!, wait.progressMeters)[0];
    if (currentFirst != null && referenceFirst != null) {
      assert.ok(
        Math.abs(currentFirst - referenceFirst) < 12_000,
        'unique-first passage at the wait must not be how +50s is represented',
      );
    }
  });

  it('treats a 90 s zero-fix wait as comparable elapsed time at that progress', () => {
    const course = courseFromPath();
    const withGap = commuteWithStop(course.referencePath, {
      sessionId: 'gap',
      startMs: 1_000,
      stopProgressMeters: 400,
      stopDurationMs: 90_000,
      mode: 'zero-fix',
    });
    const moving = coveringTrace(course.referencePath, { sessionId: 'move', startMs: 40_000 });
    const current = derived(course, 'gap', withGap);
    const reference = derived(course, 'move', moving);
    const comparison = compareAttemptGhost({
      course,
      current,
      currentSamples: withGap,
      reference,
      referenceSamples: moving,
    });
    const wait = current.waitEvents.find((event) => Math.abs((event.progressMeters ?? 0) - 400) < 20);
    assert.ok(wait?.progressMeters != null);
    const occupancy = occupancyAtProgress(comparison.currentPolyline!, wait.progressMeters);
    assert.ok(occupancy.intervals.some((interval) => interval.coverage === 'trustworthy' && interval.endElapsedMs - interval.startElapsedMs >= 80_000));
    const around = knotsNearProgress(comparison.knots, wait.progressMeters, 8);
    assert.ok(around.some((knot) => knot.coverage === 'trustworthy' && (knot.deltaMs ?? 0) > 70_000));
    assert.equal(
      around.every((knot) => knot.coverage !== 'unavailable' || knot.deltaMs == null),
      true,
    );
  });

  it('does not fabricate confident delta across a genuinely unknown telemetry hole', () => {
    const course = courseFromPath();
    const path = course.referencePath;
    const length = pathDistanceMeters(path);
    const stepMeters = 4;
    const intervalMs = 1000;
    const samples: LocationSample[] = [];
    let timeMs = 40_000;
    let progress = 0;
    let id = 0;
    let gapped = false;
    while (progress <= length + 16) {
      const point = pointAtProgress(path, Math.min(progress, length));
      samples.push(
        sample({
          id: `hole-${id}`,
          sessionId: 'hole',
          recordedAtMs: timeMs,
          latitude: point.latitude,
          longitude: point.longitude,
        }),
      );
      id += 1;
      if (!gapped && progress >= 240) {
        progress += 80;
        timeMs += MAX_STATIONARY_GAP_MS + 20_000;
        gapped = true;
        continue;
      }
      progress += stepMeters;
      timeMs += intervalMs;
    }
    const baseline = coveringTrace(path, { sessionId: 'base', startMs: 1_000 });
    const current = derived(course, 'hole', samples);
    const reference = derived(course, 'base', baseline);
    assert.equal(current.eligible, true);
    const comparison = compareAttemptGhost({
      course,
      current,
      currentSamples: samples,
      reference,
      referenceSamples: baseline,
    });
    assert.equal(comparison.available, true);
    const holeProgress = 280;
    const occupancy = occupancyAtProgress(comparison.currentPolyline!, holeProgress);
    assert.equal(
      occupancy.intervals.every((interval) => interval.coverage === 'unavailable') ||
        occupancy.increasingFlankInstants.some((instant) => instant.coverage === 'unavailable') ||
        occupancy.increasingFlankInstants.length === 0,
      true,
    );
    const around = knotsNearProgress(comparison.knots, holeProgress, 30);
    assert.ok(around.length === 0 || around.every((knot) => knot.coverage === 'unavailable' || knot.deltaMs == null));
    const queried = occupancy.increasingFlankInstants.filter((instant) => instant.coverage === 'trustworthy');
    assert.equal(queried.length, 0);
  });

  it('handles progress jitter deterministically without deleting waiting time', () => {
    const course = courseFromPath();
    const samples = commuteWithStop(course.referencePath, {
      sessionId: 'jitter',
      startMs: 3_000,
      stopProgressMeters: 280,
      stopDurationMs: 20_000,
      mode: 'dense-jitter',
      jitterMeters: 2,
    });
    const attempt = derived(course, 'jitter', samples);
    const first = compareAttemptGhost({
      course,
      current: attempt,
      currentSamples: samples,
      reference: attempt,
      referenceSamples: samples,
    });
    const second = compareAttemptGhost({
      course,
      current: attempt,
      currentSamples: samples,
      reference: attempt,
      referenceSamples: samples,
    });
    assert.deepEqual(first, second);
    const wait = attempt.waitEvents[0];
    assert.ok(wait?.progressMeters != null);
    const occupancy = occupancyAtProgress(first.currentPolyline!, wait.progressMeters);
    assert.ok(occupancy.intervals.some((interval) => interval.endElapsedMs - interval.startElapsedMs >= 12_000));
  });
});

describe('ghost comparison product wiring', () => {
  it('compares a new PB against the previous PB instead of itself', () => {
    const course = courseFromPath();
    const previousPb = stretchAfterDeparture(
      coveringTrace(course.referencePath, { sessionId: 'previous-pb', startMs: 1_000 }),
      1.6,
    );
    const newPb = coveringTrace(course.referencePath, { sessionId: 'new-pb', startMs: 800_000 });
    const traces = tracesFor(course, [
      { id: 'previous-pb', armedAtMs: 1_000, samples: previousPb },
      { id: 'new-pb', armedAtMs: 800_000, samples: newPb },
    ]);
    const focus = analyzeFocusAttempt(course, traces, 'new-pb');
    assert.ok(focus);
    assert.equal(focus.isPb, true);
    assert.equal(focus.comparisonPbAttemptId, 'previous-pb');
    assert.equal(focus.ghostComparison.available, true);
    assert.equal(focus.ghostComparison.comparisonAttemptId, 'previous-pb');
    assert.notEqual(focus.ghostComparison.finishTriggerDeltaMs, 0);
    assert.equal(focus.ghostComparison.currentAttemptId, 'new-pb');
  });

  it('marks a first-ever PB without a previous target as unavailable', () => {
    const course = courseFromPath();
    const only = coveringTrace(course.referencePath, { sessionId: 'only', startMs: 5_000 });
    const traces = tracesFor(course, [{ id: 'only', armedAtMs: 5_000, samples: only }]);
    const focus = analyzeFocusAttempt(course, traces, 'only');
    assert.ok(focus);
    assert.equal(focus.isPb, true);
    assert.equal(focus.comparisonPbAttemptId, null);
    assert.equal(focus.ghostComparison.available, false);
    assert.equal(focus.ghostComparison.unavailableReason, 'missing_comparison_target');
  });

  it('uses the current PB as the reference for a non-PB attempt', () => {
    const course = courseFromPath();
    const traces = tracesFor(course, [
      {
        id: 'fast',
        armedAtMs: 1_000,
        samples: coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 1_000 }),
      },
      {
        id: 'slow',
        armedAtMs: 50_000,
        samples: stretchAfterDeparture(
          coveringTrace(course.referencePath, { sessionId: 'slow', startMs: 50_000 }),
          2,
        ),
      },
    ]);
    const focus = analyzeFocusAttempt(course, traces, 'slow');
    assert.ok(focus);
    assert.equal(focus.isPb, false);
    assert.equal(focus.comparisonPbAttemptId, 'fast');
    assert.equal(focus.ghostComparison.comparisonAttemptId, 'fast');
    assert.equal(focus.ghostComparison.available, true);
  });

  it('places an explicit finish-trigger terminal knot that equals the official time delta', () => {
    const course = courseFromPath();
    const traces = tracesFor(course, [
      {
        id: 'fast',
        armedAtMs: 1_000,
        samples: coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 1_000 }),
      },
      {
        id: 'slow',
        armedAtMs: 20_000,
        samples: commuteWithStop(course.referencePath, {
          sessionId: 'slow',
          startMs: 20_000,
          stopProgressMeters: 240,
          stopDurationMs: 20_000,
          mode: 'zero-fix',
        }),
      },
    ]);
    const comparison = ghostOf(course, 'slow', traces);
    const focus = analyzeFocusAttempt(course, traces, 'slow');
    const pb = analyzeFocusAttempt(course, traces, 'fast');
    assert.ok(focus && pb);
    const terminal = comparison.knots.find((knot) => knot.knotKind === 'finish-trigger');
    assert.ok(terminal);
    assert.ok(Math.abs((terminal.progressMeters ?? 0) - finishTriggerProgressMeters(course)) < 0.01);
    assert.equal(terminal.currentElapsedMs, focus.focus.officialTimeMs);
    assert.equal(terminal.referenceElapsedMs, pb.focus.officialTimeMs);
    assert.equal(
      terminal.deltaMs,
      (focus.focus.officialTimeMs ?? 0) - (pb.focus.officialTimeMs ?? 0),
    );
    assert.equal(comparison.finishTriggerDeltaMs, terminal.deltaMs);
  });

  it('allows painted finish-line passage to be uncovered without breaking terminal reconciliation', () => {
    const course = courseFromPath();
    const samples = coveringTrace(course.referencePath, { sessionId: 'run', startMs: 2_000 });
    const attempt = derived(course, 'run', samples);
    const comparison = compareAttemptGhost({
      course,
      current: attempt,
      currentSamples: samples,
      reference: attempt,
      referenceSamples: samples,
    });
    const engine = replayAttemptTrace(course, samples);
    const lastProgress = engine.accepted[engine.accepted.length - 1]?.progressMeters ?? 0;
    assert.ok(lastProgress < course.finishProgressMeters - 5);
    assert.equal(comparison.paintedFinishElapsedCurrentMs, null);
    assert.equal(comparison.available, true);
    assert.equal(comparison.finishTriggerDeltaMs, 0);
    assert.ok(comparison.knots.some((knot) => knot.knotKind === 'finish-trigger'));
  });

  it('does not change checkpoint first-forward-crossing split semantics', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [{ id: 'light', name: 'Light', progressMeters: 400 }],
    });
    const longer = commuteWithStop(path, {
      sessionId: 'long-wait',
      startMs: 1_000,
      stopProgressMeters: 400,
      stopDurationMs: 90_000,
      mode: 'dense-jitter',
    });
    const shorter = commuteWithStop(path, {
      sessionId: 'short-wait',
      startMs: 40_000,
      stopProgressMeters: 400,
      stopDurationMs: 40_000,
      mode: 'dense-jitter',
    });
    const traces = tracesFor(course, [
      { id: 'short-wait', armedAtMs: 40_000, samples: shorter },
      { id: 'long-wait', armedAtMs: 1_000, samples: longer },
    ]);
    const focus = analyzeFocusAttempt(course, traces, 'long-wait');
    assert.ok(focus);
    const split = focus.segments.find((segment) => segment.spec.to.kind === 'checkpoint' && segment.spec.to.id === 'light');
    assert.ok(split?.durationMs != null);
    const engine = replayAttemptTrace(course, longer);
    let crossing: number | null = null;
    for (let index = 1; index < engine.accepted.length; index += 1) {
      const previous = engine.accepted[index - 1];
      const current = engine.accepted[index];
      if (!previous || !current) {
        continue;
      }
      if (previous.progressMeters < 400 && current.progressMeters >= 400) {
        crossing = interpolateCrossingTime(previous, current, 400);
        break;
      }
    }
    assert.ok(crossing != null && engine.startedAtMs != null);
    assert.equal(split.startedAtMs, engine.startedAtMs);
    assert.equal(split.endedAtMs, crossing);
    assert.ok(Math.abs((split.deltaVsPbRunMs ?? 0)) < 8_000);
    const wait = focus.focus.waitEvents.find((event) => Math.abs((event.progressMeters ?? 0) - 400) < 25);
    assert.ok(wait?.progressMeters != null);
    const around = knotsNearProgress(focus.ghostComparison.knots, wait.progressMeters, 8);
    const maxDelta = Math.max(...around.map((knot) => knot.deltaMs ?? 0));
    assert.ok(maxDelta > 35_000);
  });

  it('rederives from retained telemetry after current-layout edits and reload', () => {
    const path = longPath();
    const original = courseFromPath(path);
    const clipped = courseFromPath(path, {
      startProgressMeters: 200,
      startZone: {
        center: pointAtProgress(path, 200),
        radiusMeters: original.startZone.radiusMeters,
      },
    });
    const traces = tracesFor(original, [
      {
        id: 'reference',
        armedAtMs: 1_000,
        samples: coveringTrace(path, { sessionId: 'reference', startMs: 1_000 }),
      },
      {
        id: 'current',
        armedAtMs: 20_000,
        samples: commuteWithStop(path, {
          sessionId: 'current',
          startMs: 20_000,
          stopProgressMeters: 80,
          stopDurationMs: 15_000,
          mode: 'zero-fix',
        }),
      },
    ]);
    const full = analyzeFocusAttempt(original, traces, 'current');
    const trimmed = analyzeFocusAttempt(clipped, traces, 'current');
    const again = analyzeFocusAttempt(original, traces, 'current');
    assert.ok(full && trimmed && again);
    assert.deepEqual(full.ghostComparison, again.ghostComparison);
    assert.notEqual(full.focus.layoutIdentity, trimmed.focus.layoutIdentity);
    assert.equal(full.ghostComparison.available, true);
  });

  it('leaves official competitive timing, PB, rank, Gold, and Sum of Best unchanged', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [{ id: 'mid', name: 'Mid', progressMeters: 300 }],
    });
    const traces = tracesFor(course, [
      {
        id: 'fast',
        armedAtMs: 1_000,
        samples: coveringTrace(path, { sessionId: 'fast', startMs: 1_000 }),
      },
      {
        id: 'slow',
        armedAtMs: 30_000,
        samples: commuteWithStop(path, {
          sessionId: 'slow',
          startMs: 30_000,
          stopProgressMeters: 300,
          stopDurationMs: 18_000,
          mode: 'zero-fix',
        }),
      },
    ]);
    const focus = analyzeFocusAttempt(course, traces, 'slow');
    assert.ok(focus);
    assert.equal(focus.isPb, false);
    assert.equal(focus.rank, 2);
    assert.equal(focus.summary.pbAttemptId, 'fast');
    assert.equal(focus.summary.rankedAttemptCount, 2);
    assert.ok(focus.sumOfBestMs != null);
    assert.equal(
      focus.sumOfBestMs,
      focus.segments.reduce((sum, segment) => sum + (segment.goldDurationMs ?? 0), 0),
    );
    assert.equal(focus.focus.officialTimeMs, focus.focus.movement?.officialTimeMs);
    assert.equal(focus.ghostComparison.finishTriggerDeltaMs, focus.deltaVsPbMs);
  });

  it('imports no Expo, native, or MapLibre code', () => {
    const source = readFileSync('src/domain/ghost-comparison.ts', 'utf8');
    assert.doesNotMatch(
      source,
      /expo-location|expo-task-manager|expo-sqlite|react-native|@maplibre\/maplibre-react-native|maplibre/,
    );
  });
});
