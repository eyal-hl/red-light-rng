import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ATTEMPT_MAP_CURRENT_MAX_AGE_MS,
  ATTEMPT_MAP_NEARBY_PLACE_LIMIT,
  anchorOutsideCameraBounds,
  nextAttemptMapViewMode,
  presentAttemptLiveMap,
  sameAttemptLocationSample,
  sameAttemptPlaces,
  shouldFollowActiveAttemptCamera,
  shouldRefitAttemptCamera,
  shouldRenderAttemptMap,
  shouldSnapActiveAttemptCamera,
} from '../src/domain/attempt-live-map';
import { MAX_SAMPLE_ACCURACY_METERS } from '../src/domain/course-matching';
import { haversineMeters, type LatLng } from '../src/domain/geo';
import type { GpsReadiness } from '../src/domain/gps-readiness';
import type { LocationSample } from '../src/domain/location-sample';
import type { Place } from '../src/domain/place';
import type { PlaceStartZoneStatus } from '../src/domain/place-timing';
import { courseCameraBounds } from '../src/map/course-camera-bounds';
import { departureOnlySamples, makePlace, sampleAt } from './helpers/places';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = { latitude: 32.08, longitude: 34.78 };
const NOW = 1_700_000_000_000;

const LOCATING: PlaceStartZoneStatus = {
  status: 'locating',
  placeId: null,
  placeName: null,
  distanceMeters: null,
  overlapTieBreak: null,
};

function readiness(state: GpsReadiness['state'], meters: number | null = null): GpsReadiness {
  return { state, horizontalAccuracyMeters: meters };
}

function placeAt(id: string, name: string, northMeters: number, radiusMeters = 40): Place {
  return makePlace({
    id,
    name,
    radiusMeters,
    center: offsetLatLng(HOME.latitude, HOME.longitude, northMeters, 0),
  });
}

function fix(point: LatLng, recordedAtMs: number, accuracy: number | null = 8): LocationSample {
  return sampleAt(point, {
    sessionId: 'session',
    recordedAtMs,
    accuracyMeters: accuracy,
    id: `fix-${recordedAtMs}`,
  });
}

function present(input: {
  lifecycle?: 'armed' | 'active';
  sample?: LocationSample | null;
  gps?: GpsReadiness;
  places?: Place[];
  status?: PlaceStartZoneStatus;
  nowMs?: number;
}) {
  return presentAttemptLiveMap({
    lifecycle: input.lifecycle ?? 'armed',
    latestSample: input.sample === undefined ? fix(HOME, NOW) : input.sample,
    sampleGpsReadiness: input.gps ?? readiness('good', 8),
    places: input.places ?? [],
    startZoneStatus: input.status ?? LOCATING,
    nowMs: input.nowMs ?? NOW,
  });
}

