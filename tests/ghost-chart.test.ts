import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  analyzeFocusAttempt,
  deriveCurrentLayoutAttempt,
  timingCourseFromRoute,
  type AttemptTrace,
} from '../src/domain/attempt-analysis';
import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import { finishTriggerProgressMeters, type TimingCourse } from '../src/domain/attempt-timing';
import { haversineMeters, pathDistanceMeters } from '../src/domain/geo';
import {
  flattenGhostChartVertices,
  ghostChartCopy,
  ghostChartLayoutForSize,
  ghostChartPlotWidthPx,
  ghostComparisonPolylines,
  prepareGhostChartSeries,
  projectGhostChartPoint,
  reduceGhostChartPolyline,
  selectGhostChartPoint,
  type GhostChartPrepared,
  type GhostChartVertex,
} from '../src/domain/ghost-chart';
import {
  compareAttemptGhost,
  elapsedOnIncreasingFlanks,
  type GhostComparison,
} from '../src/domain/ghost-comparison';
import { MAX_STATIONARY_GAP_MS } from '../src/domain/movement-analysis';
import { pointAtProgress } from '../src/domain/path-projection';
import type { LocationSample } from '../src/domain/location-sample';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample, traceAlongPath } from './helpers/samples';

function longPath() {
  return northPath({ points: 41, stepMeters: 20 });
}

function courseFromPath(path = longPath(), overrides: Partial<TimingCourse> = {}): TimingCourse {
  return timingCourseFromRoute(
    makeRoute({
      referencePath: path,
      checkpoints: overrides.checkpoints ?? [],
      ...overrides,
    }),
  );
}

function makeAttempt(overrides: Partial<Attempt> & Pick<Attempt, 'id' | 'sessionId'>): Attempt {
  return {
    routeId: 'route-1',
    originPlaceId: 'place-home',
    destinationPlaceId: 'place-work',
    transportationMode: 'scooter',
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 5_000,
    finishedAtMs: 200_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    ...overrides,
  };
}

function coveringTrace(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    startProgressMeters?: number;
    stepMeters?: number;
    intervalMs?: number;
  },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const startProgress = options.startProgressMeters ?? 0;
  const stepMeters = options.stepMeters ?? 4;
  const intervalMs = options.intervalMs ?? 1000;
  const count = Math.ceil((length - startProgress) / stepMeters) + 16;
  return traceAlongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    startProgressMeters: startProgress,
    stepMeters,
    intervalMs,
    count,
  }).map((item, index) =>
    sample({
      ...item,
      id: `${options.sessionId}-${index}`,
    }),
  );
}

function stretchAfterDeparture(samples: LocationSample[], factor: number, afterIndex = 10): LocationSample[] {
  if (samples.length === 0) {
    return samples;
  }
  const pivot = Math.min(afterIndex, samples.length - 1);
  const out = samples.slice(0, pivot + 1).map((item) => sample({ ...item }));
  const pivotSample = samples[pivot];
  if (!pivotSample) {
    return out;
  }
  let timeMs = pivotSample.recordedAtMs;
  for (let index = pivot + 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (!previous || !current) {
      continue;
    }
    timeMs += Math.max(1, Math.round((current.recordedAtMs - previous.recordedAtMs) * factor));
    out.push(
      sample({
        ...current,
        recordedAtMs: timeMs,
      }),
    );
  }
  return out;
}

