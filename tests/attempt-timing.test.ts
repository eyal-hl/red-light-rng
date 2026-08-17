import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABANDON_OFF_COURSE_MS,
  DEPARTURE_WINDOW_MS,
  FINISH_PROGRESS_TOLERANCE_METERS,
  replayAttemptTrace,
  startLineHasPreStartRegion,
  type TimingCourse,
} from '../src/domain/attempt-timing';
import { pathDistanceMeters } from '../src/domain/geo';
import { pointAtProgress } from '../src/domain/path-projection';
import { offsetLatLng, sample, traceAlongPath } from './helpers/samples';
import { makeRoute, northPath, outAndBackPath } from './helpers/routes';

function courseFromRoute(overrides: Partial<TimingCourse> = {}): TimingCourse {
  const route = makeRoute({
    referencePath: northPath({ points: 16, stepMeters: 20 }),
  });
  return {
    referencePath: route.referencePath,
    startProgressMeters: route.startProgressMeters,
    finishProgressMeters: route.finishProgressMeters,
    finishZone: route.finishZone,
    checkpoints: route.checkpoints,
    ...overrides,
  };
}

describe('attempt timing', () => {
  it('does not start official timing from arming or stationary GPS drift at progress 0', () => {
    const course = courseFromRoute();
    assert.equal(startLineHasPreStartRegion(course.startProgressMeters), false);
    const start = course.referencePath[0]!;
    const drift = [];
    for (let index = 0; index < 180; index += 1) {
      const jitter = offsetLatLng(start.latitude, start.longitude, (index % 5) - 2, (index % 3) - 1);
      drift.push(
        sample({
          id: `drift-${index}`,
          recordedAtMs: 1_700_000_000_000 + index * 1000,
          latitude: jitter.latitude,
          longitude: jitter.longitude,
          speedMetersPerSecond: 0.2,
        }),
      );
    }
    const drifted = replayAttemptTrace(course, drift);
    assert.equal(drifted.lifecycle, 'armed');
    assert.equal(drifted.startedAtMs, null);
  });

  it('reconstructs started_at at departure on a startProgressMeters = 0 route after long drift', () => {
    const course = courseFromRoute();
    const start = course.referencePath[0]!;
    const samples = [];
    for (let index = 0; index < 180; index += 1) {
      const jitter = offsetLatLng(start.latitude, start.longitude, (index % 4) - 1.5, 0);
      samples.push(
        sample({
          id: `wait-${index}`,
          recordedAtMs: 1_700_000_000_000 + index * 1000,
          latitude: jitter.latitude,
          longitude: jitter.longitude,
          speedMetersPerSecond: 0.1,
        }),
      );
    }
    const departureStart = 1_700_000_000_000 + 180_000;
    samples.push(
      ...traceAlongPath(course.referencePath, {
        startMs: departureStart,
        startProgressMeters: 0,
        stepMeters: 5,
        count: 8,
      }),
    );
    const result = replayAttemptTrace(course, samples);
    assert.equal(result.lifecycle, 'active');
    assert.ok(result.startedAtMs != null);
    assert.ok((result.startedAtMs ?? 0) >= departureStart - 1000);
    assert.ok((result.startedAtMs ?? 0) <= departureStart + DEPARTURE_WINDOW_MS);
  });

  it('uses the start line crossing as started_at when startProgressMeters is past 0', () => {
    const course = courseFromRoute({ startProgressMeters: 40 });
    const before = traceAlongPath(course.referencePath, {
      startProgressMeters: 0,
      stepMeters: 4,
      count: 8,
      startMs: 1_700_000_000_000,
    });
    const across = traceAlongPath(course.referencePath, {
      startProgressMeters: 28,
      stepMeters: 4,
      count: 10,
      startMs: 1_700_000_008_000,
    });
    const result = replayAttemptTrace(course, [...before, ...across]);
    assert.equal(result.lifecycle, 'active');
    assert.equal(result.startedAtMs, 1_700_000_011_000);
  });

  it('stays armed when the rider is already past the start line', () => {
    const course = courseFromRoute({ startProgressMeters: 40 });
    const past = traceAlongPath(course.referencePath, {
      startProgressMeters: 60,
      stepMeters: 5,
      count: 10,
    });
    const result = replayAttemptTrace(course, past);
    assert.equal(result.lifecycle, 'armed');
    assert.equal(result.startedAtMs, null);
  });

  it('starts after returning below the start line and crossing forward', () => {
    const course = courseFromRoute({ startProgressMeters: 40 });
    const past = traceAlongPath(course.referencePath, {
      startProgressMeters: 70,
      stepMeters: 4,
      count: 4,
      startMs: 1_700_000_000_000,
    });
    const back = traceAlongPath(course.referencePath, {
      startProgressMeters: 20,
      stepMeters: 4,
      count: 4,
      startMs: 1_700_000_010_000,
    });
    const forward = traceAlongPath(course.referencePath, {
      startProgressMeters: 24,
      stepMeters: 5,
      count: 10,
      startMs: 1_700_000_014_000,
    });
    const result = replayAttemptTrace(course, [...past, ...back, ...forward]);
    assert.equal(result.lifecycle, 'active');
    assert.ok(result.startedAtMs != null);
    assert.ok(result.startedAtMs! >= 1_700_000_014_000);
  });

  it('completes a zero-checkpoint course and reconstructs finished_at from telemetry', () => {
    const course = courseFromRoute();
    const samples = traceAlongPath(course.referencePath, {
      startProgressMeters: 0,
      stepMeters: 6,
      count: 55,
    });
    const result = replayAttemptTrace(course, samples);
    assert.equal(result.lifecycle, 'completed');
    assert.equal(result.validity, 'valid');
    assert.ok(result.startedAtMs != null);
    assert.ok(result.finishedAtMs != null);
    assert.ok(result.finishedAtMs! >= result.startedAtMs!);
    assert.ok(result.finishedAtMs! <= samples[samples.length - 1]!.recordedAtMs);
    assert.equal(result.crossings.length, 0);
  });

  it('records a checkpoint that sits just after the start line during the departure window', () => {
    const path = northPath({ points: 16, stepMeters: 20 });
    const course = courseFromRoute({
      referencePath: path,
      startProgressMeters: 0,
      checkpoints: [{ id: 'cp-early', name: 'Early', progressMeters: 12 }],
    });
    const samples = traceAlongPath(path, { startProgressMeters: 0, stepMeters: 4, count: 20 });
    const result = replayAttemptTrace(course, samples);
    assert.ok(result.lifecycle === 'active' || result.lifecycle === 'completed');
    assert.equal(result.crossings.length, 1);
    assert.equal(result.crossings[0]?.checkpointId, 'cp-early');
    assert.ok(result.startedAtMs != null);
    assert.ok(result.crossings[0]!.crossedAtMs >= result.startedAtMs!);
  });

  it('detects checkpoints once in route order and ignores jitter around a split', () => {
    const path = northPath({ points: 16, stepMeters: 20 });
    const course = courseFromRoute({
      referencePath: path,
      checkpoints: [
        { id: 'cp-1', name: 'Park', progressMeters: 80 },
        { id: 'cp-2', name: 'Bridge', progressMeters: 160 },
      ],
    });
    const samples = traceAlongPath(path, { startProgressMeters: 0, stepMeters: 5, count: 55 });
    const aroundPark = pointAtProgress(path, 80);
    for (let index = 0; index < 6; index += 1) {
      const jitter = offsetLatLng(aroundPark.latitude, aroundPark.longitude, (index % 3) - 1, 0);
      samples.splice(20 + index, 0, sample({
        id: `jitter-${index}`,
        recordedAtMs: samples[19]!.recordedAtMs + 50 + index,
        latitude: jitter.latitude,
        longitude: jitter.longitude,
      }));
    }
    const result = replayAttemptTrace(course, samples);
    assert.equal(result.crossings.map((crossing) => crossing.checkpointId).join(','), 'cp-1,cp-2');
    assert.equal(result.crossings.length, 2);
    assert.ok(result.crossings[0]!.crossedAtMs < result.crossings[1]!.crossedAtMs);
  });

  it('does not let parking after finish change official time', () => {
    const course = courseFromRoute();
    const ride = traceAlongPath(course.referencePath, {
      startProgressMeters: 0,
      stepMeters: 6,
      count: 55,
    });
    const finished = replayAttemptTrace(course, ride);
    assert.equal(finished.lifecycle, 'completed');
    const parked = ride.concat(
      traceAlongPath(course.referencePath, {
        startProgressMeters: course.finishProgressMeters,
        stepMeters: 1,
        count: 20,
        startMs: ride[ride.length - 1]!.recordedAtMs + 1000,
      }),
    );
    const parkedResult = replayAttemptTrace(course, parked);
    assert.equal(parkedResult.finishedAtMs, finished.finishedAtMs);
    assert.equal(parkedResult.startedAtMs, finished.startedAtMs);
  });

  it('cannot finish before an official start', () => {
    const course = courseFromRoute();
    const nearFinish = traceAlongPath(course.referencePath, {
      startProgressMeters: course.finishProgressMeters - 10,
      stepMeters: 4,
      count: 6,
    });
    const result = replayAttemptTrace(course, nearFinish);
    assert.notEqual(result.lifecycle, 'completed');
    assert.equal(result.startedAtMs, null);
  });

  it('finishes with an explicit progress tolerance short of the last vertex', () => {
    const course = courseFromRoute();
    const samples = traceAlongPath(course.referencePath, {
      startProgressMeters: 0,
      stepMeters: 6,
      count: 48,
    });
    const lastProgress = 6 * 47;
    assert.ok(lastProgress < course.finishProgressMeters);
    assert.ok(lastProgress >= course.finishProgressMeters - FINISH_PROGRESS_TOLERANCE_METERS - 6);
    const result = replayAttemptTrace(course, samples);
    assert.equal(result.lifecycle, 'completed');
    assert.ok(result.finishedAtMs != null);
  });

  it('abandons an active attempt after sustained off-course samples', () => {
    const course = courseFromRoute();
    const ride = traceAlongPath(course.referencePath, {
      startProgressMeters: 0,
      stepMeters: 5,
      count: 12,
    });
    const last = ride[ride.length - 1]!;
    const off = [];
    for (let index = 0; index < 65; index += 1) {
      const far = offsetLatLng(last.latitude, last.longitude, 0, 80);
      off.push(
        sample({
          id: `off-${index}`,
          recordedAtMs: last.recordedAtMs + 1000 + index * 1000,
          latitude: far.latitude,
          longitude: far.longitude,
        }),
      );
    }
    const result = replayAttemptTrace(course, [...ride, ...off]);
    assert.equal(result.lifecycle, 'abandoned');
    assert.equal(result.validity, 'unranked');
    assert.ok(off[off.length - 1]!.recordedAtMs - off[0]!.recordedAtMs >= ABANDON_OFF_COURSE_MS);
  });

  it('keeps matching sequential on an out-and-back course through the turnaround', () => {
    const path = outAndBackPath(20, 6);
    const course: TimingCourse = {
      referencePath: path,
      startProgressMeters: 0,
      finishProgressMeters: pathDistanceMeters(path),
      finishZone: { center: path[path.length - 1]!, radiusMeters: 30 },
      checkpoints: [{ id: 'turn', name: 'Turn', progressMeters: pathDistanceMeters(path) / 2 }],
    };
    const samples = traceAlongPath(path, {
      startProgressMeters: 0,
      stepMeters: 5,
      count: 55,
    });
    const result = replayAttemptTrace(course, samples);
    assert.ok(result.lifecycle === 'active' || result.lifecycle === 'completed');
    assert.ok((result.match.lastAcceptedProgressMeters ?? 0) > 18);
    assert.equal(result.crossings.length, 1);
  });
});