describe('attempt live map display', () => {
  it('shows a current marker only for a fresh accurate sample', () => {
    const fresh = present({ nowMs: NOW + ATTEMPT_MAP_CURRENT_MAX_AGE_MS });
    assert.equal(fresh.marker.confidence, 'current');
    assert.equal(fresh.marker.label, '±8 m');
    assert.equal(fresh.marker.horizontalAccuracyMeters, 8);
    assert.equal(fresh.interactive, true);
    assert.equal(fresh.statusNote, '±8 m');

    const stale = present({ nowMs: NOW + ATTEMPT_MAP_CURRENT_MAX_AGE_MS + 1 });
    assert.equal(stale.marker.confidence, 'last-known');
    assert.equal(stale.marker.label, 'Last known 15s ago · ±8 m');
    assert.equal(stale.emphasizesInsidePlace, false);
  });

  it('degrades a poor fix and hides a missing or waiting fix', () => {
    const poor = present({
      gps: readiness('poor', MAX_SAMPLE_ACCURACY_METERS + 1),
      sample: fix(HOME, NOW, MAX_SAMPLE_ACCURACY_METERS + 1),
      status: { ...LOCATING, status: 'locating' },
    });
    assert.equal(poor.marker.confidence, 'last-known');
    assert.match(poor.marker.label ?? '', /Last known/);
    assert.match(poor.marker.label ?? '', /±46 m/);
    assert.equal(poor.emphasizesInsidePlace, false);

    const missing = present({ sample: null, gps: readiness('waiting') });
    assert.equal(missing.marker.confidence, 'hidden');
    assert.equal(missing.anchor, null);
    assert.equal(missing.statusNote, 'Waiting for GPS location');

    const waiting = present({
      sample: fix(HOME, NOW, 6),
      gps: readiness('waiting', 6),
      status: { ...LOCATING },
    });
    assert.equal(waiting.marker.confidence, 'hidden');
    assert.equal(waiting.marker.point, null);
    assert.ok(waiting.anchor);
    assert.equal(waiting.statusNote, 'Waiting for GPS location');
    assert.equal(waiting.emphasizesInsidePlace, false);
  });

  it('labels a null-accuracy fresh fix without an accuracy circle value', () => {
    const model = present({
      sample: { ...fix(HOME, NOW, 8), horizontalAccuracyMeters: null },
      gps: readiness('good', null),
    });
    assert.equal(model.marker.confidence, 'current');
    assert.equal(model.marker.label, 'Current location');
    assert.equal(model.marker.horizontalAccuracyMeters, null);
  });

  it('emphasizes only the canonical inside place and uses the configured radius', () => {
    const home = placeAt('home', 'Home', 0, 30);
    const work = placeAt('work', 'Work', 200, 55);
    const inside = present({
      places: [home, work],
      status: {
        status: 'inside',
        placeId: home.id,
        placeName: 'Home',
        distanceMeters: 4,
        overlapTieBreak: 'nearest',
      },
    });
    assert.equal(inside.emphasizesInsidePlace, true);
    assert.equal(inside.places.find((place) => place.id === home.id)?.emphasized, true);
    assert.equal(inside.places.find((place) => place.id === work.id)?.emphasized, false);
    assert.equal(inside.places.find((place) => place.id === home.id)?.radiusMeters, 30);
    assert.equal(inside.places.find((place) => place.id === work.id)?.radiusMeters, 55);

    const outside = present({
      places: [home, work],
      status: {
        status: 'outside',
        placeId: null,
        placeName: null,
        distanceMeters: 80,
        overlapTieBreak: null,
      },
    });
    assert.equal(outside.emphasizesInsidePlace, false);
    assert.equal(outside.places.every((place) => !place.emphasized), true);
  });

  it('frames the user and the three nearest places within 3 km', () => {
    const near = [
      placeAt('a', 'A', 100),
      placeAt('b', 'B', 250),
      placeAt('c', 'C', 800),
      placeAt('d', 'D', 1_500),
    ];
    const far = placeAt('far', 'Far', 20_000, 80);
    const model = present({ sample: fix(HOME, NOW, 5), places: [...near, far] });
    assert.deepEqual(model.nearbyPlaceIds, ['a', 'b', 'c']);
    assert.equal(model.nearbyPlaceIds.length, ATTEMPT_MAP_NEARBY_PLACE_LIMIT);
    assert.equal(model.places.some((place) => place.id === 'far'), true);
    assert.equal(model.places.some((place) => place.id === 'd'), true);
    assert.equal(model.distantPlacesNote, 'Other saved places are outside this view.');
    assert.equal(
      model.viewportPoints.some(
        (point) => point.latitude === far.center.latitude && point.longitude === far.center.longitude,
      ),
      false,
    );
    const [west, south, east, north] = courseCameraBounds(model.viewportPoints);
    assert.ok(far.center.latitude < south || far.center.latitude > north || far.center.longitude < west || far.center.longitude > east);
    assert.ok(haversineMeters(HOME, far.center) > 3_000);
  });

  it('breaks nearby ties by place id and reports no saved places', () => {
    const tied = ['b', 'd', 'a', 'c'].map((id) =>
      makePlace({ id, name: id.toUpperCase(), center: { ...HOME } }),
    );
    const model = present({ places: tied });
    assert.deepEqual(model.nearbyPlaceIds, ['a', 'b', 'c']);
    assert.equal(model.places.length, 4);

    const empty = present({ sample: null, gps: readiness('waiting'), places: [] });
    assert.equal(empty.emptyPlacesNote, 'No saved places yet.');
    assert.equal(empty.distantPlacesNote, null);
    assert.equal(empty.places.length, 0);
  });

  it('keeps the active map passive and does not follow a manual armed pan', () => {
    const active = present({ lifecycle: 'active' });
    assert.equal(active.interactive, false);

    assert.equal(
      nextAttemptMapViewMode({
        mode: 'auto',
        interactive: true,
        userInteraction: true,
        recenterRequested: false,
      }),
      'manual',
    );
    assert.equal(
      nextAttemptMapViewMode({
        mode: 'manual',
        interactive: true,
        userInteraction: false,
        recenterRequested: false,
      }),
      'manual',
    );
    assert.equal(
      nextAttemptMapViewMode({
        mode: 'manual',
        interactive: true,
        userInteraction: false,
        recenterRequested: true,
      }),
      'auto',
    );
    assert.equal(
      nextAttemptMapViewMode({
        mode: 'auto',
        interactive: false,
        userInteraction: true,
        recenterRequested: false,
      }),
      'auto',
    );
    assert.equal(
      shouldRefitAttemptCamera({
        mode: 'manual',
        hasAnchor: true,
        initialHadAnchor: false,
        caughtUp: false,
      }),
      false,
    );
    assert.equal(
      shouldRefitAttemptCamera({
        mode: 'auto',
        hasAnchor: true,
        initialHadAnchor: true,
        caughtUp: false,
      }),
      false,
    );
    assert.equal(
      shouldRefitAttemptCamera({
        mode: 'auto',
        hasAnchor: true,
        initialHadAnchor: false,
        caughtUp: false,
      }),
      true,
    );
    assert.equal(
      shouldRefitAttemptCamera({
        mode: 'auto',
        hasAnchor: true,
        initialHadAnchor: false,
        caughtUp: true,
      }),
      false,
    );

    const framed = courseCameraBounds([HOME]);
    assert.equal(anchorOutsideCameraBounds(HOME, framed), false);
    assert.equal(
      anchorOutsideCameraBounds({ latitude: HOME.latitude + 1, longitude: HOME.longitude }, framed),
      true,
    );
    assert.equal(
      shouldFollowActiveAttemptCamera({
        interactive: false,
        hasAnchor: true,
        anchorOutsideFrame: true,
      }),
      true,
    );
    assert.equal(
      shouldFollowActiveAttemptCamera({
        interactive: false,
        hasAnchor: true,
        anchorOutsideFrame: false,
      }),
      false,
    );
    assert.equal(
      shouldFollowActiveAttemptCamera({
        interactive: true,
        hasAnchor: true,
        anchorOutsideFrame: true,
      }),
      false,
    );
    assert.equal(
      shouldFollowActiveAttemptCamera({
        interactive: false,
        hasAnchor: false,
        anchorOutsideFrame: true,
      }),
      false,
    );
    assert.equal(shouldSnapActiveAttemptCamera({ interactive: false, wasInteractive: true }), true);
    assert.equal(shouldSnapActiveAttemptCamera({ interactive: false, wasInteractive: false }), false);
    assert.equal(shouldSnapActiveAttemptCamera({ interactive: true, wasInteractive: true }), false);
  });

  it('renders the map only while the app is active', () => {
    assert.equal(shouldRenderAttemptMap('active'), true);
    assert.equal(shouldRenderAttemptMap('background'), false);
    assert.equal(shouldRenderAttemptMap('inactive'), false);
    assert.equal(shouldRenderAttemptMap('unknown'), false);
  });

  it('treats unchanged samples and places as the same map source', () => {
    const sample = fix(HOME, NOW, 8);
    assert.equal(sameAttemptLocationSample(sample, { ...sample, speedMetersPerSecond: 1 }), true);
    assert.equal(sameAttemptLocationSample(sample, { ...sample, horizontalAccuracyMeters: 9 }), false);
    const home = placeAt('home', 'Home', 0, 30);
    assert.equal(sameAttemptPlaces([home], [{ ...home, center: { ...home.center } }]), true);
    assert.equal(sameAttemptPlaces([home], [{ ...home, radiusMeters: 31 }]), false);
  });
});

