import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, officialTimeMs, type Attempt } from '../src/domain/attempt';
import { summarizeJourneyPool } from '../src/domain/journey-analysis';
import { isCompatiblePathVariant } from '../src/domain/path-variant';
import {
  defaultDiscoveredPathName,
  PATH_VARIANT_CLASSIFICATION_VERSION,
  planPathVariantRecompute,
  preparePathShape,
  summarizeJourneyPathVariants,
  type JourneyAttemptTrace,
} from '../src/domain/path-variant-discovery';
import type { Route } from '../src/domain/route';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const POOL = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter' as const,
};

const MAIN_PATH = northPath({
  startLat: HOME.center.latitude,
  startLng: HOME.center.longitude,
  points: 51,
  stepMeters: 20,
});

function offsetPath(eastMeters: number) {
  return MAIN_PATH.map((point) => offsetLatLng(point.latitude, point.longitude, 0, eastMeters));
}

function pathSamples(
  sessionId: string,
  eastMeters: number,
  options?: { stepMeters?: number; intervalMs?: number; count?: number; startMs?: number },
) {
  return traceAlongPath(offsetPath(eastMeters), {
    sessionId,
    startMs: options?.startMs ?? 1_700_000_000_000,
    intervalMs: options?.intervalMs ?? 1000,
    stepMeters: options?.stepMeters ?? 10,
    count: options?.count ?? 100,
  });
}

function completedTrace(
  id: string,
  samples: ReturnType<typeof pathSamples>,
  overrides: Partial<Attempt> = {},
): JourneyAttemptTrace {
  const startedAtMs = samples[0]?.recordedAtMs ?? 1_700_000_000_000;
  const finishedAtMs = samples[samples.length - 1]?.recordedAtMs ?? startedAtMs + 1;
  return {
    attempt: {
      id,
      routeId: null,
      originPlaceId: HOME.id,
      destinationPlaceId: WORK.id,
      transportationMode: 'scooter',
      sessionId: samples[0]?.sessionId ?? id,
      lifecycle: 'completed',
      validity: 'valid',
      armedAtMs: startedAtMs - 5_000,
      startedAtMs,
      finishedAtMs,
      ...EMPTY_ATTEMPT_LOCAL_START,
      resultAcknowledged: true,
      crossings: [],
      ...overrides,
    },
    samples,
  };
}

function mainRoute(overrides: Partial<Route> = {}) {
  return makeRoute({
    id: 'route-main',
    name: 'Main road',
    createdAtMs: 50,
    referencePath: MAIN_PATH,
    startZone: { center: HOME.center, radiusMeters: 30 },
    finishZone: { center: WORK.center, radiusMeters: 30 },
    ...overrides,
  });
}

function recompute(
  traces: JourneyAttemptTrace[],
  routes: Route[],
  options?: { createRouteId?: () => string; nowMs?: number },
) {
  let nextId = 0;
  return planPathVariantRecompute({
    pool: POOL,
    origin: HOME,
    destination: WORK,
    traces,
    routes,
    nowMs: options?.nowMs ?? 9_000,
    createRouteId: options?.createRouteId ?? (() => `discovered-${++nextId}`),
  });
}

