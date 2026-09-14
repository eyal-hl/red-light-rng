import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  APP_STARTUP_STAGE_LABELS,
  APP_STARTUP_WATCHDOG_MS,
  formatStartupError,
  startAppStartup,
  type AppStartupFailure,
  type AppStartupHost,
  type AppStartupStage,
} from '../src/product/app-startup';
import type { HomeSnapshot } from '../src/product/route-workspace';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME: HomeSnapshot = {
  routes: [],
  places: [],
  journeys: [],
  incompleteAttempts: [],
  activeTransportationMode: 'scooter',
  activeRecording: null,
  pendingRecording: null,
  activeAttempt: null,
  attemptResult: null,
  canStartNewRecording: true,
  canStartAttempt: true,
};

function pending<T>(): Promise<T> {
  return new Promise(() => {});
}

function resolvingHost(overrides: Partial<AppStartupHost<HomeSnapshot>> = {}): AppStartupHost<HomeSnapshot> {
  return {
    preparePersistence: async () => {},
    recoverTracker: async () => {},
    reconcileAttempts: async () => {},
    loadHome: async () => HOME,
    recomputePathVariants: async () => {},
    ...overrides,
  };
}

describe('app startup watchdog', () => {
  it('exits a never-resolving bootstrap dependency into a timed-out failure with the stuck stage', async () => {
    const stages: AppStartupStage[] = [];
    const failures: AppStartupFailure[] = [];
    let homeReady = false;
    const session = startAppStartup(
      resolvingHost({
        recoverTracker: () => pending(),
      }),
      {
        onStage: (stage) => {
          stages.push(stage);
        },
        onHomeReady: () => {
          homeReady = true;
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
      },
      { watchdogMs: 40, stageTimeoutMs: 5_000 },
    );

    await session.finished;

    assert.equal(homeReady, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stage, 'tracker-recover');
    assert.equal(failures[0]?.timedOut, true);
    assert.match(failures[0]?.message ?? '', /tracker-recover/);
    assert.equal(stages.includes('tracker-recover'), true);
    assert.equal(stages.includes('load-home'), false);
    assert.match(formatStartupError(failures[0]!), /tracker recovery/);
  });

  it('does not wait for a hanging path-variant recompute before Home is ready', async () => {
    let homeReady = false;
    let recomputeStarted = false;
    let deferredError: string | null = null;
    const failures: AppStartupFailure[] = [];
    const session = startAppStartup(
      resolvingHost({
        recomputePathVariants: () => {
          recomputeStarted = true;
          return pending();
        },
      }),
      {
        onStage: () => {},
        onHomeReady: () => {
          homeReady = true;
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
        onDeferredRecomputeError: (message) => {
          deferredError = message;
        },
      },
      { watchdogMs: 5_000, stageTimeoutMs: 5_000 },
    );

    await Promise.race([
      session.finished,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('startup waited on hanging recomputeAllPathVariants')), 200);
      }),
    ]);

    assert.equal(homeReady, true);
    assert.equal(recomputeStarted, true);
    assert.equal(failures.length, 0);
    assert.equal(deferredError, null);
    session.cancel();
  });

  it('surfaces a thrown startup stage instead of staying pending', async () => {
    const failures: AppStartupFailure[] = [];
    const session = startAppStartup(
      resolvingHost({
        preparePersistence: async () => {
          throw new Error('migration explode');
        },
      }),
      {
        onStage: () => {},
        onHomeReady: () => {
          throw new Error('Home should not load');
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
      },
      { watchdogMs: 5_000, stageTimeoutMs: 5_000 },
    );

    await session.finished;
    assert.equal(failures[0]?.stage, 'opening-database');
    assert.equal(failures[0]?.timedOut, false);
    assert.match(failures[0]?.message ?? '', /migration explode/);
  });

  it('times out an individual stage even when the overall watchdog is longer', async () => {
    const failures: AppStartupFailure[] = [];
    const session = startAppStartup(
      resolvingHost({
        reconcileAttempts: () => pending(),
      }),
      {
        onStage: () => {},
        onHomeReady: () => {
          throw new Error('Home should not load');
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
      },
      { watchdogMs: 5_000, stageTimeoutMs: 40 },
    );

    await session.finished;
    assert.equal(failures[0]?.stage, 'attempt-reconcile');
    assert.equal(failures[0]?.timedOut, true);
    assert.match(failures[0]?.message ?? '', /attempt-reconcile/);
  });

  it('still reaches Home when a real workspace path-variant recompute is replaced with a hang', async () => {
    const { workspace } = createMemoryWorkspace();
    workspace.recomputePathVariants = async () => {
      await pending();
    };
    const failures: AppStartupFailure[] = [];
    let snapshot: HomeSnapshot | null = null;
    const session = startAppStartup(
      {
        preparePersistence: () => workspace.preparePersistence(),
        recoverTracker: () => workspace.recoverTracker(),
        reconcileAttempts: () => workspace.reconcileAttempts(),
        loadHome: () => workspace.loadHome(),
        recomputePathVariants: () => workspace.recomputePathVariants(),
      },
      {
        onStage: () => {},
        onHomeReady: (home) => {
          snapshot = home;
        },
        onFailure: (failure) => {
          failures.push(failure);
        },
      },
      { watchdogMs: 5_000, stageTimeoutMs: 5_000 },
    );

    await Promise.race([
      session.finished,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('workspace startup waited on hanging recompute')), 400);
      }),
    ]);

    assert.equal(failures.length, 0);
    assert.equal(snapshot?.activeTransportationMode, 'scooter');
    session.cancel();
  });

  it('wires AppRoot to the independent watchdog, shows the stuck stage, and defers recompute', () => {
    const appRoot = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const workspace = readFileSync('src/product/route-workspace.ts', 'utf8');
    const bootstrap = workspace.slice(
      workspace.indexOf('async bootstrap()'),
      workspace.indexOf('async loadHome()'),
    );

    assert.match(appRoot, /startAppStartup/);
    assert.match(appRoot, /APP_STARTUP_WATCHDOG_MS/);
    assert.match(appRoot, /new AbortController/);
    assert.match(appRoot, /Stage: \{startupStage\}/);
    assert.match(appRoot, /APP_STARTUP_STAGE_LABELS\[startupStage\]/);
    assert.match(appRoot, /recomputePathVariants: \(\) => workspace\.recomputePathVariants\(\)/);
    assert.match(appRoot, /watchdogMs: APP_STARTUP_WATCHDOG_MS/);
    assert.equal(APP_STARTUP_WATCHDOG_MS, 10_000);
    assert.equal(APP_STARTUP_STAGE_LABELS['path-variant-recompute'], 'path-variant recompute');
    assert.doesNotMatch(bootstrap, /recomputeAllPathVariants|recomputePathVariants/);
    assert.match(bootstrap, /preparePersistence/);
    assert.match(bootstrap, /recoverTracker/);
    assert.match(bootstrap, /reconcileAttempts/);
    assert.match(bootstrap, /loadHome/);
  });
});
