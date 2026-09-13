import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makePlace } from './helpers/places';
import { northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const MAIN_PATH = northPath({
  startLat: HOME.center.latitude,
  startLng: HOME.center.longitude,
  points: 51,
  stepMeters: 20,
});

function offsetPath(eastMeters: number) {
  return MAIN_PATH.map((point) => offsetLatLng(point.latitude, point.longitude, 0, eastMeters));
}

function pathSamples(sessionId: string, eastMeters: number) {
  return traceAlongPath(offsetPath(eastMeters), {
    sessionId,
    startMs: 1_700_000_000_000,
    intervalMs: 1000,
    stepMeters: 10,
    count: 100,
  });
}

describe('path variant persistence', () => {
  it('persists rename/archive across recompute and does not respawn the same visible candidate', async () => {
    const { workspace, sessions, attempts, places, routes, attemptRuntime } = createMemoryWorkspace({
      now: () => 9_000,
    });
    await places.createPlace(HOME);
    await places.createPlace(WORK);

    const traces = [
      { id: 'attempt-a', east: 50 },
      { id: 'attempt-b', east: 52 },
      { id: 'attempt-c', east: 48 },
    ];
    for (const item of traces) {
      const samples = pathSamples(`session-${item.id}`, item.east);
      sessions.seedSession(
        {
          id: samples[0]!.sessionId,
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
      await attempts.createAttempt({
        id: item.id,
        routeId: null,
        originPlaceId: HOME.id,
        destinationPlaceId: WORK.id,
        transportationMode: 'scooter',
        sessionId: samples[0]!.sessionId,
        lifecycle: 'completed',
        validity: 'valid',
        armedAtMs: samples[0]!.recordedAtMs - 5_000,
        startedAtMs: samples[0]!.recordedAtMs,
        finishedAtMs: samples[samples.length - 1]!.recordedAtMs,
        resultAcknowledged: true,
        crossings: [],
      });
    }

    await attemptRuntime.recomputeAllPathVariants();
    const created = (await routes.listRoutes()).filter((route) => route.kind === 'discovered');
    assert.equal(created.length, 1);
    const variant = created[0]!;
    assert.equal(variant.status, 'active');
    const assigned = await attempts.listAttemptsForRoute(variant.id);
    assert.equal(assigned.length, 3);

    const renamed = await workspace.renamePathVariant(variant.id, 'River route');
    assert.equal(renamed.ok, true);
    if (renamed.ok) {
      assert.equal(renamed.route.name, 'River route');
    }

    const archived = await workspace.archivePathVariant(variant.id);
    assert.equal(archived.ok, true);
    if (archived.ok) {
      assert.equal(archived.route.status, 'archived');
      assert.equal(archived.route.name, 'River route');
    }

    await attemptRuntime.recomputeAllPathVariants();
    const after = await routes.listRoutes();
    assert.equal(after.filter((route) => route.kind === 'discovered').length, 1);
    assert.equal(after.filter((route) => route.status === 'active' && route.kind === 'discovered').length, 0);
    const stillAssigned = await attempts.listAttemptsForRoute(variant.id);
    assert.equal(stillAssigned.length, 3);
    assert.ok(stillAssigned.every((attempt) => attempt.originPlaceId === HOME.id));
    assert.equal((await sessions.countSamples(`session-attempt-a`)) > 10, true);

    const loaded = await workspace.loadJourney({
      originPlaceId: HOME.id,
      destinationPlaceId: WORK.id,
      transportationMode: 'scooter',
    });
    assert.equal(loaded?.pathVariants.length, 0);
    assert.equal(loaded?.summary.rankedAttemptCount, 3);
  });
});