describe('path variant discovery', () => {
  it('groups ordinary recordings of the same path despite 15-25 m GPS noise', () => {
    const traces = [
      completedTrace('a', pathSamples('s-a', 15)),
      completedTrace('b', pathSamples('s-b', 20)),
      completedTrace('c', pathSamples('s-c', 25)),
    ];
    const plan = recompute(traces, []);
    assert.equal(plan.newRoutes.length, 1);
    assert.equal(plan.classificationVersion, PATH_VARIANT_CLASSIFICATION_VERSION);
    assert.deepEqual(
      plan.assignments.map((item) => item.routeId),
      [plan.newRoutes[0]!.id, plan.newRoutes[0]!.id, plan.newRoutes[0]!.id],
    );
  });

  it('keeps the same cluster when sampling frequency changes', () => {
    const traces = [
      completedTrace('dense', pathSamples('s-dense', 10, { stepMeters: 4, intervalMs: 250, count: 250 })),
      completedTrace('mid', pathSamples('s-mid', 12, { stepMeters: 10, intervalMs: 1000, count: 100 })),
      completedTrace('sparse', pathSamples('s-sparse', 8, { stepMeters: 16, intervalMs: 1600, count: 62 })),
    ];
    const plan = recompute(traces, []);
    assert.equal(plan.newRoutes.length, 1);
    assert.ok(plan.assignments.every((item) => item.routeId === plan.newRoutes[0]!.id));
  });

  it('can split recurring 40-60 m parallel streets into distinct variants', () => {
    const traces = [
      completedTrace('main-1', pathSamples('s-m1', 0)),
      completedTrace('main-2', pathSamples('s-m2', 5)),
      completedTrace('main-3', pathSamples('s-m3', 8)),
      completedTrace('side-1', pathSamples('s-p1', 50)),
      completedTrace('side-2', pathSamples('s-p2', 52)),
      completedTrace('side-3', pathSamples('s-p3', 55)),
    ];
    const plan = recompute(traces, []);
    assert.equal(plan.newRoutes.length, 2);
    const ids = new Set(plan.assignments.map((item) => item.routeId));
    assert.equal(ids.size, 2);
    assert.equal([...ids].includes(null), false);
  });

  it('does not surface a user-facing variant from one outlier attempt', () => {
    const traces = [
      completedTrace('main-1', pathSamples('s-m1', 0)),
      completedTrace('main-2', pathSamples('s-m2', 8)),
      completedTrace('main-3', pathSamples('s-m3', 12)),
      completedTrace('outlier', pathSamples('s-out', 55)),
    ];
    const plan = recompute(traces, []);
    assert.equal(plan.newRoutes.length, 1);
    const outlier = plan.assignments.find((item) => item.attemptId === 'outlier');
    assert.equal(outlier?.routeId, null);
  });

  it('surfaces a candidate once three recurring distinct attempts exist', () => {
    const two = recompute(
      [completedTrace('a', pathSamples('s-a', 50)), completedTrace('b', pathSamples('s-b', 52))],
      [],
    );
    assert.equal(two.newRoutes.length, 0);
    const three = recompute(
      [
        completedTrace('a', pathSamples('s-a', 50)),
        completedTrace('b', pathSamples('s-b', 52)),
        completedTrace('c', pathSamples('s-c', 48)),
      ],
      [],
    );
    assert.equal(three.newRoutes.length, 1);
    assert.equal(three.newRoutes[0]!.kind, 'discovered');
    assert.equal(three.newRoutes[0]!.name, 'Path 1');
  });

  it('does not collapse A≈B and B≈C into one variant when A is far from C', () => {
    const traces = [
      completedTrace('a', pathSamples('s-a', 0)),
      completedTrace('b', pathSamples('s-b', 30)),
      completedTrace('c', pathSamples('s-c', 60)),
    ];
    const plan = recompute(traces, []);
    assert.equal(plan.newRoutes.length, 0);
    assert.ok(plan.assignments.every((item) => item.routeId == null));
  });

  it('keeps opposite direction and other modes out of a journey cluster', () => {
    const traces = [
      completedTrace('s1', pathSamples('s-1', 50)),
      completedTrace('s2', pathSamples('s-2', 52)),
      completedTrace('s3', pathSamples('s-3', 48)),
      completedTrace('walk', pathSamples('s-walk', 50), { transportationMode: 'walk' }),
      completedTrace('return', pathSamples('s-ret', 50), {
        originPlaceId: WORK.id,
        destinationPlaceId: HOME.id,
      }),
    ];
    const plan = recompute(traces, []);
    assert.equal(plan.newRoutes.length, 1);
    assert.deepEqual(
      plan.assignments.map((item) => item.attemptId).sort(),
      ['s1', 's2', 's3'],
    );
  });

  it('assigns a unique migrated/explicit route match and does not invent a duplicate', () => {
    const route = mainRoute();
    const traces = [
      completedTrace('a', pathSamples('s-a', 0)),
      completedTrace('b', pathSamples('s-b', 8)),
      completedTrace('c', pathSamples('s-c', 12)),
    ];
    const plan = recompute(traces, [route]);
    assert.equal(plan.newRoutes.length, 0);
    assert.ok(plan.assignments.every((item) => item.routeId === route.id));
  });

  it('leaves a 20-30 m overlap strip between two ~50 m-apart variants unassigned', () => {
    const main = mainRoute();
    const parallel = mainRoute({
      id: 'route-park',
      name: 'Park route',
      createdAtMs: 80,
      referencePath: offsetPath(50),
      startZone: { center: offsetPath(50)[0]!, radiusMeters: 30 },
      finishZone: { center: offsetPath(50)[offsetPath(50).length - 1]!, radiusMeters: 30 },
    });
    const traces = [
      completedTrace('overlap-20', pathSamples('s-20', 20)),
      completedTrace('overlap-25', pathSamples('s-25', 25)),
      completedTrace('overlap-30', pathSamples('s-30', 30)),
    ];
    const plan = recompute(traces, [main, parallel]);
    assert.equal(plan.newRoutes.length, 0);
    assert.ok(plan.assignments.every((item) => item.routeId == null));
  });

  it('leaves attempts with no compatible variant unassigned and eligible for discovery', () => {
    const route = mainRoute();
    const traces = [
      completedTrace('side-1', pathSamples('s-1', 50)),
      completedTrace('side-2', pathSamples('s-2', 52)),
      completedTrace('side-3', pathSamples('s-3', 55)),
    ];
    const none = recompute(traces.slice(0, 1), [route]);
    assert.equal(none.newRoutes.length, 0);
    assert.equal(none.assignments[0]?.routeId, null);
    const discovered = recompute(traces, [route]);
    assert.equal(discovered.newRoutes.length, 1);
    assert.ok(discovered.assignments.every((item) => item.routeId === discovered.newRoutes[0]!.id));
  });

  it('gives each attempt at most one primary variant', () => {
    const traces = [
      completedTrace('a', pathSamples('s-a', 0)),
      completedTrace('b', pathSamples('s-b', 6)),
      completedTrace('c', pathSamples('s-c', 10)),
    ];
    const plan = recompute(traces, []);
    const assigned = plan.assignments.map((item) => item.routeId);
    assert.equal(new Set(assigned).size, 1);
    assert.notEqual(assigned[0], null);
  });

  it('materializes deterministic reference geometry that existing path analytics can consume', () => {
    const traces = [
      completedTrace('a', pathSamples('s-a', 48)),
      completedTrace('b', pathSamples('s-b', 50)),
      completedTrace('c', pathSamples('s-c', 52)),
    ];
    const first = recompute(traces, [], { nowMs: 9_000 });
    const second = recompute(traces, [], { nowMs: 9_000 });
    assert.equal(first.newRoutes.length, 1);
    assert.deepEqual(first.newRoutes[0]!.referencePath, second.newRoutes[0]!.referencePath);
    assert.equal(first.newRoutes[0]!.clusterSignature, second.newRoutes[0]!.clusterSignature);
    const route = first.newRoutes[0]!;
    assert.ok(route.referencePath.length >= 3);
    assert.ok(isCompatiblePathVariant(route, traces[0]!.samples, {
      startedAtMs: traces[0]!.attempt.startedAtMs!,
      finishedAtMs: traces[0]!.attempt.finishedAtMs!,
    }));
    const shape = preparePathShape(traces[1]!.samples, {
      startedAtMs: traces[1]!.attempt.startedAtMs!,
      finishedAtMs: traces[1]!.attempt.finishedAtMs!,
    });
    assert.ok(shape);
    assert.ok(shape.length >= 3);
  });

  it('does not respawn an archived variant from the same traces on recompute', () => {
    const traces = [
      completedTrace('a', pathSamples('s-a', 50)),
      completedTrace('b', pathSamples('s-b', 52)),
      completedTrace('c', pathSamples('s-c', 48)),
    ];
    const created = recompute(traces, []);
    const archived = { ...created.newRoutes[0]!, status: 'archived' as const };
    const again = recompute(
      traces.map((trace, index) => ({
        ...trace,
        attempt: { ...trace.attempt, routeId: archived.id },
      })),
      [archived],
    );
    assert.equal(again.newRoutes.length, 0);
    assert.ok(again.assignments.every((item) => item.routeId == null));
    const visible = summarizeJourneyPathVariants(HOME, WORK, 'scooter', traces, [archived]);
    assert.equal(visible.length, 0);
  });

  it('assigns a unique active replacement after the same-path discovered variant is archived', () => {
    const traces = [
      completedTrace('a', pathSamples('s-a', 0)),
      completedTrace('b', pathSamples('s-b', 6)),
      completedTrace('c', pathSamples('s-c', 10)),
    ];
    const created = recompute(traces, []);
    const discovered = created.newRoutes[0]!;
    const explicit = mainRoute();
    const bothActive = recompute(traces, [discovered, explicit]);
    assert.equal(bothActive.newRoutes.length, 0);
    assert.ok(bothActive.assignments.every((item) => item.routeId == null));

    const afterArchive = recompute(traces, [{ ...discovered, status: 'archived' }, explicit]);
    assert.equal(afterArchive.newRoutes.length, 0);
    assert.ok(afterArchive.assignments.every((item) => item.routeId === explicit.id));
  });

  it('keeps archived geometry and does not delete or move attempts', () => {
    const traces = [
      completedTrace('a', pathSamples('s-a', 50)),
      completedTrace('b', pathSamples('s-b', 52)),
      completedTrace('c', pathSamples('s-c', 48)),
    ];
    const created = recompute(traces, []);
    const archived = { ...created.newRoutes[0]!, status: 'archived' as const, name: 'River route' };
    const beforeTimes = traces.map((trace) => officialTimeMs(trace.attempt));
    const again = recompute(traces, [archived]);
    assert.equal(again.newRoutes.length, 0);
    assert.deepEqual(
      traces.map((trace) => officialTimeMs(trace.attempt)),
      beforeTimes,
    );
    assert.equal(archived.referencePath.length, created.newRoutes[0]!.referencePath.length);
    assert.equal(defaultDiscoveredPathName(['River route', 'Path 1']), 'Path 2');
  });

  it('is deterministic across restart/recompute and does not change journey PB or validity', () => {
    const traces = [
      completedTrace('fast', pathSamples('s-fast', 50, { intervalMs: 100 })),
      completedTrace('mid', pathSamples('s-mid', 52, { intervalMs: 120 })),
      completedTrace('slow', pathSamples('s-slow', 48, { intervalMs: 150 })),
    ];
    const first = recompute(traces, [], { nowMs: 50_000 });
    const withAssignments = traces.map((trace) => {
      const routeId = first.assignments.find((item) => item.attemptId === trace.attempt.id)?.routeId ?? null;
      return { ...trace, attempt: { ...trace.attempt, routeId } };
    });
    const second = recompute(withAssignments, first.newRoutes, { nowMs: 50_000 });
    assert.equal(second.newRoutes.length, 0);
    assert.deepEqual(second.assignments, first.assignments);
    const pbBefore = summarizeJourneyPool(POOL, HOME, WORK, traces).pbTimeMs;
    const pbAfter = summarizeJourneyPool(POOL, HOME, WORK, withAssignments).pbTimeMs;
    assert.equal(pbBefore, pbAfter);
    assert.equal(pbBefore, officialTimeMs(traces[0]!.attempt));
    assert.ok(traces.every((trace) => trace.attempt.validity === 'valid'));
    const summaries = summarizeJourneyPathVariants(HOME, WORK, 'scooter', withAssignments, first.newRoutes);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.attemptCount, 3);
    assert.equal(summaries[0]?.pbTimeMs, pbBefore);
  });

  it('does not let incomplete attempts seed competitive path variants', () => {
    const traces = [
      completedTrace('done-1', pathSamples('s-1', 50)),
      completedTrace('done-2', pathSamples('s-2', 52)),
      completedTrace('incomplete', pathSamples('s-3', 48), {
        lifecycle: 'ended',
        validity: 'unranked',
        finishedAtMs: null,
      }),
    ];
    const plan = recompute(traces, []);
    assert.equal(plan.newRoutes.length, 0);
    assert.equal(plan.assignments.some((item) => item.attemptId === 'incomplete'), false);
  });

  it('uses one geographic compatibility budget so explicit and discovered variants compete equally', () => {
    const explicit = mainRoute();
    const traces = [
      completedTrace('main-1', pathSamples('s-m1', 0)),
      completedTrace('main-2', pathSamples('s-m2', 6)),
      completedTrace('park-1', pathSamples('s-p1', 50)),
      completedTrace('park-2', pathSamples('s-p2', 52)),
      completedTrace('park-3', pathSamples('s-p3', 55)),
      completedTrace('strip', pathSamples('s-strip', 25)),
    ];
    const plan = recompute(traces, [explicit]);
    assert.equal(plan.newRoutes.length, 1);
    const byId = new Map(plan.assignments.map((item) => [item.attemptId, item.routeId]));
    assert.equal(byId.get('main-1'), explicit.id);
    assert.equal(byId.get('main-2'), explicit.id);
    assert.equal(byId.get('park-1'), plan.newRoutes[0]!.id);
    assert.equal(byId.get('strip'), null);
  });
});
