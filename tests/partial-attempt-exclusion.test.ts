import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  incompleteAttemptLabel,
  isJourneyCompetitive,
  isOfficialAttempt,
  officialTimeMs,
  type Attempt,
} from '../src/domain/attempt';
import {
  attemptInPool,
  incompleteAttempts,
  journeyHistoryRows,
  listJourneyPools,
  summarizeJourneyPool,
  tracesFromAttempts,
} from '../src/domain/journey-analysis';
import { computeJourneyPoolDepartureGrouping } from '../src/domain/journey-departure';
import { bestCompetitiveAttempt, computeJourneyPoolStatistics } from '../src/domain/journey-statistics';
import type { AttemptStore } from '../src/persistence/attempt-store';
import { MemoryAttemptStore } from '../src/persistence/memory-attempt-store';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqlitePlaceStore } from '../src/persistence/sqlite-place-store';
import { deriveAnchoredLayoutAttempt, deriveCurrentLayoutAttempt, timingCourseFromRoute } from '../src/domain/attempt-analysis';
import { makeRoute, northPath } from './helpers/routes';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';
import { DESTINATION, fullAttempt, ORIGIN, POOL, T0 } from './helpers/segments';

const DAY = 24 * 60 * 60 * 1000;

function full(id: string, durationMs: number, dayOffset: number, extra: Partial<Attempt> = {}): Attempt {
  const startedAtMs = T0 - dayOffset * DAY;
  return fullAttempt({
    id,
    sessionId: `s-${id}`,
    armedAtMs: startedAtMs - 5000,
    startedAtMs,
    finishedAtMs: startedAtMs + durationMs,
    startedUtcOffsetMinutes: 0,
    startedTimezoneId: 'UTC',
    startedLocalTimeSource: 'captured',
    ...extra,
  });
}

function partial(id: string, durationMs: number, dayOffset: number, extra: Partial<Attempt> = {}): Attempt {
  return full(id, durationMs, dayOffset, {
    kind: 'partial',
    startCheckpointId: 'b',
    checkpointConfigVersion: 1,
    ...extra,
  });
}

// Two full runs (60 s and 90 s) and a partial that is FASTER than both (30 s).
const FULL_FAST = full('full-fast', 60_000, 3);
const FULL_SLOW = full('full-slow', 90_000, 2);
const PARTIAL_FASTEST = partial('partial-fast', 30_000, 1);

