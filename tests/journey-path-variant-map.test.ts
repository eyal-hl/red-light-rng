import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import { haversineMeters } from '../src/domain/geo';
import { courseCameraBounds } from '../src/map/course-camera-bounds';
import {
  boundFallbackPathVertices,
  FALLBACK_MAX_PATH_VERTICES,
  pathVariantCameraPoints,
  pathVariantDisplayStyle,
  pathVariantsToMapLines,
  PATH_VARIANT_COLORS,
  PATH_VARIANT_DASH_KINDS,
  sanitizeReferencePath,
} from '../src/map/path-variant-display';
import { placeZone } from '../src/domain/place';
import { attemptIdentity } from './helpers/attempts';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const SLOT_PX = 260;
const DISCOVERY_SPLIT_METERS = 50;
const DISCOVERY_JOURNEY_METERS = 5_000;

function summaryFor(
  route: ReturnType<typeof makeRoute>,
  extra: { attemptCount?: number; pbTimeMs?: number | null; typicalTimeMs?: number | null } = {},
) {
  return {
    route,
    attemptCount: extra.attemptCount ?? 0,
    pbTimeMs: extra.pbTimeMs ?? null,
    typicalTimeMs: extra.typicalTimeMs ?? null,
  };
}

function parallelPath(path: ReturnType<typeof northPath>, eastMeters: number) {
  return path.map((point) => offsetLatLng(point.latitude, point.longitude, 0, eastMeters));
}

function discoveryScalePair(splitMeters: number) {
  const stepMeters = 20;
  const points = Math.floor(DISCOVERY_JOURNEY_METERS / stepMeters) + 1;
  const under = northPath({
    points,
    stepMeters,
    startLat: HOME.center.latitude,
    startLng: HOME.center.longitude,
  });
  return {
    under,
    above: parallelPath(under, splitMeters),
  };
}

function overviewPixelSeparation(splitMeters: number, journeyMeters: number, slotPx = SLOT_PX) {
  return (splitMeters / journeyMeters) * slotPx;
}

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `${id}-session`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 2_000,
    finishedAtMs: 12_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    ...attemptIdentity({ routeId: null, originPlaceId: HOME.id, destinationPlaceId: 'place-work' }),
    ...overrides,
  };
}

