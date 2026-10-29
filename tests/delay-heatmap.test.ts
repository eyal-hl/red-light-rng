import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import {
  clampHeatIntensity,
  delayHeatViewState,
  heatRawValue,
  HEAT_MAX_FEATURES,
  HEAT_MIN_RADIUS_METERS,
  nearestRankPercentile,
  prepareDelayHeat,
} from '../src/domain/delay-heatmap';
import {
  computeDelayHotspots,
  rankDelayHotspots,
  type DelayHotspot,
  type DelayHotspotAnalysis,
  type HotspotAttemptInput,
} from '../src/domain/delay-hotspots';
import type { LatLng } from '../src/domain/geo';
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

function run(attempts: HotspotAttemptInput[], pool = POOL) {
  return computeDelayHotspots({ pool, origin: HOME, destination: WORK, attempts, asOfMs: AS_OF });
}


describe('delay heat preparation', () => {
  const main = route('main');

  it('repeated waits at one location produce one deterministic heat feature', () => {
    const attempts = [
      input('a1', main, [waitAt(main, 500, 20_000)]),
      input('a2', main, [waitAt(main, 500, 30_000)]),
    ];
    const two = prepareDelayHeat(run(attempts), 'frequency')!;
    const three = prepareDelayHeat(
      run([...attempts, input('a3', main, [waitAt(main, 500, 10_000)])]),
      'frequency',
    )!;
    assert.equal(two.features.length, 1);
    assert.equal(two.features[0]!.rawValue, 2);
    assert.equal(three.features[0]!.rawValue, 3);
    assert.deepEqual(prepareDelayHeat(run(attempts), 'frequency'), two);
    assert.equal(two.features[0]!.radiusMeters, HEAT_MIN_RADIUS_METERS);
  });

  it('one long wait changes total-wait intensity but not frequency', () => {
    const build = (longMs: number) =>
      run([
        input('a1', main, [waitAt(main, 300, 10_000), waitAt(main, 800, 10_000, 90_000)]),
        input('a2', main, [waitAt(main, 300, 10_000), waitAt(main, 800, longMs, 90_000)]),
        input('a3', main, [waitAt(main, 300, 10_000)]),
      ]);
    const calm = build(10_000);
    const long = build(300_000);
    const freq = (a: typeof calm) => prepareDelayHeat(a, 'frequency')!.features.map((f) => [f.hotspotId, f.rawValue, f.intensity]);
    assert.deepEqual(freq(calm), freq(long));
    const totalCalm = prepareDelayHeat(calm, 'total')!;
    const totalLong = prepareDelayHeat(long, 'total')!;
    assert.notDeepEqual(
      totalCalm.features.map((f) => f.rawValue),
      totalLong.features.map((f) => f.rawValue),
    );
    for (const f of totalLong.features) {
      assert.ok(f.intensity > 0 && f.intensity <= 1);
    }
    // Frequency does not get fabricated by the long wait.
    assert.ok(totalLong.features.every((f) => f.waitedAttempts === 2 || f.waitedAttempts === 3));
  });

  it('frequency and total modes are semantically distinct', () => {
    const analysis = run([
      input('a1', main, [waitAt(main, 300, 5_000), waitAt(main, 800, 60_000, 90_000)]),
      input('a2', main, [waitAt(main, 300, 5_000), waitAt(main, 800, 60_000, 90_000)]),
      input('a3', main, [waitAt(main, 300, 5_000)]),
    ]);
    const freq = prepareDelayHeat(analysis, 'frequency')!;
    const total = prepareDelayHeat(analysis, 'total')!;
    assert.equal(freq.features[0]!.waitedAttempts, 3);
    assert.equal(total.features[0]!.waitedAttempts, 2);
    assert.notEqual(freq.features[0]!.hotspotId, total.features[0]!.hotspotId);
    assert.equal(freq.features[0]!.rawValue, 3);
    assert.equal(total.features[0]!.rawValue, 120_000);
    // Raw values for the summary are preserved in both modes.
    assert.equal(freq.features[0]!.totalWaitMs, 15_000);
  });

  it('unlocated events create no heat and report text totals only', () => {
    const analysis = run([
      input('a1', main, [unlocatedWait(40_000), waitAt(main, 500, 10_000)]),
      input('a2', main, [unlocatedWait(40_000), waitAt(main, 500, 10_000)]),
    ]);
    const heat = prepareDelayHeat(analysis, 'total')!;
    assert.equal(heat.features.length, 1);
    assert.equal(heat.features[0]!.totalWaitMs, 20_000);
    assert.equal(heat.unlocatedWaitMs, 80_000);
    const onlyUnlocated = run([
      input('a1', main, [unlocatedWait(40_000)]),
      input('a2', main, [unlocatedWait(40_000)]),
    ]);
    assert.equal(prepareDelayHeat(onlyUnlocated, 'total'), null);
  });

  it('one-off waits create no heat', () => {
    const analysis = run([
      input('a1', main, [waitAt(main, 300, 10_000), waitAt(main, 700, 10_000, 90_000)]),
      input('a2', main, [waitAt(main, 300, 10_000)]),
    ]);
    const heat = prepareDelayHeat(analysis, 'frequency')!;
    assert.equal(heat.features.length, 1);
    assert.equal(heat.oneOffWaitMs, 10_000);
  });

  it('keeps directions and modes separate', () => {
    const reverse = { ...POOL, originPlaceId: WORK.id, destinationPlaceId: HOME.id };
    const forward = [
      input('f1', main, [waitAt(main, 500, 10_000)]),
      input('f2', main, [waitAt(main, 500, 10_000)]),
    ];
    const wrongDirection = (id: string) =>
      input(id, main, [waitAt(main, 500, 10_000)], { originPlaceId: WORK.id, destinationPlaceId: HOME.id });
    const wrongMode = (id: string) =>
      input(id, main, [waitAt(main, 500, 10_000)], { transportationMode: 'walk' });
    const analysis = run([
      input('a1', main, [waitAt(main, 500, 10_000)]),
      wrongDirection('d1'),
      wrongDirection('d2'),
      wrongMode('m1'),
      wrongMode('m2'),
    ]);
    assert.equal(analysis.totals.analyzedAttemptCount, 1);
    assert.equal(prepareDelayHeat(analysis, 'frequency'), null);
    const swapped = computeDelayHotspots({
      pool: reverse,
      origin: WORK,
      destination: HOME,
      attempts: forward,
      asOfMs: AS_OF,
    });
    assert.equal(swapped.totals.analyzedAttemptCount, 0);
    assert.equal(prepareDelayHeat(swapped, 'frequency'), null);
  });

  it('different valid paths contribute geographically', () => {
    const a = route('a');
    const b = route('b', 20);
    const heat = prepareDelayHeat(
      run([input('a1', a, [waitAt(a, 500, 10_000)]), input('b1', b, [waitAt(b, 500, 10_000)])]),
      'frequency',
    )!;
    assert.equal(heat.features.length, 1);
    assert.equal(heat.features[0]!.waitedAttempts, 2);
  });

  it('depends only on the analysis, not on raw GPS sample counts', () => {
    const analysis = run([
      input('a1', main, [waitAt(main, 500, 10_000)]),
      input('a2', main, [waitAt(main, 500, 10_000)]),
    ]);
    const clone = JSON.parse(JSON.stringify(analysis));
    assert.deepEqual(prepareDelayHeat(clone, 'total'), prepareDelayHeat(analysis, 'total'));
  });

  it('bounds features for large histories without changing totals', () => {
    const attempts: HotspotAttemptInput[] = [];
    const routes = [route('r0', 0), route('r1', 40)];
    let n = 0;
    for (const r of routes) {
      for (const id of ['a', 'b']) {
        const events: WaitEvent[] = [];
        for (let p = 50; p <= 950; p += 33) {
          events.push(waitAt(r, p, 10_000 + n * 50, 10_000 + events.length * 30_000));
        }
        attempts.push(input(`${r.id}-${id}`, r, events));
      }
      n += 1;
    }
    const analysis = run(attempts);
    const before = JSON.stringify(analysis);
    const heat = prepareDelayHeat(analysis, 'total')!;
    assert.ok(heat.recurringCount > HEAT_MAX_FEATURES, String(heat.recurringCount));
    assert.equal(heat.features.length, HEAT_MAX_FEATURES);
    assert.equal(heat.capped, true);
    assert.equal(JSON.stringify(analysis), before);
    const raws = heat.features.map((f) => f.rawValue);
    assert.deepEqual(raws, [...raws].sort((x, y) => y - x));
    assert.deepEqual(prepareDelayHeat(analysis, 'total'), heat);
  });

  it('is unaffected by attempt timing, PB and validity inputs', () => {
    const attempts = [
      input('a1', main, [waitAt(main, 500, 10_000)]),
      input('a2', main, [waitAt(main, 500, 10_000)]),
    ];
    const snapshot = JSON.stringify(attempts);
    const analysis = run(attempts);
    prepareDelayHeat(analysis, 'frequency');
    prepareDelayHeat(analysis, 'total');
    assert.equal(JSON.stringify(attempts), snapshot);
  });

  it('ties on the raw value break by the existing #74 ranking, not by id', () => {
    const base = run([
      input('a1', main, [waitAt(main, 300, 10_000), waitAt(main, 800, 10_000, 90_000)]),
      input('a2', main, [waitAt(main, 300, 10_000), waitAt(main, 800, 10_000, 90_000)]),
    ]);
    const template = base.hotspots[0]!;
    // Ids chosen so plain id order (a < c < m < z) differs from the ranking order.
    const withHotspots = (specs: Array<[string, Partial<DelayHotspot>]>): DelayHotspotAnalysis => ({
      ...base,
      hotspots: specs.map(([id, over]) => ({ ...template, id, ...over })),
    });
    const assertTieOrder = (
      analysis: DelayHotspotAnalysis,
      mode: 'frequency' | 'total',
      tiedIds: string[],
    ) => {
      const prepared = prepareDelayHeat(analysis, mode)!;
      const tiedValue = heatRawValue(
        analysis.hotspots.find((h) => h.id === tiedIds[0])!,
        mode,
      );
      const preparedTied = prepared.features
        .filter((f) => tiedIds.includes(f.hotspotId))
        .map((f) => f.hotspotId);
      const ranked = rankDelayHotspots(analysis.hotspots, mode)
        .filter((h) => tiedIds.includes(h.id))
        .map((h) => h.id);
      for (const f of prepared.features.filter((f) => tiedIds.includes(f.hotspotId))) {
        assert.equal(f.rawValue, tiedValue);
      }
      assert.deepEqual(preparedTied, ranked);
      assert.notDeepEqual(preparedTied, [...preparedTied].sort());
      return prepared;
    };

    // total: all three tie on totalWaitMs; waitedAttempts 3 wins, then worstWaitMs 40k > 30k.
    const totalAnalysis = withHotspots([
      ['hotspot:m', { totalWaitMs: 90_000, waitedAttempts: 4, waitedRatio: 1, worstWaitMs: 50_000 }],
      ['hotspot:z', { totalWaitMs: 60_000, waitedAttempts: 3, waitedRatio: 0.6, worstWaitMs: 20_000 }],
      ['hotspot:c', { totalWaitMs: 60_000, waitedAttempts: 2, waitedRatio: 0.5, worstWaitMs: 40_000 }],
      ['hotspot:a', { totalWaitMs: 60_000, waitedAttempts: 2, waitedRatio: 0.4, worstWaitMs: 30_000 }],
    ]);
    const totalOrder = assertTieOrder(totalAnalysis, 'total', ['hotspot:z', 'hotspot:c', 'hotspot:a']);
    assert.deepEqual(
      totalOrder.features.map((f) => f.hotspotId),
      ['hotspot:m', 'hotspot:z', 'hotspot:c', 'hotspot:a'],
    );

    // frequency: all three tie on waitedAttempts; waitedRatio 0.9 wins, then ratio 0.5 with totalWaitMs 50k > 40k.
    const frequencyAnalysis = withHotspots([
      ['hotspot:m', { waitedAttempts: 4, waitedRatio: 1, totalWaitMs: 90_000, worstWaitMs: 50_000 }],
      ['hotspot:z', { waitedAttempts: 2, waitedRatio: 0.9, totalWaitMs: 10_000, worstWaitMs: 5_000 }],
      ['hotspot:c', { waitedAttempts: 2, waitedRatio: 0.5, totalWaitMs: 50_000, worstWaitMs: 30_000 }],
      ['hotspot:a', { waitedAttempts: 2, waitedRatio: 0.5, totalWaitMs: 40_000, worstWaitMs: 20_000 }],
    ]);
    const frequencyOrder = assertTieOrder(frequencyAnalysis, 'frequency', [
      'hotspot:z',
      'hotspot:c',
      'hotspot:a',
    ]);
    assert.deepEqual(
      frequencyOrder.features.map((f) => f.hotspotId),
      ['hotspot:m', 'hotspot:z', 'hotspot:c', 'hotspot:a'],
    );
  });
});

