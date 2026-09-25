import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { CURRENT_ATTEMPT_RECONCILIATION_VERSION } from '../src/domain/attempt-reconciliation';
import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import { applyMigrations, MIGRATIONS } from '../src/persistence/migrations';
import { LOCATION_SPIKE_SCHEMA } from '../src/persistence/schema';
import { startAppStartup, type AppStartupFailure } from '../src/product/app-startup';
import { yieldToEventLoop } from '../src/product/idle-yield';
import { RECONCILED_ATTEMPT } from './helpers/attempts';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const PATH = northPath({
  startLat: HOME.center.latitude,
  startLng: HOME.center.longitude,
  points: 51,
  stepMeters: 20,
});
const POOL = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter' as const,
};

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `session-${id}`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_700_000_000_000 - 5_000,
    startedAtMs: 1_700_000_000_000,
    finishedAtMs: 1_700_000_000_000 + 80_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    routeId: 'route-1',
    originPlaceId: HOME.id,
    destinationPlaceId: WORK.id,
    transportationMode: 'scooter',
    ...RECONCILED_ATTEMPT,
    ...overrides,
  };
}

async function seedAttempt(
  sessions: ReturnType<typeof createMemoryWorkspace>['sessions'],
  attempts: ReturnType<typeof createMemoryWorkspace>['attempts'],
  attempt: Attempt,
  sampleCount: number,
) {
  const samples = traceAlongPath(PATH, {
    sessionId: attempt.sessionId,
    startMs: attempt.startedAtMs ?? 1_700_000_000_000,
    intervalMs: 1000,
    stepMeters: 10,
    count: sampleCount,
  });
  sessions.seedSession(
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
  await attempts.createAttempt(attempt);
}

async function seedPlacesAndRoute(
  places: ReturnType<typeof createMemoryWorkspace>['places'],
  routes: ReturnType<typeof createMemoryWorkspace>['routes'],
) {
  await places.createPlace(HOME);
  await places.createPlace(WORK);
  await routes.createRoute(makeRoute({ id: 'route-1', referencePath: PATH, name: 'Main' }));
}

function wrapListSamples(
  sessions: ReturnType<typeof createMemoryWorkspace>['sessions'],
  onCall?: (sessionId: string, call: number) => void,
) {
  const original = sessions.listSamples.bind(sessions);
  const sessionIds: string[] = [];
  sessions.listSamples = async (sessionId: string) => {
    sessionIds.push(sessionId);
    onCall?.(sessionId, sessionIds.length);
    return original(sessionId);
  };
  return {
    sessionIds,
    get count() {
      return sessionIds.length;
    },
  };
}

describe('incremental per-attempt reconciliation', () => {
  it('does zero historical GPS work on startup when every attempt is already reconciled', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await seedPlacesAndRoute(places, routes);
    for (let index = 1; index <= 8; index += 1) {
      await seedAttempt(sessions, attempts, completedAttempt(`hist-${index}`), 40);
    }
    const gps = wrapListSamples(sessions);
    const report = await workspace.reconcilePendingAttempts();
    assert.deepEqual(report.selectedAttemptIds, []);
    assert.equal(report.selectedCount, 0);
    assert.equal(report.listSamplesCalls, 0);
    assert.equal(gps.count, 0);
    assert.equal(workspace.navigationLoad.counters.reconcilePendingSkips, 1);

    const failures: AppStartupFailure[] = [];
    let homeReady = false;
    const session = startAppStartup(
      {
        preparePersistence: () => workspace.preparePersistence(),
        recoverTracker: () => workspace.recoverTracker(),
        reconcileAttempts: () => workspace.reconcileAttempts(),
        loadHome: () => workspace.loadHome(),
        reconcilePendingAttempts: async () => {
          await workspace.reconcilePendingAttempts();
        },
      },
      {
        onStage: () => {},
        onHomeReady: () => {
          homeReady = true;
        },
        onFailure: (failure) => failures.push(failure),
      },
      { watchdogMs: 5_000, stageTimeoutMs: 5_000 },
    );
    await session.finished;
    assert.equal(failures.length, 0);
    assert.equal(homeReady, true);
    assert.equal(gps.count, 0);
    assert.equal(workspace.lastAttemptReconciliation.selectedCount, 0);
  });

  it('reconciles only the pending latest attempt and skips already-reconciled history', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await seedPlacesAndRoute(places, routes);
    for (let index = 1; index <= 7; index += 1) {
      await seedAttempt(
        sessions,
        attempts,
        completedAttempt(`hist-${index}`, { finishedAtMs: 1_700_000_000_000 + 90_000 + index }),
        80,
      );
    }
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('pending-latest', {
        sessionId: 'session-pending-latest',
        routeId: null,
        finishedAtMs: 1_700_000_000_000 + 80_000,
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      }),
      80,
    );
    const gps = wrapListSamples(sessions);
    const report = await workspace.reconcilePendingAttempts();
    assert.deepEqual(report.selectedAttemptIds, ['pending-latest']);
    assert.equal(report.selectedCount, 1);
    assert.equal(report.listSamplesCalls, 1);
    assert.deepEqual(gps.sessionIds, ['session-pending-latest']);
    const derived = await attempts.getAttempt('pending-latest');
    assert.equal(derived?.reconciliationStatus, 'reconciled');
    assert.equal(derived?.reconciliationVersion, CURRENT_ATTEMPT_RECONCILIATION_VERSION);
    assert.equal(derived?.routeId, 'route-1');
    const home = await workspace.loadHome();
    const journey = home.journeys.find(
      (item) =>
        item.originPlaceId === POOL.originPlaceId && item.destinationPlaceId === POOL.destinationPlaceId,
    );
    assert.equal(journey?.rankedAttemptCount, 8);
    assert.equal(journey?.pbTimeMs, 80_000);
  });

  it('skips a successfully reconciled attempt on the next cold start', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await seedPlacesAndRoute(places, routes);
    await seedAttempt(sessions, attempts, completedAttempt('hist-1'), 40);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('pending-1', {
        sessionId: 'session-pending-1',
        routeId: null,
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      }),
      80,
    );
    const gps = wrapListSamples(sessions);
    const first = await workspace.reconcilePendingAttempts();
    assert.equal(first.selectedCount, 1);
    assert.equal(gps.count, 1);
    workspace.resetNavigationLoad();
    const second = await workspace.reconcilePendingAttempts();
    assert.equal(second.selectedCount, 0);
    assert.equal(second.listSamplesCalls, 0);
    assert.equal(gps.count, 1);
  });

  it('retries only the failed attempt and does not reread reconciled history', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await seedPlacesAndRoute(places, routes);
    await seedAttempt(sessions, attempts, completedAttempt('hist-ok'), 40);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('pending-fail', {
        sessionId: 'session-pending-fail',
        routeId: null,
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      }),
      80,
    );
    const original = sessions.listSamples.bind(sessions);
    let shouldFail = true;
    const gps: string[] = [];
    sessions.listSamples = async (sessionId: string) => {
      gps.push(sessionId);
      if (shouldFail && sessionId === 'session-pending-fail') {
        throw new Error('simulated reconciliation failure');
      }
      return original(sessionId);
    };
    const failed = await workspace.reconcilePendingAttempts();
    assert.equal(failed.perAttempt[0]?.status, 'failed');
    assert.equal((await attempts.getAttempt('pending-fail'))?.reconciliationStatus, 'failed');
    assert.equal(await attempts.peekFailedReconciliationAttemptId(), 'pending-fail');
    shouldFail = false;
    const retried = await workspace.retryAttemptReconciliation('pending-fail');
    assert.deepEqual(retried.selectedAttemptIds, ['pending-fail']);
    assert.equal(retried.perAttempt[0]?.status, 'reconciled');
    assert.equal((await attempts.getAttempt('pending-fail'))?.reconciliationStatus, 'reconciled');
    assert.equal((await attempts.getAttempt('hist-ok'))?.reconciliationStatus, 'reconciled');
    assert.deepEqual(
      gps.filter((sessionId) => sessionId === 'session-hist-ok'),
      [],
    );
    assert.equal(gps.filter((sessionId) => sessionId === 'session-pending-fail').length, 2);
  });

  it('resumes only unfinished work after a mid-reconciliation interruption', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await seedPlacesAndRoute(places, routes);
    await seedAttempt(sessions, attempts, completedAttempt('hist-ok'), 40);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('pending-cut', {
        sessionId: 'session-pending-cut',
        routeId: null,
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      }),
      80,
    );
    const gps = wrapListSamples(sessions);
    let cuts = 0;
    const interrupted = await workspace.reconcilePendingAttempts({
      yieldToIdle: async () => {
        cuts += 1;
        if (cuts >= 3) {
          throw new Error('process died mid-reconciliation');
        }
        await yieldToEventLoop();
      },
    });
    assert.equal(interrupted.perAttempt[0]?.status, 'failed');
    const unfinished = await attempts.getAttempt('pending-cut');
    assert.ok(unfinished?.reconciliationStatus === 'failed' || unfinished?.reconciliationStatus === 'pending');
    assert.equal((await attempts.getAttempt('hist-ok'))?.reconciliationStatus, 'reconciled');
    const resumed = await workspace.retryAttemptReconciliation('pending-cut');
    assert.deepEqual(resumed.selectedAttemptIds, ['pending-cut']);
    assert.equal(resumed.perAttempt[0]?.status, 'reconciled');
    assert.ok(gps.sessionIds.every((sessionId) => sessionId === 'session-pending-cut'));
  });

  it('selects only attempts whose persisted reconciliation version is obsolete', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await seedPlacesAndRoute(places, routes);
    await seedAttempt(sessions, attempts, completedAttempt('current'), 40);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('obsolete', {
        sessionId: 'session-obsolete',
        routeId: 'route-1',
        reconciliationStatus: 'reconciled',
        reconciliationVersion: 0,
      }),
      80,
    );
    const gps = wrapListSamples(sessions);
    const due = await attempts.listAttemptsNeedingReconciliation(CURRENT_ATTEMPT_RECONCILIATION_VERSION);
    assert.deepEqual(
      due.map((attempt) => attempt.id),
      ['obsolete'],
    );
    const report = await workspace.reconcilePendingAttempts();
    assert.deepEqual(report.selectedAttemptIds, ['obsolete']);
    assert.equal(report.listSamplesCalls, 1);
    assert.deepEqual(gps.sessionIds, ['session-obsolete']);
    assert.equal((await attempts.getAttempt('obsolete'))?.reconciliationVersion, CURRENT_ATTEMPT_RECONCILIATION_VERSION);
    assert.equal((await attempts.getAttempt('current'))?.reconciliationVersion, CURRENT_ATTEMPT_RECONCILIATION_VERSION);
  });

  it('keeps Home interactive while one pending attempt is repaired and records instrumentation', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await seedPlacesAndRoute(places, routes);
    for (let index = 1; index <= 6; index += 1) {
      await seedAttempt(sessions, attempts, completedAttempt(`hist-${index}`), 80);
    }
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('pending-nav', {
        sessionId: 'session-pending-nav',
        routeId: null,
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      }),
      80,
    );
    const original = sessions.listSamples.bind(sessions);
    let listSamplesCalls = 0;
    let firstSampleAt = 0;
    let navigationDuringRepair = false;
    let resolveNavigation: () => void = () => {};
    const navigationHandled = new Promise<void>((resolve) => {
      resolveNavigation = resolve;
    });
    sessions.listSamples = async (sessionId: string) => {
      listSamplesCalls += 1;
      if (listSamplesCalls === 1) {
        firstSampleAt = performance.now();
        setTimeout(() => {
          navigationDuringRepair = !repairDone;
          void workspace.loadJourney(POOL).then(() => {
            resolveNavigation();
          });
        }, 0);
      }
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // Simulate a blocking SQLite/GPS chunk on the JS thread.
      }
      return original(sessionId);
    };

    let homeReadyAt = 0;
    let repairDone = false;
    let resolveRepair: () => void = () => {};
    const repairFinished = new Promise<void>((resolve) => {
      resolveRepair = resolve;
    });
    const startedAt = performance.now();
    const session = startAppStartup(
      {
        preparePersistence: () => workspace.preparePersistence(),
        recoverTracker: () => workspace.recoverTracker(),
        reconcileAttempts: () => workspace.reconcileAttempts(),
        loadHome: () => workspace.loadHome(),
        reconcilePendingAttempts: async () => {
          try {
            await workspace.reconcilePendingAttempts();
          } finally {
            repairDone = true;
            resolveRepair();
          }
        },
      },
      {
        onStage: () => {},
        onHomeReady: () => {
          homeReadyAt = performance.now();
        },
        onFailure: () => {},
      },
      { watchdogMs: 20_000, stageTimeoutMs: 20_000 },
    );
    await session.finished;
    await Promise.all([repairFinished, navigationHandled]);
    assert.ok(homeReadyAt > 0);
    assert.equal(repairDone, true);
    assert.equal(navigationDuringRepair, true);
    assert.deepEqual(workspace.lastAttemptReconciliation.selectedAttemptIds, ['pending-nav']);
    assert.equal(workspace.lastAttemptReconciliation.listSamplesCalls, 1);
    assert.equal(listSamplesCalls, 1);
    assert.ok(workspace.lastAttemptReconciliation.perAttempt[0]!.durationMs >= 0);
    assert.ok(workspace.lastAttemptReconciliation.totalDurationMs >= 0);
    const assigned = await attempts.getAttempt('pending-nav');
    assert.equal(assigned?.routeId, 'route-1');
    assert.equal(assigned?.reconciliationStatus, 'reconciled');

    const report = {
      environment: 'node-memory-workspace',
      selectedCount: workspace.lastAttemptReconciliation.selectedCount,
      listSamplesCalls: workspace.lastAttemptReconciliation.listSamplesCalls,
      perAttempt: workspace.lastAttemptReconciliation.perAttempt,
      totalDurationMs: workspace.lastAttemptReconciliation.totalDurationMs,
      homeReadyMs: homeReadyAt - startedAt,
      firstSampleAtMs: firstSampleAt - startedAt,
    };
    try {
      mkdirSync('/opt/cursor/artifacts', { recursive: true });
      writeFileSync(
        '/opt/cursor/artifacts/attempt-reconciliation-profile.json',
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } catch {
      // Cloud walkthrough dir is optional; CI clones should still pass.
    }
  });
});