describe('partial attempts never reach full-route competition (#81)', () => {
  it('is not full-route competitive or official, whatever its lifecycle and validity', () => {
    assert.equal(isJourneyCompetitive(PARTIAL_FASTEST), false);
    assert.equal(isOfficialAttempt(PARTIAL_FASTEST), false);
    assert.equal(isJourneyCompetitive(FULL_FAST), true);
    assert.equal(isOfficialAttempt(FULL_FAST), true);
    assert.equal(officialTimeMs(PARTIAL_FASTEST), 30_000, 'its own official time still exists for segment boards');
    assert.equal(attemptInPool(PARTIAL_FASTEST, POOL), false);
    assert.equal(attemptInPool(FULL_FAST, POOL), true);
  });

  it('PB, rank, last attempt and counts ignore a faster partial', () => {
    const traces = tracesFromAttempts([FULL_FAST, FULL_SLOW, PARTIAL_FASTEST]);
    const summary = summarizeJourneyPool(POOL, ORIGIN, DESTINATION, traces);
    assert.equal(summary.pbAttemptId, 'full-fast');
    assert.equal(summary.pbTimeMs, 60_000);
    assert.equal(summary.rankedAttemptCount, 2);
    assert.equal(summary.lastAttemptId, 'full-slow', 'the partial is not the "last" full run');
    assert.equal(bestCompetitiveAttempt([FULL_FAST, FULL_SLOW, PARTIAL_FASTEST])!.id, 'full-fast');
  });

  it('history rows and ranks never contain the partial', () => {
    const rows = journeyHistoryRows(POOL, tracesFromAttempts([FULL_FAST, FULL_SLOW, PARTIAL_FASTEST]));
    assert.deepEqual(rows.map((row) => row.attemptId).sort(), ['full-fast', 'full-slow']);
    assert.deepEqual(rows.map((row) => [row.attemptId, row.rank]).sort(), [['full-fast', 1], ['full-slow', 2]]);
  });

  it('statistics (PB, median, mean, rolling bests) and departure grouping ignore the partial', () => {
    const withPartial = tracesFromAttempts([FULL_FAST, FULL_SLOW, PARTIAL_FASTEST]);
    const without = tracesFromAttempts([FULL_FAST, FULL_SLOW]);
    const asOf = T0 + 1000;
    assert.deepEqual(computeJourneyPoolStatistics(POOL, withPartial, asOf), computeJourneyPoolStatistics(POOL, without, asOf));
    assert.deepEqual(
      computeJourneyPoolDepartureGrouping(POOL, withPartial, asOf),
      computeJourneyPoolDepartureGrouping(POOL, without, asOf),
    );
    const stats = computeJourneyPoolStatistics(POOL, withPartial, asOf);
    assert.equal(stats.pbTimeMs, 60_000);
    assert.equal(stats.medianOfficialTimeMs, 75_000);
    assert.equal(stats.validAttemptCount, 2);
  });

  it('a pool with only partial attempts does not exist on the full-route board', () => {
    const places = new Map([[ORIGIN.id, ORIGIN], [DESTINATION.id, DESTINATION]]);
    assert.deepEqual(listJourneyPools(tracesFromAttempts([PARTIAL_FASTEST]), places), []);
    assert.equal(listJourneyPools(tracesFromAttempts([FULL_FAST, PARTIAL_FASTEST]), places).length, 1);
  });

  it('a partial DNF is a clearly labeled partial non-result, never a full DNF or a ranked row', () => {
    const partialDnf = partial('partial-dnf', 0, 1, { lifecycle: 'ended', validity: 'unranked', finishedAtMs: null });
    const partialDns = partial('partial-dns', 0, 1, { lifecycle: 'ended', validity: 'unranked', startedAtMs: null, finishedAtMs: null });
    const fullDnf = full('full-dnf', 0, 1, { lifecycle: 'ended', validity: 'unranked', finishedAtMs: null });
    assert.equal(incompleteAttemptLabel(partialDnf), 'PARTIAL DID NOT FINISH');
    assert.equal(incompleteAttemptLabel(partialDns), 'PARTIAL DID NOT START');
    assert.equal(incompleteAttemptLabel(fullDnf), 'DID NOT FINISH');
    const rows = journeyHistoryRows(POOL, tracesFromAttempts([FULL_FAST, partialDnf, fullDnf]));
    assert.deepEqual(rows.map((row) => row.attemptId).sort(), ['full-dnf', 'full-fast']);
    assert.equal(rows.find((row) => row.attemptId === 'full-dnf')!.incompleteLabel, 'DID NOT FINISH');
    // The incomplete list keeps the partial DNF (hide/delete behave normally) under its own label.
    const incomplete = incompleteAttempts(tracesFromAttempts([partialDnf, fullDnf]));
    assert.deepEqual(incomplete.map((item) => incompleteAttemptLabel(item)).sort(), ['DID NOT FINISH', 'PARTIAL DID NOT FINISH']);
  });

  it('route-level analytics refuse to derive a partial attempt as a full-route run', () => {
    const course = timingCourseFromRoute(makeRoute({ referencePath: northPath({ points: 41, stepMeters: 20 }), checkpoints: [] }));
    for (const derive of [deriveCurrentLayoutAttempt, deriveAnchoredLayoutAttempt]) {
      const derived = derive(course, PARTIAL_FASTEST, []);
      assert.equal(derived.eligible, false);
      assert.equal(derived.unavailabilityReason, 'partial_attempt');
    }
  });

  it('legacy attempts without a kind field are full', () => {
    const legacy: Attempt = { ...FULL_FAST };
    delete legacy.kind;
    delete legacy.startCheckpointId;
    delete legacy.checkpointConfigVersion;
    assert.equal(isJourneyCompetitive(legacy), true);
    assert.equal(attemptInPool(legacy, POOL), true);
  });
});

