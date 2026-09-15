import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import type { JourneyPoolId } from '../src/domain/journey';
import type { JourneyPoolSummary } from '../src/domain/journey-analysis';
import { MILLISECONDS_PER_DAY } from '../src/domain/journey-statistics';
import type { Place } from '../src/domain/place';
import {
  beginJourneySnapshotLoad,
  canOpenJourneyHistory,
  canPresentRetainedJourney,
  finishJourneySnapshotLoad,
  type JourneySnapshotGateInput,
} from '../src/product/journey-navigation';
import type { LoadedJourney } from '../src/product/route-workspace';
import { makePlace } from './helpers/places';
import { offsetLatLng, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const POOL: JourneyPoolId = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter',
};

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
    ...overrides,
  };
}

async function seedAttempt(
  sessions: ReturnType<typeof createMemoryWorkspace>['sessions'],
  attempts: ReturnType<typeof createMemoryWorkspace>['attempts'],
  attempt: Attempt,
  sampleCount: number,
) {
  const pathStart = HOME.center;
  const samples = traceAlongPath(
    [
      pathStart,
      offsetLatLng(pathStart.latitude, pathStart.longitude, 200, 0),
      WORK.center,
    ],
    {
      sessionId: attempt.sessionId,
      startMs: attempt.startedAtMs ?? 1_700_000_000_000,
      intervalMs: 1000,
      stepMeters: 20,
      count: sampleCount,
    },
  );
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

function idOnlyJourneyGate(input: Omit<JourneySnapshotGateInput, 'snapshotReady'>): boolean {
  return Boolean(
    input.origin &&
      input.destination &&
      input.summary &&
      input.origin.id === input.pool.originPlaceId &&
      input.destination.id === input.pool.destinationPlaceId &&
      input.summary.transportationMode === input.pool.transportationMode,
  );
}

type JourneyUi = {
  token: number;
  snapshotReady: boolean;
  activePool: JourneyPoolId | null;
  origin: Place | null;
  destination: Place | null;
  summary: JourneyPoolSummary | null;
  pbTimeMs: number | null;
  originName: string | null;
  bestLast7DaysAttemptId: string | null;
  historyAttemptIds: string[];
};

function createJourneyUi(): JourneyUi {
  return {
    token: 0,
    snapshotReady: false,
    activePool: null,
    origin: null,
    destination: null,
    summary: null,
    pbTimeMs: null,
    originName: null,
    bestLast7DaysAttemptId: null,
    historyAttemptIds: [],
  };
}

function snapshotGate(ui: JourneyUi, pool: JourneyPoolId): JourneySnapshotGateInput {
  return {
    snapshotReady: ui.snapshotReady,
    pool,
    origin: ui.origin,
    destination: ui.destination,
    summary: ui.summary,
  };
}

function applyLoaded(ui: JourneyUi, loaded: LoadedJourney) {
  ui.origin = loaded.origin;
  ui.destination = loaded.destination;
  ui.summary = loaded.summary;
  ui.pbTimeMs = loaded.summary.pbTimeMs;
  ui.originName = loaded.origin.name;
  ui.bestLast7DaysAttemptId = loaded.statistics.bestLast7DaysAttemptId;
  ui.historyAttemptIds = loaded.history.map((row) => row.attemptId);
  ui.snapshotReady = true;
}

async function openJourney(
  ui: JourneyUi,
  workspace: ReturnType<typeof createMemoryWorkspace>['workspace'],
  pool: JourneyPoolId,
) {
  const began = beginJourneySnapshotLoad(ui.token);
  ui.token = began.token;
  ui.snapshotReady = began.snapshotReady;
  ui.activePool = pool;
  assert.equal(canPresentRetainedJourney(snapshotGate(ui, pool)), false);
  assert.equal(canOpenJourneyHistory(snapshotGate(ui, pool)), false);
  const loaded = await workspace.loadJourney(pool);
  const outcome = finishJourneySnapshotLoad(
    began.token,
    ui.token,
    ui.activePool,
    pool,
    loaded,
  );
  if (outcome.kind === 'ready') {
    applyLoaded(ui, outcome.loaded);
  }
  return outcome;
}

describe('journey snapshot presentation', () => {
  it('does not present leftover same-pool React state until the current load commits', () => {
    const leftover: JourneySnapshotGateInput = {
      snapshotReady: false,
      pool: POOL,
      origin: HOME,
      destination: WORK,
      summary: {
        originPlaceId: HOME.id,
        destinationPlaceId: WORK.id,
        originName: 'Home',
        destinationName: 'Work',
        title: 'Home → Work',
        transportationMode: 'scooter',
        rankedAttemptCount: 1,
        pbAttemptId: 'old-pb',
        pbTimeMs: 120_000,
        lastAttemptId: 'old-pb',
        lastTimeMs: 120_000,
        lastFinishedAtMs: 1_700_000_000_000,
      },
    };
    assert.equal(idOnlyJourneyGate(leftover), true);
    assert.equal(canPresentRetainedJourney(leftover), false);
    assert.equal(canOpenJourneyHistory(leftover), false);
    assert.equal(canPresentRetainedJourney({ ...leftover, snapshotReady: true }), true);
  });

  it('ignores a stale in-flight load after a newer same-pool navigation starts', async () => {
    const { workspace, sessions, attempts, places } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await seedAttempt(sessions, attempts, completedAttempt('slow'), 8);
    const first = await workspace.loadJourney(POOL);
    assert.ok(first);

    const ui = createJourneyUi();
    const firstBegin = beginJourneySnapshotLoad(ui.token);
    ui.token = firstBegin.token;
    ui.snapshotReady = firstBegin.snapshotReady;
    ui.activePool = POOL;

    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('faster', {
        finishedAtMs: 1_700_000_000_000 + 80_000,
      }),
      8,
    );

    const second = await openJourney(ui, workspace, POOL);
    assert.equal(second.kind, 'ready');
    if (second.kind !== 'ready') {
      return;
    }
    assert.equal(second.loaded.summary.pbAttemptId, 'faster');

    const stale = finishJourneySnapshotLoad(firstBegin.token, ui.token, ui.activePool, POOL, first);
    assert.equal(stale.kind, 'superseded');
    assert.equal(ui.pbTimeMs, second.loaded.summary.pbTimeMs);
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), true);
  });

  it('hides leftover PB/history after a new same-pool attempt until loadJourney commits', async () => {
    const { workspace, sessions, attempts, places } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await seedAttempt(sessions, attempts, completedAttempt('slow'), 8);

    const ui = createJourneyUi();
    const first = await openJourney(ui, workspace, POOL);
    assert.equal(first.kind, 'ready');
    assert.equal(ui.pbTimeMs, 99_000);
    assert.deepEqual(ui.historyAttemptIds, ['slow']);
    assert.equal(canOpenJourneyHistory(snapshotGate(ui, POOL)), true);

    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('faster', {
        finishedAtMs: 1_700_000_000_000 + 80_000,
      }),
      8,
    );

    const began = beginJourneySnapshotLoad(ui.token);
    ui.token = began.token;
    ui.snapshotReady = began.snapshotReady;
    ui.activePool = POOL;
    assert.equal(idOnlyJourneyGate(snapshotGate(ui, POOL)), true);
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), false);
    assert.equal(canOpenJourneyHistory(snapshotGate(ui, POOL)), false);
    assert.equal(ui.pbTimeMs, 99_000);

    workspace.resetNavigationLoad();
    const outcome = await openJourney(ui, workspace, POOL);
    assert.equal(outcome.kind, 'ready');
    if (outcome.kind !== 'ready') {
      return;
    }
    assert.equal(ui.pbTimeMs, 80_000);
    assert.equal(ui.summary?.pbAttemptId, 'faster');
    assert.ok(ui.historyAttemptIds.includes('faster'));
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), true);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);
  });

  it('hides leftover Place names after a rename with no attempt writes', async () => {
    const { workspace, sessions, attempts, places } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 8);

    const ui = createJourneyUi();
    await openJourney(ui, workspace, POOL);
    assert.equal(ui.originName, 'Home');

    const renamed = await workspace.savePlace({ ...HOME, name: 'Casa' });
    assert.equal(renamed.ok, true);
    const beforeAttempts = JSON.stringify(await attempts.listAttempts());

    const began = beginJourneySnapshotLoad(ui.token);
    ui.token = began.token;
    ui.snapshotReady = began.snapshotReady;
    ui.activePool = POOL;
    assert.equal(ui.originName, 'Home');
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), false);

    const outcome = await openJourney(ui, workspace, POOL);
    assert.equal(outcome.kind, 'ready');
    assert.equal(ui.originName, 'Casa');
    assert.match(ui.summary?.title ?? '', /Casa/);
    assert.equal(JSON.stringify(await attempts.listAttempts()), beforeAttempts);
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), true);
  });

  it('hides leftover last-7-days stats after asOfMs crosses the window with no writes', async () => {
    let now = 1_800_000_000_000;
    const { workspace, sessions, attempts, places } = createMemoryWorkspace({ now: () => now });
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    const finishedAtMs = now - 7 * MILLISECONDS_PER_DAY + 1_000;
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('edge', {
        startedAtMs: finishedAtMs - 10_000,
        finishedAtMs,
      }),
      8,
    );

    const ui = createJourneyUi();
    await openJourney(ui, workspace, POOL);
    assert.equal(ui.bestLast7DaysAttemptId, 'edge');

    now += 2_000;
    const began = beginJourneySnapshotLoad(ui.token);
    ui.token = began.token;
    ui.snapshotReady = began.snapshotReady;
    ui.activePool = POOL;
    assert.equal(ui.bestLast7DaysAttemptId, 'edge');
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), false);

    workspace.resetNavigationLoad();
    const outcome = await openJourney(ui, workspace, POOL);
    assert.equal(outcome.kind, 'ready');
    assert.equal(ui.bestLast7DaysAttemptId, null);
    assert.equal(workspace.navigationLoad.counters.loadJourneyHits, 0);
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), true);
  });

  it('reuses the workspace journey cache on an unchanged same-pool revisit', async () => {
    const { workspace, sessions, attempts, places } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 8);

    const ui = createJourneyUi();
    await openJourney(ui, workspace, POOL);
    workspace.resetNavigationLoad();
    const revisit = await openJourney(ui, workspace, POOL);
    assert.equal(revisit.kind, 'ready');
    assert.equal(ui.summary?.pbAttemptId, 'hw-1');
    assert.equal(canPresentRetainedJourney(snapshotGate(ui, POOL)), true);
    assert.equal(workspace.navigationLoad.counters.loadJourneyHits, 1);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);
  });

  it('wires AppRoot to invalidate leftover journey React state before loadJourney', () => {
    const appRoot = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const journeyScreen = appRoot.slice(
      appRoot.indexOf("{screen.kind === 'journey'"),
      appRoot.indexOf("{screen.kind === 'detail'"),
    );
    const historyScreen = appRoot.slice(
      appRoot.indexOf("{screen.kind === 'history'"),
      appRoot.indexOf("{screen.kind === 'attempt-detail'"),
    );
    const onOpenJourney = appRoot.slice(
      appRoot.indexOf('const onOpenJourney'),
      appRoot.indexOf('const onOpenHistory'),
    );
    const onOpenHistory = appRoot.slice(
      appRoot.indexOf('const onOpenHistory'),
      appRoot.indexOf('const onOpenGroupAttempts'),
    );
    const onOpenGroupAttempts = appRoot.slice(
      appRoot.indexOf('const onOpenGroupAttempts'),
      appRoot.indexOf('const onOpenHistoryAttempt'),
    );

    assert.match(appRoot, /canPresentRetainedJourney/);
    assert.match(appRoot, /beginJourneySnapshotLoad/);
    assert.match(appRoot, /finishJourneySnapshotLoad/);
    assert.match(appRoot, /canOpenJourneyHistory/);
    assert.match(appRoot, /setJourneySnapshotReady\(began\.snapshotReady\)/);
    assert.match(appRoot, /setJourneySnapshotReady\(false\)/);
    assert.match(
      onOpenJourney,
      /setScreen\(\{ kind: 'journey', pool \}\);\s*const loaded = await loadJourney\(pool\);/s,
    );
    assert.match(onOpenHistory, /canOpenJourneyHistory/);
    assert.match(onOpenGroupAttempts, /canOpenJourneyHistory/);
    assert.match(journeyScreen, /canPresentRetainedJourney/);
    assert.match(journeyScreen, /JourneyLoadingShell/);
    assert.match(historyScreen, /canPresentRetainedJourney/);
    assert.match(historyScreen, /JourneyLoadingShell/);
    assert.match(appRoot, /Loading journey…/);
  });
});
