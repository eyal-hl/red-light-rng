import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CORRIDOR_WIDTH_METERS,
  createCourseMatchState,
  MATCH_FORWARD_WINDOW_METERS,
  matchSampleToCourse,
} from '../src/domain/course-matching';
import { pointAtProgress } from '../src/domain/path-projection';
import { offsetLatLng, sample } from './helpers/samples';
import { makeRoute, northPath, outAndBackPath } from './helpers/routes';

function selfCrossingPath() {
  const start = { latitude: 32.08, longitude: 34.78 };
  return [
    start,
    offsetLatLng(start.latitude, start.longitude, 80, 0),
    offsetLatLng(start.latitude, start.longitude, 80, 40),
    offsetLatLng(start.latitude, start.longitude, 40, 40),
    offsetLatLng(start.latitude, start.longitude, 40, -20),
  ];
}

describe('course matching', () => {
  it('anchors the first match near start progress instead of a later retraced branch', () => {
    const path = outAndBackPath(20, 5);
    const start = path[0]!;
    const match = matchSampleToCourse(
      path,
      sample({ latitude: start.latitude, longitude: start.longitude }),
      createCourseMatchState(),
      0,
    );
    assert.equal(match.accepted, true);
    assert.ok((match.progressMeters ?? 99) < 10);
  });

  it('does not teleport onto a later out-and-back branch while still outbound', () => {
    const path = outAndBackPath(20, 5);
    let state = createCourseMatchState();
    const outbound = pointAtProgress(path, 40);
    const first = matchSampleToCourse(
      path,
      sample({ latitude: outbound.latitude, longitude: outbound.longitude, recordedAtMs: 1 }),
      state,
      0,
    );
    assert.equal(first.accepted, true);
    assert.ok((first.progressMeters ?? 0) < 80);
    state = first.state;

    const noisySamePlace = offsetLatLng(outbound.latitude, outbound.longitude, 0, 3);
    const second = matchSampleToCourse(
      path,
      sample({
        latitude: noisySamePlace.latitude,
        longitude: noisySamePlace.longitude,
        recordedAtMs: 2,
      }),
      state,
      0,
    );
    assert.equal(second.accepted, true);
    assert.ok(
      Math.abs((second.progressMeters ?? 0) - (first.progressMeters ?? 0)) < MATCH_FORWARD_WINDOW_METERS,
    );
    assert.ok((second.progressMeters ?? 0) < 100);
  });

  it('stays on the first crossing of a self-crossing course until progress actually reaches the later branch', () => {
    const path = selfCrossingPath();
    const crossing = offsetLatLng(32.08, 34.78, 40, 0);
    let state = createCourseMatchState();
    const first = matchSampleToCourse(
      path,
      sample({ latitude: crossing.latitude, longitude: crossing.longitude, recordedAtMs: 1 }),
      state,
      0,
    );
    assert.equal(first.accepted, true);
    assert.ok((first.progressMeters ?? 200) < 90);
    state = first.state;

    const later = matchSampleToCourse(
      path,
      sample({
        latitude: crossing.latitude,
        longitude: crossing.longitude,
        recordedAtMs: 2,
        headingDegrees: 90,
      }),
      state,
      0,
    );
    assert.equal(later.accepted, true);
    assert.ok((later.progressMeters ?? 0) < 90);
  });

  it('rejects samples outside the corridor', () => {
    const route = makeRoute({ referencePath: northPath() });
    const far = offsetLatLng(32.08, 34.78, 0, CORRIDOR_WIDTH_METERS + 20);
    const match = matchSampleToCourse(
      route.referencePath,
      sample({ latitude: far.latitude, longitude: far.longitude }),
      createCourseMatchState(),
      0,
    );
    assert.equal(match.accepted, false);
    assert.equal(match.quality, 'off_course');
  });
});
