import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attempt } from '../src/domain/attempt';
import { CompetitiveCheckpointValidationError } from '../src/domain/competitive-checkpoint';
import {
  deriveSegments,
  isSegmentResultStale,
  segmentResultsFromDerivation,
  SEGMENT_DERIVATION_VERSION,
} from '../src/domain/segment-derivation';
import type { AttemptStore } from '../src/persistence/attempt-store';
import type { CompetitiveCheckpointStore } from '../src/persistence/competitive-checkpoint-store';
import { MemoryAttemptStore } from '../src/persistence/memory-attempt-store';
import { MemoryCompetitiveCheckpointStore } from '../src/persistence/memory-competitive-checkpoint-store';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqliteCompetitiveCheckpointStore } from '../src/persistence/sqlite-competitive-checkpoint-store';
import { SqlitePlaceStore } from '../src/persistence/sqlite-place-store';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import {
  checkpoint,
  DESTINATION,
  fullAttempt,
  ORIGIN,
  POOL,
  partialAttempt,
  ride,
  T0,
  track,
  config as makeConfig,
} from './helpers/segments';

type Ctx = {
  attempts: AttemptStore;
  checkpoints: CompetitiveCheckpointStore;
  seedAttempt(attempt: Attempt): Promise<void>;
  tableCount(table: string): Promise<number | null>;
};

