import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import { CORRIDOR_WIDTH_METERS } from '../src/domain/course-matching';
import {
  aggregateDelayHotspots,
  DELAY_HOTSPOT_DIAMETER_METERS,
  DELAY_HOTSPOT_TIGHT_SPREAD_METERS,
  MAX_VISIBLE_DELAY_HOTSPOTS,
  rankDelayHotspots,
  type DelayHotspotAnalysis,
  type DelayHotspotAttemptInput,
  type DelayHotspotRouteInput,
} from '../src/domain/delay-hotspots';
import { haversineMeters, pathDistanceMeters, type LatLng } from '../src/domain/geo';
import type { JourneyPoolId } from '../src/domain/journey';
import { MILLISECONDS_PER_DAY } from '../src/domain/journey-statistics';
import { pointAtProgress } from '../src/domain/path-projection';
import type { LocationSample } from '../src/domain/location-sample';
import type { WaitEvent } from '../src/domain/wait-events';
import { WAIT_COMPARISON_LOCATION_RADIUS_METERS } from '../src/domain/wait-comparison';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const POOL: JourneyPoolId = {
  originPlaceId: 'home',
  destinationPlaceId: 'work',
  transportationMode: 'scooter',
};

const AS_OF_MS = 1_700_000_000_000;

function path(): LatLng[] {
  return northPath({ points: 40, stepMeters: 20 });
}

function parallelPath(reference: LatLng[], eastMeters: number): LatLng[] {
  return reference.map((point) => offsetLatLng(point.latitude, point.longitude, 0, eastMeters));
}

function locatedWait(
  id: string,
  coordinate: LatLng,
  durationMs: number,
  progressMeters = 100,
): WaitEvent {
  return {
    id,
    startMs: 0,
    endMs: durationMs,
    durationMs,
    progressMeters,
    coordinate,
    locationState: 'located',
  };
}

function unlocatedWait(id: string, durationMs: number, coordinate: LatLng | null = null): WaitEvent {
  return {
    id,
    startMs: 0,
    endMs: durationMs,
    durationMs,
    progressMeters: null,
    coordinate,
    locationState: 'unavailable',
  };
}

function attempt(
  id: string,
  routeId: string | null,
  waitEvents: WaitEvent[],
  overrides: Partial<DelayHotspotAttemptInput> = {},
): DelayHotspotAttemptInput {
  return {
    attemptId: id,
    finishedAtMs: AS_OF_MS - 86_400_000,
    originPlaceId: POOL.originPlaceId,
    destinationPlaceId: POOL.destinationPlaceId,
    transportationMode: POOL.transportationMode,
    routeId,
    analysisTrustworthy: true,
    waitEvents,
    ...overrides,
  };
}

function route(routeId: string, referencePath: readonly LatLng[]): DelayHotspotRouteInput {
  return { routeId, referencePath };
}

function analyze(
  attempts: DelayHotspotAttemptInput[],
  routes: DelayHotspotRouteInput[],
  asOfMs = AS_OF_MS,
): DelayHotspotAnalysis {
  return aggregateDelayHotspots({ pool: POOL, attempts, routes, asOfMs });
}

function eventIds(analysis: DelayHotspotAnalysis): string[] {
  return analysis.hotspots.flatMap((hotspot) =>
    hotspot.attempts.flatMap((share) => share.eventIds.map((eventId) => `${share.attemptId}|${eventId}`)),
  );
}