function commuteWithStop(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    stopProgressMeters: number;
    stopDurationMs: number;
    mode: 'dense-jitter' | 'zero-fix';
    jitterMeters?: number;
    stepMeters?: number;
    intervalMs?: number;
  },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const stepMeters = options.stepMeters ?? 4;
  const intervalMs = options.intervalMs ?? 1000;
  const samples: LocationSample[] = [];
  let timeMs = options.startMs;
  let id = 0;
  const pushAt = (progressMeters: number, recordedAtMs: number, extra: Partial<LocationSample> = {}) => {
    const point = pointAtProgress(path, Math.min(Math.max(progressMeters, 0), length));
    samples.push(
      sample({
        id: `${options.sessionId}-${id}`,
        sessionId: options.sessionId,
        recordedAtMs,
        latitude: extra.latitude ?? point.latitude,
        longitude: extra.longitude ?? point.longitude,
        speedMetersPerSecond: extra.speedMetersPerSecond ?? 4,
        horizontalAccuracyMeters: extra.horizontalAccuracyMeters ?? 6,
        headingDegrees: extra.headingDegrees,
      }),
    );
    id += 1;
  };

  let progress = 0;
  let stopped = false;
  while (progress <= length + stepMeters * 4) {
    if (!stopped && progress + stepMeters > options.stopProgressMeters) {
      const stop = options.stopProgressMeters;
      if (options.mode === 'zero-fix') {
        pushAt(stop, timeMs, { speedMetersPerSecond: 0 });
        timeMs += options.stopDurationMs;
        pushAt(stop, timeMs, { speedMetersPerSecond: 0 });
      } else {
        const jitter = options.jitterMeters ?? 2;
        const ticks = Math.max(1, Math.round(options.stopDurationMs / intervalMs));
        for (let tick = 0; tick <= ticks; tick += 1) {
          const phase = tick % 4;
          const east = jitter === 0 ? 0 : phase === 1 ? jitter : phase === 3 ? -jitter : 0;
          const along = jitter === 0 ? 0 : phase === 2 ? jitter * 0.25 : 0;
          const point = pointAtProgress(path, stop);
          const jittered = offsetLatLng(point.latitude, point.longitude, along, east);
          pushAt(stop, timeMs, {
            latitude: jittered.latitude,
            longitude: jittered.longitude,
            speedMetersPerSecond: 0,
          });
          timeMs += intervalMs;
        }
      }
      stopped = true;
      progress = stop;
    }
    pushAt(progress, timeMs);
    progress += stepMeters;
    timeMs += intervalMs;
  }
  return samples;
}

function tracesFor(
  course: TimingCourse,
  rows: { id: string; armedAtMs: number; samples: LocationSample[] }[],
): AttemptTrace[] {
  return rows.map((row) => ({
    attempt: makeAttempt({
      id: row.id,
      sessionId: row.id,
      armedAtMs: row.armedAtMs,
    }),
    samples: row.samples,
  }));
}

function derived(course: TimingCourse, id: string, samples: LocationSample[]) {
  return deriveCurrentLayoutAttempt(
    course,
    makeAttempt({ id, sessionId: id, armedAtMs: samples[0]?.recordedAtMs ?? 1_000 }),
    samples,
  );
}

function wait90vs40(
  course: TimingCourse,
  jitterMeters: number,
): { comparison: GhostComparison; current: ReturnType<typeof derived>; waitProgressMeters: number } {
  const longer = commuteWithStop(course.referencePath, {
    sessionId: 'long-wait',
    startMs: 1_000,
    stopProgressMeters: 400,
    stopDurationMs: 90_000,
    mode: 'dense-jitter',
    jitterMeters,
  });
  const shorter = commuteWithStop(course.referencePath, {
    sessionId: 'short-wait',
    startMs: 50_000,
    stopProgressMeters: 400,
    stopDurationMs: 40_000,
    mode: 'dense-jitter',
    jitterMeters,
  });
  const current = derived(course, 'long-wait', longer);
  const reference = derived(course, 'short-wait', shorter);
  const comparison = compareAttemptGhost({
    course,
    current,
    currentSamples: longer,
    reference,
    referenceSamples: shorter,
  });
  const wait = current.waitEvents.find((event) => Math.abs((event.progressMeters ?? 0) - 400) < 25);
  assert.ok(wait?.progressMeters != null);
  return { comparison, current, waitProgressMeters: wait.progressMeters };
}

function vertex(input: {
  progressMeters: number;
  deltaMs: number;
  currentElapsedMs: number;
  knotKind?: GhostChartVertex['knotKind'];
}): GhostChartVertex {
  return {
    progressMeters: input.progressMeters,
    deltaMs: input.deltaMs,
    currentElapsedMs: input.currentElapsedMs,
    referenceElapsedMs: input.currentElapsedMs - input.deltaMs,
    coordinate: { latitude: 32.08 + input.progressMeters / 111_320, longitude: 34.78 },
    knotKind: input.knotKind ?? 'sample',
    source: 'current',
  };
}

