import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  classifyCurrentPosition,
  createLiveMapVisibility,
  fallbackLiveMapLayout,
  formatLiveMapCaption,
  initialViewportBounds,
  INITIAL_LIVE_MAP_CAMERA,
  inZonePlaceId,
  liveMapInteractivity,
  LIVE_MAP_FRESH_FIX_MAX_AGE_MS,
  positionOutsideBounds,
  reduceLiveMapCamera,
  resolveLiveMapDisplay,
  selectViewportPlaces,
  type AttemptLiveMapPlace,
  type LiveMapCameraEvent,
  type LiveMapCameraState,
} from '../src/domain/attempt-live-map';
import { MAX_SAMPLE_ACCURACY_METERS } from '../src/domain/course-matching';
import type { PlaceStartZoneStatus } from '../src/domain/place-timing';
import { departureOnlySamples, sampleAt } from './helpers/places';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = { latitude: 32.08, longitude: 34.78 };
const NOW = 1_700_000_000_000;

function fix(overrides: Partial<{ accuracy: number | null; ageMs: number }> = {}) {
  return {
    latitude: HOME.latitude,
    longitude: HOME.longitude,
    horizontalAccuracyMeters: overrides.accuracy === undefined ? 10 : overrides.accuracy,
    recordedAtMs: NOW - (overrides.ageMs ?? 2_000),
  };
}

function place(id: string, northMeters: number, eastMeters = 0, radiusMeters = 30): AttemptLiveMapPlace {
  return {
    id,
    name: id.toUpperCase(),
    center: offsetLatLng(HOME.latitude, HOME.longitude, northMeters, eastMeters),
    radiusMeters,
  };
}

const LOCATING: PlaceStartZoneStatus = {
  status: 'locating',
  placeId: null,
  placeName: null,
  distanceMeters: null,
  overlapTieBreak: null,
};

describe('current position classification', () => {
  it('shows an accurate recent fix as fresh', () => {
    const marker = classifyCurrentPosition(fix(), NOW);
    assert.equal(marker.kind, 'fresh');
    assert.match(formatLiveMapCaption(marker), /±10 m/);
  });

  it('treats the engine accuracy gate and the 15 s age boundary inclusively', () => {
    assert.equal(classifyCurrentPosition(fix({ accuracy: MAX_SAMPLE_ACCURACY_METERS }), NOW).kind, 'fresh');
    assert.equal(classifyCurrentPosition(fix({ accuracy: null }), NOW).kind, 'fresh');
    assert.equal(classifyCurrentPosition(fix({ ageMs: LIVE_MAP_FRESH_FIX_MAX_AGE_MS }), NOW).kind, 'fresh');
  });

  it('mutes poor-accuracy fixes with accuracy and age', () => {
    const marker = classifyCurrentPosition(fix({ accuracy: MAX_SAMPLE_ACCURACY_METERS + 1 }), NOW);
    assert.equal(marker.kind, 'last-known');
    assert.equal(marker.kind === 'last-known' && marker.reason, 'poor-accuracy');
    const caption = formatLiveMapCaption(marker);
    assert.match(caption, /Last known/);
    assert.match(caption, /±46 m/);
    assert.match(caption, /2 s ago/);
  });

  it('mutes stale fixes older than 15 s', () => {
    const marker = classifyCurrentPosition(fix({ ageMs: LIVE_MAP_FRESH_FIX_MAX_AGE_MS + 1 }), NOW);
    assert.equal(marker.kind, 'last-known');
    assert.equal(marker.kind === 'last-known' && marker.reason, 'stale');
    assert.match(formatLiveMapCaption(classifyCurrentPosition(fix({ ageMs: 125_000 }), NOW)), /2 min ago/);
    const both = classifyCurrentPosition(fix({ accuracy: 80, ageMs: 60_000 }), NOW);
    assert.equal(both.kind === 'last-known' && both.reason, 'poor-accuracy-and-stale');
  });

  it('is honestly unavailable without a fix and never confident', () => {
    const marker = classifyCurrentPosition(null, NOW);
    assert.equal(marker.kind, 'unavailable');
    assert.equal(marker.point, null);
    assert.match(formatLiveMapCaption(marker), /Waiting for a GPS fix/);
  });

  it('does not treat a future-dated fix as negative age', () => {
    const marker = classifyCurrentPosition({ ...fix(), recordedAtMs: NOW + 5_000 }, NOW);
    assert.equal(marker.kind, 'fresh');
    assert.equal(marker.kind === 'fresh' && marker.ageMs, 0);
  });
});