for (const storeKind of ['memory', 'sqlite'] as const) {
  describe(`attempt store list defaults to full only [${storeKind}] (#81)`, () => {
    async function makeStore(): Promise<AttemptStore> {
      if (storeKind === 'memory') {
        return new MemoryAttemptStore();
      }
      const sql = createMemorySqlExecutor();
      await applyMigrations(sql, T0);
      const places = new SqlitePlaceStore(async () => sql);
      await places.createPlace(ORIGIN);
      await places.createPlace(DESTINATION);
      const store = new SqliteAttemptStore(async () => sql);
      const original = store.saveAttempt.bind(store);
      store.saveAttempt = async (attempt: Attempt) => {
        await sql.run(
          `INSERT OR IGNORE INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition)
           VALUES (?, 1, 2, 0, 'attempt', 'finished', 'saved')`,
          [attempt.sessionId],
        );
        await original(attempt);
      };
      return store;
    }

    it('listAttempts, listAttemptsForJourney and reconciliation lists exclude partials unless asked', async () => {
      const store = await makeStore();
      for (const attempt of [
        FULL_FAST,
        FULL_SLOW,
        PARTIAL_FASTEST,
        { ...PARTIAL_FASTEST, id: 'partial-pending', sessionId: 's-partial-pending', reconciliationStatus: 'pending' as const, reconciliationVersion: 0 },
      ]) {
        await store.saveAttempt(attempt);
      }
      const ids = (attempts: Attempt[]) => attempts.map((item) => item.id).sort();
      assert.deepEqual(ids(await store.listAttempts()), ['full-fast', 'full-slow']);
      assert.deepEqual(ids(await store.listAttempts({ kind: 'full' })), ['full-fast', 'full-slow']);
      assert.deepEqual(ids(await store.listAttempts({ kind: 'partial' })), ['partial-fast', 'partial-pending']);
      assert.deepEqual(ids(await store.listAttempts({ kind: 'all' })), ['full-fast', 'full-slow', 'partial-fast', 'partial-pending']);
      assert.deepEqual(ids(await store.listAttemptsForJourney('a', 'c', 'scooter')), ['full-fast', 'full-slow']);
      assert.deepEqual(
        ids(await store.listAttemptsForJourney('a', 'c', 'scooter', { kind: 'partial' })),
        ['partial-fast', 'partial-pending'],
      );
      assert.deepEqual(ids(await store.listAttemptsNeedingReconciliation(1)), [], 'partials are never path-reconciled');
      assert.equal(await store.peekFailedReconciliationAttemptId(), null);
      // Place references count every kind, so a Place used only by a partial is still protected.
      assert.equal(await store.countAttemptsReferencingPlace('a'), 4);
    });

    it('listAttemptsForRoute defaults to full only', async () => {
      const store = await makeStore();
      // Routes are not needed by the memory store; SQLite keeps route_id NULL here.
      await store.saveAttempt(FULL_FAST);
      await store.saveAttempt(PARTIAL_FASTEST);
      assert.deepEqual((await store.listAttemptsForRoute('none')).map((item) => item.id), []);
    });
  });
}

describe('journey workspace ignores partial attempts end to end (#81)', () => {
  async function seedMemory() {
    const ws = createMemoryWorkspace();
    await ws.places.createPlace(ORIGIN);
    await ws.places.createPlace(DESTINATION);
    for (const attempt of [FULL_FAST, FULL_SLOW, PARTIAL_FASTEST]) {
      await ws.attempts.saveAttempt(attempt);
    }
    return ws;
  }

  it('loadJourney summary, statistics and history are unchanged by a faster partial', async () => {
    const ws = await seedMemory();
    const journey = (await ws.workspace.loadJourney(POOL))!;
    assert.equal(journey.summary.pbAttemptId, 'full-fast');
    assert.equal(journey.summary.rankedAttemptCount, 2);
    assert.equal(journey.statistics.pbTimeMs, 60_000);
    assert.equal(journey.statistics.medianOfficialTimeMs, 75_000);
    assert.deepEqual(journey.history.map((row) => row.attemptId).sort(), ['full-fast', 'full-slow']);
    const home = await ws.workspace.loadHome();
    assert.equal(home.journeys.length, 1);
    assert.equal(home.journeys[0]!.pbTimeMs, 60_000);
    assert.equal(home.journeys[0]!.rankedAttemptCount, 2);
  });

  it('history recalculation never re-times a partial attempt against origin/destination places', async () => {
    const ws = await seedMemory();
    const preview = await ws.recalc.preview();
    // Only the two full runs are in scope (no stored GPS in this fixture); the partial is not counted.
    assert.equal(preview.candidateCount + preview.preSkippedNoTrace + preview.preSkippedMissingPlace, 2);
  });

  it('focusing a partial attempt as a full-route result yields no rank, PB or comparison', async () => {
    const ws = await seedMemory();
    const headline = (await ws.workspace.analyzeJourneyHeadline(POOL, 'partial-fast'))!;
    assert.equal(headline.summary.pbAttemptId, 'full-fast');
    assert.equal(headline.focus, null, 'a partial is not a member of the full-route pool');
    assert.deepEqual(headline.history.map((row) => row.attemptId).sort(), ['full-fast', 'full-slow']);
  });

  it('the same holds on SQLite', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, T0);
    const ws = createSqliteWorkspace(sql);
    await ws.places.createPlace(ORIGIN);
    await ws.places.createPlace(DESTINATION);
    for (const attempt of [FULL_FAST, FULL_SLOW, PARTIAL_FASTEST]) {
      await sql.run(
        `INSERT INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition)
         VALUES (?, 1, 2, 0, 'attempt', 'finished', 'saved')`,
        [attempt.sessionId],
      );
      await ws.attempts.saveAttempt(attempt);
    }
    const journey = (await ws.workspace.loadJourney(POOL))!;
    assert.equal(journey.summary.pbAttemptId, 'full-fast');
    assert.equal(journey.statistics.pbTimeMs, 60_000);
    assert.deepEqual(journey.history.map((row) => row.attemptId).sort(), ['full-fast', 'full-slow']);
  });
});
