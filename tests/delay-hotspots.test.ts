import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import {
  computeDelayHotspots,
  HOTSPOT_CLUSTER_DIAMETER_METERS,
  HOTSPOT_ENCOUNTER_RADIUS_METERS,
  HOTSPOT_TREND_MIN_OLDER_ENCOUNTERS,
  HOTSPOT_TREND_MIN_RECENT_ENCOUNTERS,
  rankDelayHotspots,
  type HotspotAttemptInput,
} from '../src/domain/delay-hotspots';
import { haversineMeters, type LatLng } from '../src/domain/geo';
import { MILLISECONDS_PER_DAY } from '../src/domain/journey-statistics';
import { pointAtProgress } from '../src/domain/path-projection';
import type { Route } from '../src/domain/route';
import type { WaitEvent } from '../src/domain/wait-events';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const POOL = { originPlaceId: HOME.id, destinationPlaceId: WORK.id, transportationMode: 'scooter' as const };
const AS_OF = 1_800_000_000_000;

function pathEast(eastMeters: number): LatLng[] {
  const base = offsetLatLng(HOME.center.latitude, HOME.center.longitude, 0, eastMeters);
  return northPath({ startLat: base.latitude, startLng: base.longitude, points: 51, stepMeters: 20 });
}

function route(id: string, eastMeters = 0): Route {
  return makeRoute({ id, name: id, referencePath: pathEast(eastMeters), createdAtMs: 1_000 });
}

function waitAt(route: Route, progress: number, durationMs: number, startMs = 10_000): WaitEvent {
  return {
    id: `wait:${startMs}:${startMs + durationMs}`,
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    progressMeters: progress,
    coordinate: pointAtProgress(route.referencePath, progress),
    locationState: 'located',
  };
}

function unlocatedWait(durationMs: number, startMs = 50_000): WaitEvent {
  return {
    id: `wait:${startMs}:${startMs + durationMs}`,
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    progressMeters: null,
    coordinate: null,
    locationState: 'unavailable',
  };
}

function attempt(id: string, routeId: string | null, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `session-${id}`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_700_000_000_000 - 5_000,
    startedAtMs: 1_700_000_000_000,
    finishedAtMs: 1_700_000_100_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    routeId,
    originPlaceId: HOME.id,
    destinationPlaceId: WORK.id,
    transportationMode: 'scooter',
    ...overrides,
  };
}

function input(
  id: string,
  r: Route | null,
  events: WaitEvent[],
  overrides: Partial<Attempt> & { compatible?: boolean } = {},
): HotspotAttemptInput {
  const { compatible, ...attemptOverrides } = overrides;
  return {
    attempt: attempt(id, r?.id ?? null, attemptOverrides),
    route: r,
    compatible: compatible ?? r != null,
    waitEvents: events,
  };
}

function run(attempts: HotspotAttemptInput[], clusterDiameterMeters?: number) {
  return computeDelayHotspots({
    pool: POOL,
    origin: HOME,
    destination: WORK,
    attempts,
    asOfMs: AS_OF,
    clusterDiameterMeters,
  });
}

describe('delay hotspot constants', () => {
  it('documents the chosen merge/split boundary', () => {
    assert.equal(HOTSPOT_CLUSTER_DIAMETER_METERS, 30);
    assert.equal(HOTSPOT_ENCOUNTER_RADIUS_METERS, 30);
  });
});

