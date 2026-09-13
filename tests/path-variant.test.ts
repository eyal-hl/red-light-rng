import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findCompatiblePathVariant,
  routeEndpointsMatchJourney,
  selectJourneyPathVariant,
} from '../src/domain/path-variant';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 300, 0),
  createdAtMs: 2,
});
const GYM = makePlace({
  id: 'place-gym',
  name: 'Gym',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 0, 400),
  createdAtMs: 3,
});
const CAFE = makePlace({
  id: 'place-cafe',
  name: 'Cafe',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 400, 400),
  createdAtMs: 4,
});

function homeWorkRoute(overrides: Parameters<typeof makeRoute>[0] = {}) {
  return makeRoute({
    id: 'route-hw',
    name: 'Home → Work',
    transportationMode: 'scooter',
    createdAtMs: 100,
    referencePath: northPath({
      startLat: HOME.center.latitude,
      startLng: HOME.center.longitude,
      points: 8,
      stepMeters: 40,
    }),
    startZone: { center: HOME.center, radiusMeters: 30 },
    finishZone: { center: WORK.center, radiusMeters: 30 },
    ...overrides,
  });
}

describe('journey path-variant selection', () => {
  it('attaches a variant only when endpoints and mode match the journey', () => {
    const route = homeWorkRoute();
    assert.equal(routeEndpointsMatchJourney(route, HOME, WORK, 'scooter'), true);
    assert.equal(selectJourneyPathVariant([route], HOME, WORK, 'scooter')?.id, route.id);
  });

  it('does not attach a Home → Work variant to Work → Home or another pool', () => {
    const route = homeWorkRoute();
    assert.equal(selectJourneyPathVariant([route], WORK, HOME, 'scooter'), null);
    assert.equal(selectJourneyPathVariant([route], HOME, WORK, 'walk'), null);
    assert.equal(selectJourneyPathVariant([route], GYM, CAFE, 'scooter'), null);
  });

  it('does not fall back to an unrelated first route when name or latitude heuristics miss', () => {
    const homeWork = homeWorkRoute();
    const gymCafe = makeRoute({
      id: 'route-gc',
      name: 'Scenic loop',
      transportationMode: 'scooter',
      createdAtMs: 50,
      startZone: { center: GYM.center, radiusMeters: 30 },
      finishZone: { center: CAFE.center, radiusMeters: 30 },
    });
    const eastWest = makeRoute({
      id: 'route-ew',
      name: 'Home → Work',
      transportationMode: 'scooter',
      createdAtMs: 10,
      startZone: {
        center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 0, 300),
        radiusMeters: 30,
      },
      finishZone: {
        center: offsetLatLng(WORK.center.latitude, WORK.center.longitude, 0, 300),
        radiusMeters: 30,
      },
    });

    assert.equal(selectJourneyPathVariant([homeWork, gymCafe], GYM, CAFE, 'scooter')?.id, gymCafe.id);
    assert.equal(selectJourneyPathVariant([homeWork], WORK, HOME, 'scooter'), null);
    assert.equal(selectJourneyPathVariant([eastWest, homeWork], HOME, WORK, 'scooter')?.id, homeWork.id);
    assert.equal(selectJourneyPathVariant([eastWest], HOME, WORK, 'scooter'), null);
  });

  it('picks the oldest active variant when several belong to the same pool', () => {
    const older = homeWorkRoute({ id: 'route-old', createdAtMs: 20 });
    const newer = homeWorkRoute({ id: 'route-new', createdAtMs: 80 });
    const archivedOlder = homeWorkRoute({ id: 'route-archived', createdAtMs: 10, status: 'archived' });
    assert.equal(selectJourneyPathVariant([newer, older], HOME, WORK, 'scooter')?.id, older.id);
    assert.equal(selectJourneyPathVariant([archivedOlder, newer], HOME, WORK, 'scooter')?.id, newer.id);
  });

  it('assigns a unique compatible variant and leaves dual matches unassigned', () => {
    const main = homeWorkRoute({ id: 'route-main' });
    const samples = traceAlongPath(main.referencePath, {
      sessionId: 'attempt-main',
      startMs: 1_000,
      stepMeters: 8,
      count: 40,
    });
    const window = { startedAtMs: 1_000, finishedAtMs: 1_000 + 39_000 };
    assert.equal(
      findCompatiblePathVariant([main], HOME, WORK, 'scooter', samples, window)?.id,
      main.id,
    );

    const parallelPath = northPath({
      startLat: HOME.center.latitude,
      startLng: HOME.center.longitude,
      points: 8,
      stepMeters: 40,
    }).map((point) => offsetLatLng(point.latitude, point.longitude, 0, 50));
    const parallel = homeWorkRoute({
      id: 'route-parallel',
      createdAtMs: 200,
      referencePath: parallelPath,
      startZone: { center: parallelPath[0]!, radiusMeters: 30 },
      finishZone: { center: parallelPath[parallelPath.length - 1]!, radiusMeters: 30 },
    });
    const overlap = traceAlongPath(main.referencePath, {
      sessionId: 'attempt-overlap',
      startMs: 1_000,
      stepMeters: 8,
      count: 40,
      eastJitterMeters: 25,
    });
    assert.equal(
      findCompatiblePathVariant([main, parallel], HOME, WORK, 'scooter', overlap, window),
      null,
    );
  });
});