function uniqueFirstPerColumn(
  vertices: GhostChartVertex[],
  startProgressMeters: number,
  finishProgressMeters: number,
  widthPx: number,
): GhostChartVertex[] {
  const span = Math.max(finishProgressMeters - startProgressMeters, 1e-6);
  const kept: GhostChartVertex[] = [];
  const seen = new Set<number>();
  for (const item of vertices) {
    const t = (item.progressMeters - startProgressMeters) / span;
    const bucket = Math.round(Math.min(1, Math.max(0, t)) * Math.max(widthPx - 1, 0));
    if (seen.has(bucket)) {
      continue;
    }
    seen.add(bucket);
    kept.push(item);
  }
  return kept;
}

function maxDeltaSpanByColumn(
  vertices: GhostChartVertex[],
  startProgressMeters: number,
  finishProgressMeters: number,
  widthPx: number,
): number {
  const span = Math.max(finishProgressMeters - startProgressMeters, 1e-6);
  const buckets = new Map<number, number[]>();
  for (const item of vertices) {
    const t = (item.progressMeters - startProgressMeters) / span;
    const bucket = Math.round(Math.min(1, Math.max(0, t)) * Math.max(widthPx - 1, 0));
    const list = buckets.get(bucket) ?? [];
    list.push(item.deltaMs);
    buckets.set(bucket, list);
  }
  let best = 0;
  for (const deltas of buckets.values()) {
    best = Math.max(best, Math.max(...deltas) - Math.min(...deltas));
  }
  return best;
}

function preparedLayout(prepared: GhostChartPrepared, plotWidthPx = 320, heightPx = 148) {
  const layout = ghostChartLayoutForSize(
    plotWidthPx + 44 + 12,
    heightPx,
  );
  assert.equal(ghostChartPlotWidthPx(layout), plotWidthPx);
  return { prepared, layout };
}

