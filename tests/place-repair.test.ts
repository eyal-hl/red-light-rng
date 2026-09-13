import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLACE_REPAIR_DISTANCE_METERS,
  PLACE_ROUTE_MATCH_DISTANCE_METERS,
  partitionPlacesByStatus,
} from '../src/domain/place';
import {
  clusterPlacesForRepair,
  normalizePlaceNameForRepair,
  placeNamesMatchForRepair,
  planPlaceDuplicateRepair,
  rewriteRepairedPlaceId,
  selectCanonicalPlace,
} from '../src/domain/place-repair';
import { makePlace } from './helpers/places';
import { offsetLatLng } from './helpers/samples';

const HOME = { latitude: 32.08, longitude: 34.78 };

describe('place duplicate repair', () => {
  it('pins the 25 m repair and route-match distances', () => {
    assert.equal(PLACE_REPAIR_DISTANCE_METERS, 25);
    assert.equal(PLACE_ROUTE_MATCH_DISTANCE_METERS, 25);
  });

  it('normalizes names by trim, whitespace collapse, and lowercase', () => {
    assert.equal(normalizePlaceNameForRepair('  Home   3  '), 'home 3');
    assert.equal(
      placeNamesMatchForRepair({ name: ' Home' }, { name: 'HOME' }, [{ name: ' Home' }, { name: 'HOME' }]),
      true,
    );
  });

  it('treats a trailing integer suffix as an alias only when a base-name sibling is in the neighborhood', () => {
    const home = makePlace({ id: 'home', name: 'Home', createdAtMs: 1 });
    const home3 = makePlace({ id: 'home-3', name: 'Home 3', createdAtMs: 2 });
    const home4 = makePlace({ id: 'home-4', name: 'Home 4', createdAtMs: 3 });
    assert.equal(placeNamesMatchForRepair(home, home3, [home, home3]), true);
    assert.equal(placeNamesMatchForRepair(home3, home4, [home3, home4]), false);
    assert.equal(placeNamesMatchForRepair(home3, home4, [home, home3, home4]), true);
  });

  it('collapses legacy Home 10 m / 30 m / active 17 m at the same physical location onto the active Place', () => {
    const home10 = makePlace({
      id: 'home-10',
      name: 'Home',
      radiusMeters: 10,
      status: 'archived',
      createdAtMs: 1,
    });
    const home30 = makePlace({
      id: 'home-30',
      name: 'Home',
      radiusMeters: 30,
      status: 'archived',
      createdAtMs: 2,
    });
    const home17 = makePlace({
      id: 'home-17',
      name: 'Home',
      radiusMeters: 17,
      status: 'active',
      createdAtMs: 3,
    });
    const plan = planPlaceDuplicateRepair([home10, home30, home17]);
    assert.equal(plan.canonicalIdByPlaceId.get('home-10'), 'home-17');
    assert.equal(plan.canonicalIdByPlaceId.get('home-30'), 'home-17');
    assert.equal(plan.canonicalIdByPlaceId.get('home-17'), 'home-17');
    assert.deepEqual(plan.obsoletePlaceIds, ['home-10', 'home-30']);
    assert.equal(selectCanonicalPlace([home10, home30, home17]).radiusMeters, 17);
    assert.equal(selectCanonicalPlace([home10, home30, home17]).status, 'active');
  });

  it('merges two Work 30 m rows whose centers are about 12 m apart onto the active Work', () => {
    const activeWork = makePlace({
      id: 'work-active',
      name: 'Work',
      radiusMeters: 30,
      status: 'active',
      createdAtMs: 2,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 300, 0),
    });
    const archivedWork = makePlace({
      id: 'work-archived',
      name: 'Work',
      radiusMeters: 30,
      status: 'archived',
      createdAtMs: 1,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 312, 0),
    });
    const plan = planPlaceDuplicateRepair([activeWork, archivedWork]);
    assert.equal(plan.canonicalIdByPlaceId.get('work-archived'), 'work-active');
    assert.deepEqual(plan.obsoletePlaceIds, ['work-archived']);
  });

  it('collapses nearby Home and Home 3 when they represent the same physical location', () => {
    const home = makePlace({ id: 'home', name: 'Home', createdAtMs: 1, status: 'active' });
    const home3 = makePlace({
      id: 'home-3',
      name: 'Home 3',
      radiusMeters: 30,
      status: 'archived',
      createdAtMs: 2,
    });
    const plan = planPlaceDuplicateRepair([home, home3]);
    assert.equal(plan.canonicalIdByPlaceId.get('home-3'), 'home');
    assert.deepEqual(plan.obsoletePlaceIds, ['home-3']);
  });

  it('keeps Home and Home 3 about 80 m apart as separate Places', () => {
    const home = makePlace({ id: 'home', name: 'Home', createdAtMs: 1 });
    const home3 = makePlace({
      id: 'home-3',
      name: 'Home 3',
      createdAtMs: 2,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 80, 0),
    });
    const plan = planPlaceDuplicateRepair([home, home3]);
    assert.deepEqual(plan.obsoletePlaceIds, []);
    assert.equal(plan.canonicalIdByPlaceId.get('home'), 'home');
    assert.equal(plan.canonicalIdByPlaceId.get('home-3'), 'home-3');
  });

  it('does not merge a 0 / 20 / 40 m same-name chain because complete-linkage caps span at 25 m', () => {
    const home0 = makePlace({ id: 'home-0', name: 'Home', createdAtMs: 1, center: HOME });
    const home20 = makePlace({
      id: 'home-20',
      name: 'Home',
      createdAtMs: 2,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 20, 0),
    });
    const home40 = makePlace({
      id: 'home-40',
      name: 'Home',
      createdAtMs: 3,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 40, 0),
    });
    const clusters = clusterPlacesForRepair([home0, home20, home40]);
    assert.equal(clusters.length, 2);
    const plan = planPlaceDuplicateRepair([home0, home20, home40]);
    assert.equal(plan.obsoletePlaceIds.length, 1);
    assert.equal(plan.canonicalIdByPlaceId.get('home-0'), 'home-0');
    assert.equal(plan.canonicalIdByPlaceId.get('home-40'), 'home-40');
    assert.equal(plan.canonicalIdByPlaceId.get('home-20'), 'home-0');
  });

  it('does not merge same-name but geographically distinct Places', () => {
    const home = makePlace({ id: 'home-a', name: 'Home', createdAtMs: 1 });
    const otherHome = makePlace({
      id: 'home-b',
      name: 'Home',
      createdAtMs: 2,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 400, 0),
    });
    const plan = planPlaceDuplicateRepair([home, otherHome]);
    assert.deepEqual(plan.obsoletePlaceIds, []);
  });

  it('does not merge differently named neighbors such as Home and Cafe', () => {
    const home = makePlace({ id: 'home', name: 'Home', createdAtMs: 1 });
    const cafe = makePlace({
      id: 'cafe',
      name: 'Cafe',
      createdAtMs: 2,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 12, 0),
    });
    const plan = planPlaceDuplicateRepair([home, cafe]);
    assert.deepEqual(plan.obsoletePlaceIds, []);
  });

  it('leaves a second repair pass with nothing to delete', () => {
    const home10 = makePlace({
      id: 'home-10',
      name: 'Home',
      radiusMeters: 10,
      status: 'archived',
      createdAtMs: 1,
    });
    const home17 = makePlace({
      id: 'home-17',
      name: 'Home',
      radiusMeters: 17,
      createdAtMs: 2,
    });
    const first = planPlaceDuplicateRepair([home10, home17]);
    const remaining = [home10, home17].filter((place) => !first.obsoletePlaceIds.includes(place.id));
    const second = planPlaceDuplicateRepair(remaining);
    assert.deepEqual(second.obsoletePlaceIds, []);
    assert.equal(rewriteRepairedPlaceId('home-10', first), 'home-17');
    assert.equal(rewriteRepairedPlaceId(null, first), null);
  });

  it('keeps archived Places out of the active list used by the Places screen', () => {
    const active = makePlace({ id: 'home', name: 'Home', status: 'active', createdAtMs: 1 });
    const archived = makePlace({
      id: 'gym',
      name: 'Gym',
      status: 'archived',
      createdAtMs: 2,
      center: offsetLatLng(HOME.latitude, HOME.longitude, 500, 0),
    });
    const split = partitionPlacesByStatus([archived, active]);
    assert.deepEqual(
      split.active.map((place) => place.id),
      ['home'],
    );
    assert.deepEqual(
      split.archived.map((place) => place.id),
      ['gym'],
    );
  });
});