async function makeCtx(kind: 'memory' | 'sqlite'): Promise<Ctx> {
  if (kind === 'memory') {
    const attempts = new MemoryAttemptStore();
    return {
      attempts,
      checkpoints: new MemoryCompetitiveCheckpointStore(attempts),
      seedAttempt: (attempt) => attempts.saveAttempt(attempt),
      tableCount: async () => null,
    };
  }
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, T0);
  const places = new SqlitePlaceStore(async () => sql);
  await places.createPlace(ORIGIN);
  await places.createPlace(DESTINATION);
  const attempts = new SqliteAttemptStore(async () => sql);
  return {
    attempts,
    checkpoints: new SqliteCompetitiveCheckpointStore(async () => sql),
    async seedAttempt(attempt) {
      await sql.run(
        `INSERT OR IGNORE INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition)
         VALUES (?, 1, 2, 0, 'attempt', 'finished', 'saved')`,
        [attempt.sessionId],
      );
      await attempts.saveAttempt(attempt);
    },
    async tableCount(table) {
      return (await sql.getFirst<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`))!.c;
    },
  };
}

const PLACES = [ORIGIN, DESTINATION];

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`competitive checkpoint store [${kind}] (#81)`, () => {
    it('versions configurations: edits supersede, history stays readable, identical saves are no-ops', async () => {
      const { checkpoints } = await makeCtx(kind);
      assert.equal(await checkpoints.getCurrentConfig(POOL), null);
      const v1 = await checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b', 150)], places: PLACES, nowMs: 10 });
      assert.equal(v1.version, 1);
      assert.equal(v1.status, 'current');
      const same = await checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b', 150)], places: PLACES, nowMs: 20 });
      assert.equal(same.version, 1, 'unchanged configuration does not make results stale');

      const v2 = await checkpoints.saveConfig({
        pool: POOL,
        checkpoints: [checkpoint('b', 150, 25), checkpoint('b2', 300)],
        places: PLACES,
        nowMs: 30,
      });
      assert.equal(v2.version, 2);
      assert.deepEqual(v2.checkpoints.map((item) => item.id), ['b', 'b2'], 'order is preserved');
      assert.equal((await checkpoints.getCurrentConfig(POOL))!.version, 2);
      const history = await checkpoints.listConfigs(POOL);
      assert.deepEqual(history.map((item) => [item.version, item.status]), [[1, 'superseded'], [2, 'current']]);
      assert.equal((await checkpoints.getConfig(POOL, 1))!.checkpoints[0]!.radiusMeters, 20, 'old definition still readable');

      // Reorder and delete-all are also new versions.
      const v3 = await checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b2', 300), checkpoint('b', 150, 25)], places: PLACES, nowMs: 40 });
      assert.equal(v3.version, 3);
      const v4 = await checkpoints.saveConfig({ pool: POOL, checkpoints: [], places: PLACES, nowMs: 50 });
      assert.equal(v4.version, 4);
      assert.deepEqual((await checkpoints.getCurrentConfig(POOL))!.checkpoints, []);
    });

    it('scopes configurations to the directional pool and mode', async () => {
      const { checkpoints } = await makeCtx(kind);
      await checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b', 150)], places: PLACES, nowMs: 1 });
      const reverse = { originPlaceId: 'c', destinationPlaceId: 'a', transportationMode: 'scooter' as const };
      const bike = { ...POOL, transportationMode: 'bike' as const };
      assert.equal(await checkpoints.getCurrentConfig(reverse), null);
      assert.equal(await checkpoints.getCurrentConfig(bike), null);
    });

    it('rejects invalid configurations at save time and writes nothing', async () => {
      const ctx = await makeCtx(kind);
      const { checkpoints } = ctx;
      for (const bad of [
        [checkpoint('b', 150, 7)],
        [checkpoint('b', 150, 251)],
        [checkpoint('b', 435)], // overlaps the destination place
        [checkpoint('b', 150), checkpoint('b2', 180)], // overlap each other
      ]) {
        await assert.rejects(
          () => checkpoints.saveConfig({ pool: POOL, checkpoints: bad, places: PLACES, nowMs: 1 }),
          CompetitiveCheckpointValidationError,
        );
      }
      assert.equal(await checkpoints.getCurrentConfig(POOL), null);
      assert.deepEqual(await checkpoints.listConfigs(POOL), []);
      assert.ok([null, 0].includes(await ctx.tableCount('competitive_checkpoint_config')));
    });

    it('an unconfigured pool stays unconfigured when an empty list is saved', async () => {
      const { checkpoints } = await makeCtx(kind);
      const result = await checkpoints.saveConfig({ pool: POOL, checkpoints: [], places: PLACES, nowMs: 1 });
      assert.equal(result.version, 0);
      assert.equal(await checkpoints.getCurrentConfig(POOL), null);
    });

    it('stores derived segment results per (attempt, version), replaces them idempotently and detects stale ones', async () => {
      const ctx = await makeCtx(kind);
      const { checkpoints } = ctx;
      const v1 = await checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b', 150)], places: PLACES, nowMs: 1 });
      const attempt = fullAttempt();
      await ctx.seedAttempt(attempt);
      const derivation = deriveSegments({
        attempt,
        samples: track(ride({})),
        config: v1,
        origin: ORIGIN,
        destination: DESTINATION,
      });
      const rows = segmentResultsFromDerivation(derivation, 99);
      assert.equal(rows.length, 2);

      await checkpoints.replaceSegmentResults([{ attemptId: attempt.id, configVersion: 1, results: rows }]);
      await checkpoints.replaceSegmentResults([{ attemptId: attempt.id, configVersion: 1, results: rows }]);
      assert.deepEqual(await checkpoints.listSegmentResults(attempt.id), rows.sort((a, b) => a.id.localeCompare(b.id)));
      assert.equal((await checkpoints.listSegmentResultsForPool(POOL, 1)).length, 2);
      assert.equal((await checkpoints.listSegmentResultsForPool(POOL, 2)).length, 0);

      // A new configuration version makes the stored rows stale without touching them.
      const v2 = await checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b', 150, 25)], places: PLACES, nowMs: 2 });
      const stored = await checkpoints.listSegmentResults(attempt.id);
      assert.ok(stored.every((row) => isSegmentResultStale(row, v2.version)));
      assert.ok(stored.every((row) => !isSegmentResultStale(row, 1) || row.derivationVersion !== SEGMENT_DERIVATION_VERSION));

      // The attempt's official timing is never altered by any of this.
      assert.deepEqual(await ctx.attempts.getAttempt(attempt.id), { ...attempt, kind: 'full', startCheckpointId: null, checkpointConfigVersion: null });

      assert.equal(await checkpoints.pruneStaleSegmentResults(POOL, v2.version), 2);
      assert.deepEqual(await checkpoints.listSegmentResults(attempt.id), []);
    });

    it('a batch replace is all-or-nothing', async () => {
      const ctx = await makeCtx(kind);
      await ctx.checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b', 150)], places: PLACES, nowMs: 1 });
      const attempt = fullAttempt();
      await ctx.seedAttempt(attempt);
      const good = segmentResultsFromDerivation(
        deriveSegments({
          attempt,
          samples: track(ride({})),
          config: makeConfig([checkpoint('b', 150)]),
          origin: ORIGIN,
          destination: DESTINATION,
        }),
        1,
      );
      if (kind === 'sqlite') {
        // The second item references an attempt that does not exist: the foreign key rejects it and the first item rolls back.
        await assert.rejects(() =>
          ctx.checkpoints.replaceSegmentResults([
            { attemptId: attempt.id, configVersion: 1, results: good },
            {
              attemptId: 'ghost',
              configVersion: 1,
              results: good.map((row) => ({ ...row, id: `ghost:${row.id}`, attemptId: 'ghost' })),
            },
          ]),
        );
        assert.deepEqual(await ctx.checkpoints.listSegmentResults(attempt.id), []);
      } else {
        await ctx.checkpoints.replaceSegmentResults([{ attemptId: attempt.id, configVersion: 1, results: good }]);
        assert.equal((await ctx.checkpoints.listSegmentResults(attempt.id)).length, 2);
      }
    });

    it('deleting an attempt deletes its segment results', async () => {
      const ctx = await makeCtx(kind);
      await ctx.checkpoints.saveConfig({ pool: POOL, checkpoints: [checkpoint('b', 150)], places: PLACES, nowMs: 1 });
      const attempt = fullAttempt();
      await ctx.seedAttempt(attempt);
      const rows = segmentResultsFromDerivation(
        deriveSegments({
          attempt,
          samples: track(ride({})),
          config: makeConfig([checkpoint('b', 150)]),
          origin: ORIGIN,
          destination: DESTINATION,
        }),
        1,
      );
      await ctx.checkpoints.replaceSegmentResults([{ attemptId: attempt.id, configVersion: 1, results: rows }]);
      await ctx.attempts.deleteAttempt(attempt.id);
      assert.deepEqual(await ctx.checkpoints.listSegmentResults(attempt.id), []);
    });

    it('stores partial attempt kind and checkpoint reference exactly', async () => {
      const ctx = await makeCtx(kind);
      const partial = partialAttempt('b', T0 + 5000, T0 + 46_000);
      await ctx.seedAttempt(partial);
      const loaded = (await ctx.attempts.getAttempt(partial.id))!;
      assert.equal(loaded.kind, 'partial');
      assert.equal(loaded.startCheckpointId, 'b');
      assert.equal(loaded.checkpointConfigVersion, 1);
    });
  });
}