describe('ghost chart series preparation', () => {
  it('starts at zero and finishes at the shared official finish-trigger delta', () => {
    const course = courseFromPath();
    const { comparison } = wait90vs40(course, 2);
    const prepared = prepareGhostChartSeries(comparison, { widthPx: 320 });
    assert.equal(prepared.available, true);
    const vertices = flattenGhostChartVertices(prepared);
    assert.equal(vertices[0]?.deltaMs, 0);
    assert.equal(vertices[0]?.knotKind, 'start');
    const finish =
      [...vertices].reverse().find((item) => item.knotKind === 'finish-trigger') ?? vertices[vertices.length - 1];
    assert.ok(finish);
    assert.equal(finish.deltaMs, comparison.finishTriggerDeltaMs);
    assert.ok(Math.abs(finish.progressMeters - finishTriggerProgressMeters(course)) < 0.01);
  });

  it('is exactly zero through preparation and scrubbing for identical traces', () => {
    const course = courseFromPath();
    const samples = commuteWithStop(course.referencePath, {
      sessionId: 'self',
      startMs: 8_000,
      stopProgressMeters: 360,
      stopDurationMs: 25_000,
      mode: 'dense-jitter',
    });
    const attempt = derived(course, 'self', samples);
    const comparison = compareAttemptGhost({
      course,
      current: attempt,
      currentSamples: samples,
      reference: attempt,
      referenceSamples: samples,
    });
    const prepared = prepareGhostChartSeries(comparison, { widthPx: 320 });
    const vertices = flattenGhostChartVertices(prepared);
    assert.ok(vertices.length > 10);
    for (const item of vertices) {
      assert.equal(item.deltaMs, 0);
    }
    const { layout } = preparedLayout(prepared);
    const mid = vertices[Math.floor(vertices.length / 2)]!;
    const point = projectGhostChartPoint(prepared, layout, mid.progressMeters, mid.deltaMs);
    const selected = selectGhostChartPoint(prepared, layout, point.x, point.y);
    assert.ok(selected);
    assert.equal(selected.deltaMs, 0);
    const again = selectGhostChartPoint(prepared, layout, point.x, point.y);
    assert.deepEqual(selected, again);
  });

  it('produces negative prepared values for a faster run and positive values for a slower run', () => {
    const course = courseFromPath();
    const slow = stretchAfterDeparture(
      coveringTrace(course.referencePath, { sessionId: 'slow', startMs: 1_000 }),
      2,
    );
    const fast = coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 800_000 });
    const traces = tracesFor(course, [
      { id: 'slow', armedAtMs: 1_000, samples: slow },
      { id: 'fast', armedAtMs: 800_000, samples: fast },
    ]);
    const faster = analyzeFocusAttempt(course, traces, 'fast');
    const slower = analyzeFocusAttempt(course, traces, 'slow');
    assert.ok(faster && slower);
    const fastChart = prepareGhostChartSeries(faster.ghostComparison, { widthPx: 320 });
    const slowChart = prepareGhostChartSeries(slower.ghostComparison, { widthPx: 320 });
    assert.ok(fastChart.minDeltaMs < -50_000);
    assert.ok((fastChart.finishTriggerDeltaMs ?? 0) < 0);
    assert.ok(slowChart.maxDeltaMs > 50_000);
    assert.ok((slowChart.finishTriggerDeltaMs ?? 0) > 0);
  });

  it('keeps a 90 s vs 40 s same-location wait as a local ~+50 s transition in the prepared series', () => {
    const course = courseFromPath();
    const { comparison, waitProgressMeters } = wait90vs40(course, 2);
    const officialDelta = comparison.finishTriggerDeltaMs ?? 0;
    assert.ok(Math.abs(officialDelta - 50_000) < 4_000, `official delta ${officialDelta}`);

    const occupancyFirst = elapsedOnIncreasingFlanks(comparison.currentPolyline!, waitProgressMeters)[0];
    const referenceFirst = elapsedOnIncreasingFlanks(comparison.referencePolyline!, waitProgressMeters)[0];
    if (occupancyFirst != null && referenceFirst != null) {
      assert.ok(
        Math.abs(occupancyFirst - referenceFirst) < 12_000,
        'unique-first flanks at the wait must not be how +50s is represented',
      );
    }

    const prepared = prepareGhostChartSeries(comparison, { widthPx: 320 });
    const aroundWait = flattenGhostChartVertices(prepared).filter(
      (item) => Math.abs(item.progressMeters - waitProgressMeters) <= 8,
    );
    assert.ok(aroundWait.length >= 2);
    const minAround = Math.min(...aroundWait.map((item) => item.deltaMs));
    const maxAround = Math.max(...aroundWait.map((item) => item.deltaMs));
    assert.ok(maxAround > 35_000, `prepared wait max ${maxAround}`);
    assert.ok(minAround < 12_000, `prepared wait min ${minAround}`);
    const progressSpan = Math.max(...aroundWait.map((item) => item.progressMeters)) - Math.min(...aroundWait.map((item) => item.progressMeters));
    assert.ok(progressSpan < 20, `wait transition should stay local, span ${progressSpan}`);
    assert.equal(
      flattenGhostChartVertices(prepared).some((item) => item.knotKind === 'finish-trigger' && item.deltaMs === comparison.finishTriggerDeltaMs),
      true,
    );
  });

  it('rejects unique-first / one-value-per-x sampling of a same-location 90 s vs 40 s wait', () => {
    const course = courseFromPath();
    const { comparison, waitProgressMeters } = wait90vs40(course, 0);
    const widthPx = 320;
    const raw = ghostComparisonPolylines(comparison).flatMap((polyline) => polyline.vertices);
    const uniqueFirst = uniqueFirstPerColumn(
      raw,
      comparison.currentPolyline?.startProgressMeters ?? 0,
      comparison.currentPolyline?.finishTriggerProgressMeters ?? 800,
      widthPx,
    );
    const uniqueFirstColumnSpan = maxDeltaSpanByColumn(
      uniqueFirst,
      comparison.currentPolyline?.startProgressMeters ?? 0,
      comparison.currentPolyline?.finishTriggerProgressMeters ?? 800,
      widthPx,
    );
    assert.equal(uniqueFirstColumnSpan, 0, 'unique-first can only keep one y per x column');
    const waitBucket = Math.round(
      ((waitProgressMeters - (comparison.currentPolyline?.startProgressMeters ?? 0)) /
        Math.max(
          (comparison.currentPolyline?.finishTriggerProgressMeters ?? 800) -
            (comparison.currentPolyline?.startProgressMeters ?? 0),
          1e-6,
        )) *
        Math.max(widthPx - 1, 0),
    );
    const bucketOf = (progressMeters: number) =>
      Math.round(
        ((progressMeters - (comparison.currentPolyline?.startProgressMeters ?? 0)) /
          Math.max(
            (comparison.currentPolyline?.finishTriggerProgressMeters ?? 800) -
              (comparison.currentPolyline?.startProgressMeters ?? 0),
            1e-6,
          )) *
          Math.max(widthPx - 1, 0),
      );
    const uniqueFirstWaitColumn = uniqueFirst.filter((item) => bucketOf(item.progressMeters) === waitBucket);
    assert.equal(uniqueFirstWaitColumn.length, 1);
    assert.ok(
      (uniqueFirstWaitColumn[0]?.deltaMs ?? 99_999) < 15_000,
      `unique-first in the wait column should stay near arrival, got ${uniqueFirstWaitColumn[0]?.deltaMs}`,
    );

    const prepared = prepareGhostChartSeries(comparison, { widthPx });
    const preparedWait = flattenGhostChartVertices(prepared).filter(
      (item) => Math.abs(item.progressMeters - waitProgressMeters) <= 8,
    );
    const preparedMax = Math.max(...preparedWait.map((item) => item.deltaMs));
    assert.ok(preparedMax > 35_000, `prepared wait max ${preparedMax}`);
    const preparedColumnSpan = maxDeltaSpanByColumn(
      flattenGhostChartVertices(prepared),
      prepared.startProgressMeters,
      prepared.finishProgressMeters,
      widthPx,
    );
    assert.ok(preparedColumnSpan > 35_000, `same-column prepared span ${preparedColumnSpan}`);
  });

  it('preserves a synthetic wait spike when many knots collapse into one phone-width pixel column', () => {
    const wait: GhostChartVertex[] = [
      vertex({ progressMeters: 0, deltaMs: 0, currentElapsedMs: 0, knotKind: 'start' }),
    ];
    for (let tick = 0; tick <= 100; tick += 1) {
      wait.push(
        vertex({
          progressMeters: 400,
          deltaMs: tick * 500,
          currentElapsedMs: 80_000 + tick * 1_000,
        }),
      );
    }
    wait.push(vertex({ progressMeters: 800, deltaMs: 50_000, currentElapsedMs: 200_000, knotKind: 'finish-trigger' }));
    const reduced = reduceGhostChartPolyline(wait, 0, 800, 320);
    const waitPoints = reduced.filter((item) => Math.abs(item.progressMeters - 400) < 1);
    assert.ok(waitPoints.length >= 2);
    assert.ok(Math.max(...waitPoints.map((item) => item.deltaMs)) >= 49_000);
    assert.ok(Math.min(...waitPoints.map((item) => item.deltaMs)) <= 500);
    const uniqueFirst = uniqueFirstPerColumn(wait, 0, 800, 320);
    const uniqueWait = uniqueFirst.filter((item) => Math.abs(item.progressMeters - 400) < 1);
    assert.equal(uniqueWait.length, 1);
    assert.equal(uniqueWait[0]?.deltaMs, 0);
  });

  it('creates path breaks for unavailable coverage instead of connecting across the hole', () => {
    const course = courseFromPath();
    const path = course.referencePath;
    const length = pathDistanceMeters(path);
    const samples: LocationSample[] = [];
    let timeMs = 40_000;
    let progress = 0;
    let id = 0;
    let gapped = false;
    while (progress <= length + 16) {
      const point = pointAtProgress(path, Math.min(progress, length));
      samples.push(
        sample({
          id: `hole-${id}`,
          sessionId: 'hole',
          recordedAtMs: timeMs,
          latitude: point.latitude,
          longitude: point.longitude,
        }),
      );
      id += 1;
      if (!gapped && progress >= 240) {
        progress += 80;
        timeMs += MAX_STATIONARY_GAP_MS + 20_000;
        gapped = true;
        continue;
      }
      progress += 4;
      timeMs += 1000;
    }
    const baseline = coveringTrace(path, { sessionId: 'base', startMs: 1_000 });
    const current = derived(course, 'hole', samples);
    const reference = derived(course, 'base', baseline);
    const comparison = compareAttemptGhost({
      course,
      current,
      currentSamples: samples,
      reference,
      referenceSamples: baseline,
    });
    const prepared = prepareGhostChartSeries(comparison, { widthPx: 320 });
    assert.ok(prepared.polylines.length >= 2, 'unavailable coverage must split the chart path');
    const inHole = flattenGhostChartVertices(prepared).filter(
      (item) => item.progressMeters > 250 && item.progressMeters < 310,
    );
    assert.equal(inHole.length, 0);

    const { layout } = preparedLayout(prepared);
    const holeTap = projectGhostChartPoint(prepared, layout, 280, 0);
    const selected = selectGhostChartPoint(prepared, layout, holeTap.x, holeTap.y);
    if (selected) {
      assert.equal(
        selected.progressMeters > 250 && selected.progressMeters < 310,
        false,
        'scrub must not invent a comparable point inside the hole',
      );
    }
  });

  it('reproduces the same prepared series on reload', () => {
    const course = courseFromPath();
    const { comparison } = wait90vs40(course, 2);
    const first = prepareGhostChartSeries(comparison, { widthPx: 320 });
    const second = prepareGhostChartSeries(comparison, { widthPx: 320 });
    assert.deepEqual(first, second);
  });

  it('keeps prepared vertex count bounded at phone width without dropping the wait extrema', () => {
    const course = courseFromPath();
    const { comparison, waitProgressMeters } = wait90vs40(course, 0);
    const rawCount = ghostComparisonPolylines(comparison).reduce((sum, polyline) => sum + polyline.vertices.length, 0);
    const prepared = prepareGhostChartSeries(comparison, { widthPx: 320 });
    const preparedCount = flattenGhostChartVertices(prepared).length;
    assert.ok(rawCount > 80, `raw ${rawCount}`);
    assert.ok(preparedCount <= 320 * 4 + 8, `prepared ${preparedCount}`);
    const waitMax = Math.max(
      ...flattenGhostChartVertices(prepared)
        .filter((item) => Math.abs(item.progressMeters - waitProgressMeters) <= 8)
        .map((item) => item.deltaMs),
    );
    assert.ok(waitMax > 35_000);
  });
});

