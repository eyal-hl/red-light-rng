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
import type { TimingCourse } from '../src/domain/attempt-timing';
import type { LocationSample } from '../src/domain/location-sample';
import { pathDistanceMeters } from '../src/domain/geo';
import {
  analyzeAttemptMovement,
  analyzeAttemptMovementTimeline,
  MAX_STATIONARY_GAP_MS,
  MIN_DISPLAYABLE_COVERAGE_RATIO,
  MOVEMENT_ANALYSIS_VERSION,
  movementTotalsReconcile,
} from '../src/domain/movement-analysis';
import { pointAtProgress } from '../src/domain/path-projection';
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

function alongPath(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    startProgressMeters?: number;
    stepMeters?: number;
    intervalMs?: number;
    count: number;
    speedMetersPerSecond?: number | null;
    horizontalAccuracyMeters?: number | null;
  },
): LocationSample[] {
  return traceAlongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    startProgressMeters: options.startProgressMeters ?? 0,
    stepMeters: options.stepMeters ?? 4,
    intervalMs: options.intervalMs ?? 1000,
    count: options.count,
  }).map((item, index) =>
    sample({
      ...item,
      id: `${options.sessionId}-${index}`,
      speedMetersPerSecond:
        options.speedMetersPerSecond === undefined ? item.speedMetersPerSecond : options.speedMetersPerSecond,
      horizontalAccuracyMeters:
        options.horizontalAccuracyMeters === undefined
          ? item.horizontalAccuracyMeters
          : options.horizontalAccuracyMeters,
    }),
  );
}

function stationaryAt(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    progressMeters: number;
    count: number;
    intervalMs?: number;
    speedMetersPerSecond?: number | null;
    horizontalAccuracyMeters?: number | null;
    jitterMeters?: number[];
  },
): LocationSample[] {
  const point = pointAtProgress(path, options.progressMeters);
  const intervalMs = options.intervalMs ?? 1000;
  const jitter = options.jitterMeters ?? [];
  const samples: LocationSample[] = [];
  for (let index = 0; index < options.count; index += 1) {
    const north = jitter[index % Math.max(1, jitter.length)] ?? 0;
    const east = jitter.length === 0 ? 0 : jitter[(index * 3) % jitter.length] ?? 0;
    const coord = offsetLatLng(point.latitude, point.longitude, north, east);
    samples.push(
      sample({
        id: `${options.sessionId}-stat-${index}`,
        sessionId: options.sessionId,
        recordedAtMs: options.startMs + index * intervalMs,
        latitude: coord.latitude,
        longitude: coord.longitude,
        speedMetersPerSecond: options.speedMetersPerSecond === undefined ? 0.15 : options.speedMetersPerSecond,
        horizontalAccuracyMeters: options.horizontalAccuracyMeters === undefined ? 6 : options.horizontalAccuracyMeters,
      }),
    );
  }
  return samples;
}

function windowOf(samples: LocationSample[]): { startedAtMs: number; finishedAtMs: number } {
  const first = samples[0];
  const last = samples[samples.length - 1];
  assert.ok(first && last);
  return { startedAtMs: first.recordedAtMs, finishedAtMs: last.recordedAtMs };
}

function analyze(course: TimingCourse, samples: LocationSample[], startedAtMs?: number, finishedAtMs?: number) {
  const bounds = windowOf(samples);
  return analyzeAttemptMovement({
    course,
    samples,
    startedAtMs: startedAtMs ?? bounds.startedAtMs,
    finishedAtMs: finishedAtMs ?? bounds.finishedAtMs,
  });
}

function coveringTrace(
  path: { latitude: number; longitude: number }[],
  options: { sessionId: string; startMs: number; startProgressMeters?: number; stepMeters?: number; intervalMs?: number },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const startProgress = options.startProgressMeters ?? 0;
  const stepMeters = options.stepMeters ?? 5;
  const count = Math.ceil((length - startProgress) / stepMeters) + 12;
  return alongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    startProgressMeters: startProgress,
    stepMeters,
    intervalMs: options.intervalMs ?? 1000,
    count,
  });
}