describe('delay hotspot clustering', () => {
  it('clusters repeated waits at the same intersection', () => {
    const main = route('main');
    const result = run([
      input('a1', main, [waitAt(main, 500, 20_000)]),
      input('a2', main, [waitAt(main, 502, 30_000)]),
      input('a3', main, [waitAt(main, 498, 10_000)]),
    ]);
    assert.equal(result.hotspots.length, 1);
    const hotspot = result.hotspots[0]!;
    assert.equal(hotspot.waitedAttempts, 3);
    assert.equal(hotspot.encounteredAttempts, 3);
    assert.equal(hotspot.totalWaitMs, 60_000);
    assert.equal(hotspot.medianWaitMs, 20_000);
    assert.equal(hotspot.averageWaitMs, 20_000);
    assert.equal(hotspot.worstWaitMs, 30_000);
    assert.equal(hotspot.worstAttemptId, 'a2');
    assert.ok(hotspot.spreadMeters <= HOTSPOT_CLUSTER_DIAMETER_METERS);
    assert.ok(haversineMeters(hotspot.coordinate, pointAtProgress(main.referencePath, 500)) < 5);
  });

  it('merges a 20 m offset fixture', () => {
    const a = route('a');
    const b = route('b', 20);
    const distance = haversineMeters(pointAtProgress(a.referencePath, 500), pointAtProgress(b.referencePath, 500));
    assert.ok(distance > 19 && distance < 21);
    const result = run([
      input('a1', a, [waitAt(a, 500, 10_000)]),
      input('b1', b, [waitAt(b, 500, 10_000)]),
    ]);
    assert.equal(result.hotspots.length, 1);
    assert.equal(result.hotspots[0]!.waitedAttempts, 2);
  });

  for (const eastMeters of [40, 50, 60]) {
    it(`splits ${eastMeters} m parallel-street fixtures`, () => {
      const a = route('a');
      const b = route('b', eastMeters);
      const distance = haversineMeters(
        pointAtProgress(a.referencePath, 500),
        pointAtProgress(b.referencePath, 500),
      );
      assert.ok(distance > eastMeters - 0.2 && distance < eastMeters);
      const attempts = [
        input('a1', a, [waitAt(a, 500, 10_000)]),
        input('a2', a, [waitAt(a, 500, 10_000)]),
        input('b1', b, [waitAt(b, 500, 10_000)]),
        input('b2', b, [waitAt(b, 500, 10_000)]),
      ];
      const result = run(attempts);
      assert.equal(result.hotspots.length, 2);
      assert.deepEqual(result.hotspots.map((item) => item.waitedAttempts), [2, 2]);
      // The 40 m wait-comparison radius would have merged the 40 m pair.
      assert.equal(run(attempts, 40).hotspots.length, eastMeters === 40 ? 1 : 2);
    });
  }

  it('does not chain 400/440/480 points into one cluster', () => {
    const main = route('main');
    const attempts = [400, 440, 480].flatMap((progress, index) => [
      input(`p${progress}-1`, main, [waitAt(main, progress, 10_000)], { finishedAtMs: 1 + index }),
      input(`p${progress}-2`, main, [waitAt(main, progress, 10_000)], { finishedAtMs: 10 + index }),
    ]);
    // Default diameter: three distinct hotspots (40 m gaps exceed 30 m).
    assert.deepEqual(run(attempts).hotspots.map((item) => item.waitedAttempts), [2, 2, 2]);
    // Gaps now fit inside the diameter but the 80 m endpoints do not: single-linkage would
    // make one cluster, complete-linkage must not.
    const wide = run(attempts, 45).hotspots;
    assert.ok(wide.length >= 2);
    for (const hotspot of wide) {
      assert.ok(hotspot.spreadMeters <= 45);
    }
    const covered = wide.reduce((sum, hotspot) => sum + hotspot.eventCount, 0);
    assert.equal(covered, 6);
  });

  it('does not chain a 0/20/40 m run at the default diameter', () => {
    const main = route('main');
    const attempts = [500, 520, 540].flatMap((progress) => [
      input(`c${progress}-1`, main, [waitAt(main, progress, 10_000)]),
      input(`c${progress}-2`, main, [waitAt(main, progress, 10_000)]),
    ]);
    const hotspots = run(attempts).hotspots;
    assert.ok(hotspots.length >= 2);
    for (const hotspot of hotspots) {
      assert.ok(hotspot.spreadMeters <= HOTSPOT_CLUSTER_DIAMETER_METERS);
    }
    assert.equal(hotspots.reduce((sum, item) => sum + item.eventCount, 0), 6);
  });

  it('assigns every event to exactly one hotspot and reconciles totals', () => {
    const main = route('main');
    const attempts = [
      input('a1', main, [waitAt(main, 300, 7_000, 1_000), waitAt(main, 700, 9_000, 20_000), unlocatedWait(4_000)]),
      input('a2', main, [waitAt(main, 300, 5_000, 1_000), waitAt(main, 701, 6_000, 20_000)]),
      input('a3', main, [waitAt(main, 900, 8_000, 1_000)]),
    ];
    const result = run(attempts);
    const ids = result.hotspots.flatMap((hotspot) =>
      hotspot.contributions.flatMap((c) => c.eventIds.map((eventId) => `${c.attemptId}|${eventId}`)),
    );
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(result.hotspots.reduce((sum, h) => sum + h.eventCount, 0), 4);
    assert.equal(result.totals.locatedWaitMs, 7_000 + 9_000 + 5_000 + 6_000 + 8_000);
    assert.equal(result.totals.recurringWaitMs, 7_000 + 9_000 + 5_000 + 6_000);
    assert.equal(result.totals.oneOffWaitMs, 8_000);
    assert.equal(
      result.totals.recurringWaitMs + result.totals.oneOffWaitMs,
      result.totals.locatedWaitMs,
    );
  });
});

