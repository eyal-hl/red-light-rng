import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attempt } from '../src/domain/attempt';
import {
  analyzeFocusAttempt,
  analyzeRouteAttempts,
  courseLayoutIdentity,
  deriveCurrentLayoutAttempt,
  hasStartCoverage,
  segmentSpecsForCourse,
  startCoverageThresholdMeters,
  timingCourseFromRoute,
  type AttemptTrace,
} from '../src/domain/attempt-analysis';
import {
  finishTriggerProgressMeters,
  replayAttemptTrace,
  START_PROGRESS_NOISE_METERS,
  type TimingCourse,
} from '../src/domain/attempt-timing';
import { pathDistanceMeters } from '../src/domain/geo';
import type { LocationSample } from '../src/domain/location-sample';
import { makeRoute, northPath } from './helpers/routes';
import { traceAlongPath } from './helpers/samples';

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
  const stepMeters = options.stepMeters ?? 5;
  const count = Math.ceil((length - startProgress) / stepMeters) + 12;
  return traceAlongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    intervalMs: options.intervalMs ?? 1000,
    startProgressMeters: startProgress,
    stepMeters,
    count,
  });
}

function makeAttempt(overrides: Partial<Attempt> & Pick<Attempt, 'id' | 'sessionId'>): Attempt {
  return {
    routeId: 'route-1',
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_700_000_000_000,
    startedAtMs: 1_700_000_001_000,
    finishedAtMs: 1_700_000_200_000,
    resultAcknowledged: true,
    crossings: [],
    ...overrides,
  };
}

function traceFor(
  course: TimingCourse,
  attempt: Attempt,
  samples: LocationSample[],
): AttemptTrace {
  return { attempt, samples };
}

function segmentByEnd(analysis: NonNullable<ReturnType<typeof analyzeFocusAttempt>>, endId: string) {
  return analysis.segments.find((segment) =>
    segment.spec.to.kind === 'checkpoint' ? segment.spec.to.id === endId : segment.spec.to.kind === endId,
  );
}