describe('delay hotspots', () => {
  it('documents a 35 m complete-linkage diameter below the 40 m wait-comparison radius', () => {
    assert.equal(DELAY_HOTSPOT_DIAMETER_METERS, 35);
    assert.equal(DELAY_HOTSPOT_DIAMETER_METERS, CORRIDOR_WIDTH_METERS);
    assert.ok(DELAY_HOTSPOT_DIAMETER_METERS < WAIT_COMPARISON_LOCATION_RADIUS_METERS);
    assert.equal(MAX_VISIBLE_DELAY_HOTSPOTS, 3);
    const source = readFileSync('src/domain/delay-hotspots.ts', 'utf8');
    assert.match(source, /complete-linkage/i);
    assert.doesNotMatch(source, /selectJourneyPathVariant|listSamples|expo-location/);
  });

  it('clusters repeated waits at the same intersection and keeps a distinct intersection separate', () => {
    const reference = path();
    const sameA = pointAtProgress(reference, 200);
    const sameB = pointAtProgress(reference, 208);
    const distinct = pointAtProgress(reference, 280);
    assert.ok(haversineMeters(sameA, sameB) < DELAY_HOTSPOT_TIGHT_SPREAD_METERS);
    assert.ok(haversineMeters(sameA, distinct) > DELAY_HOTSPOT_DIAMETER_METERS);
    const analysis = analyze(
      [
        attempt('a1', 'main', [locatedWait('w1', sameA, 10_000, 200)]),
        attempt('a2', 'main', [locatedWait('w2', sameB, 12_000, 208)]),
        attempt('a3', 'main', [locatedWait('w3', distinct, 9_000, 280)]),
      ],
      [route('main', reference)],
    );
    assert.equal(analysis.hotspots.length, 2);
    const repeated = analysis.hotspots.find((hotspot) => hotspot.memberEventIds.includes('w1'));
    assert.ok(repeated);
    assert.deepEqual(repeated.memberEventIds, ['w1', 'w2']);
    assert.equal(repeated.confidence, 'tight');
    assert.ok(repeated.spreadMeters <= DELAY_HOTSPOT_DIAMETER_METERS);
    assert.equal(repeated.waitedAttempts, 2);
    assert.equal(analysis.hotspots.find((hotspot) => hotspot.memberEventIds.includes('w3'))?.waitedAttempts, 1);
  });

  it('splits 40 m, 50 m, and 60 m parallel paths and merges a 20 m pair', () => {
    const reference = path();
    for (const eastMeters of [40, 50, 60]) {
      const other = parallelPath(reference, eastMeters);
      const mainPoint = pointAtProgress(reference, 200);
      const otherPoint = pointAtProgress(other, 200);
      const separation = haversineMeters(mainPoint, otherPoint);
      assert.ok(
        separation > DELAY_HOTSPOT_DIAMETER_METERS,
        `expected ${eastMeters} m parallels to exceed the hotspot diameter, got ${separation}`,
      );
      if (eastMeters === 50) {
        assert.ok(separation > 40 && separation < 60, `discovery-scale split was ${separation}`);
      }
      const analysis = analyze(
        [
          attempt('main-run', 'main', [locatedWait('main-wait', mainPoint, 10_000, 200)]),
          attempt('other-run', 'other', [locatedWait('other-wait', otherPoint, 10_000, 200)]),
        ],
        [route('main', reference), route('other', other)],
      );
      assert.equal(analysis.hotspots.length, 2, `${eastMeters} m parallels must stay separate`);
      assert.ok(analysis.hotspots.every((hotspot) => hotspot.spreadMeters <= DELAY_HOTSPOT_DIAMETER_METERS));
    }

    const close = parallelPath(reference, 20);
    const mainPoint = pointAtProgress(reference, 200);
    const closePoint = pointAtProgress(close, 200);
    const closeSeparation = haversineMeters(mainPoint, closePoint);
    assert.ok(closeSeparation <= DELAY_HOTSPOT_DIAMETER_METERS);
    const merged = analyze(
      [
        attempt('main-run', 'main', [locatedWait('main-wait', mainPoint, 10_000, 200)]),
        attempt('close-run', 'close', [locatedWait('close-wait', closePoint, 8_000, 200)]),
      ],
      [route('main', reference), route('close', close)],
    );
    assert.equal(merged.hotspots.length, 1);
    assert.ok(merged.hotspots[0]!.spreadMeters <= DELAY_HOTSPOT_DIAMETER_METERS);
  });

  it('does not collapse a 400 / 440 / 480 chain or a tighter chain whose endpoints exceed the diameter', () => {
    const reference = path();
    const chain = [400, 440, 480].map((progress) => ({
      progress,
      coordinate: pointAtProgress(reference, progress),
    }));
    for (let index = 1; index < chain.length; index += 1) {
      const gap = haversineMeters(chain[index - 1]!.coordinate, chain[index]!.coordinate);
      assert.ok(gap > DELAY_HOTSPOT_DIAMETER_METERS, `adjacent chain gap ${gap} should exceed the diameter`);
    }
    const wide = analyze(
      chain.map((point, index) =>
        attempt(`chain-${index}`, 'main', [locatedWait(`e-${point.progress}`, point.coordinate, 10_000, point.progress)]),
      ),
      [route('main', reference)],
    );
    assert.equal(wide.hotspots.length, 3);
    assert.ok(wide.hotspots.every((hotspot) => hotspot.spreadMeters <= DELAY_HOTSPOT_DIAMETER_METERS));
    const endpointIds = new Set(
      wide.hotspots.filter((hotspot) => hotspot.memberEventIds.some((id) => id === 'e-400' || id === 'e-480')).map((hotspot) => hotspot.id),
    );
    assert.equal(endpointIds.size, 2);

    const tight = [0, 30, 60, 90, 120].map((progress) => ({
      progress,
      coordinate: pointAtProgress(reference, progress),
    }));
    assert.ok(haversineMeters(tight[0]!.coordinate, tight[1]!.coordinate) <= DELAY_HOTSPOT_DIAMETER_METERS);
    assert.ok(haversineMeters(tight[0]!.coordinate, tight[tight.length - 1]!.coordinate) > DELAY_HOTSPOT_DIAMETER_METERS);
    const bounded = analyze(
      tight.map((point) =>
        attempt(`tight-${point.progress}`, 'main', [
          locatedWait(`t-${point.progress}`, point.coordinate, 10_000, point.progress),
        ]),
      ),
      [route('main', reference)],
    );
    assert.ok(bounded.hotspots.length >= 3);
    assert.ok(bounded.hotspots.every((hotspot) => hotspot.spreadMeters <= DELAY_HOTSPOT_DIAMETER_METERS + 1e-6));
    const containsEnd = bounded.hotspots.filter((hotspot) =>
      hotspot.memberEventIds.some((id) => id === 't-0' || id === 't-120'),
    );
    assert.equal(containsEnd.length, 2);
    assert.ok(containsEnd.every((hotspot) => !(hotspot.memberEventIds.includes('t-0') && hotspot.memberEventIds.includes('t-120'))));
  });

  it('assigns every located event to one hotspot and sums repeated waits on one attempt once', () => {
    const reference = path();
    const point = pointAtProgress(reference, 200);
    const nearby = pointAtProgress(reference, 205);
    const analysis = analyze(
      [
        attempt('repeat', 'main', [
          locatedWait('first', point, 10_000, 200),
          locatedWait('second', nearby, 20_000, 205),
        ]),
        attempt('other', 'main', [locatedWait('third', point, 5_000, 200)]),
      ],
      [route('main', reference)],
    );
    assert.equal(analysis.hotspots.length, 1);
    const hotspot = analysis.hotspots[0]!;
    const identities = eventIds(analysis);
    assert.equal(new Set(identities).size, identities.length);
    assert.equal(identities.length, 3);
    assert.equal(hotspot.waitedAttempts, 2);
    assert.equal(hotspot.totalConfirmedWaitMs, 35_000);
    const repeated = hotspot.attempts.find((share) => share.attemptId === 'repeat');
    assert.deepEqual(repeated?.eventIds, ['first', 'second']);
    assert.equal(repeated?.confirmedWaitMs, 30_000);
    assert.equal(hotspot.averageWaitMs, 17_500);
    assert.equal(hotspot.medianWaitMs, (30_000 + 5_000) / 2);
    assert.equal(hotspot.worstWaitMs, 20_000);
  });

  it('counts frequency over encountered compatible paths, not the whole pool or waiters only', () => {
    const main = path();
    const park = parallelPath(main, 120);
    const light = pointAtProgress(main, 240);
    assert.ok(haversineMeters(light, pointAtProgress(park, 240)) > DELAY_HOTSPOT_DIAMETER_METERS);
    const mainWaits = Array.from({ length: 10 }, (_, index) =>
      attempt(`main-${index}`, 'main', [locatedWait(`wait-${index}`, light, 8_000, 240)]),
    );
    const parkPasses = Array.from({ length: 10 }, (_, index) => attempt(`park-${index}`, 'park', []));
    const samePathPasses = Array.from({ length: 5 }, (_, index) => attempt(`pass-${index}`, 'main', []));
    const separated = analyze([...mainWaits, ...parkPasses], [route('main', main), route('park', park)]);
    assert.equal(separated.hotspots.length, 1);
    assert.equal(separated.hotspots[0]!.waitedAttempts, 10);
    assert.equal(separated.hotspots[0]!.encounteredAttempts, 10);
    assert.equal(separated.hotspots[0]!.frequency, 1);
    assert.notEqual(separated.hotspots[0]!.encounteredAttempts, 20);

    const withPassers = analyze([...mainWaits, ...samePathPasses], [route('main', main), route('park', park)]);
    assert.equal(withPassers.hotspots[0]!.waitedAttempts, 10);
    assert.equal(withPassers.hotspots[0]!.encounteredAttempts, 15);
    assert.equal(withPassers.hotspots[0]!.frequency, 10 / 15);
  });

  it('keeps opposite directions, other modes, and unassigned attempts out of the hotspot', () => {
    const reference = path();
    const light = pointAtProgress(reference, 180);
    const analysis = analyze(
      [
        attempt('home-work', 'main', [locatedWait('kept', light, 10_000)]),
        attempt('work-home', 'return', [locatedWait('opposite', light, 50_000)], {
          originPlaceId: POOL.destinationPlaceId,
          destinationPlaceId: POOL.originPlaceId,
        }),
        attempt('walk', 'walk', [locatedWait('walked', light, 40_000)], {
          transportationMode: 'walk',
        }),
        attempt('unassigned', null, [locatedWait('loose', light, 30_000)]),
        attempt('untrustworthy', 'main', [locatedWait('ignored', light, 70_000)], {
          analysisTrustworthy: false,
        }),
      ],
      [route('main', reference), route('return', reference), route('walk', reference)],
    );
    assert.equal(analysis.hotspots.length, 1);
    assert.equal(analysis.hotspots[0]!.totalConfirmedWaitMs, 10_000);
    assert.equal(analysis.hotspots[0]!.waitedAttempts, 1);
    assert.equal(analysis.unlocatedConfirmedWaitMs, 0);
    assert.equal(analysis.trustworthyAttemptCount, 1);
    assert.deepEqual(eventIds(analysis), ['home-work|kept']);
  });

  it('does not treat equal progress on different variants as the same place', () => {
    const main = path();
    const other = parallelPath(main, 55);
    const progress = 400;
    const analysis = analyze(
      [
        attempt('main-run', 'main', [locatedWait('main-wait', pointAtProgress(main, progress), 10_000, progress)]),
        attempt('other-run', 'other', [locatedWait('other-wait', pointAtProgress(other, progress), 10_000, progress)]),
      ],
      [route('main', main), route('other', other)],
    );
    assert.equal(analysis.hotspots.length, 2);
  });

  it('keeps location-unavailable waits in an unlocated total and never gives them a marker', () => {
    const reference = path();
    const light = pointAtProgress(reference, 160);
    const fake = pointAtProgress(reference, 500);
    const analysis = analyze(
      [
        attempt('mixed', 'main', [
          locatedWait('real', light, 12_000, 160),
          unlocatedWait('missing', 9_000, fake),
        ]),
      ],
      [route('main', reference)],
    );
    assert.equal(analysis.hotspots.length, 1);
    assert.equal(analysis.hotspots[0]!.totalConfirmedWaitMs, 12_000);
    assert.equal(analysis.unlocatedConfirmedWaitMs, 9_000);
    assert.ok(haversineMeters(analysis.hotspots[0]!.coordinate, fake) > DELAY_HOTSPOT_DIAMETER_METERS);
    assert.equal(analysis.hotspots[0]!.totalConfirmedWaitMs + analysis.unlocatedConfirmedWaitMs, 21_000);
  });

  it('reconciles hotspot totals with source events and repeats after reordered input', () => {
    const reference = path();
    const light = pointAtProgress(reference, 150);
    const elsewhere = pointAtProgress(reference, 360);
    const attempts = [
      attempt('a', 'main', [locatedWait('a1', light, 10_000, 150), unlocatedWait('a-missing', 4_000)]),
      attempt('b', 'main', [locatedWait('b1', pointAtProgress(reference, 154), 6_000, 154)]),
      attempt('c', 'main', [locatedWait('c1', elsewhere, 8_000, 360)]),
      attempt('other-pool', 'main', [locatedWait('nope', light, 100_000)], {
        transportationMode: 'bicycle',
      }),
    ];
    const routes = [route('main', reference)];
    const first = analyze(attempts, routes);
    const reversed = analyze(
      [...attempts].reverse().map((item) => ({ ...item, waitEvents: [...item.waitEvents].reverse() })),
      routes,
    );
    assert.deepEqual(first, reversed);
    const located = first.hotspots.reduce((sum, hotspot) => sum + hotspot.totalConfirmedWaitMs, 0);
    assert.equal(located + first.unlocatedConfirmedWaitMs, 10_000 + 4_000 + 6_000 + 8_000);
    assert.equal(eventIds(first).length, 3);
    const snapshot = structuredClone(attempts);
    analyze(attempts, routes);
    assert.deepEqual(attempts, snapshot);
  });

  it('reports a 30-day recent signal only when enough encountered attempts exist', () => {
    const reference = path();
    const light = pointAtProgress(reference, 200);
    const oldFinished = AS_OF_MS - 40 * MILLISECONDS_PER_DAY;
    const recentFinished = AS_OF_MS - MILLISECONDS_PER_DAY;
    const attempts = [
      ...Array.from({ length: 4 }, (_, index) =>
        attempt(`old-${index}`, 'main', [locatedWait(`old-wait-${index}`, light, 10_000)], {
          finishedAtMs: oldFinished - index,
        }),
      ),
      attempt('recent-wait', 'main', [locatedWait('recent-wait-event', light, 20_000)], {
        finishedAtMs: recentFinished,
      }),
      attempt('recent-pass', 'main', [], { finishedAtMs: recentFinished - 1 }),
    ];
    const analysis = analyze(attempts, [route('main', reference)]);
    const hotspot = analysis.hotspots[0]!;
    assert.equal(hotspot.waitedAttempts, 5);
    assert.equal(hotspot.encounteredAttempts, 6);
    assert.ok(hotspot.recent);
    assert.equal(hotspot.recent.windowDays, 30);
    assert.equal(hotspot.recent.encounteredAttempts, 2);
    assert.equal(hotspot.recent.waitedAttempts, 1);
    assert.equal(hotspot.recent.frequency, 0.5);
    assert.equal(hotspot.recent.versusAllTime, 'less-often');

    const sparse = analyze(
      [
        attempt('only-recent', 'main', [locatedWait('one', light, 10_000)], { finishedAtMs: recentFinished }),
        attempt('old', 'main', [locatedWait('two', light, 10_000)], { finishedAtMs: oldFinished }),
      ],
      [route('main', reference)],
    );
    assert.equal(sparse.hotspots[0]!.recent, null);
  });

  it('ranks frequent delays and worst waits without calling one a loss versus PB', () => {
    const reference = path();
    const often = pointAtProgress(reference, 100);
    const rare = pointAtProgress(reference, 300);
    const analysis = analyze(
      [
        ...Array.from({ length: 4 }, (_, index) =>
          attempt(`often-${index}`, 'main', [locatedWait(`often-${index}`, often, 5_000)]),
        ),
        attempt('rare', 'main', [locatedWait('rare-wait', rare, 40_000)]),
        attempt('passer', 'main', []),
      ],
      [route('main', reference)],
    );
    const frequent = rankDelayHotspots(analysis.hotspots, 'frequency');
    const worst = rankDelayHotspots(analysis.hotspots, 'worst');
    assert.equal(frequent[0]!.waitedAttempts, 4);
    assert.equal(worst[0]!.worstWaitMs, 40_000);
    assert.deepEqual(frequent.slice(0, MAX_VISIBLE_DELAY_HOTSPOTS).length, Math.min(MAX_VISIBLE_DELAY_HOTSPOTS, frequent.length));
    const ui = readFileSync('src/ui/JourneyDelayHotspots.tsx', 'utf8');
    assert.match(ui, /Most frequent/);
    assert.match(ui, /Worst waits/);
    assert.doesNotMatch(ui, /time lost|vs PB/i);
    assert.doesNotMatch(ui, /listSamples/);
  });
});

