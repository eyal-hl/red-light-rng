import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLACE_SEED_CENTER_TOLERANCE_METERS,
  PLACE_SEED_RADIUS_TOLERANCE_METERS,
} from '../src/domain/place';
import {
  endpointsMatchForSeed,
  placeNamesFromRouteName,
  seedPlacesFromRoutes,
} from '../src/domain/place-seeding';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';

describe('place seeding', () => {
  it('splits route names at an arrow and falls back to start/finish labels', () => {
    assert.deepEqual(placeNamesFromRouteName('Home → Work'), { start: 'Home', finish: 'Work' });
    assert.deepEqual(placeNamesFromRouteName('Home -> Work'), { start: 'Home', finish: 'Work' });
    assert.deepEqual(placeNamesFromRouteName('Loop'), { start: 'Loop start', finish: 'Loop finish' });
  });

  it('dedupes endpoints within the pinned 10 m / 10 m tolerance and keeps ambiguous endpoints separate', () => {
    assert.equal(PLACE_SEED_CENTER_TOLERANCE_METERS, 10);
    assert.equal(PLACE_SEED_RADIUS_TOLERANCE_METERS, 10);
    const home = { latitude: 32.08, longitude: 34.78 };
    const work = offsetLatLng(32.08, 34.78, 300, 0);
    const nearHome = offsetLatLng(32.08, 34.78, 8, 0);
    const farHome = offsetLatLng(32.08, 34.78, 15, 0);

    assert.equal(
      endpointsMatchForSeed(
        { center: home, radiusMeters: 30 },
        { center: nearHome, radiusMeters: 35 },
      ),
      true,
    );
    assert.equal(
      endpointsMatchForSeed(
        { center: home, radiusMeters: 30 },
        { center: farHome, radiusMeters: 30 },
      ),
      false,
    );

    const homeWork = makeRoute({
      id: 'route-hw',
      name: 'Home → Work',
      createdAtMs: 100,
      sourceRecordingId: 's1',
      referencePath: northPath({ startLat: home.latitude, startLng: home.longitude, points: 8, stepMeters: 40 }),
      startZone: { center: home, radiusMeters: 30 },
      finishZone: { center: work, radiusMeters: 30 },
    });
    const workHome = makeRoute({
      id: 'route-wh',
      name: 'Work → Home',
      createdAtMs: 200,
      sourceRecordingId: 's2',
      referencePath: [...homeWork.referencePath].reverse(),
      startZone: { center: work, radiusMeters: 30 },
      finishZone: { center: home, radiusMeters: 32 },
    });
    const other = makeRoute({
      id: 'route-other',
      name: 'Cafe → Work',
      createdAtMs: 300,
      sourceRecordingId: 's3',
      startZone: { center: farHome, radiusMeters: 30 },
      finishZone: { center: work, radiusMeters: 30 },
    });

    const seeded = seedPlacesFromRoutes([other, workHome, homeWork], { nowMs: 1_000 });
    const homePlaces = seeded.places.filter((place) => place.name === 'Home' || place.name === 'Cafe');
    assert.ok(seeded.places.length >= 3);
    const assignmentHw = seeded.assignments.find((item) => item.routeId === 'route-hw');
    const assignmentWh = seeded.assignments.find((item) => item.routeId === 'route-wh');
    const assignmentOther = seeded.assignments.find((item) => item.routeId === 'route-other');
    assert.equal(assignmentHw?.startPlaceId, assignmentWh?.finishPlaceId);
    assert.equal(assignmentHw?.finishPlaceId, assignmentWh?.startPlaceId);
    assert.notEqual(assignmentOther?.startPlaceId, assignmentHw?.startPlaceId);
    assert.equal(homePlaces.length >= 1, true);
  });
});