describe('attempt analysis', () => {
  it('treats the first valid attempt as PB without fake deltas', () => {
    const course = courseFromPath();
    const attempt = makeAttempt({ id: 'a1', sessionId: 's1', armedAtMs: 1_000 });
    const traces = [traceFor(course, attempt, coveringTrace(course.referencePath, { sessionId: 's1', startMs: 5_000 }))];
    const focus = analyzeFocusAttempt(course, traces, 'a1');
    const summary = analyzeRouteAttempts(course, traces).summary;

    assert.ok(focus);
    assert.equal(focus.focus.eligible, true);
    assert.ok((focus.focus.officialTimeMs ?? 0) > 0);
    assert.equal(focus.isPb, true);
    assert.equal(focus.rank, 1);
    assert.equal(focus.deltaVsPbMs, null);
    assert.equal(focus.deltaVsPreviousMs, null);
    assert.equal(focus.previousAttemptId, null);
    assert.equal(summary.rankedAttemptCount, 1);
    assert.equal(summary.pbAttemptId, 'a1');
    assert.equal(summary.lastAttemptId, 'a1');
    assert.equal(summary.sumOfBestMs, focus.focus.officialTimeMs);
    assert.equal(focus.segments.length, 1);
    assert.equal(focus.segments[0]?.isNewGold, true);
    assert.equal(focus.segments[0]?.deltaVsPbRunMs, null);
    assert.equal(focus.segments[0]?.pbRunDurationMs, null);
  });

  it('replaces PB when a later attempt is faster and keeps previous deltas', () => {
    const course = courseFromPath();
    const slow = makeAttempt({ id: 'slow', sessionId: 'slow', armedAtMs: 1_000, finishedAtMs: 10_000 });
    const fast = makeAttempt({ id: 'fast', sessionId: 'fast', armedAtMs: 2_000, finishedAtMs: 20_000 });
    const traces = [
      traceFor(course, slow, coveringTrace(course.referencePath, { sessionId: 'slow', startMs: 1_000, stepMeters: 4 })),
      traceFor(course, fast, coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 500_000, stepMeters: 7 })),
    ];
    const analysis = analyzeRouteAttempts(course, traces);
    const slowFocus = analyzeFocusAttempt(course, traces, 'slow');
    const fastFocus = analyzeFocusAttempt(course, traces, 'fast');

    assert.equal(analysis.summary.pbAttemptId, 'fast');
    assert.ok((fastFocus?.focus.officialTimeMs ?? 0) < (slowFocus?.focus.officialTimeMs ?? 0));
    assert.equal(fastFocus?.isPb, true);
    assert.equal(fastFocus?.deltaVsPreviousMs != null && fastFocus.deltaVsPreviousMs < 0, true);
    assert.equal(fastFocus?.deltaVsPbMs != null && fastFocus.deltaVsPbMs < 0, true);
    assert.equal(slowFocus?.isPb, false);
    assert.equal(slowFocus?.rank, 2);
    assert.equal(fastFocus?.rank, 1);
    assert.equal(slowFocus?.deltaVsPbMs != null && slowFocus.deltaVsPbMs > 0, true);
    assert.equal(fastFocus?.segments[0]?.deltaVsPbRunMs, fastFocus?.deltaVsPbMs);
    assert.equal(slowFocus?.segments[0]?.deltaVsPbRunMs, slowFocus?.deltaVsPbMs);
  });

  it('ranks a slower second attempt behind the PB and reports previous-attempt delta', () => {
    const course = courseFromPath();
    const first = makeAttempt({ id: 'first', sessionId: 'first', armedAtMs: 1_000, finishedAtMs: 10_000 });
    const second = makeAttempt({ id: 'second', sessionId: 'second', armedAtMs: 2_000, finishedAtMs: 20_000 });
    const traces = [
      traceFor(course, first, coveringTrace(course.referencePath, { sessionId: 'first', startMs: 1_000, stepMeters: 7 })),
      traceFor(course, second, coveringTrace(course.referencePath, { sessionId: 'second', startMs: 500_000, stepMeters: 4 })),
    ];
    const secondFocus = analyzeFocusAttempt(course, traces, 'second');
    assert.equal(secondFocus?.rank, 2);
    assert.equal(secondFocus?.previousAttemptId, 'first');
    assert.equal(secondFocus?.deltaVsPreviousMs != null && secondFocus.deltaVsPreviousMs > 0, true);
    assert.equal(secondFocus?.isPb, false);
  });

  it('breaks official-time ties by earlier start, then earlier arming', () => {
    const course = courseFromPath();
    const samples = coveringTrace(course.referencePath, { sessionId: 'shared', startMs: 5_000, intervalMs: 1000 });
    const later = makeAttempt({
      id: 'later',
      sessionId: 'later',
      armedAtMs: 9_000,
      startedAtMs: 9_500,
      finishedAtMs: 80_000,
    });
    const earlier = makeAttempt({
      id: 'earlier',
      sessionId: 'earlier',
      armedAtMs: 1_000,
      startedAtMs: 1_500,
      finishedAtMs: 70_000,
    });
    const traces = [
      { attempt: later, samples: samples.map((sample) => ({ ...sample, sessionId: 'later' })) },
      { attempt: earlier, samples: samples.map((sample) => ({ ...sample, sessionId: 'earlier' })) },
    ];
    const analysis = analyzeRouteAttempts(course, traces);
    assert.equal(analysis.ranked[0]?.attemptId, 'earlier');
    assert.equal(analysis.ranked[1]?.attemptId, 'later');
    assert.equal(analysis.ranked[0]?.officialTimeMs, analysis.ranked[1]?.officialTimeMs);
    assert.equal(analyzeFocusAttempt(course, traces, 'earlier')?.rank, 1);
    assert.equal(analyzeFocusAttempt(course, traces, 'later')?.rank, 2);
  });

  it('uses a single Start → Finish segment when the course has no checkpoints', () => {
    const course = courseFromPath();
    const specs = segmentSpecsForCourse(course);
    assert.equal(specs.length, 1);
    assert.equal(specs[0]?.from.kind, 'start');
    assert.equal(specs[0]?.to.kind, 'finish');
  });

  it('derives multi-checkpoint segment durations by checkpoint id', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [
        { id: 'cp-corner', name: 'Corner', progressMeters: 200 },
        { id: 'cp-park', name: 'Park', progressMeters: 500 },
      ],
    });
    const attempt = makeAttempt({ id: 'a1', sessionId: 's1' });
    const focus = analyzeFocusAttempt(course, [traceFor(course, attempt, coveringTrace(path, { sessionId: 's1', startMs: 1_000 }))], 'a1');
    assert.ok(focus);
    assert.equal(focus.segments.length, 3);
    assert.equal(focus.segments[0]?.spec.to.kind === 'checkpoint' && focus.segments[0].spec.to.id, 'cp-corner');
    assert.equal(focus.segments[1]?.spec.to.kind === 'checkpoint' && focus.segments[1].spec.to.id, 'cp-park');
    assert.equal(focus.segments[2]?.spec.to.kind, 'finish');
    for (const segment of focus.segments) {
      assert.ok(segment.durationMs != null && segment.durationMs > 0);
    }
    const corner = segmentByEnd(focus, 'cp-corner');
    const park = segmentByEnd(focus, 'cp-park');
    assert.ok((corner?.endedAtMs ?? 0) < (park?.endedAtMs ?? 0));
    assert.ok((park?.endedAtMs ?? 0) < (focus.focus.finishedAtMs ?? 0));
  });

  it('compares segments against the PB run and detects Golds, including multiple Golds in one run', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [
        { id: 'cp-a', name: 'A', progressMeters: 200 },
        { id: 'cp-b', name: 'B', progressMeters: 500 },
      ],
    });
    const pb = makeAttempt({ id: 'pb', sessionId: 'pb', armedAtMs: 1_000, finishedAtMs: 10_000 });
    const goldRun = makeAttempt({ id: 'gold-run', sessionId: 'gold-run', armedAtMs: 2_000, finishedAtMs: 20_000 });
    const traces = [
      traceFor(course, pb, coveringTrace(path, { sessionId: 'pb', startMs: 1_000, stepMeters: 7 })),
      traceFor(course, goldRun, coveringTrace(path, { sessionId: 'gold-run', startMs: 80_000, stepMeters: 4 })),
    ];
    const pbFocus = analyzeFocusAttempt(course, traces, 'pb');
    const slowerFocus = analyzeFocusAttempt(course, traces, 'gold-run');
    assert.equal(pbFocus?.isPb, true);
    assert.ok(pbFocus?.segments.some((segment) => segment.isNewGold));
    const goldCount = pbFocus?.segments.filter((segment) => segment.isNewGold).length ?? 0;
    assert.ok(goldCount >= 2);
    assert.equal(slowerFocus?.isPb, false);
    assert.equal(slowerFocus?.segments.some((segment) => segment.deltaVsPbRunMs != null && segment.deltaVsPbRunMs > 0), true);
    assert.equal(slowerFocus?.segments.every((segment) => segment.isNewGold === false), true);
  });

  it('compares a new PB segments against the previous PB run instead of itself', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [{ id: 'cp-mid', name: 'Mid', progressMeters: 400 }],
    });
    const previousPb = makeAttempt({
      id: 'previous-pb',
      sessionId: 'previous-pb',
      armedAtMs: 1_000,
      finishedAtMs: 10_000,
    });
    const newPb = makeAttempt({
      id: 'new-pb',
      sessionId: 'new-pb',
      armedAtMs: 2_000,
      finishedAtMs: 20_000,
    });
    const traces = [
      traceFor(course, previousPb, [
        ...traceAlongPath(path, {
          sessionId: 'previous-pb',
          startMs: 1_000,
          startProgressMeters: 0,
          stepMeters: 4,
          intervalMs: 1000,
          count: 110,
        }),
        ...traceAlongPath(path, {
          sessionId: 'previous-pb',
          startMs: 1_000 + 110_000,
          startProgressMeters: 440,
          stepMeters: 10,
          intervalMs: 1000,
          count: 50,
        }),
      ]),
      traceFor(course, newPb, [
        ...traceAlongPath(path, {
          sessionId: 'new-pb',
          startMs: 200_000,
          startProgressMeters: 0,
          stepMeters: 10,
          intervalMs: 1000,
          count: 50,
        }),
        ...traceAlongPath(path, {
          sessionId: 'new-pb',
          startMs: 200_000 + 50_000,
          startProgressMeters: 440,
          stepMeters: 5,
          intervalMs: 1000,
          count: 90,
        }),
      ]),
    ];
    const previousFocus = analyzeFocusAttempt(course, traces, 'previous-pb');
    const newFocus = analyzeFocusAttempt(course, traces, 'new-pb');
    assert.ok(previousFocus && newFocus);
    assert.equal(newFocus.isPb, true);
    assert.equal(previousFocus.isPb, false);
    assert.ok((newFocus.focus.officialTimeMs ?? 0) < (previousFocus.focus.officialTimeMs ?? 0));
    assert.equal(newFocus.deltaVsPbMs != null && newFocus.deltaVsPbMs < 0, true);

    const previousFirst = previousFocus.segments[0]?.durationMs;
    const previousLast = previousFocus.segments[1]?.durationMs;
    const newFirst = newFocus.segments[0]?.durationMs;
    const newLast = newFocus.segments[1]?.durationMs;
    assert.ok(previousFirst != null && previousLast != null && newFirst != null && newLast != null);
    assert.ok(newFirst < previousFirst);
    assert.ok(newLast > previousLast);

    assert.equal(newFocus.segments[0]?.pbRunDurationMs, previousFirst);
    assert.equal(newFocus.segments[1]?.pbRunDurationMs, previousLast);
    assert.equal(newFocus.segments[0]?.deltaVsPbRunMs, newFirst - previousFirst);
    assert.equal(newFocus.segments[1]?.deltaVsPbRunMs, newLast - previousLast);
    assert.equal(newFocus.segments[0]?.deltaVsPbRunMs != null && newFocus.segments[0].deltaVsPbRunMs < 0, true);
    assert.equal(newFocus.segments[1]?.deltaVsPbRunMs != null && newFocus.segments[1].deltaVsPbRunMs > 0, true);
    assert.notEqual(newFocus.segments[0]?.deltaVsPbRunMs, 0);
    assert.notEqual(newFocus.segments[1]?.deltaVsPbRunMs, 0);
  });

  it('assembles Sum of Best from independently fastest historical segments', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [{ id: 'cp-mid', name: 'Mid', progressMeters: 400 }],
    });
    const earlyFast = makeAttempt({ id: 'early-fast', sessionId: 'early-fast', armedAtMs: 1_000, finishedAtMs: 10_000 });
    const lateFast = makeAttempt({ id: 'late-fast', sessionId: 'late-fast', armedAtMs: 2_000, finishedAtMs: 20_000 });
    const mixed = [
      traceFor(course, earlyFast, [
        ...traceAlongPath(path, {
          sessionId: 'early-fast',
          startMs: 1_000,
          startProgressMeters: 0,
          stepMeters: 8,
          intervalMs: 1000,
          count: 55,
        }),
        ...traceAlongPath(path, {
          sessionId: 'early-fast',
          startMs: 1_000 + 55_000,
          startProgressMeters: 440,
          stepMeters: 4,
          intervalMs: 1000,
          count: 110,
        }),
      ]),
      traceFor(course, lateFast, [
        ...traceAlongPath(path, {
          sessionId: 'late-fast',
          startMs: 200_000,
          startProgressMeters: 0,
          stepMeters: 4,
          intervalMs: 1000,
          count: 110,
        }),
        ...traceAlongPath(path, {
          sessionId: 'late-fast',
          startMs: 200_000 + 110_000,
          startProgressMeters: 440,
          stepMeters: 8,
          intervalMs: 1000,
          count: 55,
        }),
      ]),
    ];
    const analysis = analyzeRouteAttempts(course, mixed);
    const early = analyzeFocusAttempt(course, mixed, 'early-fast');
    const late = analyzeFocusAttempt(course, mixed, 'late-fast');
    assert.ok(early && late);
    const earlyFirst = early.segments[0]?.durationMs ?? Number.MAX_SAFE_INTEGER;
    const lateFirst = late.segments[0]?.durationMs ?? Number.MAX_SAFE_INTEGER;
    const earlyLast = early.segments[1]?.durationMs ?? Number.MAX_SAFE_INTEGER;
    const lateLast = late.segments[1]?.durationMs ?? Number.MAX_SAFE_INTEGER;
    assert.ok(earlyFirst < lateFirst);
    assert.ok(lateLast < earlyLast);
    assert.equal(analysis.summary.sumOfBestMs, earlyFirst + lateLast);
    assert.ok((analysis.summary.sumOfBestMs ?? 0) < (analysis.summary.pbTimeMs ?? 0));
  });

  it('excludes cancelled, abandoned, and invalid attempts from competitive stats', () => {
    const course = courseFromPath();
    const official = makeAttempt({ id: 'official', sessionId: 'official', armedAtMs: 1_000 });
    const cancelled = makeAttempt({
      id: 'cancelled',
      sessionId: 'cancelled',
      lifecycle: 'cancelled',
      validity: 'unranked',
      armedAtMs: 2_000,
    });
    const abandoned = makeAttempt({
      id: 'abandoned',
      sessionId: 'abandoned',
      lifecycle: 'abandoned',
      validity: 'unranked',
      armedAtMs: 3_000,
    });
    const invalid = makeAttempt({
      id: 'invalid',
      sessionId: 'invalid',
      validity: 'unranked',
      armedAtMs: 4_000,
    });
    const traces = [
      traceFor(course, official, coveringTrace(course.referencePath, { sessionId: 'official', startMs: 1_000 })),
      traceFor(course, cancelled, coveringTrace(course.referencePath, { sessionId: 'cancelled', startMs: 50_000 })),
      traceFor(course, abandoned, coveringTrace(course.referencePath, { sessionId: 'abandoned', startMs: 90_000 })),
      traceFor(
        course,
        invalid,
        coveringTrace(course.referencePath, { sessionId: 'invalid', startMs: 130_000 }).map((sample) => ({
          ...sample,
          longitude: sample.longitude + 0.01,
        })),
      ),
    ];
    const analysis = analyzeRouteAttempts(course, traces);
    assert.equal(analysis.summary.rankedAttemptCount, 1);
    assert.equal(analysis.summary.pbAttemptId, 'official');
    assert.equal(analysis.rankedHistory.map((row) => row.attemptId).join(','), 'official');
    assert.equal(analysis.chronologicalHistory.some((row) => row.attemptId === 'cancelled'), false);
    assert.equal(analysis.chronologicalHistory.some((row) => row.attemptId === 'abandoned'), false);
  });

  it('orders chronological history newest-first and ranked history by official time', () => {
    const course = courseFromPath();
    const first = makeAttempt({ id: 'first', sessionId: 'first', armedAtMs: 1_000, finishedAtMs: 10_000 });
    const second = makeAttempt({ id: 'second', sessionId: 'second', armedAtMs: 2_000, finishedAtMs: 20_000 });
    const traces = [
      traceFor(course, first, coveringTrace(course.referencePath, { sessionId: 'first', startMs: 1_000, stepMeters: 4 })),
      traceFor(course, second, coveringTrace(course.referencePath, { sessionId: 'second', startMs: 500_000, stepMeters: 7 })),
    ];
    const analysis = analyzeRouteAttempts(course, traces);
    assert.deepEqual(analysis.chronologicalHistory.map((row) => row.attemptId), ['second', 'first']);
    assert.deepEqual(analysis.rankedHistory.map((row) => row.attemptId), ['second', 'first']);
    assert.equal(analysis.rankedHistory[0]?.rank, 1);
    assert.equal(analysis.rankedHistory[0]?.isPb, true);
  });

  it('reconstructs current-layout results from raw telemetry instead of persisted attempt times', () => {
    const course = courseFromPath();
    const attempt = makeAttempt({
      id: 'stale',
      sessionId: 'stale',
      startedAtMs: 1,
      finishedAtMs: 2,
      crossings: [
        {
          id: 'bogus',
          attemptId: 'stale',
          checkpointId: 'missing',
          checkpointName: 'Ghost',
          checkpointProgressMeters: 10,
          crossedAtMs: 2,
        },
      ],
    });
    const samples = coveringTrace(course.referencePath, { sessionId: 'stale', startMs: 5_000 });
    const derived = deriveCurrentLayoutAttempt(course, attempt, samples);
    assert.equal(derived.eligible, true);
    assert.notEqual(derived.officialTimeMs, 1);
    assert.ok((derived.officialTimeMs ?? 0) > 1_000);
    assert.equal(derived.segments[0]?.spec.to.kind, 'finish');
  });

  it('does not shift later splits onto an earlier segment when an interior crossing is missing', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [
        { id: 'cp-corner', name: 'Corner', progressMeters: pathDistanceMeters(path) - 25 },
        { id: 'cp-park', name: 'Park', progressMeters: 400 },
      ],
    });
    const finishTrigger = finishTriggerProgressMeters(course);
    const lateCheckpoint = course.checkpoints.find((checkpoint) => checkpoint.id === 'cp-corner');
    assert.ok(lateCheckpoint);
    assert.ok(lateCheckpoint.progressMeters > finishTrigger);
    assert.ok(lateCheckpoint.progressMeters < course.finishProgressMeters);

    const attempt = makeAttempt({ id: 'partial', sessionId: 'partial' });
    const focus = analyzeFocusAttempt(
      course,
      [traceFor(course, attempt, coveringTrace(path, { sessionId: 'partial', startMs: 1_000 }))],
      'partial',
    );
    assert.ok(focus);
    assert.equal(focus.focus.eligible, true);
    const corner = segmentByEnd(focus, 'cp-corner');
    const park = segmentByEnd(focus, 'cp-park');
    const finish = segmentByEnd(focus, 'finish');
    assert.equal(park?.durationMs != null, true);
    assert.equal(corner?.durationMs, null);
    assert.equal(finish?.durationMs, null);
    assert.equal(focus.sumOfBestMs, null);
    assert.equal(corner?.isNewGold, false);
  });

  it('keeps Sum of Best unavailable when any current-layout segment lacks eligible data', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [{ id: 'cp-late', name: 'Late', progressMeters: pathDistanceMeters(path) - 20 }],
    });
    const attempt = makeAttempt({ id: 'a1', sessionId: 's1' });
    const analysis = analyzeRouteAttempts(course, [
      traceFor(course, attempt, coveringTrace(path, { sessionId: 's1', startMs: 1_000 })),
    ]);
    assert.equal(analysis.summary.rankedAttemptCount, 1);
    assert.equal(analysis.summary.sumOfBestMs, null);
    assert.ok(analysis.summary.pbTimeMs != null);
  });

  it('excludes a completed/valid attempt whose telemetry begins after a default start', () => {
    const course = courseFromPath();
    assert.equal(startCoverageThresholdMeters(course.startProgressMeters), START_PROGRESS_NOISE_METERS);
    const samples = coveringTrace(course.referencePath, {
      sessionId: 'late',
      startMs: 1_000,
      startProgressMeters: 25,
    });
    const engine = replayAttemptTrace(course, samples);
    assert.equal(engine.lifecycle, 'completed');
    assert.equal(engine.validity, 'valid');
    assert.equal(hasStartCoverage(engine.accepted, course.startProgressMeters), false);

    const attempt = makeAttempt({ id: 'late', sessionId: 'late' });
    const derived = deriveCurrentLayoutAttempt(course, attempt, samples);
    assert.equal(derived.eligible, false);
    assert.equal(derived.unavailabilityReason, 'missing_start_coverage');
    assert.equal(derived.officialTimeMs, null);
    const analysis = analyzeRouteAttempts(course, [traceFor(course, attempt, samples)]);
    assert.equal(analysis.summary.rankedAttemptCount, 0);
    assert.equal(analysis.summary.pbAttemptId, null);
    assert.equal(analysis.summary.sumOfBestMs, null);
    assert.equal(analysis.chronologicalHistory[0]?.eligible, false);
    assert.equal(analysis.rankedHistory.length, 0);
  });

  it('does not fabricate a competitive start from the first downstream sample', () => {
    const course = courseFromPath();
    const covered = coveringTrace(course.referencePath, { sessionId: 'covered', startMs: 1_000 });
    const late = coveringTrace(course.referencePath, {
      sessionId: 'late',
      startMs: 1_000,
      startProgressMeters: 40,
    });
    const coveredAttempt = makeAttempt({ id: 'covered', sessionId: 'covered', armedAtMs: 1_000 });
    const lateAttempt = makeAttempt({ id: 'late', sessionId: 'late', armedAtMs: 2_000 });
    const analysis = analyzeRouteAttempts(course, [
      traceFor(course, coveredAttempt, covered),
      traceFor(course, lateAttempt, late),
    ]);
    assert.equal(analysis.summary.pbAttemptId, 'covered');
    assert.equal(analysis.competitive.length, 1);
    const lateDerived = analysis.derived.find((item) => item.attemptId === 'late');
    assert.equal(lateDerived?.startedAtMs, null);
    assert.equal(lateDerived?.officialTimeMs, null);
  });

  it('replays historical attempts after a start/finish move and excludes unreplayable traces', () => {
    const path = longPath();
    const originalStart = courseFromPath(path, { startProgressMeters: 40 });
    const covered = makeAttempt({ id: 'covered', sessionId: 'covered', armedAtMs: 1_000 });
    const late = makeAttempt({ id: 'late', sessionId: 'late', armedAtMs: 2_000 });
    const coveredSamples = coveringTrace(path, { sessionId: 'covered', startMs: 1_000 });
    const lateSamples = coveringTrace(path, {
      sessionId: 'late',
      startMs: 80_000,
      startProgressMeters: 20,
    });
    const startTraces = [
      traceFor(originalStart, covered, coveredSamples),
      traceFor(originalStart, late, lateSamples),
    ];
    const originalAnalysis = analyzeRouteAttempts(originalStart, startTraces);
    assert.equal(originalAnalysis.summary.rankedAttemptCount, 2);

    const movedStart = courseFromPath(path, { startProgressMeters: 0 });
    const afterStartMove = analyzeRouteAttempts(movedStart, startTraces);
    assert.equal(afterStartMove.summary.rankedAttemptCount, 1);
    assert.equal(afterStartMove.summary.pbAttemptId, 'covered');
    assert.equal(afterStartMove.derived.find((item) => item.attemptId === 'late')?.eligible, false);
    assert.equal(
      afterStartMove.derived.find((item) => item.attemptId === 'late')?.unavailabilityReason,
      'missing_start_coverage',
    );
    assert.notEqual(afterStartMove.layoutIdentity, originalAnalysis.layoutIdentity);

    const shortFinish = courseFromPath(path, { finishProgressMeters: 450 });
    const truncated = traceAlongPath(path, {
      sessionId: 'late',
      startMs: 80_000,
      startProgressMeters: 0,
      stepMeters: 4,
      count: 130,
    });
    const finishTraces = [
      traceFor(shortFinish, covered, coveredSamples),
      traceFor(shortFinish, late, truncated),
    ];
    const atShortFinish = analyzeRouteAttempts(shortFinish, finishTraces);
    assert.equal(atShortFinish.summary.rankedAttemptCount, 2);

    const longFinish = courseFromPath(path);
    const afterFinishMove = analyzeRouteAttempts(longFinish, finishTraces);
    assert.equal(afterFinishMove.summary.pbAttemptId, 'covered');
    assert.equal(afterFinishMove.summary.rankedAttemptCount, 1);
    assert.equal(afterFinishMove.derived.find((item) => item.attemptId === 'late')?.eligible, false);
    assert.ok((atShortFinish.summary.pbTimeMs ?? 0) < (afterFinishMove.summary.pbTimeMs ?? Number.MAX_SAFE_INTEGER));
  });

  it('re-derives totals, Golds, and Sum of Best after an auto-finish radius-only edit', () => {
    const path = longPath();
    const defaultCourse = courseFromPath(path, {
      checkpoints: [
        { id: 'cp-a', name: 'A', progressMeters: 200 },
        { id: 'cp-b', name: 'B', progressMeters: 500 },
      ],
    });
    const wideFinish = {
      ...defaultCourse,
      finishZone: { ...defaultCourse.finishZone, radiusMeters: 100 },
    };
    const attempt = makeAttempt({ id: 'a1', sessionId: 's1' });
    const samples = coveringTrace(path, { sessionId: 's1', startMs: 1_000 });
    const defaultAnalysis = analyzeRouteAttempts(defaultCourse, [traceFor(defaultCourse, attempt, samples)]);
    const wideAnalysis = analyzeRouteAttempts(wideFinish, [traceFor(wideFinish, attempt, samples)]);

    assert.notEqual(courseLayoutIdentity(defaultCourse), courseLayoutIdentity(wideFinish));
    assert.ok((wideAnalysis.summary.pbTimeMs ?? 0) < (defaultAnalysis.summary.pbTimeMs ?? 0));
    const defaultLast = defaultAnalysis.derived[0]?.segments.at(-1)?.durationMs ?? 0;
    const wideLast = wideAnalysis.derived[0]?.segments.at(-1)?.durationMs ?? 0;
    assert.ok(wideLast < defaultLast);
    assert.ok((wideAnalysis.summary.sumOfBestMs ?? 0) < (defaultAnalysis.summary.sumOfBestMs ?? 0));

    const unreplayable = makeAttempt({ id: 'cut-short', sessionId: 'cut-short', armedAtMs: 2_000 });
    const truncated = traceAlongPath(path, {
      sessionId: 'cut-short',
      startMs: 80_000,
      startProgressMeters: 0,
      stepMeters: 4,
      count: 185,
    });
    const mixedWide = analyzeRouteAttempts(wideFinish, [
      traceFor(wideFinish, attempt, samples),
      traceFor(wideFinish, unreplayable, truncated),
    ]);
    const mixedDefault = analyzeRouteAttempts(defaultCourse, [
      traceFor(defaultCourse, attempt, samples),
      traceFor(defaultCourse, unreplayable, truncated),
    ]);
    assert.equal(mixedWide.derived.find((item) => item.attemptId === 'cut-short')?.eligible, true);
    assert.equal(mixedDefault.derived.find((item) => item.attemptId === 'cut-short')?.eligible, false);
    assert.equal(mixedWide.summary.rankedAttemptCount, 2);
    assert.equal(mixedDefault.summary.rankedAttemptCount, 1);
    assert.equal(mixedWide.summary.pbAttemptId, 'a1');
  });

  it('ignores stale pre-edit crossings after a checkpoint move and keeps unreplayable attempts out of Golds', () => {
    const path = longPath();
    const original = courseFromPath(path, {
      checkpoints: [{ id: 'cp-mid', name: 'Mid', progressMeters: 200 }],
    });
    const moved = courseFromPath(path, {
      checkpoints: [{ id: 'cp-mid', name: 'Mid', progressMeters: 600 }],
    });
    const replayable = makeAttempt({
      id: 'replayable',
      sessionId: 'replayable',
      armedAtMs: 1_000,
      crossings: [
        {
          id: 'old',
          attemptId: 'replayable',
          checkpointId: 'cp-mid',
          checkpointName: 'Mid',
          checkpointProgressMeters: 200,
          crossedAtMs: 1_500,
        },
      ],
    });
    const missing = makeAttempt({
      id: 'missing',
      sessionId: 'missing',
      armedAtMs: 2_000,
      crossings: [
        {
          id: 'stale',
          attemptId: 'missing',
          checkpointId: 'cp-mid',
          checkpointName: 'Mid',
          checkpointProgressMeters: 200,
          crossedAtMs: 1_200,
        },
      ],
    });
    const traces: AttemptTrace[] = [
      traceFor(moved, replayable, coveringTrace(path, { sessionId: 'replayable', startMs: 1_000 })),
      traceFor(moved, missing, []),
    ];
    const analysis = analyzeRouteAttempts(moved, traces);
    assert.equal(analysis.summary.rankedAttemptCount, 1);
    assert.equal(analysis.summary.pbAttemptId, 'replayable');
    const focus = analyzeFocusAttempt(moved, traces, 'replayable');
    const mid = segmentByEnd(focus!, 'cp-mid');
    assert.ok((mid?.durationMs ?? 0) > 0);
    assert.notEqual(mid?.durationMs, 1_500 - 1_000);
    assert.equal(analysis.derived.find((item) => item.attemptId === 'missing')?.unavailabilityReason, 'missing_telemetry');
    assert.equal(analysis.derived.find((item) => item.attemptId === 'missing')?.segments.every((segment) => segment.durationMs == null), true);
    assert.notEqual(courseLayoutIdentity(original), courseLayoutIdentity(moved));
  });

  it('includes start and finish radiuses in layout provenance', () => {
    const course = courseFromPath();
    const widerStart = {
      ...course,
      startZone: { ...course.startZone, radiusMeters: 80 },
    };
    const widerFinish = {
      ...course,
      finishZone: { ...course.finishZone, radiusMeters: 90 },
    };
    assert.notEqual(courseLayoutIdentity(course), courseLayoutIdentity(widerStart));
    assert.notEqual(courseLayoutIdentity(course), courseLayoutIdentity(widerFinish));
    assert.match(courseLayoutIdentity(widerFinish), /finishR=90\.000/);
    assert.match(courseLayoutIdentity(widerFinish), /finishTrigger=/);
  });
});