describe('journey delay hotspot loading', () => {
  it('keeps journey first paint sample-free and derives hotspots from the assigned variant afterward', async () => {
    const reference = northPath({ points: 41, stepMeters: 20, startLat: 32.08, startLng: 34.78 });
    const home = {
      id: 'place-home',
      name: 'Home',
      center: reference[0]!,
      radiusMeters: 40,
      status: 'active' as const,
      createdAtMs: 1,
    };
    const work = {
      id: 'place-work',
      name: 'Work',
      center: reference[reference.length - 1]!,
      radiusMeters: 40,
      status: 'active' as const,
      createdAtMs: 2,
    };
    const pool: JourneyPoolId = {
      originPlaceId: home.id,
      destinationPlaceId: work.id,
      transportationMode: 'scooter',
    };
    const { workspace, sessions, routes, attempts, places } = createMemoryWorkspace({
      now: () => 1_700_000_000_000,
    });
    await places.createPlace(home);
    await places.createPlace(work);
    const variant = makeRoute({
      id: 'main',
      name: 'Main',
      sourceRecordingId: 'route-source-main',
      referencePath: reference,
      startZone: { center: home.center, radiusMeters: 40 },
      finishZone: { center: work.center, radiusMeters: 40 },
    });
    await routes.createRoute(variant);
    const samples = commuteWithBoundedWaits(reference, {
      sessionId: 'session-wait',
      startMs: 1_699_000_000_000,
      waits: [{ progressMeters: 80, durationMs: 30_000 }],
    });
    const startedAtMs = samples[0]!.recordedAtMs;
    const finishedAtMs = samples[samples.length - 1]!.recordedAtMs;
    sessions.seedSession(
      {
        id: 'session-wait',
        startedAtMs,
        stoppedAtMs: finishedAtMs,
        isActive: false,
        purpose: 'attempt',
        captureOutcome: 'finished',
        reviewDisposition: 'saved',
        lastSampleAtMs: finishedAtMs,
        backgroundPermissionConfirmed: true,
      },
      samples,
    );
    const waited = completedAttempt('waited', {
      sessionId: 'session-wait',
      routeId: 'main',
      originPlaceId: home.id,
      destinationPlaceId: work.id,
      startedAtMs,
      finishedAtMs,
    });
    await attempts.createAttempt(waited);
    await attempts.createAttempt(
      completedAttempt('unassigned', {
        sessionId: 'session-unassigned',
        routeId: null,
        originPlaceId: home.id,
        destinationPlaceId: work.id,
        startedAtMs,
        finishedAtMs: startedAtMs + 60_000,
      }),
    );
    await attempts.createAttempt(
      completedAttempt('opposite', {
        sessionId: 'session-opposite',
        routeId: 'main',
        originPlaceId: work.id,
        destinationPlaceId: home.id,
        startedAtMs,
        finishedAtMs: startedAtMs + 60_000,
      }),
    );

    workspace.resetNavigationLoad();
    const loaded = await workspace.loadJourney(pool);
    assert.ok(loaded);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);
    const pbTimeMs = loaded.statistics.pbTimeMs;
    const pbAttemptId = loaded.statistics.pbAttemptId;
    assert.equal(loaded.summary.rankedAttemptCount, 2);

    const analysis = await workspace.loadJourneyDelayHotspots(pool);
    assert.ok(analysis);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 1);
    assert.ok(analysis.hotspots.length >= 1);
    assert.ok(analysis.hotspots.some((hotspot) => hotspot.attempts.some((share) => share.attemptId === 'waited')));
    assert.ok(analysis.hotspots.every((hotspot) => hotspot.attempts.every((share) => share.attemptId === 'waited')));
    assert.equal(analysis.hotspots[0]!.coordinate == null, false);

    const again = await workspace.loadJourneyDelayHotspots(pool);
    assert.deepEqual(again, analysis);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 1);

    const reloaded = await workspace.loadJourney(pool);
    assert.equal(reloaded?.statistics.pbTimeMs, pbTimeMs);
    assert.equal(reloaded?.statistics.pbAttemptId, pbAttemptId);
    assert.equal(reloaded?.summary.rankedAttemptCount, 2);
    const stored = await attempts.getAttempt('waited');
    assert.equal(stored?.validity, 'valid');
    assert.equal(stored?.finishedAtMs, finishedAtMs);

    const workspaceSource = readFileSync('src/product/route-workspace.ts', 'utf8');
    const method = workspaceSource.slice(
      workspaceSource.indexOf('async loadJourneyDelayHotspots'),
      workspaceSource.indexOf('private async listAttemptSamples'),
    );
    assert.match(method, /isCompatiblePathVariant/);
    assert.match(method, /attempt\.routeId/);
    assert.doesNotMatch(method, /selectJourneyPathVariant/);
    const journeyMethod = workspaceSource.slice(
      workspaceSource.indexOf('async loadJourney('),
      workspaceSource.indexOf('async loadJourneyDelayHotspots'),
    );
    assert.doesNotMatch(journeyMethod, /listAttemptSamples|loadJourneyDelayHotspots/);

    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    const appRoot = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    assert.match(detail, /waitMarkers/);
    assert.doesNotMatch(detail, /listSamples/);
    const loadJourneyFn = appRoot.slice(appRoot.indexOf('const loadJourney = useCallback'), appRoot.indexOf('const openReview'));
    const readyAt = loadJourneyFn.indexOf('setJourneySnapshotReady(true)');
    const hydrateAt = loadJourneyFn.indexOf('loadJourneyDelayHotspots');
    assert.ok(readyAt >= 0 && hydrateAt > readyAt);
  });
});