describe('initial viewport', () => {
  it('includes at most the 3 nearest places within 3 km, nearest first', () => {
    const places = [place('far', 5_000), place('d', 900), place('a', 100), place('c', 600), place('b', 300)];
    const chosen = selectViewportPlaces(HOME, places).map((item) => item.id);
    assert.deepEqual(chosen, ['a', 'b', 'c']);
  });

  it('excludes places beyond 3 km and still frames the position alone', () => {
    const places = [place('far', 3_500)];
    assert.deepEqual(selectViewportPlaces(HOME, places), []);
    const bounds = initialViewportBounds(HOME, places);
    assert.ok(bounds);
    assert.ok(bounds[0] < HOME.longitude && bounds[2] > HOME.longitude);
    assert.ok(bounds[1] < HOME.latitude && bounds[3] > HOME.latitude);
    assert.ok(bounds[3] - bounds[1] < 0.01, 'far place must not stretch the viewport');
  });

  it('frames position and nearby place radii', () => {
    const bounds = initialViewportBounds(HOME, [place('a', 500, 0, 100)]);
    assert.ok(bounds);
    const north = offsetLatLng(HOME.latitude, HOME.longitude, 600, 0).latitude;
    assert.ok(bounds[3] >= north);
  });

  it('with no fix frames all places; with nothing returns null', () => {
    const places = [place('a', 100), place('far', 9_000)];
    const bounds = initialViewportBounds(null, places);
    assert.ok(bounds);
    assert.ok(bounds[3] - bounds[1] > 0.05);
    assert.equal(initialViewportBounds(null, []), null);
  });

  it('no saved places still frames a position', () => {
    assert.ok(initialViewportBounds(HOME, []));
  });
});

describe('in-zone visual', () => {
  const places = [place('home', 0)];
  it('never highlights while the start zone is LOCATING', () => {
    assert.equal(inZonePlaceId(LOCATING, places), null);
    assert.equal(inZonePlaceId({ ...LOCATING, placeId: 'home', placeName: 'HOME' }, places), null);
  });
  it('highlights only the official inside place', () => {
    const inside: PlaceStartZoneStatus = { ...LOCATING, status: 'inside', placeId: 'home', placeName: 'HOME' };
    assert.equal(inZonePlaceId(inside, places), 'home');
    assert.equal(inZonePlaceId({ ...inside, placeId: 'gone' }, places), null);
    assert.equal(inZonePlaceId({ ...inside, status: 'outside' }, places), null);
  });
});

describe('camera state machine', () => {
  const places = [place('a', 100)];
  const view = (position: typeof HOME | null, lifecycle: 'armed' | 'active' = 'armed'): LiveMapCameraEvent => ({
    type: 'view',
    position,
    places,
    lifecycle,
  });
  const run = (events: LiveMapCameraEvent[], start: LiveMapCameraState = INITIAL_LIVE_MAP_CAMERA) =>
    events.reduce(reduceLiveMapCamera, start);

  it('fits once, then ignores repeated identical view updates', () => {
    const first = run([view(HOME)]);
    assert.equal(first.fitSeq, 1);
    const later = run([view(HOME), view(HOME), view({ ...HOME, latitude: HOME.latitude + 0.00001 })]);
    assert.equal(later.fitSeq, 1);
  });

  it('refits once when the first real position follows a places-only fit', () => {
    const state = run([view(null), view(null)]);
    assert.equal(state.fitSeq, 1);
    assert.equal(state.fittedToPosition, false);
    const withFix = run([view(HOME), view(HOME)], state);
    assert.equal(withFix.fitSeq, 2);
    assert.equal(withFix.fittedToPosition, true);
  });

  it('never forces a recenter after the user pans until explicit recenter', () => {
    let state = run([view(null), { type: 'user-gesture' }]);
    assert.equal(state.mode, 'user');
    const seq = state.fitSeq;
    const moved = offsetLatLng(HOME.latitude, HOME.longitude, 800, 800);
    state = run([view(HOME), view(moved), view(null)], state);
    assert.equal(state.fitSeq, seq);
    state = run([{ type: 'recenter', position: HOME, places }], state);
    assert.equal(state.mode, 'fitted');
    assert.equal(state.fitSeq, seq + 1);
    state = run([view(moved)], state);
    assert.equal(state.fitSeq, seq + 1, 'ordinary position changes do not move the camera');
  });

  it('passive ACTIVE map re-frames only when the position leaves the framed area', () => {
    let state = run([view(HOME, 'active')]);
    const seq = state.fitSeq;
    state = run([view(offsetLatLng(HOME.latitude, HOME.longitude, 5, 5), 'active')], state);
    assert.equal(state.fitSeq, seq);
    const gone = offsetLatLng(HOME.latitude, HOME.longitude, 2_000, 0);
    assert.ok(state.fitBounds && positionOutsideBounds(gone, state.fitBounds));
    state = run([view(gone, 'active')], state);
    assert.equal(state.fitSeq, seq + 1);
  });
});

