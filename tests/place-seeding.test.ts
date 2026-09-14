import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLACE_ROUTE_MATCH_DISTANCE_METERS,
  PLACE_SEED_CENTER_TOLERANCE_METERS,
  PLACE_SEED_RADIUS_TOLERANCE_METERS,
} from '../src/domain/place';
import {
  endpointsMatchForSeed,
  ensurePlacesForRoute,
  findPlaceForRouteEndpoint,
  placeNamesFromRouteName,
  seedPlacesFromRoutes,
} from '../src/domain/place-seeding';
import { makePlace } from './helpers/places';
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

  it('reuses an existing Place on route sync by 25 m proximity, ignoring radius and route-derived names', () => {
    assert.equal(PLACE_ROUTE_MATCH_DISTANCE_METERS, 25);
    const homeCenter = { latitude: 32.08, longitude: 34.78 };
    const workCenter = offsetLatLng(32.08, 34.78, 300, 0);
    const home = makePlace({
      id: 'home-canonical',
      name: 'Home',
      center: homeCenter,
      radiusMeters: 17,
      createdAtMs: 1,
    });
    const work = makePlace({
      id: 'work-canonical',
      name: 'Work',
      center: workCenter,
      radiusMeters: 30,
      createdAtMs: 2,
    });
    const nearHome = offsetLatLng(32.08, 34.78, 12, 0);
    assert.equal(findPlaceForRouteEndpoint([home, work], nearHome)?.id, 'home-canonical');
    assert.equal(findPlaceForRouteEndpoint([home, work], offsetLatLng(32.08, 34.78, 26, 0)), null);

    const archivedNearer = makePlace({
      id: 'home-archived',
      name: 'Old Home',
      center: homeCenter,
      radiusMeters: 10,
      status: 'archived',
      createdAtMs: 0,
    });
    const activeFarther = makePlace({
      id: 'home-active',
      name: 'Home',
      center: offsetLatLng(32.08, 34.78, 20, 0),
      radiusMeters: 30,
      createdAtMs: 3,
    });
    assert.equal(
      findPlaceForRouteEndpoint([archivedNearer, activeFarther], homeCenter)?.id,
      'home-active',
    );

    const parkRoute = makeRoute({
      id: 'park-route',
      name: 'Park Route',
      createdAtMs: 400,
      sourceRecordingId: 's-park',
      startZone: { center: homeCenter, radiusMeters: 30 },
      finishZone: { center: workCenter, radiusMeters: 10 },
    });
    const synced = ensurePlacesForRoute([home, work], parkRoute, { nowMs: 5_000 });
    assert.equal(synced.placesToCreate.length, 0);
    assert.equal(synced.assignment.startPlaceId, 'home-canonical');
    assert.equal(synced.assignment.finishPlaceId, 'work-canonical');

    const resized = ensurePlacesForRoute(
      [{ ...home, radiusMeters: 40 }, work],
      makeRoute({
        id: 'home-3-work',
        name: 'Home 3 → Work',
        createdAtMs: 500,
        sourceRecordingId: 's-h3',
        startZone: { center: homeCenter, radiusMeters: 10 },
        finishZone: { center: workCenter, radiusMeters: 30 },
      }),
      { nowMs: 6_000 },
    );
    assert.equal(resized.placesToCreate.length, 0);
    assert.equal(resized.assignment.startPlaceId, 'home-canonical');
  });
});