describe('attempt live map runtime source', () => {
  it('reads the marker and place set from the existing attempt stream', async () => {
    const now = { value: NOW };
    const ctx = createMemoryWorkspace({ now: () => now.value });
    const home = await ctx.workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    const work = await ctx.workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(HOME.latitude, HOME.longitude, 300, 0),
      radiusMeters: 45,
    });
    const gym = await ctx.workspace.createPlace({
      name: 'Gym',
      center: offsetLatLng(HOME.latitude, HOME.longitude, 4_000, 0),
      radiusMeters: 25,
    });
    assert.equal(home.ok && work.ok && gym.ok, true);
    if (!home.ok || !work.ok || !gym.ok) {
      return;
    }
    await ctx.workspace.archivePlace(gym.place.id);
    const started = await ctx.workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const open = await ctx.attempts.getOpenAttempt();
    assert.ok(open);
    if (!open) {
      return;
    }
    await ctx.attempts.saveAttempt({ ...open, originPlaceId: gym.place.id });
    await ctx.sessions.appendSamples([
      sampleAt(offsetLatLng(HOME.latitude, HOME.longitude, 120, 0), {
        sessionId: started.attempt.sessionId,
        recordedAtMs: NOW,
        accuracyMeters: 12,
        id: 'older',
      }),
      sampleAt(HOME, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: NOW + 1_000,
        accuracyMeters: 12,
        id: 'latest',
      }),
    ]);

    let listCalls = 0;
    const original = ctx.places.listActivePlaces.bind(ctx.places);
    ctx.places.listActivePlaces = async () => {
      listCalls += 1;
      return original();
    };
    const processed = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(listCalls, 1);
    assert.equal(ctx.platform.getCurrentPositionCalls, 0);
    assert.equal(ctx.platform.startUpdatesCalls, 1);
    assert.equal(processed.latestSample?.id, 'latest');
    assert.equal(processed.latestSample?.latitude, HOME.latitude);
    assert.equal(processed.sampleGpsReadiness.state, 'good');
    assert.equal(processed.gpsReadiness.state, 'good');
    assert.equal(processed.startZoneStatus.status, 'inside');
    assert.equal(processed.attempt?.lifecycle, 'armed');
    assert.equal(processed.attempt?.startedAtMs, null);
    const ids = processed.effectivePlaces.map((place) => place.id).sort();
    assert.deepEqual(ids, [gym.place.id, home.place.id, work.place.id].sort());
    assert.equal(processed.effectivePlaces.find((place) => place.id === gym.place.id)?.radiusMeters, 25);
    assert.equal(processed.effectivePlaces.find((place) => place.id === work.place.id)?.radiusMeters, 45);

    const model = presentAttemptLiveMap({
      lifecycle: 'armed',
      latestSample: processed.latestSample,
      sampleGpsReadiness: processed.sampleGpsReadiness,
      places: processed.effectivePlaces,
      startZoneStatus: processed.startZoneStatus,
      nowMs: now.value,
    });
    assert.equal(model.marker.confidence, 'current');
    assert.equal(model.marker.label, '±12 m');
    assert.equal(model.emphasizesInsidePlace, true);
    assert.equal(model.places.find((place) => place.emphasized)?.id, home.place.id);
    assert.equal(model.places.every((place) => place.radiusMeters === 25 || place.radiusMeters === 30 || place.radiusMeters === 45), true);
  });

  it('keeps a stale good fix degraded on the map without changing readiness or timing', async () => {
    const now = { value: NOW };
    const ctx = createMemoryWorkspace({ now: () => now.value });
    const home = await ctx.workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    assert.equal(home.ok, true);
    if (!home.ok) {
      return;
    }
    const started = await ctx.workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await ctx.sessions.appendSamples([
      sampleAt(HOME, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: NOW,
        accuracyMeters: 8,
      }),
    ]);
    now.value = NOW + 16_000;
    const processed = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.gpsReadiness.state, 'good');
    assert.equal(processed.startZoneStatus.status, 'inside');
    assert.equal(processed.attempt?.startedAtMs, null);
    assert.equal(ctx.platform.getCurrentPositionCalls, 0);
    const model = presentAttemptLiveMap({
      lifecycle: 'armed',
      latestSample: processed.latestSample,
      sampleGpsReadiness: processed.sampleGpsReadiness,
      places: processed.effectivePlaces,
      startZoneStatus: processed.startZoneStatus,
      nowMs: now.value,
    });
    assert.equal(model.marker.confidence, 'last-known');
    assert.equal(model.marker.label, 'Last known 16s ago · ±8 m');
    assert.equal(model.emphasizesInsidePlace, true);
  });

  it('shows a last-known marker for a poor sample and does not start the attempt', async () => {
    const ctx = createMemoryWorkspace({ now: () => NOW });
    const home = await ctx.workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    assert.equal(home.ok, true);
    if (!home.ok) {
      return;
    }
    const started = await ctx.workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await ctx.sessions.appendSamples([
      sampleAt(HOME, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: NOW,
        accuracyMeters: MAX_SAMPLE_ACCURACY_METERS + 1,
      }),
    ]);
    const processed = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.gpsReadiness.state, 'poor');
    assert.equal(processed.sampleGpsReadiness.state, 'poor');
    assert.equal(processed.startZoneStatus.status, 'locating');
    assert.equal(processed.attempt?.lifecycle, 'armed');
    assert.equal(processed.attempt?.startedAtMs, null);
    const model = presentAttemptLiveMap({
      lifecycle: 'armed',
      latestSample: processed.latestSample,
      sampleGpsReadiness: processed.sampleGpsReadiness,
      places: processed.effectivePlaces,
      startZoneStatus: processed.startZoneStatus,
      nowMs: NOW,
    });
    assert.equal(model.marker.confidence, 'last-known');
    assert.equal(model.emphasizesInsidePlace, false);
    assert.equal(ctx.platform.getCurrentPositionCalls, 0);
    assert.equal(ctx.platform.startUpdatesCalls, 1);
  });

  it('hides the marker when capture is unavailable', async () => {
    const ctx = createMemoryWorkspace({ now: () => NOW });
    const home = await ctx.workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    assert.equal(home.ok, true);
    if (!home.ok) {
      return;
    }
    const started = await ctx.workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await ctx.sessions.appendSamples([
      sampleAt(HOME, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: NOW,
        accuracyMeters: 8,
      }),
    ]);
    ctx.platform.foregroundGranted = false;
    const processed = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.sampleGpsReadiness.state, 'waiting');
    assert.equal(processed.startZoneStatus.status, 'locating');
    const model = presentAttemptLiveMap({
      lifecycle: 'armed',
      latestSample: processed.latestSample,
      sampleGpsReadiness: processed.sampleGpsReadiness,
      places: processed.effectivePlaces,
      startZoneStatus: processed.startZoneStatus,
      nowMs: NOW,
    });
    assert.equal(model.marker.confidence, 'hidden');
    assert.equal(model.statusNote, 'Waiting for GPS location');
    assert.equal(model.emphasizesInsidePlace, false);
    assert.equal(ctx.platform.getCurrentPositionCalls, 0);
  });

  it('keeps active timing unchanged and the active map passive', async () => {
    const ctx = createMemoryWorkspace({ now: () => NOW });
    const home = await ctx.workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    const work = await ctx.workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(HOME.latitude, HOME.longitude, 400, 0),
      radiusMeters: 30,
    });
    assert.equal(home.ok && work.ok, true);
    if (!home.ok || !work.ok) {
      return;
    }
    const started = await ctx.workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await ctx.sessions.appendSamples(
      departureOnlySamples({
        origin: home.place,
        sessionId: started.attempt.sessionId,
        extraMeters: 40,
      }),
    );
    const processed = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.attempt?.lifecycle, 'active');
    assert.equal(processed.attempt?.originPlaceId, home.place.id);
    assert.ok(processed.attempt?.startedAtMs != null);
    assert.equal(processed.gpsReadiness.state, 'waiting');
    assert.equal(processed.startZoneStatus.status, 'locating');
    assert.equal(processed.sampleGpsReadiness.state, 'good');
    const startedAtMs = processed.attempt?.startedAtMs;
    const again = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(again.attempt?.startedAtMs, startedAtMs);
    assert.equal(again.attempt?.originPlaceId, home.place.id);
    assert.equal(again.attempt?.lifecycle, 'active');
    assert.equal(ctx.platform.startUpdatesCalls, 1);
    assert.equal(ctx.platform.getCurrentPositionCalls, 0);
    const model = presentAttemptLiveMap({
      lifecycle: 'active',
      latestSample: again.latestSample,
      sampleGpsReadiness: again.sampleGpsReadiness,
      places: again.effectivePlaces,
      startZoneStatus: again.startZoneStatus,
      nowMs: again.latestSample?.recordedAtMs ?? NOW,
    });
    assert.equal(model.interactive, false);
    assert.equal(model.emphasizesInsidePlace, false);
    assert.equal(model.marker.confidence, 'current');
    assert.equal(
      again.effectivePlaces.find((place) => place.id === work.place.id)?.radiusMeters,
      30,
    );
  });

  it('still runs with no saved places and no extra location session', async () => {
    const ctx = createMemoryWorkspace({ now: () => NOW });
    const started = await ctx.workspace.startAttempt();
    assert.equal(started.ok, true);
    const processed = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.deepEqual(processed.effectivePlaces, []);
    assert.equal(processed.latestSample, null);
    assert.equal(processed.attempt?.lifecycle, 'armed');
    assert.equal(ctx.platform.getCurrentPositionCalls, 0);
    assert.equal(ctx.platform.startUpdatesCalls, 1);
    const model = presentAttemptLiveMap({
      lifecycle: 'armed',
      latestSample: processed.latestSample,
      sampleGpsReadiness: processed.sampleGpsReadiness,
      places: processed.effectivePlaces,
      startZoneStatus: processed.startZoneStatus,
      nowMs: NOW,
    });
    assert.equal(model.emptyPlacesNote, 'No saved places yet.');
    assert.equal(model.statusNote, 'Waiting for GPS location');
    assert.equal(model.marker.confidence, 'hidden');
  });
});