describe('interactivity', () => {
  it('ARMED allows pan, zoom and recenter only', () => {
    const armed = liveMapInteractivity('armed');
    assert.equal(armed.dragPan && armed.touchZoom && armed.recenterControl && armed.capturesTouches, true);
    assert.equal(armed.touchRotate || armed.touchPitch, false);
  });
  it('ACTIVE is fully non-interactive and does not capture touches', () => {
    const active = liveMapInteractivity('active');
    assert.deepEqual(Object.values(active).filter(Boolean), []);
  });
});

describe('foreground visibility', () => {
  function fakeAppState(initial: string) {
    let state = initial;
    const listeners = new Set<(next: string) => void>();
    return {
      source: {
        getState: () => state,
        subscribe: (listener: (next: string) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      set(next: string) {
        state = next;
        for (const listener of listeners) {
          listener(next);
        }
      },
      listenerCount: () => listeners.size,
    };
  }

  it('unmounts on background/inactive and remounts on active', () => {
    const app = fakeAppState('active');
    const seen: boolean[] = [];
    const visibility = createLiveMapVisibility(app.source);
    visibility.subscribe((visible) => seen.push(visible));
    assert.equal(visibility.isVisible(), true);
    app.set('inactive');
    assert.equal(visibility.isVisible(), false);
    app.set('background');
    app.set('active');
    assert.deepEqual(seen, [false, true]);
    visibility.dispose();
    assert.equal(app.listenerCount(), 0);
  });

  it('background hides the map without involving tracking', async () => {
    const { workspace, platform, tracker } = createMemoryWorkspace({ now: () => NOW });
    await workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    const app = fakeAppState('active');
    const visibility = createLiveMapVisibility(app.source);
    app.set('background');
    app.set('active');
    visibility.dispose();
    assert.equal(platform.startUpdatesCalls, 1);
    assert.equal(platform.getCurrentPositionCalls, 0);
    assert.equal(platform.updating, true);
    assert.equal((await tracker.getState()).status, 'tracking');
  });

  it('resolves display mode: hidden in background, fallback on failures, map otherwise', () => {
    assert.equal(resolveLiveMapDisplay({ appState: 'background', rendererFailed: false, tilesFailed: false }), 'hidden');
    assert.equal(resolveLiveMapDisplay({ appState: 'inactive', rendererFailed: false, tilesFailed: false }), 'hidden');
    assert.equal(resolveLiveMapDisplay({ appState: 'active', rendererFailed: false, tilesFailed: false }), 'map');
    assert.equal(resolveLiveMapDisplay({ appState: 'active', rendererFailed: false, tilesFailed: true }), 'fallback');
    assert.equal(resolveLiveMapDisplay({ appState: 'active', rendererFailed: true, tilesFailed: false }), 'fallback');
  });
});

describe('offline fallback layout', () => {
  it('places saved places and the marker inside the schematic', () => {
    const places = [place('a', 100, 0, 50)];
    const bounds = initialViewportBounds(HOME, places);
    const layout = fallbackLiveMapLayout(bounds, places, HOME);
    assert.equal(layout.places.length, 1);
    assert.ok(layout.marker);
    assert.ok(layout.places[0]!.diameterPercent > 0);
    assert.deepEqual(fallbackLiveMapLayout(null, places, HOME), { places: [], marker: null });
  });
});

describe('runtime snapshot', () => {
  async function seed() {
    const now = { value: NOW };
    const ctx = createMemoryWorkspace({ now: () => now.value });
    const home = await ctx.workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    const work = await ctx.workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(HOME.latitude, HOME.longitude, 300, 0),
      radiusMeters: 45,
    });
    if (!home.ok || !work.ok) {
      throw new Error('expected places');
    }
    return { ...ctx, now, home: home.place, work: work.place };
  }

  it('exposes the engine place set with persisted radii and the latest persisted sample', async () => {
    const { workspace, sessions } = await seed();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const empty = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(empty.liveMap.latestFix, null);
    assert.deepEqual(
      empty.liveMap.places.map((item) => [item.name, item.radiusMeters]).sort(),
      [['Home', 30], ['Work', 45]],
    );
    await sessions.appendSamples([
      sampleAt(HOME, { sessionId: started.attempt.sessionId, recordedAtMs: NOW - 1000, accuracyMeters: 9 }),
    ]);
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.deepEqual(processed.liveMap.latestFix, {
      latitude: HOME.latitude,
      longitude: HOME.longitude,
      horizontalAccuracyMeters: 9,
      recordedAtMs: NOW - 1000,
    });
    assert.equal(processed.liveMap.observedAtMs, NOW);
    assert.equal(classifyCurrentPosition(processed.liveMap.latestFix, processed.liveMap.observedAtMs).kind, 'fresh');
  });

  it('equals placesForAttempt, including archived origin extras', async () => {
    const { workspace, sessions, places, attemptRuntime, home } = await seed();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await sessions.appendSamples(
      departureOnlySamples({ origin: home, sessionId: started.attempt.sessionId, startMs: NOW - 20_000 }),
    );
    const active = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(active.attempt?.lifecycle, 'active');
    await places.archivePlace(home.id);
    // The set the engine will evaluate for this poll, read from the same open attempt.
    const open = await workspace.getOpenAttempt();
    assert.ok(open);
    const engineSet = await (
      attemptRuntime as unknown as { placesForAttempt(a: typeof open): Promise<(typeof home)[]> }
    ).placesForAttempt(open);
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.deepEqual(
      processed.liveMap.places.map((item) => [item.id, item.radiusMeters]),
      engineSet.map((item) => [item.id, item.radiusMeters]),
    );
    assert.ok(processed.liveMap.places.some((item) => item.id === home.id), 'archived origin is an extra');
  });

  it('LOCATING start zone yields no in-zone visual even with the engine place set', async () => {
    const { workspace } = await seed();
    await workspace.startAttempt();
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.startZoneStatus.status, 'locating');
    assert.equal(inZonePlaceId(processed.startZoneStatus, processed.liveMap.places), null);
  });

  it('adds no watcher, no position poll, and leaves timing results unchanged', async () => {
    const { workspace, sessions, platform, home } = await seed();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await sessions.appendSamples(
      departureOnlySamples({ origin: home, sessionId: started.attempt.sessionId, startMs: NOW - 20_000 }),
    );
    for (let index = 0; index < 5; index += 1) {
      await workspace.processActiveAttemptWithStartZoneStatus();
    }
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(platform.startUpdatesCalls, 1);
    assert.equal(platform.getCurrentPositionCalls, 0);
    assert.equal(processed.attempt?.lifecycle, 'active');
    assert.equal(processed.attempt?.originPlaceId, home.id);
    assert.equal(processed.gpsReadiness.state, 'waiting');
    assert.equal(processed.startZoneStatus.status, 'locating');
    const plain = await workspace.processActiveAttempt();
    assert.equal(plain?.startedAtMs, processed.attempt?.startedAtMs);
  });

  it('keeps run control working with no GPS, no saved places and no samples', async () => {
    const ctx = createMemoryWorkspace({ now: () => NOW });
    const seeded = await ctx.workspace.createPlace({ name: 'Home', center: HOME, radiusMeters: 30 });
    assert.equal(seeded.ok, true);
    const started = await ctx.workspace.startAttempt();
    assert.equal(started.ok, true);
    const processed = await ctx.workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(classifyCurrentPosition(processed.liveMap.latestFix, processed.liveMap.observedAtMs).kind, 'unavailable');
    assert.equal(processed.attempt?.lifecycle, 'armed');
  });
});