describe('ghost chart scrub helper', () => {
  it('can select the later stall delta on a vertical wait instead of only arrival', () => {
    const prepared: GhostChartPrepared = {
      available: true,
      polylines: [
        {
          vertices: [
            vertex({ progressMeters: 0, deltaMs: 0, currentElapsedMs: 0, knotKind: 'start' }),
            vertex({ progressMeters: 400, deltaMs: 0, currentElapsedMs: 90_000 }),
            vertex({ progressMeters: 400, deltaMs: 50_000, currentElapsedMs: 140_000 }),
            vertex({ progressMeters: 800, deltaMs: 50_000, currentElapsedMs: 200_000, knotKind: 'finish-trigger' }),
          ],
        },
      ],
      startProgressMeters: 0,
      finishProgressMeters: 800,
      minDeltaMs: 0,
      maxDeltaMs: 50_000,
      startDeltaMs: 0,
      finishTriggerDeltaMs: 50_000,
    };
    const { layout } = preparedLayout(prepared);
    const top = projectGhostChartPoint(prepared, layout, 400, 50_000);
    const bottom = projectGhostChartPoint(prepared, layout, 400, 0);
    const later = selectGhostChartPoint(prepared, layout, top.x, top.y);
    const arrival = selectGhostChartPoint(prepared, layout, bottom.x, bottom.y);
    assert.ok(later);
    assert.ok(arrival);
    assert.ok(later.deltaMs > 45_000, `later ${later.deltaMs}`);
    assert.ok(arrival.deltaMs < 5_000, `arrival ${arrival.deltaMs}`);
    assert.deepEqual(later, selectGhostChartPoint(prepared, layout, top.x, top.y));
  });

  it('selects ~+50 s on the prepared 90 s vs 40 s wait spike', () => {
    const course = courseFromPath();
    const { comparison, waitProgressMeters } = wait90vs40(course, 0);
    const prepared = prepareGhostChartSeries(comparison, { widthPx: 320 });
    const { layout } = preparedLayout(prepared);
    const waitVertices = flattenGhostChartVertices(prepared).filter(
      (item) => Math.abs(item.progressMeters - waitProgressMeters) <= 8,
    );
    const peak = waitVertices.reduce((best, item) => (item.deltaMs > best.deltaMs ? item : best));
    const point = projectGhostChartPoint(prepared, layout, peak.progressMeters, peak.deltaMs);
    const selected = selectGhostChartPoint(prepared, layout, point.x, point.y);
    assert.ok(selected);
    assert.ok(selected.deltaMs > 35_000, `selected wait delta ${selected.deltaMs}`);
    const mapped = pointAtProgress(course.referencePath, selected.progressMeters);
    const waitCoord = pointAtProgress(course.referencePath, waitProgressMeters);
    assert.ok(haversineMeters(mapped, waitCoord) < 25);
  });

  it('does not snap a gap as though it were a trustworthy segment', () => {
    const prepared: GhostChartPrepared = {
      available: true,
      polylines: [
        {
          vertices: [
            vertex({ progressMeters: 0, deltaMs: 0, currentElapsedMs: 0, knotKind: 'start' }),
            vertex({ progressMeters: 200, deltaMs: 1_000, currentElapsedMs: 50_000 }),
          ],
        },
        {
          vertices: [
            vertex({ progressMeters: 500, deltaMs: 8_000, currentElapsedMs: 140_000 }),
            vertex({ progressMeters: 800, deltaMs: 8_000, currentElapsedMs: 200_000, knotKind: 'finish-trigger' }),
          ],
        },
      ],
      startProgressMeters: 0,
      finishProgressMeters: 800,
      minDeltaMs: 0,
      maxDeltaMs: 8_000,
      startDeltaMs: 0,
      finishTriggerDeltaMs: 8_000,
    };
    const { layout } = preparedLayout(prepared);
    const fabricated = projectGhostChartPoint(prepared, layout, 350, 4_500);
    const selected = selectGhostChartPoint(prepared, layout, fabricated.x, fabricated.y);
    if (selected) {
      assert.equal(selected.progressMeters > 220 && selected.progressMeters < 480, false);
    }
  });
});