describe('attempt reconciliation schema', () => {
  it('upgrades a v9 database and marks finalized rows reconciled without selecting them', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    for (const migration of MIGRATIONS) {
      if (migration.version > 9) {
        break;
      }
      await migration.up(sql, 9_000);
    }
    await sql.exec('PRAGMA user_version = 9');
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'attempt', 'finished', 'saved', 0)`,
      ['sess-v9', 1000, 2000],
    );
    await sql.run(
      `INSERT INTO attempt (
         id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
         lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
       ) VALUES (?, NULL, NULL, NULL, 'scooter', ?, 'ended', 'unranked', ?, NULL, NULL, 1)`,
      ['v9-ended', 'sess-v9', 1000],
    );
    const before = await sql.getAll<{ name: string }>('PRAGMA table_info(attempt)');
    assert.equal(
      before.some((column) => column.name === 'reconciliation_status'),
      false,
    );
    await applyMigrations(sql, 20_000);
    const after = await sql.getFirst<{ reconciliation_status: string; reconciliation_version: number }>(
      'SELECT reconciliation_status, reconciliation_version FROM attempt WHERE id = ?',
      ['v9-ended'],
    );
    assert.equal(after?.reconciliation_status, 'reconciled');
    assert.equal(after?.reconciliation_version, CURRENT_ATTEMPT_RECONCILIATION_VERSION);
    const { workspace, attempts } = createSqliteWorkspace(sql);
    const due = await attempts.listAttemptsNeedingReconciliation(CURRENT_ATTEMPT_RECONCILIATION_VERSION);
    assert.equal(due.length, 0);
    const report = await workspace.reconcilePendingAttempts();
    assert.equal(report.selectedCount, 0);
    assert.equal(report.listSamplesCalls, 0);
  });
});