function completedAttempt(id: string, overrides: Partial<Attempt>): Attempt {
  return {
    id,
    sessionId: `session-${id}`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 2_000,
    finishedAtMs: 12_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    routeId: null,
    originPlaceId: 'place-home',
    destinationPlaceId: 'place-work',
    transportationMode: 'scooter',
    ...overrides,
  };
}

function commuteWithBoundedWaits(
  reference: LatLng[],
  options: {
    sessionId: string;
    startMs: number;
    waits: { progressMeters: number; durationMs: number }[];
  },
): LocationSample[] {
  const length = pathDistanceMeters(reference);
  const stepMeters = 4;
  const intervalMs = 1000;
  const samples: LocationSample[] = [];
  let timeMs = options.startMs;
  let progress = 0;
  let waitIndex = 0;
  let id = 0;
  const remainingWaits = [...options.waits].sort((left, right) => left.progressMeters - right.progressMeters);
  while (progress <= length) {
    const point = pointAtProgress(reference, Math.min(progress, length));
    samples.push(
      sample({
        id: `${options.sessionId}-${id}`,
        sessionId: options.sessionId,
        recordedAtMs: timeMs,
        latitude: point.latitude,
        longitude: point.longitude,
        speedMetersPerSecond: 4,
        horizontalAccuracyMeters: 6,
      }),
    );
    id += 1;
    const nextWait = remainingWaits[waitIndex];
    if (nextWait && progress + stepMeters > nextWait.progressMeters) {
      const stop = pointAtProgress(reference, nextWait.progressMeters);
      timeMs += nextWait.durationMs;
      samples.push(
        sample({
          id: `${options.sessionId}-${id}`,
          sessionId: options.sessionId,
          recordedAtMs: timeMs,
          latitude: stop.latitude,
          longitude: stop.longitude,
          speedMetersPerSecond: 0,
          horizontalAccuracyMeters: 6,
        }),
      );
      id += 1;
      waitIndex += 1;
    }
    progress += stepMeters;
    timeMs += intervalMs;
  }
  return samples;
}
