import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyMigrations } from '../src/persistence/migrations';
import { utcOffsetMinutesAt } from '../src/domain/attempt-local-time';
import { RouteWorkspace } from '../src/product/route-workspace';
import { handleSystemBack, type SystemBackActions } from '../src/ui/system-back';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { completeJourneySamples, departureOnlySamples, seedPlacesForRoute } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { movingTrace, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

async function saveDefaultRoute(
  workspace: RouteWorkspace,
  sessions: { appendSamples: (samples: ReturnType<typeof movingTrace>) => Promise<void> },
) {
  await workspace.startRouteRecording();
  await sessions.appendSamples(movingTrace({ sessionId: 'id-1', points: 16, stepMeters: 15 }));
  await workspace.finishRecording();
  const saved = await workspace.saveRoute('id-1', 'Home → Work', 'scooter');
  assert.equal(saved.ok, true);
  if (!saved.ok) {
    throw new Error('expected saved route');
  }
  return saved.route;
}

function preserveInspectBackActions(onInspect: () => void): SystemBackActions {
  return {
    leaveToHome() {
      throw new Error('system back should not leave to home from an attempt');
    },
    cancelRecording() {
      throw new Error('system back should not cancel recording from an attempt');
    },
    cancelEditor() {
      throw new Error('system back should not cancel the editor from an attempt');
    },
    leaveHistoryToDetail() {
      throw new Error('system back should not leave history from an attempt');
    },
    leavePlaceEditor() {
      throw new Error('system back should not leave the place editor from an attempt');
    },
    leaveDetailToJourney() {
      throw new Error('system back should not leave route detail from an attempt');
    },
    inspectAttempt: onInspect,
    acknowledgeAttemptResult() {
      throw new Error('system back should not acknowledge a result from an attempt');
    },
    leaveAttemptDetailToHistory() {
      throw new Error('system back should not leave attempt detail from an attempt');
    },
  };
}

describe('attempt lifecycle', { concurrency: 1 }, () => {
  it('arms without setting official started_at and uses an attempt session purpose', async () => {
    const { workspace, sessions, platform } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    const armed = await workspace.armRun(route.id);
    assert.equal(armed.ok, true);
    if (!armed.ok) {
      return;
    }
    assert.equal(armed.attempt.lifecycle, 'armed');
    assert.equal(armed.attempt.startedAtMs, null);
    assert.equal(armed.attempt.startedUtcOffsetMinutes, null);
    assert.equal(armed.attempt.startedLocalTimeSource, null);
    assert.equal((await sessions.getActiveSession())?.purpose, 'attempt');
    assert.match(platform.lastNotificationBody ?? '', /Timing an armed run/);
    const home = await workspace.loadHome();
    assert.equal(home.activeAttempt?.id, armed.attempt.id);
    assert.equal(home.activeRecording, null);
    assert.equal(home.canStartNewRecording, false);
  });

  it('cancels from armed and active, stops tracking, and never counts as official', async () => {
    const { workspace, sessions, platform } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    const armed = await workspace.armRun(route.id);
    assert.equal(armed.ok, true);
    const cancelled = await workspace.cancelAttempt();
    assert.equal(cancelled?.lifecycle, 'cancelled');
    assert.equal(cancelled?.validity, 'unranked');
    assert.equal(platform.updating, false);
    assert.equal(await sessions.getActiveSession(), null);
    assert.equal((await sessions.getSession('id-2'))?.captureOutcome, 'cancelled');
    assert.ok((await sessions.countSamples('id-2')) >= 0);

    const { workspace: second, sessions: sessions2, platform: platform2 } = createMemoryWorkspace({
      routeId: 'route-2',
      attemptId: 'attempt-2',
    });
    await second.startRouteRecording();
    await sessions2.appendSamples(movingTrace({ sessionId: 'id-1', points: 16, stepMeters: 15 }));
    await second.finishRecording();
    const saved = await second.saveRoute('id-1', 'Home → Work', 'scooter');
    assert.equal(saved.ok, true);
    if (!saved.ok) {
      return;
    }
    const places = await second.listPlaces();
    const origin = places.find((place) => place.name === 'Home');
    assert.ok(origin);
    await second.armRun(saved.route.id);
    await sessions2.appendSamples(
      departureOnlySamples({ origin, sessionId: 'id-2', extraMeters: 40 }),
    );
    const processed = await second.processActiveAttempt();
    assert.equal(processed?.lifecycle, 'active');
    const cancelledActive = await second.cancelAttempt();
    assert.equal(cancelledActive?.lifecycle, 'cancelled');
    assert.equal(platform2.updating, false);
    assert.equal(await sessions2.getActiveSession(), null);
  });

  it('retains raw attempt telemetry separately from the route-source recording', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    await workspace.armRun(route.id);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'id-2', stepMeters: 5, count: 20 }),
    );
    await workspace.processActiveAttempt();
    assert.equal(await sessions.countSamples(route.sourceRecordingId), 16);
    assert.equal(await sessions.countSamples('id-2'), 20);
    assert.equal((await sessions.getSession(route.sourceRecordingId))?.purpose, 'route_creation');
    assert.equal((await sessions.getSession('id-2'))?.purpose, 'attempt');
  });

  it('reconstructs an active attempt as an attempt, not a route-creation recording', async () => {
    const { workspace, sessions, tracker } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    await workspace.armRun(route.id);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'id-2', stepMeters: 5, count: 12 }),
    );
    await workspace.processActiveAttempt();

    await tracker.recover();
    const home = await workspace.loadHome();
    assert.equal(home.activeAttempt?.lifecycle, 'active');
    assert.equal(home.activeRecording, null);
    assert.equal(home.pendingRecording, null);
    assert.equal((await sessions.getActiveSession())?.purpose, 'attempt');
  });

  it('does not let route-creation finish adopt an attempt session', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    await workspace.armRun(route.id);
    await workspace.finishRecording();
    assert.equal((await sessions.getActiveSession())?.purpose, 'attempt');
    assert.equal((await sessions.getActiveSession())?.isActive, true);
    assert.equal(await sessions.findPendingRouteCreation(), null);
    const open = await workspace.getOpenAttempt();
    assert.equal(open?.lifecycle, 'armed');
  });

  it('persists a completed attempt across sqlite reload', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const { workspace, sessions, routes, places, platform } = createSqliteWorkspace(sql, {
      now: () => 1_700_000_100_000,
      sessionId: 'attempt-session',
      routeId: 'route-1',
      attemptId: 'attempt-1',
    });

    await sessions.createSession('source', 1, 'route_creation');
    await sessions.completeSession('source', {
      stoppedAtMs: 2,
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
    });
    const route = makeRoute({
      id: 'route-1',
      sourceRecordingId: 'source',
      referencePath: northPath({ points: 16, stepMeters: 20 }),
    });
    await routes.createRoute(route);
    const seeded = await seedPlacesForRoute(places, route);
    const armed = await workspace.armRun(route.id);
    assert.equal(armed.ok, true);
    await sessions.appendSamples(
      completeJourneySamples({
        origin: seeded.origin,
        destination: seeded.destination,
        sessionId: 'attempt-session',
      }),
    );
    const completed = await workspace.processActiveAttempt();
    assert.equal(completed?.lifecycle, 'completed');
    assert.equal(completed?.validity, 'valid');
    assert.ok((await sessions.countSamples('attempt-session')) > 10);
    assert.equal(platform.updating, false);

    const reloaded = createSqliteWorkspace(sql, {
      now: () => 1_700_000_200_000,
      sessionId: 'unused-session',
      routeId: 'route-2',
      attemptId: 'attempt-2',
    });
    const loaded = await reloaded.attempts.getAttempt('attempt-1');
    assert.equal(loaded?.lifecycle, 'completed');
    assert.equal(loaded?.startedAtMs, completed?.startedAtMs);
    assert.equal(loaded?.finishedAtMs, completed?.finishedAtMs);
    assert.equal(loaded?.startedLocalTimeSource, 'captured');
    assert.equal(completed?.startedLocalTimeSource, 'captured');
    assert.equal(loaded?.startedUtcOffsetMinutes, completed?.startedUtcOffsetMinutes);
    assert.equal(
      loaded?.startedUtcOffsetMinutes,
      loaded.startedAtMs == null ? null : utcOffsetMinutesAt(loaded.startedAtMs),
    );
    assert.equal(loaded?.originPlaceId, seeded.origin.id);
    assert.equal(loaded?.destinationPlaceId, seeded.destination.id);
    assert.equal(await reloaded.sessions.countSamples('attempt-session'), await sessions.countSamples('attempt-session'));
    assert.equal(await reloaded.attempts.getOpenAttempt(), null);
  });

  it('keeps a journey active when the path diverges and still abandons when tracking fails', async () => {
    const { workspace, sessions, platform, attemptRuntime } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    const places = await workspace.listPlaces();
    const origin = places.find((place) => place.name === 'Home');
    assert.ok(origin);
    await workspace.armRun(route.id);
    await sessions.appendSamples(departureOnlySamples({ origin, sessionId: 'id-2', extraMeters: 40 }));
    await workspace.processActiveAttempt();
    const last = (await sessions.listSamples('id-2')).at(-1)!;
    const off = movingTrace({
      sessionId: 'id-2',
      startMs: last.recordedAtMs + 1000,
      points: 20,
      stepMeters: 8,
      startLat: last.latitude,
      startLng: last.longitude + 0.01,
    });
    await sessions.appendSamples(off);
    const stillActive = await workspace.processActiveAttempt();
    assert.equal(stillActive?.lifecycle, 'active');
    assert.notEqual(stillActive?.lifecycle, 'abandoned');
    platform.updating = false;
    platform.servicesEnabled = false;
    const abandoned = await attemptRuntime.reconcile();
    assert.equal(abandoned?.lifecycle, 'abandoned');
    assert.equal(abandoned?.validity, 'unranked');
    assert.equal(platform.updating, false);
    assert.equal(await sessions.getActiveSession(), null);
    const home = await workspace.loadHome();
    assert.equal(home.activeAttempt, null);
    assert.equal(home.canStartNewRecording, true);
  });

  it('ends an armed attempt for inspection, keeps samples, and leaves ARM retryable', async () => {
    let nextAttempt = 0;
    const { workspace, sessions, platform } = createMemoryWorkspace({
      createAttemptId: () => `attempt-${++nextAttempt}`,
    });
    const route = await saveDefaultRoute(workspace, sessions);
    const armed = await workspace.armRun(route.id);
    assert.equal(armed.ok, true);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'id-2', stepMeters: 3, count: 2 }),
    );
    const ended = await workspace.endAndInspectAttempt();
    assert.equal(ended?.lifecycle, 'ended');
    assert.equal(ended?.validity, 'unranked');
    assert.equal(ended?.startedAtMs, null);
    assert.equal(ended?.resultAcknowledged, false);
    assert.equal(platform.updating, false);
    assert.equal(await sessions.getActiveSession(), null);
    assert.ok((await sessions.countSamples('id-2')) >= 2);
    assert.equal((await sessions.getSession('id-2'))?.reviewDisposition, 'saved');
    const debug = await workspace.inspectAttempt(ended!.id);
    assert.equal(debug?.place.incompleteLabel, 'DID NOT START');
    assert.equal(debug?.place.rawSampleCount, await sessions.countSamples('id-2'));
    assert.equal(await workspace.getOpenAttempt(), null);
    const home = await workspace.loadHome();
    assert.equal(home.incompleteAttempts.some((item) => item.id === ended.id), true);
    const retry = await workspace.armRun(route.id);
    assert.equal(retry.ok, true);
    assert.notEqual(retry.ok ? retry.attempt.id : null, ended.id);
    const afterRetry = await workspace.loadHome();
    assert.equal(afterRetry.incompleteAttempts.some((item) => item.id === ended.id), true);
  });

  it('labels a started unfinished inspect as DID NOT FINISH and keeps it non-competitive', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    const places = await workspace.listPlaces();
    const origin = places.find((place) => place.name === 'Home');
    assert.ok(origin);
    await workspace.armRun(route.id);
    await sessions.appendSamples(departureOnlySamples({ origin, sessionId: 'id-2', extraMeters: 40 }));
    await workspace.processActiveAttempt();
    const ended = await workspace.endAndInspectAttempt();
    assert.equal(ended?.lifecycle, 'ended');
    assert.ok(ended?.startedAtMs != null);
    assert.equal(ended?.finishedAtMs, null);
    const debug = await workspace.inspectAttempt(ended!.id);
    assert.equal(debug?.place.incompleteLabel, 'DID NOT FINISH');
    const home = await workspace.loadHome();
    const row = home.incompleteAttempts.find((item) => item.id === ended.id);
    assert.equal(row?.id, ended.id);
    const journeys = home.journeys.filter((item) => item.rankedAttemptCount > 0);
    assert.equal(journeys.length, 0);
  });

  it('Android system back from an armed never-started attempt preserves inspect evidence', async () => {
    let nextAttempt = 0;
    const { workspace, sessions, platform } = createMemoryWorkspace({
      createAttemptId: () => `attempt-${++nextAttempt}`,
    });
    const route = await saveDefaultRoute(workspace, sessions);
    await workspace.armRun(route.id);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'id-2', stepMeters: 3, count: 2 }),
    );
    let inspectPromise: Promise<Awaited<ReturnType<RouteWorkspace['endAndInspectAttempt']>>> | undefined;
    const handled = handleSystemBack('attempt', preserveInspectBackActions(() => {
      inspectPromise = workspace.endAndInspectAttempt();
    }));
    assert.equal(handled, true);
    const ended = await inspectPromise;
    assert.equal(ended?.lifecycle, 'ended');
    assert.equal(ended?.startedAtMs, null);
    assert.equal(platform.updating, false);
    assert.equal(await sessions.getActiveSession(), null);
    assert.ok((await sessions.countSamples('id-2')) >= 2);
    const debug = await workspace.inspectAttempt(ended!.id);
    assert.equal(debug?.place.incompleteLabel, 'DID NOT START');
    const home = await workspace.loadHome();
    assert.equal(home.incompleteAttempts.some((item) => item.id === ended!.id), true);
    const retry = await workspace.armRun(route.id);
    assert.equal(retry.ok, true);
  });

  it('Android system back from an active unfinished attempt yields DID NOT FINISH', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    const places = await workspace.listPlaces();
    const origin = places.find((place) => place.name === 'Home');
    assert.ok(origin);
    await workspace.armRun(route.id);
    await sessions.appendSamples(departureOnlySamples({ origin, sessionId: 'id-2', extraMeters: 40 }));
    await workspace.processActiveAttempt();
    let inspectPromise: Promise<Awaited<ReturnType<RouteWorkspace['endAndInspectAttempt']>>> | undefined;
    const handled = handleSystemBack('attempt', preserveInspectBackActions(() => {
      inspectPromise = workspace.endAndInspectAttempt();
    }));
    assert.equal(handled, true);
    const ended = await inspectPromise;
    assert.equal(ended?.lifecycle, 'ended');
    assert.ok(ended?.startedAtMs != null);
    assert.equal(ended?.finishedAtMs, null);
    const debug = await workspace.inspectAttempt(ended!.id);
    assert.equal(debug?.place.incompleteLabel, 'DID NOT FINISH');
    assert.equal(await workspace.getOpenAttempt(), null);
  });

  it('persists an ended incomplete attempt and its ARM-session samples across sqlite reload', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const { workspace, sessions, routes, places } = createSqliteWorkspace(sql, {
      now: () => 1_700_000_100_000,
      sessionId: 'attempt-session',
      routeId: 'route-1',
      attemptId: 'attempt-1',
    });

    await sessions.createSession('source', 1, 'route_creation');
    await sessions.completeSession('source', {
      stoppedAtMs: 2,
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
    });
    const route = makeRoute({
      id: 'route-1',
      sourceRecordingId: 'source',
      referencePath: northPath({ points: 16, stepMeters: 20 }),
    });
    await routes.createRoute(route);
    await seedPlacesForRoute(places, route);
    const armed = await workspace.armRun(route.id);
    assert.equal(armed.ok, true);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'attempt-session', stepMeters: 3, count: 4 }),
    );
    const ended = await workspace.endAndInspectAttempt();
    assert.equal(ended?.lifecycle, 'ended');
    assert.equal(ended?.validity, 'unranked');
    const sampleCount = await sessions.countSamples('attempt-session');
    assert.ok(sampleCount >= 4);

    const reloaded = createSqliteWorkspace(sql, {
      now: () => 1_700_000_200_000,
      sessionId: 'unused-session',
      routeId: 'route-2',
      attemptId: 'attempt-2',
    });
    const loaded = await reloaded.attempts.getAttempt('attempt-1');
    assert.equal(loaded?.lifecycle, 'ended');
    assert.equal(loaded?.startedAtMs, null);
    assert.equal(loaded?.resultAcknowledged, false);
    assert.equal(await reloaded.sessions.countSamples('attempt-session'), sampleCount);
    assert.equal(await reloaded.attempts.getOpenAttempt(), null);
    const debug = await reloaded.workspace.inspectAttempt('attempt-1');
    assert.equal(debug?.place.incompleteLabel, 'DID NOT START');
    assert.equal(debug?.place.rawSampleCount, sampleCount);
    const home = await reloaded.workspace.loadHome();
    assert.equal(home.incompleteAttempts.some((item) => item.id === 'attempt-1'), true);
    const retry = await reloaded.workspace.armRun(route.id);
    assert.equal(retry.ok, true);
  });

  it('still hides cancelled attempts instead of opening inspect', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    await workspace.armRun(route.id);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'id-2', stepMeters: 5, count: 8 }),
    );
    const cancelled = await workspace.cancelAttempt();
    assert.equal(cancelled?.lifecycle, 'cancelled');
    assert.equal(cancelled?.resultAcknowledged, true);
    assert.equal(await workspace.getAttemptResult(), null);
    const analysis = await workspace.analyzeRoute(route.id);
    assert.equal(analysis?.analysis.chronologicalHistory.some((row) => row.attemptId === cancelled?.id), false);
  });
});