describe('journey path variant map', () => {
  it('renders start/finish only when the journey has zero path variants', () => {
    const lines = pathVariantsToMapLines([]);
    assert.deepEqual(lines, []);
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    assert.match(detail, /path=\{\[\]\}/);
    assert.match(detail, /pathVariants=\{variantMapLines\}/);
    assert.match(detail, /startZone=\{placeZone\(origin\)\}/);
    assert.match(detail, /finishZone=\{placeZone\(destination\)\}/);
    assert.doesNotMatch(detail, /pathVariants\.length === 1/);
  });

  it('renders one route line from the persisted reference path', () => {
    const path = northPath({ points: 12, stepMeters: 20 });
    const route = makeRoute({ id: 'route-under', name: 'Under', referencePath: path });
    const lines = pathVariantsToMapLines([summaryFor(route)]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.id, 'route-under');
    assert.deepEqual(lines[0]?.path, path);
  });

  it('renders every PATH VARIANTS route that has geometry, including explicit recordings', () => {
    const under = northPath({ points: 10, stepMeters: 20 });
    const above = parallelPath(under, 50);
    const summaries = [
      summaryFor(makeRoute({ id: 'explicit-1', name: 'Manual', kind: 'explicit', referencePath: under })),
      summaryFor(makeRoute({ id: 'discovered-1', name: 'Above', kind: 'discovered', referencePath: above })),
    ];
    const lines = pathVariantsToMapLines(summaries);
    assert.deepEqual(
      lines.map((line) => line.id),
      ['explicit-1', 'discovered-1'],
    );
    assert.equal(lines[0]?.name, 'Manual');
    assert.equal(lines[1]?.name, 'Above');
  });

  it('assigns deterministic styles by stable route id across rerender, restart, and reorder', () => {
    const first = pathVariantDisplayStyle('route-under');
    const second = pathVariantDisplayStyle('route-under');
    const other = pathVariantDisplayStyle('route-above');
    assert.deepEqual(first, second);
    assert.equal(PATH_VARIANT_COLORS.includes(first.color as (typeof PATH_VARIANT_COLORS)[number]), true);
    assert.equal(PATH_VARIANT_DASH_KINDS.includes(first.dashKind), true);

    const under = northPath({ points: 8, stepMeters: 25 });
    const above = parallelPath(under, 45);
    const underRoute = makeRoute({ id: 'route-under', name: 'Under', referencePath: under });
    const aboveRoute = makeRoute({ id: 'route-above', name: 'Above', referencePath: above });
    const original = pathVariantsToMapLines([summaryFor(underRoute), summaryFor(aboveRoute)]);
    const reordered = pathVariantsToMapLines([summaryFor(aboveRoute), summaryFor(underRoute)]);
    const underStyle = original.find((line) => line.id === 'route-under');
    const reorderedUnder = reordered.find((line) => line.id === 'route-under');
    assert.equal(underStyle?.color, reorderedUnder?.color);
    assert.equal(underStyle?.dashKind, reorderedUnder?.dashKind);
    assert.equal(underStyle?.color, first.color);
    if (first.color === other.color) {
      assert.notEqual(first.dashKind, other.dashKind);
    }
  });

  it('keeps Path Variant card indicators matched to the rendered route identity', () => {
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    assert.match(detail, /pathVariantDisplayStyle\(item\.route\.id\)/);
    assert.match(detail, /pathVariantsToMapLines\(pathVariants\)/);
    assert.match(detail, /variantSwatch/);
    assert.match(detail, /path color/);
    assert.match(detail, /item\.route\.name/);
    const route = makeRoute({ id: 'route-park', name: 'Park', referencePath: northPath() });
    const style = pathVariantDisplayStyle(route.id);
    const [line] = pathVariantsToMapLines([summaryFor(route)]);
    assert.equal(line?.color, style.color);
    assert.equal(line?.dashKind, style.dashKind);
  });

  it('fits map bounds to every rendered variant plus start and finish', () => {
    const startZone = placeZone(HOME);
    const finishZone = {
      center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 200, 0),
      radiusMeters: HOME.radiusMeters,
    };
    const detour = [
      HOME.center,
      offsetLatLng(HOME.center.latitude, HOME.center.longitude, 100, 3_000),
      finishZone.center,
    ];
    const lines = pathVariantsToMapLines([
      summaryFor(makeRoute({ id: 'detour', referencePath: detour })),
    ]);
    const startFinishOnly = courseCameraBounds([], startZone, finishZone);
    const withVariants = courseCameraBounds(
      [],
      startZone,
      finishZone,
      pathVariantCameraPoints(lines),
    );
    assert.notDeepEqual(withVariants, startFinishOnly);
    assert.ok(withVariants[2] > startFinishOnly[2]);
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    assert.match(map, /pathVariantCameraPoints\(pathVariants\)/);
    assert.match(
      map,
      /courseCameraBounds\(\s*path,\s*startZone,\s*finishZone,\s*cameraPoints\s*\)/,
    );
  });

  it('does not suppress valid variants when one geometry is missing or invalid', () => {
    const validA = northPath({ points: 6, stepMeters: 20 });
    const validB = parallelPath(validA, 40);
    const lines = pathVariantsToMapLines([
      summaryFor(makeRoute({ id: 'keep-a', referencePath: validA })),
      summaryFor(makeRoute({ id: 'empty', referencePath: [] })),
      summaryFor(makeRoute({ id: 'single', referencePath: [validA[0]!] })),
      summaryFor(
        makeRoute({
          id: 'nan',
          referencePath: [
            { latitude: Number.NaN, longitude: 34.78 },
            { latitude: 32.08, longitude: Number.POSITIVE_INFINITY },
          ],
        }),
      ),
      summaryFor(makeRoute({ id: 'keep-b', referencePath: validB })),
    ]);
    assert.deepEqual(
      lines.map((line) => line.id),
      ['keep-a', 'keep-b'],
    );
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    assert.match(map, /isRenderableReferencePath\(variant\.path\)/);
    assert.match(map, /continue/);
  });

  it('does not load raw attempt GPS traces to paint variant routes', async () => {
    const display = readFileSync('src/map/path-variant-display.ts', 'utf8');
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    assert.doesNotMatch(display, /listSamples/);
    assert.doesNotMatch(detail, /listSamples/);
    assert.doesNotMatch(map, /listSamples/);
    assert.match(display, /referencePath/);

    const work = makePlace({
      id: 'place-work',
      name: 'Work',
      center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
      createdAtMs: 2,
    });
    const { workspace, sessions, routes, attempts, places } = createMemoryWorkspace();
    let listSamplesCalls = 0;
    const originalListSamples = sessions.listSamples.bind(sessions);
    sessions.listSamples = async (sessionId: string) => {
      listSamplesCalls += 1;
      return originalListSamples(sessionId);
    };
    await places.createPlace(HOME);
    await places.createPlace(work);
    const path = northPath({
      startLat: HOME.center.latitude,
      startLng: HOME.center.longitude,
      points: 20,
      stepMeters: 20,
    });
    await routes.createRoute(
      makeRoute({
        id: 'under',
        name: 'Under',
        referencePath: path,
        startZone: { center: HOME.center, radiusMeters: 40 },
        finishZone: { center: work.center, radiusMeters: 40 },
      }),
    );
    sessions.seedSession(
      {
        id: 'attempt-1-session',
        startedAtMs: 1_700_000_000_000,
        stoppedAtMs: 1_700_000_060_000,
        isActive: false,
        purpose: 'attempt',
        captureOutcome: 'finished',
        reviewDisposition: 'saved',
        lastSampleAtMs: 1_700_000_060_000,
        backgroundPermissionConfirmed: true,
      },
      [
        {
          id: 's1',
          sessionId: 'attempt-1-session',
          recordedAtMs: 1_700_000_000_000,
          latitude: HOME.center.latitude,
          longitude: HOME.center.longitude,
          horizontalAccuracyMeters: 5,
          speedMetersPerSecond: 4,
          headingDegrees: 0,
        },
      ],
    );
    await attempts.createAttempt(
      completedAttempt('attempt-1', {
        destinationPlaceId: work.id,
        sessionId: 'attempt-1-session',
      }),
    );
    const loaded = await workspace.loadJourney({
      originPlaceId: HOME.id,
      destinationPlaceId: work.id,
      transportationMode: 'scooter',
    });
    assert.ok(loaded);
    assert.equal(loaded.pathVariants.length, 1);
    assert.equal(listSamplesCalls, 0);
    assert.deepEqual(
      pathVariantsToMapLines(loaded.pathVariants)[0]?.path,
      loaded.pathVariants[0]?.route.referencePath,
    );
  });

  it('leaves journey PB, rank, and statistics unchanged by visualization', async () => {
    const work = makePlace({
      id: 'place-work',
      name: 'Work',
      center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 800, 0),
      createdAtMs: 2,
    });
    const { workspace, routes, attempts, places } = createMemoryWorkspace({
      now: () => 1_700_000_100_000,
    });
    await places.createPlace(HOME);
    await places.createPlace(work);
    const pb = completedAttempt('pb-run', {
      destinationPlaceId: work.id,
      startedAtMs: 1_700_000_000_000,
      finishedAtMs: 1_700_000_000_000 + 11 * 60_000,
    });
    const slower = completedAttempt('slower-run', {
      destinationPlaceId: work.id,
      startedAtMs: 1_700_000_010_000,
      finishedAtMs: 1_700_000_010_000 + 13 * 60_000,
    });
    await attempts.createAttempt(pb);
    await attempts.createAttempt(slower);
    const before = await workspace.loadJourney({
      originPlaceId: HOME.id,
      destinationPlaceId: work.id,
      transportationMode: 'scooter',
    });
    assert.ok(before);
    const under = northPath({
      startLat: HOME.center.latitude,
      startLng: HOME.center.longitude,
      points: 16,
      stepMeters: 20,
    });
    await routes.createRoute(
      makeRoute({
        id: 'under',
        name: 'Under',
        kind: 'discovered',
        sourceRecordingId: 'session-under',
        referencePath: under,
        startZone: { center: HOME.center, radiusMeters: 40 },
        finishZone: { center: work.center, radiusMeters: 40 },
      }),
    );
    await routes.createRoute(
      makeRoute({
        id: 'above',
        name: 'Above',
        kind: 'explicit',
        sourceRecordingId: 'session-above',
        createdAtMs: 1_700_000_200_000,
        referencePath: parallelPath(under, 55),
        startZone: { center: HOME.center, radiusMeters: 40 },
        finishZone: { center: work.center, radiusMeters: 40 },
      }),
    );
    const after = await workspace.loadJourney({
      originPlaceId: HOME.id,
      destinationPlaceId: work.id,
      transportationMode: 'scooter',
    });
    assert.ok(after);
    assert.equal(after.pathVariants.length, 2);
    assert.equal(after.statistics.pbTimeMs, before.statistics.pbTimeMs);
    assert.equal(after.statistics.pbAttemptId, before.statistics.pbAttemptId);
    assert.equal(after.statistics.validAttemptCount, before.statistics.validAttemptCount);
    assert.equal(after.summary.rankedAttemptCount, before.summary.rankedAttemptCount);
    assert.equal(after.summary.pbTimeMs, before.summary.pbTimeMs);
    assert.equal(after.history.length, before.history.length);
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    assert.match(detail, /Any path between these places counts/);
  });

  it('keeps variant map work secondary to the journey shell', () => {
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    const titleIndex = detail.indexOf('styles.title');
    const statsIndex = detail.indexOf('JourneyStatisticsDashboard');
    const mapIndex = detail.indexOf('<RouteMap');
    const deferredIndex = detail.indexOf('DeferredMapSlot');
    assert.ok(titleIndex >= 0 && statsIndex >= 0 && mapIndex >= 0 && deferredIndex >= 0);
    assert.ok(deferredIndex < mapIndex, 'RouteMap must stay inside DeferredMapSlot');
    assert.ok(titleIndex < mapIndex, 'journey title must paint without waiting on the map');
    assert.match(detail, /JourneyStatRow label="PB"/);
    const workspace = readFileSync('src/product/route-workspace.ts', 'utf8');
    assert.match(workspace, /tracesFromAttempts/);
    assert.doesNotMatch(workspace, /listAttemptSamples\(.*pathVariant/);
  });

  it('keeps discovery-scale parallel geometry geographically distinct without fake offsets', () => {
    const { under, above } = discoveryScalePair(DISCOVERY_SPLIT_METERS);
    assert.ok(haversineMeters(under[0]!, under[under.length - 1]!) > 4_800);
    const mid = Math.floor(under.length / 2);
    const split = haversineMeters(under[mid]!, above[mid]!);
    assert.ok(split > 40 && split < 60, `expected 40-60 m split, got ${split.toFixed(1)} m`);
    const overviewPx = overviewPixelSeparation(DISCOVERY_SPLIT_METERS, DISCOVERY_JOURNEY_METERS);
    assert.ok(
      overviewPx < 4,
      `full-journey overview may overlap; ${overviewPx.toFixed(2)} px at ${SLOT_PX}px slot`,
    );
    const zoomedPx = overviewPixelSeparation(DISCOVERY_SPLIT_METERS, 200);
    assert.ok(zoomedPx > 40, 'zooming into ~200 m reveals the true 50 m split');

    const lines = pathVariantsToMapLines([
      summaryFor(makeRoute({ id: 'under', name: 'Under', referencePath: under })),
      summaryFor(makeRoute({ id: 'above', name: 'Above', referencePath: above })),
    ]);
    assert.deepEqual(lines[0]?.path, under);
    assert.deepEqual(lines[1]?.path, above);
    assert.deepEqual(sanitizeReferencePath(under), under);
    const display = readFileSync('src/map/path-variant-display.ts', 'utf8');
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    assert.doesNotMatch(display, /cartographic|nudge|offsetPath|fakeOffset/);
    assert.doesNotMatch(map, /cartographic|nudge|offsetPath/);
    assert.doesNotMatch(detail, /cartographic|nudge|offsetPath/);
  });

  it('keeps fallback variant rendering bounded for dense and multiple reference paths', () => {
    const dense = northPath({ points: 2_000, stepMeters: 20 });
    const paths = [dense, parallelPath(dense, 50), parallelPath(dense, 90), parallelPath(dense, 140)];
    const bounded = boundFallbackPathVertices(paths);
    const total = bounded.reduce((sum, path) => sum + path.length, 0);
    assert.ok(total <= FALLBACK_MAX_PATH_VERTICES);
    assert.equal(bounded.length, 4);
    for (const [index, path] of bounded.entries()) {
      assert.ok(path.length >= 2);
      assert.deepEqual(path[0], paths[index]![0]);
      assert.deepEqual(path[path.length - 1], paths[index]![paths[index]!.length - 1]);
    }
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    assert.match(fallback, /boundFallbackPathVertices/);
    assert.match(fallback, /pathVariants/);
    assert.match(fallback, /variantStrokes/);
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    assert.match(map, /pathVariants=\{pathVariants\}/);
    assert.match(map, /path-variant-/);
    assert.match(map, /\['get', 'color'\]/);
    const variantLayer = map.indexOf('path-variant-');
    const startPoint = map.indexOf('id="start-point"');
    const finishPoint = map.indexOf('id="finish-point"');
    assert.ok(variantLayer >= 0 && startPoint > variantLayer && finishPoint > startPoint);
  });

  it('keeps shared domain and persistence free of MapLibre types', () => {
    const display = readFileSync('src/map/path-variant-display.ts', 'utf8');
    const discovery = readFileSync('src/domain/path-variant-discovery.ts', 'utf8');
    const workspace = readFileSync('src/product/route-workspace.ts', 'utf8');
    assert.doesNotMatch(display, /@maplibre\/maplibre-react-native|maplibre/);
    assert.doesNotMatch(discovery, /@maplibre\/maplibre-react-native|maplibre/);
    assert.doesNotMatch(workspace, /@maplibre\/maplibre-react-native|maplibre/);
  });
});