describe('delay hotspot attempt semantics', () => {
  it('sums multiple waits by one attempt but counts the attempt once', () => {
    const main = route('main');
    const result = run([
      input('a1', main, [waitAt(main, 500, 10_000, 1_000), waitAt(main, 505, 6_000, 40_000)]),
      input('a2', main, [waitAt(main, 500, 4_000)]),
    ]);
    const hotspot = result.hotspots[0]!;
    assert.equal(hotspot.waitedAttempts, 2);
    assert.equal(hotspot.eventCount, 3);
    assert.equal(hotspot.totalWaitMs, 20_000);
    assert.equal(hotspot.worstWaitMs, 16_000);
    assert.equal(hotspot.worstAttemptId, 'a1');
    assert.equal(hotspot.medianWaitMs, 10_000);
    assert.equal(hotspot.contributions.find((c) => c.attemptId === 'a1')?.eventCount, 2);
  });

  it('keeps opposite directions and modes out of the analysis', () => {
    const main = route('main');
    const result = run([
      input('ok1', main, [waitAt(main, 500, 10_000)]),
      input('ok2', main, [waitAt(main, 500, 10_000)]),
      input('reverse', main, [waitAt(main, 500, 99_000)], {
        originPlaceId: WORK.id,
        destinationPlaceId: HOME.id,
      }),
      input('walk', main, [waitAt(main, 500, 99_000)], { transportationMode: 'walking' }),
    ]);
    assert.equal(result.hotspots.length, 1);
    assert.equal(result.hotspots[0]!.totalWaitMs, 20_000);
    assert.equal(result.hotspots[0]!.encounteredAttempts, 2);
    assert.equal(result.totals.analyzedAttemptCount, 2);
    assert.equal(result.totals.excludedAttemptCount, 2);
  });

  it('ignores a variant whose endpoints do not match the journey', () => {
    const main = route('main');
    const far = makeRoute({
      id: 'far',
      referencePath: northPath({
        startLat: HOME.center.latitude + 0.01,
        startLng: HOME.center.longitude,
        points: 51,
        stepMeters: 20,
      }),
    });
    const result = run([
      input('ok1', main, [waitAt(main, 500, 10_000)]),
      input('ok2', main, [waitAt(main, 500, 10_000)]),
      input('far1', far, [waitAt(far, 500, 10_000)]),
    ]);
    assert.equal(result.totals.analyzedAttemptCount, 2);
  });

  it('excludes unassigned, incompatible and non-competitive attempts entirely', () => {
    const main = route('main');
    const result = run([
      input('ok1', main, [waitAt(main, 500, 10_000), unlocatedWait(3_000)]),
      input('ok2', main, [waitAt(main, 500, 10_000)]),
      input('unassigned', null, [waitAt(main, 500, 77_000), unlocatedWait(66_000)]),
      input('incompatible', main, [waitAt(main, 500, 77_000), unlocatedWait(66_000)], { compatible: false }),
      input('wrong-route', main, [waitAt(main, 500, 77_000)], { routeId: 'other' }),
      input('invalid', main, [waitAt(main, 500, 77_000)], { validity: 'invalid' }),
      input('incomplete', main, [waitAt(main, 500, 77_000)], { lifecycle: 'interrupted' }),
    ]);
    assert.equal(result.totals.analyzedAttemptCount, 2);
    assert.equal(result.hotspots[0]!.totalWaitMs, 20_000);
    assert.equal(result.hotspots[0]!.encounteredAttempts, 2);
    assert.equal(result.totals.unlocatedWaitMs, 3_000);
    assert.equal(result.totals.unlocatedAttemptCount, 1);
  });

  it('uses encountered attempts as the denominator (10/10, not 10/20)', () => {
    const mainPath = pathEast(0);
    const main = makeRoute({ id: 'main', referencePath: mainPath, createdAtMs: 1_000 });
    // Park path shares both endpoints but detours 300 m east and never passes the light.
    const parkPath = [
      HOME.center,
      offsetLatLng(HOME.center.latitude, HOME.center.longitude, 250, 300),
      offsetLatLng(HOME.center.latitude, HOME.center.longitude, 750, 300),
      WORK.center,
    ];
    const park = makeRoute({ id: 'park', referencePath: parkPath, createdAtMs: 2_000 });
    const attempts = [
      ...Array.from({ length: 10 }, (_, index) =>
        input(`main-${index}`, main, [waitAt(main, 500, 15_000)], { finishedAtMs: 1_700_000_000_000 + index }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        input(`park-${index}`, park, [], { finishedAtMs: 1_700_000_000_000 + 100 + index }),
      ),
    ];
    const result = run(attempts);
    const hotspot = result.hotspots[0]!;
    assert.equal(hotspot.waitedAttempts, 10);
    assert.equal(hotspot.encounteredAttempts, 10);
    assert.equal(hotspot.waitedRatio, 1);
    assert.equal(result.totals.analyzedAttemptCount, 20);
  });

  it('counts non-waiting attempts whose path passes the hotspot as encountered', () => {
    const main = route('main');
    const result = run([
      input('w1', main, [waitAt(main, 500, 10_000)]),
      input('w2', main, [waitAt(main, 500, 10_000)]),
      input('clear1', main, []),
      input('clear2', main, []),
    ]);
    assert.equal(result.hotspots[0]!.encounteredAttempts, 4);
    assert.equal(result.hotspots[0]!.waitedRatio, 0.5);
  });

  it('keeps unlocated waits in separate totals and never creates pins for them', () => {
    const main = route('main');
    const result = run([
      input('a1', main, [unlocatedWait(5_000), unlocatedWait(7_000, 70_000)]),
      input('a2', main, [unlocatedWait(9_000)]),
    ]);
    assert.equal(result.hotspots.length, 0);
    assert.equal(result.totals.unlocatedWaitMs, 21_000);
    assert.equal(result.totals.unlocatedEventCount, 3);
    assert.equal(result.totals.unlocatedAttemptCount, 2);
    assert.equal(result.totals.locatedWaitMs, 0);
  });
});

describe('delay hotspot determinism and trend', () => {
  it('is identical across input order and repeated runs, with stable tie-breaks', () => {
    const main = route('main');
    const other = route('other', 200);
    const attempts = [
      input('a1', main, [waitAt(main, 300, 10_000)]),
      input('a2', main, [waitAt(main, 300, 10_000)]),
      input('b1', other, [waitAt(other, 600, 10_000)]),
      input('b2', other, [waitAt(other, 600, 10_000)]),
      input('c1', main, [waitAt(main, 800, 10_000)]),
      input('c2', main, [waitAt(main, 800, 10_000)]),
    ];
    const first = run(attempts);
    const reversed = run([...attempts].reverse());
    assert.deepEqual(reversed, first);
    assert.deepEqual(run(attempts), first);
    const ids = first.hotspots.map((item) => item.id);
    assert.deepEqual(ids, [...ids].sort());
    const byFrequency = rankDelayHotspots(first.hotspots, 'frequency').map((item) => item.id);
    assert.deepEqual(byFrequency, ids);
  });

  it('ranks by total confirmed waiting, then frequency orders by ratio', () => {
    const main = route('main');
    const attempts = [
      input('a1', main, [waitAt(main, 300, 40_000)]),
      input('a2', main, [waitAt(main, 300, 40_000)]),
      input('b1', main, [waitAt(main, 800, 10_000)]),
      input('b2', main, [waitAt(main, 800, 10_000)]),
      input('b3', main, [waitAt(main, 800, 10_000)]),
    ];
    const result = run(attempts);
    assert.deepEqual(result.hotspots.map((item) => item.totalWaitMs), [80_000, 30_000]);
    const frequency = rankDelayHotspots(result.hotspots, 'frequency');
    assert.deepEqual(frequency.map((item) => item.waitedRatio), [3 / 5, 2 / 5]);
    assert.deepEqual(frequency.map((item) => item.waitedAttempts), [3, 2]);
  });

  it('only reports a trend when recent and older samples suffice', () => {
    const main = route('main');
    const day = MILLISECONDS_PER_DAY;
    const make = (count: number, ageDays: number, prefix: string, waitMs: number) =>
      Array.from({ length: count }, (_, index) =>
        input(`${prefix}${index}`, main, waitMs > 0 ? [waitAt(main, 500, waitMs)] : [], {
          startedAtMs: AS_OF - ageDays * day - 60_000 + index,
          finishedAtMs: AS_OF - ageDays * day + index,
        }),
      );
    assert.equal(HOTSPOT_TREND_MIN_RECENT_ENCOUNTERS, 3);
    assert.equal(HOTSPOT_TREND_MIN_OLDER_ENCOUNTERS, 3);

    const enough = run([...make(3, 100, 'old', 10_000), ...make(3, 2, 'new', 40_000)]);
    const trend = enough.hotspots[0]!.trend;
    assert.ok(trend);
    assert.equal(trend.direction, 'worse');
    assert.equal(trend.recentEncountered, 3);
    assert.equal(trend.recentMeanWaitMs, 40_000);
    assert.equal(trend.allTimeMeanWaitMs, 25_000);

    const better = run([...make(3, 100, 'old', 40_000), ...make(3, 2, 'new', 10_000)]);
    assert.equal(better.hotspots[0]!.trend?.direction, 'better');

    const steady = run([...make(3, 100, 'old', 20_000), ...make(3, 2, 'new', 20_000)]);
    assert.equal(steady.hotspots[0]!.trend?.direction, 'steady');

    const fewRecent = run([...make(5, 100, 'old', 20_000), ...make(2, 2, 'new', 20_000)]);
    assert.equal(fewRecent.hotspots[0]!.trend, null);
    const fewOlder = run([...make(2, 100, 'old', 20_000), ...make(4, 2, 'new', 20_000)]);
    assert.equal(fewOlder.hotspots[0]!.trend, null);
  });

  it('does not mutate its inputs', () => {
    const main = route('main');
    const attempts = [
      input('a1', main, [waitAt(main, 500, 10_000)]),
      input('a2', main, [waitAt(main, 500, 10_000)]),
    ];
    const before = JSON.stringify(attempts);
    run(attempts);
    assert.equal(JSON.stringify(attempts), before);
  });
});
