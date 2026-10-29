import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import { HOTSPOT_DEFAULT_VISIBLE_COUNT, visibleDelayHotspots } from '../src/domain/delay-hotspots';
import { delayHotspotMapMarkers } from '../src/map/hotspot-display';
import { JourneyFocusStoppedError } from '../src/domain/journey-analysis';
import type { JourneyPoolId } from '../src/domain/journey';
import type { LocationSample } from '../src/domain/location-sample';
import { pointAtProgress } from '../src/domain/path-projection';
import {
  journeyHotspotsViewFor,
  shouldHydrateJourneyHotspots,
  type JourneyHotspotsState,
} from '../src/product/journey-navigation';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const POOL: JourneyPoolId = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter',
};
const PATH = northPath({
  startLat: HOME.center.latitude,
  startLng: HOME.center.longitude,
  points: 51,
  stepMeters: 20,
});
const START_MS = 1_700_000_000_000;

/** Drive along PATH, stand still for `waitSeconds` at `waitProgress`, then finish. */
function tripSamples(sessionId: string, waitProgress: number, waitSeconds: number): LocationSample[] {
  const stepsBefore = Math.round(waitProgress / 8);
  const before = traceAlongPath(PATH, { sessionId, startMs: START_MS, stepMeters: 8, count: stepsBefore + 1 });
  const stop = pointAtProgress(PATH, stepsBefore * 8);
  const wait = Array.from({ length: waitSeconds }, (_, index) =>
    sample({
      id: `${sessionId}-wait-${index}`,
      sessionId,
      recordedAtMs: START_MS + (stepsBefore + 1 + index) * 1000,
      latitude: stop.latitude,
      longitude: stop.longitude,
      speedMetersPerSecond: 0,
    }),
  );
  const resumeMs = START_MS + (stepsBefore + 1 + waitSeconds) * 1000;
  const remaining = Math.ceil((1000 - stepsBefore * 8) / 8) + 4;
  const after = traceAlongPath(PATH, {
    sessionId,
    startMs: resumeMs,
    startProgressMeters: stepsBefore * 8 + 8,
    stepMeters: 8,
    count: remaining,
  }).map((item, index) => ({ ...item, id: `${sessionId}-after-${index}` }));
  return [...before, ...wait, ...after];
}

function attemptFor(id: string, samples: LocationSample[], overrides: Partial<Attempt> = {}): Attempt {
  const last = samples[samples.length - 1]!;
  return {
    id,
    sessionId: `session-${id}`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: START_MS - 5_000,
    startedAtMs: START_MS,
    finishedAtMs: last.recordedAtMs,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    routeId: 'route-main',
    originPlaceId: HOME.id,
    destinationPlaceId: WORK.id,
    transportationMode: 'scooter',
    ...overrides,
  };
}

async function setup(count = 3, extra: { unassigned?: boolean } = {}) {
  const ctx = createMemoryWorkspace();
  await ctx.places.createPlace(HOME);
  await ctx.places.createPlace(WORK);
  await ctx.routes.createRoute(makeRoute({ id: 'route-main', referencePath: PATH, name: 'Main' }));
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `trip-${index}`;
    const samples = tripSamples(`session-${id}`, 480, 14).map((item) => ({
      ...item,
      sessionId: `session-${id}`,
    }));
    const attempt = attemptFor(id, samples);
    ctx.sessions.seedSession(
      {
        id: attempt.sessionId,
        startedAtMs: samples[0]!.recordedAtMs,
        stoppedAtMs: samples[samples.length - 1]!.recordedAtMs,
        isActive: false,
        purpose: 'attempt',
        captureOutcome: 'finished',
        reviewDisposition: 'saved',
        lastSampleAtMs: samples[samples.length - 1]!.recordedAtMs,
        backgroundPermissionConfirmed: true,
      },
      samples,
    );
    await ctx.attempts.createAttempt(attempt);
    ids.push(id);
  }
  if (extra.unassigned) {
    const id = 'trip-unassigned';
    const samples = tripSamples(`session-${id}`, 480, 14).map((item) => ({
      ...item,
      sessionId: `session-${id}`,
    }));
    const attempt = attemptFor(id, samples, { routeId: null });
    ctx.sessions.seedSession(
      {
        id: attempt.sessionId,
        startedAtMs: samples[0]!.recordedAtMs,
        stoppedAtMs: samples[samples.length - 1]!.recordedAtMs,
        isActive: false,
        purpose: 'attempt',
        captureOutcome: 'finished',
        reviewDisposition: 'saved',
        lastSampleAtMs: samples[samples.length - 1]!.recordedAtMs,
        backgroundPermissionConfirmed: true,
      },
      samples,
    );
    await ctx.attempts.createAttempt(attempt);
  }
  return { ...ctx, ids };
}

