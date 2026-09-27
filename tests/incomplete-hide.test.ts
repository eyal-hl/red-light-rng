import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  canHideIncompleteAttempt,
  EMPTY_ATTEMPT_LOCAL_START,
  hideIncompleteAttemptRecord,
  restoreIncompleteAttemptRecord,
  type Attempt,
} from '../src/domain/attempt';
import {
  hiddenIncompleteAttempts,
  incompleteAttempts,
  journeyHistoryRows,
  summarizeJourneyPool,
  tracesFromAttempts,
} from '../src/domain/journey-analysis';
import { computeJourneyPoolStatistics } from '../src/domain/journey-statistics';
import { fingerprintAttempt } from '../src/product/derived-view-cache';
import { applyMigrations } from '../src/persistence/migrations';
import { RECONCILED_ATTEMPT } from './helpers/attempts';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { completeJourneySamples, departureOnlySamples, makePlace } from './helpers/places';
import { movingTrace, offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 300, 0),
  createdAtMs: 2,
});

function endedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `${id}-session`,
    lifecycle: 'ended',
    validity: 'unranked',
    armedAtMs: 1_000,
    startedAtMs: null,
    finishedAtMs: null,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: false,
    hiddenIncomplete: false,
    crossings: [],
    routeId: null,
    originPlaceId: HOME.id,
    destinationPlaceId: null,
    transportationMode: 'scooter',
    ...RECONCILED_ATTEMPT,
    ...overrides,
  };
}

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `${id}-session`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 2_000,
    startedAtMs: 3_000,
    finishedAtMs: 13_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    hiddenIncomplete: false,
    crossings: [],
    routeId: 'route-1',
    originPlaceId: HOME.id,
    destinationPlaceId: WORK.id,
    transportationMode: 'scooter',
    ...RECONCILED_ATTEMPT,
    ...overrides,
  };
}

async function createHomeAndWork(workspace: ReturnType<typeof createMemoryWorkspace>['workspace']) {
  const home = await workspace.createPlace({
    name: 'Home',
    center: HOME.center,
    radiusMeters: HOME.radiusMeters,
  });
  const work = await workspace.createPlace({
    name: 'Work',
    center: WORK.center,
    radiusMeters: WORK.radiusMeters,
  });
  assert.equal(home.ok && work.ok, true);
  if (!home.ok || !work.ok) {
    throw new Error('expected Home and Work');
  }
  return { home: home.place, work: work.place };
}

async function endDidNotStart(
  workspace: ReturnType<typeof createMemoryWorkspace>['workspace'],
  sessions?: ReturnType<typeof createMemoryWorkspace>['sessions'],
) {
  const started = await workspace.startAttempt();
  assert.equal(started.ok, true);
  if (!started.ok) {
    throw new Error('expected armed attempt');
  }
  if (sessions) {
    await sessions.appendSamples(
      movingTrace({ sessionId: started.attempt.sessionId, points: 4, stepMeters: 3 }),
    );
  }
  const ended = await workspace.endAndInspectAttempt();
  assert.equal(ended?.lifecycle, 'ended');
  assert.equal(ended?.startedAtMs, null);
  return ended!;
}

async function endDidNotFinish(
  workspace: ReturnType<typeof createMemoryWorkspace>['workspace'],
  sessions: ReturnType<typeof createMemoryWorkspace>['sessions'],
  origin: { id: string; center: { latitude: number; longitude: number }; radiusMeters: number },
) {
  const started = await workspace.startAttempt();
  assert.equal(started.ok, true);
  if (!started.ok) {
    throw new Error('expected armed attempt');
  }
  await sessions.appendSamples(
    departureOnlySamples({
      origin,
      sessionId: started.attempt.sessionId,
      extraMeters: 40,
    }),
  );
  await workspace.processActiveAttempt();
  const ended = await workspace.endAndInspectAttempt();
  assert.equal(ended?.lifecycle, 'ended');
  assert.ok(ended?.startedAtMs != null);
  return ended!;
}

