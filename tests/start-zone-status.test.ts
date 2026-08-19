import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { replayAttemptTrace, type TimingCourse } from '../src/domain/attempt-timing';
import { pointAtProgress } from '../src/domain/path-projection';
import { deriveStartZoneStatus } from '../src/domain/start-zone-status';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample } from './helpers/samples';

function makeCourse(radiusMeters = 30): TimingCourse {
  const route = makeRoute({
    referencePath: northPath({ points: 20, stepMeters: 20 }),
  });
  return {
    referencePath: route.referencePath,
    startProgressMeters: route.startProgressMeters,
    finishProgressMeters: route.finishProgressMeters,
    startZone: { ...route.startZone, radiusMeters },
    finishZone: route.finishZone,
    checkpoints: route.checkpoints,
  };
}

function statusFor(course: TimingCourse, samples: ReturnType<typeof sample>[]) {
  const engine = replayAttemptTrace(course, samples);
  return {
    engine,
    status: deriveStartZoneStatus(course, samples, engine),
  };
}

describe('armed start-zone status', () => {
  it('locates until there is a usable fix', () => {
    const course = makeCourse();
    assert.equal(statusFor(course, []).status, 'locating');

    const start = course.referencePath[0]!;
    const poor = sample({
      latitude: start.latitude,
      longitude: start.longitude,
      horizontalAccuracyMeters: 60,
    });
    assert.equal(statusFor(course, [poor]).status, 'locating');
  });

  it('uses timing progress semantics for perpendicular fixes inside the matcher corridor', () => {
    const defaultCourse = makeCourse(30);
    const start = defaultCourse.referencePath[0]!;
    const thirtyTwoMetersBesideStart = offsetLatLng(
      start.latitude,
      start.longitude,
      0,
      32,
    );
    assert.equal(
      statusFor(
        defaultCourse,
        [sample({ ...thirtyTwoMetersBesideStart, horizontalAccuracyMeters: 5 })],
      ).status,
      'inside',
    );

    const minimumRadiusCourse = makeCourse(8);
    const twentyMetersBesideStart = offsetLatLng(start.latitude, start.longitude, 0, 20);
    assert.equal(
      statusFor(
        minimumRadiusCourse,
        [sample({ ...twentyMetersBesideStart, horizontalAccuracyMeters: 5 })],
      ).status,
      'inside',
    );
  });

  it('reports usable matcher rejections as outside, not locating', () => {
    const course = makeCourse(50);
    const start = course.referencePath[0]!;
    const offCourse = offsetLatLng(start.latitude, start.longitude, 0, 40);
    assert.equal(
      statusFor(course, [sample({ ...offCourse, horizontalAccuracyMeters: 5 })]).status,
      'outside',
    );

    const wideCourse = makeCourse(250);
    const farAlongPath = pointAtProgress(wideCourse.referencePath, 200);
    assert.equal(
      statusFor(wideCourse, [sample({ ...farAlongPath, horizontalAccuracyMeters: 5 })]).status,
      'outside',
    );
  });

  it('uses the configured per-route radius for accepted progress', () => {
    const narrow = makeCourse(8);
    const wide = makeCourse(50);
    const point = pointAtProgress(narrow.referencePath, 12);
    const fix = sample({ ...point, horizontalAccuracyMeters: 5 });

    assert.equal(statusFor(narrow, [fix]).status, 'outside');
    assert.equal(statusFor(wide, [fix]).status, 'inside');
  });

  it('uses the latest sample so an off-course fix cannot leave a stale green light', () => {
    const course = makeCourse(30);
    const start = course.referencePath[0]!;
    const inside = sample({
      id: 'inside',
      recordedAtMs: 1_700_000_000_000,
      latitude: start.latitude,
      longitude: start.longitude,
      horizontalAccuracyMeters: 5,
    });
    const offCoursePoint = offsetLatLng(start.latitude, start.longitude, 0, 40);
    const laterOutside = sample({
      id: 'outside-later',
      recordedAtMs: 1_700_000_001_000,
      ...offCoursePoint,
      horizontalAccuracyMeters: 5,
    });
    const collidingOutside = sample({
      id: 'outside-same-timestamp',
      recordedAtMs: inside.recordedAtMs,
      ...offCoursePoint,
      horizontalAccuracyMeters: 5,
    });

    assert.equal(statusFor(course, [inside]).status, 'inside');
    assert.equal(statusFor(course, [inside, laterOutside]).status, 'outside');
    assert.equal(statusFor(course, [inside, collidingOutside]).status, 'outside');
  });

  it('keeps null accuracy usable just like the course matcher', () => {
    const course = makeCourse();
    const start = course.referencePath[0]!;
    const fix = {
      ...sample({ latitude: start.latitude, longitude: start.longitude }),
      horizontalAccuracyMeters: null,
    };
    assert.equal(statusFor(course, [fix]).status, 'inside');
  });

  it('being green is observability only and does not start official timing', () => {
    const course = makeCourse();
    const start = course.referencePath[0]!;
    const stationary = [0, 1, 2, 3].map((index) =>
      sample({
        id: `stationary-${index}`,
        recordedAtMs: 1_700_000_000_000 + index * 1000,
        latitude: start.latitude,
        longitude: start.longitude,
        horizontalAccuracyMeters: 5,
        speedMetersPerSecond: 0,
      }),
    );
    const result = statusFor(course, stationary);

    assert.equal(result.status, 'inside');
    assert.equal(result.engine.lifecycle, 'armed');
    assert.equal(result.engine.startedAtMs, null);
  });
});