describe('attempt live map source boundaries', () => {
  it('does not mount a private location provider or a second place query', () => {
    const screen = readFileSync('src/ui/AttemptScreen.tsx', 'utf8');
    const live = readFileSync('src/ui/AttemptLiveMap.tsx', 'utf8');
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    const app = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const runtime = readFileSync('src/product/attempt-runtime.ts', 'utf8');
    const domain = readFileSync('src/domain/attempt-live-map.ts', 'utf8');
    const effectStart = app.indexOf("if (screen.kind !== 'attempt')");
    const effectEnd = app.indexOf(
      '}, [publishAttemptRuntime, screen.kind, showAttemptResult, workspace]);',
    );
    const effect = app.slice(effectStart, effectEnd);
    const showStart = app.indexOf('const showAttempt = useCallback(');
    const showEnd = app.indexOf('const showAttemptResult = useCallback(');
    const show = app.slice(showStart, showEnd);
    const processAt = show.indexOf('processActiveAttemptWithStartZoneStatus');
    const screenAt = show.indexOf("setScreen({ kind: 'attempt' })");

    const publishStart = app.indexOf('const publishAttemptRuntime = useCallback(');
    const publish = app.slice(publishStart, showStart);

    assert.ok(processAt >= 0 && screenAt > processAt);
    assert.doesNotMatch(show, /setLatestSample\(null\)|setEffectivePlaces\(\[\]\)/);
    assert.match(publish, /setLatestSample/);
    assert.match(publish, /setEffectivePlaces/);
    assert.match(publish, /processed\.latestSample/);
    assert.match(publish, /processed\.effectivePlaces/);
    assert.match(effect, /processActiveAttemptWithStartZoneStatus/);
    assert.match(effect, /publishAttemptRuntime\(processed\)/);
    assert.ok(effect.indexOf('void refresh()') >= 0);
    assert.ok(effect.indexOf('void refresh()') < effect.indexOf('setInterval'));
    assert.doesNotMatch(effect, /getCurrentPosition|listActivePlaces|startTracking|UserLocation|trackUserLocation/);
    assert.match(live, /shouldFollowActiveAttemptCamera/);
    assert.match(live, /shouldSnapActiveAttemptCamera/);
    assert.match(live, /anchorOutsideCameraBounds/);
    const recenterAt = live.indexOf('accessibilityLabel="Recenter map"');
    const recenter = live.slice(recenterAt, live.indexOf('RECENTER', recenterAt));
    assert.match(recenter, /setFollowedBounds\(fitTarget\)/);
    assert.match(screen, /shouldRenderAttemptMap\(appState\)/);
    assert.match(screen, /<AttemptLiveMap/);
    assert.match(screen, /Attempt map paused/);
    assert.match(screen, /Map paused\. Recording continues\./);
    assert.match(screen, /END & INSPECT/);
    assert.match(screen, /Cancel/);
    assert.match(screen, /put it in your pocket/);
    assert.doesNotMatch(screen, /getCurrentPosition|listActivePlaces|UserLocation|trackUserLocation|startTracking|stopTracking/);
    assert.match(live, /cameraGesturesEnabled=\{model\.interactive\}/);
    assert.match(live, /compassEnabled=\{model\.interactive\}/);
    assert.match(live, /model\.interactive && viewMode === 'manual'/);
    assert.match(live, /Recenter map/);
    assert.match(live, /useStableValue<LiveMapPlaceMarker\[\]>\(\s*placeKey/);
    assert.doesNotMatch(live, /UserLocation|trackUserLocation|getCurrentPosition|listActivePlaces|startTracking/);
    assert.match(map, /id="user-point"/);
    assert.match(map, /id="user-accuracy"/);
    assert.match(map, /id="place-zone-fill"/);
    assert.match(map, /circlePolygon\(place\.center, place\.radiusMeters\)/);
    assert.match(map, /circlePolygon\(userMarker\.point, userMarker\.horizontalAccuracyMeters\)/);
    assert.match(map, /placeMarkers=\{placeMarkers\}/);
    assert.doesNotMatch(map, /UserLocation|trackUserLocation|getCurrentPosition/);
    assert.match(fallback, /Saved place/);
    assert.match(fallback, /Current location/);
    assert.match(fallback, /Last known location/);
    assert.match(runtime, /locationDisplayFields\(samples, places, sampleGpsReadiness\)/);
    assert.doesNotMatch(runtime, /getCurrentPosition/);
    assert.doesNotMatch(domain, /PLACE_DEPARTURE_SUSTAIN|PLACE_DESTINATION_ELIGIBILITY|getCurrentPosition|UserLocation/);
    assert.doesNotMatch(domain, /@maplibre|expo-location/);
  });
});