describe('delay heat clamp', () => {
  it('uses nearest-rank P90 and caps at 1', () => {
    assert.equal(nearestRankPercentile([], 0.9), 0);
    assert.equal(nearestRankPercentile([5], 0.9), 5);
    assert.equal(nearestRankPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 0.9), 9);
    assert.equal(clampHeatIntensity(100, 9), 1);
    assert.equal(clampHeatIntensity(4.5, 9), 0.5);
  });

  it('handles all-equal, single and zero values', () => {
    assert.equal(clampHeatIntensity(7, 7), 1);
    assert.equal(clampHeatIntensity(0, 0), 0);
    assert.equal(clampHeatIntensity(3, 0), 1);
    assert.equal(clampHeatIntensity(-1, 5), 0);
  });

  it('one extreme wait does not flatten the other hotspots', () => {
    const main = route('main');
    const spots = Array.from({ length: 11 }, (_, i) => 100 + i * 80);
    const mk = (id: string) =>
      input(
        id,
        main,
        spots.map((p, i) => waitAt(main, p, i === 10 ? 600_000 : 10_000, 10_000 + i * 700_000)),
      );
    const heat = prepareDelayHeat(run([mk('a1'), mk('a2')]), 'total')!;
    assert.equal(heat.features.length, 11);
    assert.equal(heat.scaleReference, 20_000);
    assert.ok(heat.features.every((f) => f.intensity === 1));
    assert.equal(heat.features[0]!.rawValue, 1_200_000);
  });
});

describe('delay heat view state', () => {
  const main = route('main');
  const one = run([input('a1', main, [waitAt(main, 500, 10_000)])]);
  const ready = run([
    input('a1', main, [waitAt(main, 500, 10_000)]),
    input('a2', main, [waitAt(main, 500, 10_000)]),
  ]);

  it('shows loading while hotspots are not ready, never not-enough-history', () => {
    assert.equal(delayHeatViewState('idle', null, 'total').kind, 'loading');
    assert.equal(delayHeatViewState('loading', null, 'total').kind, 'loading');
    assert.equal(delayHeatViewState('error', null, 'total').kind, 'unavailable');
  });

  it('is not-enough-history for a single attempt or no recurring hotspot', () => {
    assert.equal(delayHeatViewState('ready', one, 'total').kind, 'not-enough-history');
    const noRecurring = run([
      input('a1', main, [waitAt(main, 300, 10_000)]),
      input('a2', main, [waitAt(main, 700, 10_000)]),
    ]);
    assert.equal(delayHeatViewState('ready', noRecurring, 'total').kind, 'not-enough-history');
    assert.equal(delayHeatViewState('ready', ready, 'total').kind, 'ready');
  });
});