describe('UI wiring (source contracts)', () => {
  const map = readFileSync('src/map/AttemptLiveMap.tsx', 'utf8');
  const screen = readFileSync('src/ui/AttemptScreen.tsx', 'utf8');
  const app = readFileSync('src/ui/AppRoot.tsx', 'utf8');

  it('owns no location source or parallel data access', () => {
    assert.doesNotMatch(
      map,
      /UserLocation|showUserLocation|trackUserLocation|getCurrentPosition|watchPosition|startTracking|startUpdates|listPlaces|listActivePlaces|listSamples|expo-location|persistence\//,
    );
    assert.match(map, /MapErrorBoundary/);
    assert.match(map, /AppState/);
  });

  it('threads the engine snapshot through the existing 1 s poll only', () => {
    assert.match(app, /setLiveMap\(processed\.liveMap\)/);
    assert.match(app, /liveMap=\{liveMap\}/);
    assert.equal((app.match(/processActiveAttemptWithStartZoneStatus\(\)/g) ?? []).length, 1);
  });

  it('keeps Cancel and End & Inspect outside the map and its error boundary', () => {
    assert.ok(screen.indexOf('<AttemptLiveMap') < screen.indexOf('END & INSPECT'));
    assert.match(screen, /onPress=\{onEndAndInspect\}/);
    assert.match(screen, /onPress=\{onCancel\}/);
    assert.match(map, /pointerEvents=\{interactivity\.capturesTouches/);
  });
});