describe('hiding incomplete attempts', () => {
  it('hides DID NOT START from Home INCOMPLETE without changing lifecycle', async () => {
    const { workspace } = createMemoryWorkspace();
    const ended = await endDidNotStart(workspace);
    const before = await workspace.loadHome();
    assert.equal(before.incompleteAttempts.some((item) => item.id === ended.id), true);
    const hidden = await workspace.hideIncompleteAttempt(ended.id);
    assert.equal(hidden.ok, true);
    if (hidden.ok) {
      assert.equal(hidden.attempt.lifecycle, 'ended');
      assert.equal(hidden.attempt.hiddenIncomplete, true);
      assert.equal(hidden.attempt.validity, 'unranked');
    }
    const after = await workspace.loadHome();
    assert.equal(after.incompleteAttempts.some((item) => item.id === ended.id), false);
    assert.equal(after.hiddenIncompleteAttempts.some((item) => item.id === ended.id), true);
  });

  it('hides DID NOT FINISH from Home INCOMPLETE', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const { home } = await createHomeAndWork(workspace);
    const ended = await endDidNotFinish(workspace, sessions, home);
    const hidden = await workspace.hideIncompleteAttempt(ended.id);
    assert.equal(hidden.ok, true);
    const after = await workspace.loadHome();
    assert.equal(after.incompleteAttempts.some((item) => item.id === ended.id), false);
    assert.equal(after.hiddenIncompleteAttempts.some((item) => item.id === ended.id), true);
  });

  it('keeps hidden state after sqlite store reconstruction', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    let nextAttempt = 0;
    let nextSession = 0;
    const first = createSqliteWorkspace(sql, {
      createAttemptId: () => `attempt-${++nextAttempt}`,
      createSessionId: () => `session-${++nextSession}`,
    });
    const ended = await endDidNotStart(first.workspace, first.sessions);
    const sampleCount = await first.sessions.countSamples(ended.sessionId);
    assert.ok(sampleCount > 0);
    const hidden = await first.workspace.hideIncompleteAttempt(ended.id);
    assert.equal(hidden.ok, true);

    const reloaded = createSqliteWorkspace(sql, {
      createAttemptId: () => `attempt-${++nextAttempt}`,
      createSessionId: () => `session-${++nextSession}`,
    });
    const loaded = await reloaded.attempts.getAttempt(ended.id);
    assert.equal(loaded?.lifecycle, 'ended');
    assert.equal(loaded?.hiddenIncomplete, true);
    assert.equal(loaded?.resultAcknowledged, true);
    assert.equal(await reloaded.sessions.countSamples(ended.sessionId), sampleCount);
    const home = await reloaded.workspace.loadHome();
    assert.equal(home.incompleteAttempts.some((item) => item.id === ended.id), false);
    assert.equal(home.hiddenIncompleteAttempts.some((item) => item.id === ended.id), true);
    assert.equal(home.attemptResult, null);
  });

  it('still exposes a reachable Home reveal control when only hidden rows remain', async () => {
    const { workspace } = createMemoryWorkspace();
    const ended = await endDidNotStart(workspace);
    await workspace.hideIncompleteAttempt(ended.id);
    const home = await workspace.loadHome();
    assert.equal(home.incompleteAttempts.length, 0);
    assert.equal(home.hiddenIncompleteAttempts.length, 1);
    const source = readFileSync('src/ui/HomeScreen.tsx', 'utf8');
    const visibleBlockStart = source.indexOf('incompleteAttempts.length > 0');
    const hiddenBlockStart = source.indexOf('hiddenIncompleteAttempts.length > 0');
    assert.ok(visibleBlockStart >= 0);
    assert.ok(hiddenBlockStart > visibleBlockStart);
    assert.doesNotMatch(
      source.slice(visibleBlockStart, hiddenBlockStart),
      /SHOW HIDDEN INCOMPLETE/,
    );
    assert.match(source.slice(hiddenBlockStart), /SHOW HIDDEN INCOMPLETE/);
  });

  it('reveals hidden rows and restores them to Home INCOMPLETE', async () => {
    const { workspace } = createMemoryWorkspace();
    const ended = await endDidNotStart(workspace);
    await workspace.hideIncompleteAttempt(ended.id);
    let home = await workspace.loadHome();
    assert.equal(home.hiddenIncompleteAttempts.map((item) => item.id).join(','), ended.id);
    const restored = await workspace.restoreIncompleteAttempt(ended.id);
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.attempt.hiddenIncomplete, false);
      assert.equal(restored.attempt.lifecycle, 'ended');
    }
    home = await workspace.loadHome();
    assert.equal(home.incompleteAttempts.some((item) => item.id === ended.id), true);
    assert.equal(home.hiddenIncompleteAttempts.length, 0);
  });

  it('prevents a hidden unacknowledged ended attempt from resurfacing as the cold-start result', async () => {
    const { workspace } = createMemoryWorkspace();
    const ended = await endDidNotStart(workspace);
    assert.equal((await workspace.getAttemptResult())?.id, ended.id);
    const homeBefore = await workspace.loadHome();
    assert.equal(homeBefore.attemptResult?.id, ended.id);
    await workspace.hideIncompleteAttempt(ended.id);
    assert.equal(await workspace.getAttemptResult(), null);
    const homeAfter = await workspace.loadHome();
    assert.equal(homeAfter.attemptResult, null);
    const stored = await workspace.getAttempt(ended.id);
    assert.equal(stored?.resultAcknowledged, true);
    assert.equal(stored?.hiddenIncomplete, true);
  });

  it('does not expose hide-DNF on a completed official attempt', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const { home, work } = await createHomeAndWork(workspace);
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      throw new Error('expected armed attempt');
    }
    await sessions.appendSamples(
      completeJourneySamples({
        origin: home,
        destination: work,
        sessionId: started.attempt.sessionId,
      }),
    );
    const completed = await workspace.processActiveAttempt();
    assert.equal(completed?.lifecycle, 'completed');
    assert.equal(canHideIncompleteAttempt(completed!), false);
    const hidden = await workspace.hideIncompleteAttempt(completed!.id);
    assert.equal(hidden.ok, false);
    const stored = await workspace.getAttempt(completed!.id);
    assert.equal(stored?.hiddenIncomplete, false);
    assert.equal(stored?.lifecycle, 'completed');
    const resultScreen = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    assert.match(resultScreen, /canHideIncompleteAttempt/);
    assert.match(resultScreen, /HIDE INCOMPLETE/);
    assert.match(readFileSync('src/ui/AppRoot.tsx', 'utf8'), /HIDE_INCOMPLETE_TITLE/);
  });

  it('leaves PB, rank, Gold/SoB inputs, and completed statistics unchanged', async () => {
    const { workspace, attempts } = createMemoryWorkspace();
    await workspace.createPlace({
      name: HOME.name,
      center: HOME.center,
      radiusMeters: HOME.radiusMeters,
    });
    await workspace.createPlace({
      name: WORK.name,
      center: WORK.center,
      radiusMeters: WORK.radiusMeters,
    });
    const official = completedAttempt('official', {
      originPlaceId: (await workspace.listPlaces()).find((place) => place.name === 'Home')!.id,
      destinationPlaceId: (await workspace.listPlaces()).find((place) => place.name === 'Work')!.id,
    });
    const dnf = endedAttempt('dnf-in-pool', {
      originPlaceId: official.originPlaceId,
      destinationPlaceId: official.destinationPlaceId,
      startedAtMs: 4_000,
      routeId: official.routeId,
    });
    await attempts.createAttempt(official);
    await attempts.createAttempt(dnf);
    const pool = {
      originPlaceId: official.originPlaceId!,
      destinationPlaceId: official.destinationPlaceId!,
      transportationMode: official.transportationMode,
    };
    const tracesBefore = tracesFromAttempts(await attempts.listAttempts());
    const summaryBefore = summarizeJourneyPool(
      pool,
      HOME,
      WORK,
      tracesBefore,
    );
    const statsBefore = computeJourneyPoolStatistics(pool, tracesBefore, 20_000);
    const hidden = await workspace.hideIncompleteAttempt(dnf.id);
    assert.equal(hidden.ok, true);
    if (hidden.ok) {
      assert.equal(hidden.attempt.routeId, official.routeId);
    }
    const tracesAfter = tracesFromAttempts(await attempts.listAttempts());
    const summaryAfter = summarizeJourneyPool(pool, HOME, WORK, tracesAfter);
    const statsAfter = computeJourneyPoolStatistics(pool, tracesAfter, 20_000);
    assert.equal(summaryBefore.rankedAttemptCount, 1);
    assert.equal(summaryAfter.rankedAttemptCount, 1);
    assert.equal(summaryBefore.pbTimeMs, summaryAfter.pbTimeMs);
    assert.equal(summaryBefore.pbAttemptId, 'official');
    assert.equal(summaryAfter.pbAttemptId, 'official');
    assert.equal(statsBefore.validAttemptCount, statsAfter.validAttemptCount);
    assert.equal(statsAfter.validAttemptCount, 1);
    const stored = await workspace.getAttempt(dnf.id);
    assert.equal(stored?.routeId, official.routeId);
    assert.equal(stored?.lifecycle, 'ended');
  });

  it('preserves raw retained telemetry and attempt identity', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const ended = await endDidNotStart(workspace, sessions);
    const sampleCount = await sessions.countSamples(ended.sessionId);
    assert.ok(sampleCount > 0);
    const identity = {
      id: ended.id,
      sessionId: ended.sessionId,
      originPlaceId: ended.originPlaceId,
      destinationPlaceId: ended.destinationPlaceId,
      routeId: ended.routeId,
      lifecycle: ended.lifecycle,
      validity: ended.validity,
    };
    await workspace.hideIncompleteAttempt(ended.id);
    const stored = await workspace.getAttempt(ended.id);
    assert.equal(stored?.id, identity.id);
    assert.equal(stored?.sessionId, identity.sessionId);
    assert.equal(stored?.originPlaceId, identity.originPlaceId);
    assert.equal(stored?.destinationPlaceId, identity.destinationPlaceId);
    assert.equal(stored?.routeId, identity.routeId);
    assert.equal(stored?.lifecycle, identity.lifecycle);
    assert.equal(stored?.validity, identity.validity);
    assert.equal(await sessions.countSamples(ended.sessionId), sampleCount);
    await workspace.restoreIncompleteAttempt(ended.id);
    assert.equal(await sessions.countSamples(ended.sessionId), sampleCount);
    assert.equal((await workspace.getAttempt(ended.id))?.id, identity.id);
  });

  it('omits hidden ended rows from journey chronological history', async () => {
    const traces = [
      { attempt: completedAttempt('official'), samples: [] },
      {
        attempt: endedAttempt('dnf', {
          originPlaceId: HOME.id,
          destinationPlaceId: WORK.id,
          startedAtMs: 4_000,
        }),
        samples: [],
      },
    ];
    const pool = {
      originPlaceId: HOME.id,
      destinationPlaceId: WORK.id,
      transportationMode: 'scooter' as const,
    };
    const visible = journeyHistoryRows(pool, traces);
    assert.equal(visible.some((row) => row.attemptId === 'dnf'), true);
    const hiddenTraces = [
      traces[0]!,
      { attempt: { ...traces[1]!.attempt, hiddenIncomplete: true }, samples: [] },
    ];
    const omitted = journeyHistoryRows(pool, hiddenTraces);
    assert.equal(omitted.some((row) => row.attemptId === 'dnf'), false);
    assert.equal(omitted.some((row) => row.attemptId === 'official'), true);
  });

  it('still counts hidden retained attempts for place-reference safety', async () => {
    const { workspace, attempts } = createMemoryWorkspace();
    const { home } = await createHomeAndWork(workspace);
    const ended = endedAttempt('hidden-ref', { originPlaceId: home.id, destinationPlaceId: null });
    await attempts.createAttempt(ended);
    assert.equal(await workspace.countAttemptsReferencingPlace(home.id), 1);
    await workspace.hideIncompleteAttempt(ended.id);
    assert.equal(await workspace.countAttemptsReferencingPlace(home.id), 1);
    const stored = await workspace.getAttempt(ended.id);
    assert.equal(stored?.originPlaceId, home.id);
  });

  it('handles multiple hidden incomplete attempts without dropping rows', async () => {
    const { workspace } = createMemoryWorkspace();
    const first = await endDidNotStart(workspace);
    const second = await endDidNotStart(workspace);
    const third = await endDidNotStart(workspace);
    await workspace.hideIncompleteAttempt(first.id);
    await workspace.hideIncompleteAttempt(second.id);
    await workspace.hideIncompleteAttempt(third.id);
    const home = await workspace.loadHome();
    assert.equal(home.incompleteAttempts.length, 0);
    assert.equal(home.hiddenIncompleteAttempts.length, 3);
    assert.deepEqual(
      home.hiddenIncompleteAttempts.map((item) => item.id).sort(),
      [first.id, second.id, third.id].sort(),
    );
  });

  it('does not fake a hide by cancelling or abandoning the attempt', () => {
    const ended = endedAttempt('dns');
    const hidden = hideIncompleteAttemptRecord(ended);
    assert.equal(hidden?.lifecycle, 'ended');
    assert.equal(hidden?.hiddenIncomplete, true);
    assert.equal(hideIncompleteAttemptRecord(completedAttempt('official')), null);
    const restored = restoreIncompleteAttemptRecord(hidden!);
    assert.equal(restored?.hiddenIncomplete, false);
    assert.equal(restored?.lifecycle, 'ended');
  });

  it('changes the attempt fingerprint when hidden state changes', () => {
    const visible = endedAttempt('dns');
    const hidden = { ...visible, hiddenIncomplete: true };
    assert.notEqual(fingerprintAttempt(visible), fingerprintAttempt(hidden));
  });

  it('splits visible and hidden incomplete lists in domain helpers', () => {
    const traces = tracesFromAttempts([
      endedAttempt('visible'),
      endedAttempt('hidden', { hiddenIncomplete: true, armedAtMs: 2_000 }),
      completedAttempt('official'),
    ]);
    assert.deepEqual(
      incompleteAttempts(traces).map((item) => item.id),
      ['visible'],
    );
    assert.deepEqual(
      hiddenIncompleteAttempts(traces).map((item) => item.id),
      ['hidden'],
    );
  });
});