describe('ghost chart product copy and wiring', () => {
  it('uses current PB copy for a non-PB attempt and previous-PB copy for the current PB', () => {
    const course = courseFromPath();
    const previousPb = stretchAfterDeparture(
      coveringTrace(course.referencePath, { sessionId: 'previous-pb', startMs: 1_000 }),
      1.6,
    );
    const newPb = coveringTrace(course.referencePath, { sessionId: 'new-pb', startMs: 800_000 });
    const slower = stretchAfterDeparture(
      coveringTrace(course.referencePath, { sessionId: 'slow', startMs: 1_200_000 }),
      2,
    );
    const traces = tracesFor(course, [
      { id: 'previous-pb', armedAtMs: 1_000, samples: previousPb },
      { id: 'new-pb', armedAtMs: 800_000, samples: newPb },
      { id: 'slow', armedAtMs: 1_200_000, samples: slower },
    ]);
    const pbFocus = analyzeFocusAttempt(course, traces, 'new-pb');
    const slowFocus = analyzeFocusAttempt(course, traces, 'slow');
    assert.ok(pbFocus && slowFocus);
    assert.equal(pbFocus.isPb, true);
    assert.equal(pbFocus.comparisonPbAttemptId, 'previous-pb');
    assert.equal(slowFocus.isPb, false);
    assert.equal(slowFocus.comparisonPbAttemptId, 'new-pb');
    const pbCopy = ghostChartCopy({
      available: pbFocus.ghostComparison.available,
      unavailableReason: pbFocus.ghostComparison.unavailableReason,
      isCurrentPb: true,
    });
    const slowCopy = ghostChartCopy({
      available: slowFocus.ghostComparison.available,
      unavailableReason: slowFocus.ghostComparison.unavailableReason,
      isCurrentPb: false,
    });
    assert.equal(pbCopy.sectionLabel, 'GHOST VS PREVIOUS PB');
    assert.equal(pbCopy.deltaLabel, 'Delta vs previous PB');
    assert.equal(slowCopy.sectionLabel, 'GHOST VS PB');
    assert.equal(slowCopy.deltaLabel, 'Delta vs PB');
  });

  it('shows a clean unavailable state for a first-ever PB', () => {
    const course = courseFromPath();
    const only = coveringTrace(course.referencePath, { sessionId: 'only', startMs: 5_000 });
    const traces = tracesFor(course, [{ id: 'only', armedAtMs: 5_000, samples: only }]);
    const focus = analyzeFocusAttempt(course, traces, 'only');
    assert.ok(focus);
    assert.equal(focus.ghostComparison.available, false);
    const copy = ghostChartCopy({
      available: false,
      unavailableReason: focus.ghostComparison.unavailableReason,
      isCurrentPb: true,
    });
    assert.equal(copy.sectionLabel, 'GHOST VS PREVIOUS PB');
    assert.equal(copy.unavailableMessage, 'No previous PB to compare against.');
    const prepared = prepareGhostChartSeries(focus.ghostComparison, { widthPx: 320 });
    assert.equal(prepared.available, false);
    assert.equal(prepared.polylines.length, 0);
    const { layout } = preparedLayout({ ...prepared, startProgressMeters: 0, finishProgressMeters: 800 });
    assert.equal(selectGhostChartPoint(prepared, layout, 40, 40), null);
  });

  it('does not change official time, PB, rank, Gold, or Sum of Best', () => {
    const path = longPath();
    const course = courseFromPath(path, {
      checkpoints: [{ id: 'mid', name: 'Mid', progressMeters: 300 }],
    });
    const traces = tracesFor(course, [
      {
        id: 'fast',
        armedAtMs: 1_000,
        samples: coveringTrace(path, { sessionId: 'fast', startMs: 1_000 }),
      },
      {
        id: 'slow',
        armedAtMs: 30_000,
        samples: commuteWithStop(path, {
          sessionId: 'slow',
          startMs: 30_000,
          stopProgressMeters: 300,
          stopDurationMs: 18_000,
          mode: 'zero-fix',
        }),
      },
    ]);
    const focus = analyzeFocusAttempt(course, traces, 'slow');
    assert.ok(focus);
    const prepared = prepareGhostChartSeries(focus.ghostComparison, { widthPx: 320 });
    assert.equal(focus.rank, 2);
    assert.equal(focus.summary.pbAttemptId, 'fast');
    assert.equal(focus.focus.officialTimeMs, focus.focus.movement?.officialTimeMs);
    assert.equal(prepared.finishTriggerDeltaMs, focus.ghostComparison.finishTriggerDeltaMs);
    assert.equal(
      focus.sumOfBestMs,
      focus.segments.reduce((sum, segment) => sum + (segment.goldDurationMs ?? 0), 0),
    );
  });

  it('keeps chart helpers free of Expo, React Native, and MapLibre', () => {
    const source = readFileSync('src/domain/ghost-chart.ts', 'utf8');
    assert.doesNotMatch(
      source,
      /expo-location|expo-task-manager|expo-sqlite|react-native|@maplibre\/maplibre-react-native|maplibre/,
    );
  });
});
