import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import { planPathVariantRecompute } from '../src/domain/path-variant-discovery';
import { startAppStartup, type AppStartupFailure } from '../src/product/app-startup';
import { yieldToEventLoop } from '../src/product/idle-yield';
import type { LoadedJourney } from '../src/product/route-workspace';
import { RECONCILED_ATTEMPT } from './helpers/attempts';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const GYM = makePlace({
  id: 'place-gym',
  name: 'Gym',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 0, 1000),
  createdAtMs: 3,
});
const POOL = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter' as const,
};
const PATH = northPath({
  startLat: HOME.center.latitude,
  startLng: HOME.center.longitude,
  points: 51,
  stepMeters: 20,
});
const GYM_PATH = northPath({
  startLat: HOME.center.latitude,
  startLng: HOME.center.longitude,
  points: 40,
  stepMeters: 20,
});

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `session-${id}`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_700_000_000_000 - 5_000,
    startedAtMs: 1_700_000_000_000,
    finishedAtMs: 1_700_000_000_000 + 99_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    routeId: null,
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
  path = PATH,
) {
  const samples = traceAlongPath(path, {
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

function busyWaitMs(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Simulate a blocking SQLite/GPS chunk on the JS thread.
  }
}

describe('post-Home interaction during deferred pending-attempt repair', () => {
  it('keeps a queued navigation callback runnable before a pending attempt GPS repair finishes, then skips unchanged startups', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await places.createPlace(GYM);
    await routes.createRoute(makeRoute({ id: 'route-1', referencePath: PATH, name: 'Main' }));
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 80);
    await seedAttempt(sessions, attempts, completedAttempt('hw-2', { sessionId: 'session-hw-2' }), 80);
    await seedAttempt(sessions, attempts, completedAttempt('hw-3', { sessionId: 'session-hw-3' }), 80);
    await seedAttempt(sessions, attempts, completedAttempt('hw-4', { sessionId: 'session-hw-4' }), 80);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('gym-1', {
        destinationPlaceId: GYM.id,
        sessionId: 'session-gym-1',
      }),
      80,
      GYM_PATH,
    );
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('gym-2', {
        destinationPlaceId: GYM.id,
        sessionId: 'session-gym-2',
      }),
      80,
      GYM_PATH,
    );
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('pending-hw', {
        sessionId: 'session-pending-hw',
        routeId: null,
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      }),
      80,
    );

    const originalListSamples = sessions.listSamples.bind(sessions);
    let listSamplesCalls = 0;
    let firstSampleAt = 0;
    let homeInteractiveAt = 0;
    let midInteractiveAt = 0;
    let recomputeDone = false;
    let navigationDuringRecompute = false;
    let journeyDuringRecompute: LoadedJourney | null = null;
    let journeyCompletedDuringRecompute = false;
    let resolveNavigation: () => void = () => {};
    const navigationHandled = new Promise<void>((resolve) => {
      resolveNavigation = resolve;
    });
    const CHUNK_MS = 25;

    sessions.listSamples = async (sessionId: string) => {
      listSamplesCalls += 1;
      if (listSamplesCalls === 1) {
        firstSampleAt = performance.now();
        setTimeout(() => {
          midInteractiveAt = performance.now();
          navigationDuringRecompute = !recomputeDone;
          void workspace.loadJourney(POOL).then((loaded) => {
            journeyDuringRecompute = loaded;
            journeyCompletedDuringRecompute = !recomputeDone;
            resolveNavigation();
          });
        }, 0);
      }
      busyWaitMs(CHUNK_MS);
      return originalListSamples(sessionId);
    };

    const failures: AppStartupFailure[] = [];
    let homeReadyAt = 0;
    let resolveRecompute: () => void = () => {};
    const recomputeFinished = new Promise<void>((resolve) => {
      resolveRecompute = resolve;
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
            recomputeDone = true;
            resolveRecompute();
          }
        },
      },
      {
        onStage: () => {},
        onHomeReady: () => {
          homeReadyAt = performance.now();
          setTimeout(() => {
            homeInteractiveAt = performance.now();
          }, 0);
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
      },
      { watchdogMs: 20_000, stageTimeoutMs: 20_000 },
    );

    await session.finished;
    assert.ok(homeReadyAt > 0);
    await Promise.all([recomputeFinished, navigationHandled]);
    const recomputeFinishedAt = performance.now();

    assert.equal(failures.length, 0);
    assert.equal(recomputeDone, true);
    assert.ok(homeInteractiveAt > 0);
    assert.ok(midInteractiveAt > 0);
    assert.ok(homeInteractiveAt < recomputeFinishedAt);
    assert.equal(navigationDuringRecompute, true);
    assert.equal(journeyCompletedDuringRecompute, true);
    assert.ok(journeyDuringRecompute);
    assert.equal(journeyDuringRecompute.summary.rankedAttemptCount, 5);
    assert.ok(midInteractiveAt < recomputeFinishedAt);
    const homeCallbackMs = homeInteractiveAt - homeReadyAt;
    const midCallbackMs = midInteractiveAt - firstSampleAt;
    const maintenanceMs = recomputeFinishedAt - startedAt;
    assert.ok(homeCallbackMs < 200, `Home tap callback took ${homeCallbackMs}ms`);
    assert.ok(
      midCallbackMs < maintenanceMs,
      `queued input after a blocking GPS chunk took ${midCallbackMs}ms; maintenance was ${maintenanceMs}ms`,
    );
    assert.ok(maintenanceMs > CHUNK_MS);
    const firstPass = workspace.lastAttemptReconciliation;
    const firstPassTiming = workspace.navigationLoad.timings.find((item) => item.operation === 'reconcilePendingAttempts');
    assert.deepEqual(firstPass.selectedAttemptIds, ['pending-hw']);
    assert.equal(firstPass.listSamplesCalls, 1);

    const assigned = await attempts.getAttempt('pending-hw');
    assert.equal(assigned?.routeId, 'route-1');
    assert.equal(assigned?.reconciliationStatus, 'reconciled');

    const samplesAfterFirst = listSamplesCalls;
    workspace.resetNavigationLoad();
    let secondHomeReady = false;
    let secondRecomputeDone = false;
    let resolveSecond: () => void = () => {};
    const secondFinished = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const second = startAppStartup(
      {
        preparePersistence: () => workspace.preparePersistence(),
        recoverTracker: () => workspace.recoverTracker(),
        reconcileAttempts: () => workspace.reconcileAttempts(),
        loadHome: () => workspace.loadHome(),
        reconcilePendingAttempts: async () => {
          try {
            await workspace.reconcilePendingAttempts();
          } finally {
            secondRecomputeDone = true;
            resolveSecond();
          }
        },
      },
      {
        onStage: () => {},
        onHomeReady: () => {
          secondHomeReady = true;
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
      },
      { watchdogMs: 20_000, stageTimeoutMs: 20_000 },
    );
    await second.finished;
    await secondFinished;
    assert.equal(secondHomeReady, true);
    assert.equal(secondRecomputeDone, true);
    assert.equal(workspace.lastAttemptReconciliation.selectedCount, 0);
    assert.equal(workspace.lastAttemptReconciliation.listSamplesCalls, 0);
    assert.equal(listSamplesCalls, samplesAfterFirst);
    assert.equal(workspace.navigationLoad.counters.reconcilePendingSkips, 1);
    const secondPass = workspace.lastAttemptReconciliation;

    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('hw-5', {
        sessionId: 'session-hw-5',
        routeId: null,
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      }),
      80,
    );
    workspace.resetNavigationLoad();
    const third = await workspace.reconcilePendingAttempts();
    assert.equal(third.selectedCount, 1);
    assert.deepEqual(third.selectedAttemptIds, ['hw-5']);
    assert.equal(third.listSamplesCalls, 1);

    const report = {
      environment: 'node-memory-workspace',
      chunkBusyWaitMs: CHUNK_MS,
      homeCallbackMs,
      midRecomputeCallbackMs: midCallbackMs,
      maintenanceMs,
      firstPass,
      firstPassTiming,
      secondPassSkipped: secondPass,
      thirdPassDirty: third,
    };
    try {
      mkdirSync('/opt/cursor/artifacts', { recursive: true });
      writeFileSync(
        '/opt/cursor/artifacts/post-home-interaction-profile.json',
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } catch {
      // Cloud walkthrough dir is optional; CI clones should still pass.
    }
  });

  it('yields inside a CPU-heavy planner so a queued callback can run before planning finishes', async () => {
    const traces = [];
    for (let index = 0; index < 6; index += 1) {
      const samples = traceAlongPath(PATH, {
        sessionId: `s-${index}`,
        startMs: 1_700_000_000_000,
        intervalMs: 1000,
        stepMeters: 10,
        count: 40,
      });
      traces.push({
        attempt: completedAttempt(`a-${index}`, { sessionId: `s-${index}` }),
        samples,
      });
    }
    let planningDone = false;
    let callbackDuringPlan = false;
    let yields = 0;
    const planning = planPathVariantRecompute({
      pool: POOL,
      origin: HOME,
      destination: WORK,
      traces,
      routes: [],
      nowMs: 9_000,
      createRouteId: () => 'discovered-1',
      yieldToIdle: async () => {
        yields += 1;
        if (yields === 1) {
          setTimeout(() => {
            callbackDuringPlan = !planningDone;
          }, 0);
        }
        await yieldToEventLoop();
      },
    }).then((plan) => {
      planningDone = true;
      return plan;
    });
    const plan = await planning;
    await yieldToEventLoop();
    assert.ok(yields > 1);
    assert.equal(callbackDuringPlan, true);
    assert.equal(plan.classificationVersion, 1);
  });
});