describe('journey delay hotspot hydration', () => {
  it('first paint of journey detail reads zero raw samples; hotspots hydrate afterwards', async () => {
    const { workspace } = await setup(3);
    workspace.resetNavigationLoad();

    const loaded = await workspace.loadJourney(POOL);
    assert.ok(loaded);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);

    const analysis = await workspace.analyzeJourneyHotspots(POOL);
    assert.ok(analysis);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 3);
    assert.equal(analysis.hotspots.length, 1);
    const hotspot = analysis.hotspots[0]!;
    assert.equal(hotspot.waitedAttempts, 3);
    assert.equal(hotspot.encounteredAttempts, 3);
    assert.ok(hotspot.totalWaitMs >= 3 * 10_000);
    assert.ok(Math.abs(hotspot.coordinate.latitude - pointAtProgress(PATH, 480).latitude) < 0.0003);
  });

  it('caches the hydrated result and reloads identically', async () => {
    const { workspace } = await setup(3);
    const first = await workspace.analyzeJourneyHotspots(POOL);
    const callsAfterFirst = workspace.navigationLoad.counters.listSamplesCalls;
    const second = await workspace.analyzeJourneyHotspots(POOL);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, callsAfterFirst);
    assert.equal(workspace.navigationLoad.counters.analyzeHotspotsHits, 1);
    assert.equal(second, first);

    const fresh = await setup(3);
    const reloaded = await fresh.workspace.analyzeJourneyHotspots(POOL);
    assert.deepEqual(reloaded, first);
  });

  it('excludes unassigned attempts and never mutates attempts, PB or official timing', async () => {
    const { workspace, attempts } = await setup(3, { unassigned: true });
    const attemptsBefore = JSON.stringify(await attempts.listAttempts());
    const journeyBefore = await workspace.loadJourney(POOL);

    const analysis = await workspace.analyzeJourneyHotspots(POOL);
    assert.ok(analysis);
    assert.equal(analysis.totals.analyzedAttemptCount, 3);
    assert.equal(analysis.hotspots[0]!.encounteredAttempts, 3);

    assert.equal(JSON.stringify(await attempts.listAttempts()), attemptsBefore);
    const journeyAfter = await workspace.loadJourney(POOL);
    assert.equal(journeyAfter?.summary.pbAttemptId, journeyBefore?.summary.pbAttemptId);
    assert.equal(journeyAfter?.summary.pbTimeMs, journeyBefore?.summary.pbTimeMs);
    assert.deepEqual(journeyAfter?.history, journeyBefore?.history);
  });

  it('stops promptly when the screen no longer wants the result', async () => {
    const { workspace } = await setup(3);
    await assert.rejects(
      () => workspace.analyzeJourneyHotspots(POOL, { shouldContinue: () => false }),
      JourneyFocusStoppedError,
    );
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);
  });

  it('returns null for an unknown journey', async () => {
    const { workspace } = await setup(1);
    assert.equal(
      await workspace.analyzeJourneyHotspots({ ...POOL, destinationPlaceId: 'missing' }),
      null,
    );
  });
});

describe('journey hotspot hydration gate', () => {
  const idle: JourneyHotspotsState = { status: 'idle' };

  it('waits for the shell, never re-hydrates, and ignores another journey', () => {
    assert.equal(shouldHydrateJourneyHotspots({ snapshotReady: false, pool: POOL, state: idle }), false);
    assert.equal(shouldHydrateJourneyHotspots({ snapshotReady: true, pool: POOL, state: idle }), true);
    const loading: JourneyHotspotsState = { status: 'loading', pool: POOL };
    assert.equal(shouldHydrateJourneyHotspots({ snapshotReady: true, pool: POOL, state: loading }), false);
    const other = { ...POOL, destinationPlaceId: 'elsewhere' };
    assert.equal(journeyHotspotsViewFor(loading, other).status, 'idle');
    assert.equal(shouldHydrateJourneyHotspots({ snapshotReady: true, pool: other, state: loading }), true);
  });
});

describe('journey hotspot presentation', () => {
  it('caps the default list, expands on demand and pins only located recurring hotspots', async () => {
    const { workspace } = await setup(3);
    const analysis = await workspace.analyzeJourneyHotspots(POOL);
    const template = analysis!.hotspots[0]!;
    const many = Array.from({ length: HOTSPOT_DEFAULT_VISIBLE_COUNT + 2 }, (_, index) => ({
      ...template,
      id: `hotspot:${index}`,
    }));
    assert.equal(visibleDelayHotspots(many, false).length, HOTSPOT_DEFAULT_VISIBLE_COUNT);
    assert.equal(visibleDelayHotspots(many, true).length, many.length);
    const markers = delayHotspotMapMarkers(analysis!.hotspots);
    assert.equal(markers.length, 1);
    assert.equal(markers[0]!.id, template.id);
    assert.equal(markers[0]!.label, '3/3');
    assert.deepEqual(markers[0]!.point, template.coordinate);
  });

  it('hydrates in an effect gated on the ready shell with no blocking spinner', () => {
    const root = readFileSync(new URL('../src/ui/AppRoot.tsx', import.meta.url), 'utf8');
    const effect = root.slice(root.indexOf('Deferred hotspot hydration'));
    assert.match(effect.slice(0, 400), /!journeySnapshotReady/);
    assert.match(effect, /workspace\s*\.analyzeJourneyHotspots/);
    assert.ok(!root.slice(0, root.indexOf('Deferred hotspot hydration')).includes('analyzeJourneyHotspots'));
    const section = readFileSync(new URL('../src/ui/JourneyDelayHotspots.tsx', import.meta.url), 'utf8');
    assert.ok(!section.includes('ActivityIndicator'));
    const screen = readFileSync(new URL('../src/ui/JourneyDetailScreen.tsx', import.meta.url), 'utf8');
    assert.ok(!screen.includes('ActivityIndicator'));
  });
});