describe('movement analysis', () => {
  it('classifies continuous movement for the whole official window', () => {
    const course = courseFromPath();
    const samples = alongPath(course.referencePath, {
      sessionId: 'move',
      startMs: 10_000,
      count: 40,
      stepMeters: 4,
    });
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.movingMs > breakdown.officialTimeMs * 0.95);
    assert.ok(breakdown.waitingMs < breakdown.officialTimeMs * 0.05);
    assert.equal(breakdown.trust, 'complete');
  });

  it('classifies a fully stationary interval as waiting', () => {
    const course = courseFromPath();
    const samples = stationaryAt(course.referencePath, {
      sessionId: 'wait',
      startMs: 10_000,
      progressMeters: 80,
      count: 31,
    });
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.waitingMs > breakdown.officialTimeMs * 0.95);
    assert.ok(breakdown.movingMs < breakdown.officialTimeMs * 0.05);
    assert.equal(breakdown.trust, 'complete');
  });

  it('classifies a moving → waiting → moving trace', () => {
    const course = courseFromPath();
    const firstMove = alongPath(course.referencePath, {
      sessionId: 'mix',
      startMs: 10_000,
      count: 16,
      stepMeters: 4,
    });
    const lastMove = firstMove[firstMove.length - 1];
    assert.ok(lastMove);
    const wait = stationaryAt(course.referencePath, {
      sessionId: 'mix',
      startMs: lastMove.recordedAtMs + 1000,
      progressMeters: 15 * 4,
      count: 16,
    });
    const lastWait = wait[wait.length - 1];
    assert.ok(lastWait);
    const secondMove = alongPath(course.referencePath, {
      sessionId: 'mix',
      startMs: lastWait.recordedAtMs + 1000,
      startProgressMeters: 15 * 4,
      count: 16,
      stepMeters: 4,
    });
    const samples = [...firstMove, ...wait, ...secondMove];
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.movingMs > 20_000);
    assert.ok(breakdown.waitingMs > 10_000);
    assert.ok(breakdown.movingMs > breakdown.waitingMs);
  });

  it('does not treat low-speed GPS jitter while stationary as sustained movement', () => {
    const course = courseFromPath();
    const samples = stationaryAt(course.referencePath, {
      sessionId: 'jitter',
      startMs: 10_000,
      progressMeters: 120,
      count: 25,
      speedMetersPerSecond: 0.4,
      jitterMeters: [3.5, -2.8, 4.2, -3.1, 2.4, -4.0, 1.8, -2.2],
    });
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.waitingMs > breakdown.officialTimeMs * 0.8);
    assert.ok(breakdown.movingMs < breakdown.officialTimeMs * 0.2);
  });

  it('does not automatically treat plausible slow movement as waiting', () => {
    const course = courseFromPath();
    const samples = alongPath(course.referencePath, {
      sessionId: 'slow',
      startMs: 10_000,
      count: 21,
      stepMeters: 1,
      intervalMs: 1000,
      speedMetersPerSecond: 1,
    });
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.movingMs > breakdown.officialTimeMs * 0.85);
    assert.ok(breakdown.waitingMs < breakdown.officialTimeMs * 0.15);
  });

  it('does not label a sparse 9 s span of 1 m/s route progress as waiting', () => {
    const course = courseFromPath();
    const leftPoint = pointAtProgress(course.referencePath, 40);
    const rightPoint = pointAtProgress(course.referencePath, 49);
    const left = sample({
      id: 'sparse-slow-left',
      sessionId: 'sparse-slow',
      recordedAtMs: 20_000,
      latitude: leftPoint.latitude,
      longitude: leftPoint.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 1,
    });
    const right = sample({
      id: 'sparse-slow-right',
      sessionId: 'sparse-slow',
      recordedAtMs: 29_000,
      latitude: rightPoint.latitude,
      longitude: rightPoint.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 1,
    });
    const breakdown = analyze(course, [left, right]);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.waitingMs < 1_000);
    assert.ok(breakdown.unknownMs >= 8_000);
    assert.notEqual(breakdown.trust, 'complete');
  });

  it('does not treat 1 m/s travel as waiting when interior 1 Hz fixes are dropped as unusable', () => {
    const course = courseFromPath();
    const samples: LocationSample[] = [];
    for (let index = 0; index < 10; index += 1) {
      const point = pointAtProgress(course.referencePath, 40 + index);
      samples.push(
        sample({
          id: `sparse-drop-${index}`,
          sessionId: 'sparse-drop',
          recordedAtMs: 20_000 + index * 1000,
          latitude: point.latitude,
          longitude: point.longitude,
          horizontalAccuracyMeters: index === 0 || index === 9 ? 8 : 32,
          speedMetersPerSecond: 1,
        }),
      );
    }
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.waitingMs < 1_000);
    assert.ok(breakdown.unknownMs >= 8_000);
    assert.notEqual(breakdown.trust, 'complete');
  });

  it('classifies movement when reported speed is absent', () => {
    const course = courseFromPath();
    const samples = alongPath(course.referencePath, {
      sessionId: 'nospeed',
      startMs: 10_000,
      count: 25,
      stepMeters: 4,
      speedMetersPerSecond: null,
    });
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.movingMs > breakdown.officialTimeMs * 0.9);
  });

  it('does not let a poor-accuracy jump create large fake moving time', () => {
    const course = courseFromPath();
    const before = alongPath(course.referencePath, {
      sessionId: 'jump',
      startMs: 10_000,
      count: 10,
      stepMeters: 4,
    });
    const lastGood = before[before.length - 1];
    assert.ok(lastGood);
    const jump = sample({
      id: 'jump-bad',
      sessionId: 'jump',
      recordedAtMs: lastGood.recordedAtMs + 1000,
      latitude: lastGood.latitude,
      longitude: lastGood.longitude + 0.002,
      horizontalAccuracyMeters: 80,
      speedMetersPerSecond: 40,
    });
    const after = alongPath(course.referencePath, {
      sessionId: 'jump',
      startMs: jump.recordedAtMs + 1000,
      startProgressMeters: 9 * 4,
      count: 10,
      stepMeters: 4,
    });
    const samples = [...before, jump, ...after];
    const breakdown = analyze(course, samples);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.movingMs < 30_000);
    assert.ok(breakdown.unknownMs < 5_000);
  });

  it('still classifies a bounded stationary gap as waiting when ignored poor-accuracy interiors spike along-track', () => {
    const course = courseFromPath();
    const stop = pointAtProgress(course.referencePath, 80);
    const spike = pointAtProgress(course.referencePath, 140);
    const left = sample({
      id: 'poison-left',
      sessionId: 'poison',
      recordedAtMs: 20_000,
      latitude: stop.latitude,
      longitude: stop.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const interior = sample({
      id: 'poison-spike',
      sessionId: 'poison',
      recordedAtMs: 45_000,
      latitude: spike.latitude,
      longitude: spike.longitude,
      horizontalAccuracyMeters: 40,
      speedMetersPerSecond: 4,
    });
    const right = sample({
      id: 'poison-right',
      sessionId: 'poison',
      recordedAtMs: 70_000,
      latitude: stop.latitude,
      longitude: stop.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const breakdown = analyze(course, [left, interior, right]);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.waitingMs >= 49_000);
    assert.ok(breakdown.unknownMs < 1_000);
    assert.equal(breakdown.trust, 'complete');
  });

  it('classifies a bounded no-sample stop as waiting when flanks are trustworthy and co-located', () => {
    const course = courseFromPath();
    const path = course.referencePath;
    const point = pointAtProgress(path, 80);
    const left = sample({
      id: 'gap-left',
      sessionId: 'gap',
      recordedAtMs: 20_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const right = sample({
      id: 'gap-right',
      sessionId: 'gap',
      recordedAtMs: left.recordedAtMs + 90_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 9,
      speedMetersPerSecond: 0,
    });
    const breakdown = analyze(course, [left, right]);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.waitingMs >= 89_000);
    assert.ok(breakdown.unknownMs < 1_000);
    assert.equal(breakdown.trust, 'complete');
  });

  it('classifies the same stable flanks as unknown when the gap exceeds 120 s', () => {
    const course = courseFromPath();
    const point = pointAtProgress(course.referencePath, 80);
    const left = sample({
      id: 'long-left',
      sessionId: 'long',
      recordedAtMs: 20_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const right = sample({
      id: 'long-right',
      sessionId: 'long',
      recordedAtMs: left.recordedAtMs + MAX_STATIONARY_GAP_MS + 1_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const breakdown = analyze(course, [left, right]);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.unknownMs >= MAX_STATIONARY_GAP_MS);
    assert.ok(breakdown.waitingMs < 1_000);
    assert.equal(breakdown.trust, 'unavailable');
    assert.ok(breakdown.coverageRatio < MIN_DISPLAYABLE_COVERAGE_RATIO);
  });

  it('does not fabricate waiting across a short gap with materially different flank progress', () => {
    const course = courseFromPath();
    const leftPoint = pointAtProgress(course.referencePath, 40);
    const rightPoint = pointAtProgress(course.referencePath, 90);
    const left = sample({
      id: 'sep-left',
      sessionId: 'sep',
      recordedAtMs: 20_000,
      latitude: leftPoint.latitude,
      longitude: leftPoint.longitude,
      horizontalAccuracyMeters: 6,
    });
    const right = sample({
      id: 'sep-right',
      sessionId: 'sep',
      recordedAtMs: 40_000,
      latitude: rightPoint.latitude,
      longitude: rightPoint.longitude,
      horizontalAccuracyMeters: 6,
    });
    const breakdown = analyze(course, [left, right]);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.waitingMs < 1_000);
    assert.ok(breakdown.unknownMs >= 19_000);
  });

  it('treats poor-accuracy flanks around a gap as unknown', () => {
    const course = courseFromPath();
    const point = pointAtProgress(course.referencePath, 80);
    const left = sample({
      id: 'acc-left',
      sessionId: 'acc',
      recordedAtMs: 20_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 32,
      speedMetersPerSecond: 0,
    });
    const right = sample({
      id: 'acc-right',
      sessionId: 'acc',
      recordedAtMs: 60_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 36,
      speedMetersPerSecond: 0,
    });
    const breakdown = analyze(course, [left, right]);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.unknownMs >= 39_000);
    assert.ok(breakdown.waitingMs < 1_000);
  });

  it('handles non-monotonic and duplicate timestamps deterministically', () => {
    const course = courseFromPath();
    const base = alongPath(course.referencePath, {
      sessionId: 'time',
      startMs: 10_000,
      count: 8,
      stepMeters: 4,
    });
    const third = base[2];
    const fourth = base[3];
    assert.ok(third && fourth);
    const duplicate = sample({ ...fourth, id: 'dup' });
    const backward = sample({
      ...third,
      id: 'back',
      recordedAtMs: third.recordedAtMs - 500,
    });
    const samples = [...base.slice(0, 4), duplicate, backward, ...base.slice(4)];
    const first = samples[0];
    const last = samples[samples.length - 1];
    assert.ok(first && last);
    const once = analyzeAttemptMovement({
      course,
      samples,
      startedAtMs: first.recordedAtMs,
      finishedAtMs: last.recordedAtMs,
    });
    const twice = analyzeAttemptMovement({
      course,
      samples,
      startedAtMs: first.recordedAtMs,
      finishedAtMs: last.recordedAtMs,
    });
    assert.deepEqual(once, twice);
    assert.equal(movementTotalsReconcile(once), true);
  });

  it('clips exactly when official start and finish fall on sample timestamps', () => {
    const course = courseFromPath();
    const samples = alongPath(course.referencePath, {
      sessionId: 'exact',
      startMs: 10_000,
      count: 20,
      stepMeters: 4,
    });
    const first = samples[0];
    const last = samples[samples.length - 1];
    assert.ok(first && last);
    const breakdown = analyzeAttemptMovement({
      course,
      samples,
      startedAtMs: first.recordedAtMs,
      finishedAtMs: last.recordedAtMs,
    });
    assert.equal(breakdown.officialTimeMs, last.recordedAtMs - first.recordedAtMs);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(Math.abs(breakdown.unknownMs) <= 1);
  });

  it('accounts for official start and finish reconstructed between samples', () => {
    const course = courseFromPath();
    const samples = alongPath(course.referencePath, {
      sessionId: 'between',
      startMs: 10_000,
      count: 20,
      stepMeters: 4,
    });
    const first = samples[0];
    const last = samples[samples.length - 1];
    assert.ok(first && last);
    const startedAtMs = first.recordedAtMs + 350;
    const finishedAtMs = last.recordedAtMs - 275;
    const breakdown = analyzeAttemptMovement({
      course,
      samples,
      startedAtMs,
      finishedAtMs,
    });
    assert.equal(breakdown.officialTimeMs, finishedAtMs - startedAtMs);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.movingMs > breakdown.officialTimeMs * 0.9);
  });

  it('keeps moving + waiting + unknown equal to official total', () => {
    const course = courseFromPath();
    const moving = alongPath(course.referencePath, { sessionId: 'inv', startMs: 1_000, count: 12, stepMeters: 4 });
    const lastMove = moving[moving.length - 1];
    assert.ok(lastMove);
    const wait = stationaryAt(course.referencePath, {
      sessionId: 'inv',
      startMs: lastMove.recordedAtMs + 1000,
      progressMeters: 44,
      count: 8,
    });
    const samples = [...moving, ...wait];
    const breakdown = analyze(course, samples);
    assert.equal(
      breakdown.movingMs + breakdown.waitingMs + breakdown.unknownMs,
      breakdown.officialTimeMs,
    );
    assert.equal(breakdown.classifiedMs, breakdown.movingMs + breakdown.waitingMs);
  });

  it('does not interpolate official start/finish across a gap longer than 120 s', () => {
    const course = courseFromPath();
    const point = pointAtProgress(course.referencePath, 80);
    const left = sample({
      id: 'clip-left',
      sessionId: 'clip',
      recordedAtMs: 10_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const right = sample({
      id: 'clip-right',
      sessionId: 'clip',
      recordedAtMs: 10_000 + MAX_STATIONARY_GAP_MS + 30_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const breakdown = analyzeAttemptMovement({
      course,
      samples: [left, right],
      startedAtMs: 25_000,
      finishedAtMs: 85_000,
    });
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.equal(breakdown.officialTimeMs, 60_000);
    assert.ok(breakdown.unknownMs >= 59_000);
    assert.ok(breakdown.waitingMs < 1_000);
    assert.equal(breakdown.trust, 'unavailable');
  });

  it('treats an unbounded official-window edge with only one trustworthy flank as unknown', () => {
    const course = courseFromPath();
    const samples = alongPath(course.referencePath, {
      sessionId: 'unbounded',
      startMs: 20_000,
      count: 12,
      stepMeters: 4,
    });
    const last = samples[samples.length - 1];
    assert.ok(last);
    const breakdown = analyzeAttemptMovement({
      course,
      samples,
      startedAtMs: 5_000,
      finishedAtMs: last.recordedAtMs,
    });
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.ok(breakdown.unknownMs >= 14_000);
    assert.ok(breakdown.movingMs > 0);
  });

  it('exposes a partial trust state when some official time cannot be classified', () => {
    const course = courseFromPath();
    const moving = alongPath(course.referencePath, {
      sessionId: 'partial',
      startMs: 10_000,
      count: 41,
      stepMeters: 4,
    });
    const lastMove = moving[moving.length - 1];
    assert.ok(lastMove);
    const far = pointAtProgress(course.referencePath, 200);
    const afterGap = sample({
      id: 'partial-after',
      sessionId: 'partial',
      recordedAtMs: lastMove.recordedAtMs + 10_000,
      latitude: far.latitude,
      longitude: far.longitude,
      horizontalAccuracyMeters: 6,
    });
    const breakdown = analyze(course, [...moving, afterGap]);
    assert.equal(movementTotalsReconcile(breakdown), true);
    assert.equal(breakdown.trust, 'partial');
    assert.ok(breakdown.movingMs > 0);
    assert.ok(breakdown.unknownMs >= 8_000);
    assert.ok(breakdown.coverageRatio >= MIN_DISPLAYABLE_COVERAGE_RATIO);
  });

  it('marks insufficient coverage unavailable instead of fabricating a two-way split', () => {
    const course = courseFromPath();
    const left = sample({
      id: 'thin-left',
      sessionId: 'thin',
      recordedAtMs: 1_000,
      ...pointAtProgress(course.referencePath, 20),
      horizontalAccuracyMeters: 8,
    });
    const right = sample({
      id: 'thin-right',
      sessionId: 'thin',
      recordedAtMs: 1_000 + 180_000,
      ...pointAtProgress(course.referencePath, 20),
      horizontalAccuracyMeters: 8,
    });
    const breakdown = analyze(course, [left, right]);
    assert.equal(breakdown.trust, 'unavailable');
    assert.ok(breakdown.coverageRatio < MIN_DISPLAYABLE_COVERAGE_RATIO);
    assert.ok(breakdown.unknownMs > breakdown.classifiedMs);
  });

  it('reproduces the same breakdown after a second reconstruction from retained samples', () => {
    const course = courseFromPath();
    const attempt = makeAttempt({ id: 'a1', sessionId: 's1' });
    const samples = coveringTrace(course.referencePath, { sessionId: 's1', startMs: 5_000 });
    const first = deriveCurrentLayoutAttempt(course, attempt, samples);
    const second = deriveCurrentLayoutAttempt(course, attempt, samples);
    assert.equal(first.eligible, true);
    assert.ok(first.movement);
    assert.deepEqual(first.movement, second.movement);
    assert.equal(first.movement.analysisVersion, MOVEMENT_ANALYSIS_VERSION);
  });

  it('rederives the movement window when current-layout start and finish change', () => {
    const path = longPath();
    const original = courseFromPath(path, { startProgressMeters: 0 });
    const shortened = courseFromPath(path, {
      startProgressMeters: 80,
      finishProgressMeters: 400,
      startZone: {
        center: pointAtProgress(path, 80),
        radiusMeters: original.startZone.radiusMeters,
      },
      finishZone: {
        center: pointAtProgress(path, 400),
        radiusMeters: original.finishZone.radiusMeters,
      },
    });
    const attempt = makeAttempt({ id: 'layout', sessionId: 'layout' });
    const samples = coveringTrace(path, { sessionId: 'layout', startMs: 1_000 });
    const full = deriveCurrentLayoutAttempt(original, attempt, samples);
    const clipped = deriveCurrentLayoutAttempt(shortened, attempt, samples);
    assert.equal(full.eligible, true);
    assert.equal(clipped.eligible, true);
    assert.ok(full.movement && clipped.movement);
    assert.ok((clipped.officialTimeMs ?? 0) < (full.officialTimeMs ?? 0));
    assert.ok(clipped.movement.officialTimeMs < full.movement.officialTimeMs);
    assert.equal(clipped.movement.officialTimeMs, clipped.officialTimeMs);
    assert.equal(full.movement.officialTimeMs, full.officialTimeMs);
  });

  it('does not attach movement analysis to ineligible attempts or change competitive ranking', () => {
    const course = courseFromPath();
    const valid = makeAttempt({ id: 'valid', sessionId: 'valid', armedAtMs: 1_000 });
    const missing = makeAttempt({ id: 'missing', sessionId: 'missing', armedAtMs: 2_000 });
    const traces: AttemptTrace[] = [
      { attempt: valid, samples: coveringTrace(course.referencePath, { sessionId: 'valid', startMs: 1_000 }) },
      { attempt: missing, samples: [] },
    ];
    const focus = analyzeFocusAttempt(course, traces, 'valid');
    const missingFocus = analyzeFocusAttempt(course, traces, 'missing');
    assert.equal(focus?.isPb, true);
    assert.equal(focus?.rank, 1);
    assert.ok(focus?.focus.movement);
    assert.equal(missingFocus?.focus.eligible, false);
    assert.equal(missingFocus?.focus.movement, null);
    assert.equal(missingFocus?.rank, null);
  });

  it('imports no Expo, native, or MapLibre code', () => {
    const source = readFileSync('src/domain/movement-analysis.ts', 'utf8');
    assert.doesNotMatch(source, /expo-location|expo-task-manager|expo-sqlite|react-native|@maplibre\/maplibre-react-native|maplibre/);
  });

  it('exposes the classified interval sequence used to produce aggregate totals', () => {
    const course = courseFromPath();
    const moving = alongPath(course.referencePath, { sessionId: 'seq', startMs: 1_000, count: 12, stepMeters: 4 });
    const lastMove = moving[moving.length - 1];
    assert.ok(lastMove);
    const wait = stationaryAt(course.referencePath, {
      sessionId: 'seq',
      startMs: lastMove.recordedAtMs + 1000,
      progressMeters: 44,
      count: 8,
    });
    const samples = [...moving, ...wait];
    const bounds = windowOf(samples);
    const timeline = analyzeAttemptMovementTimeline({
      course,
      samples,
      startedAtMs: bounds.startedAtMs,
      finishedAtMs: bounds.finishedAtMs,
    });
    const fromIntervals = { movingMs: 0, waitingMs: 0, unknownMs: 0 };
    for (const interval of timeline.intervals) {
      fromIntervals[`${interval.label}Ms` as 'movingMs' | 'waitingMs' | 'unknownMs'] += interval.durationMs;
    }
    assert.equal(fromIntervals.movingMs, timeline.breakdown.movingMs);
    assert.equal(fromIntervals.waitingMs, timeline.breakdown.waitingMs);
    assert.equal(fromIntervals.unknownMs, timeline.breakdown.unknownMs);
    assert.ok(timeline.intervals.some((interval) => interval.label === 'waiting' && interval.startFix != null));
    assert.deepEqual(analyzeAttemptMovement({ course, samples, ...bounds }), timeline.breakdown);
  });
});
