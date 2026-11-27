import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyMigrations, MIGRATIONS } from '../src/persistence/migrations';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { CURRENT_SCHEMA_VERSION, LOCATION_SPIKE_SCHEMA } from '../src/persistence/schema';
import type { SqlExecutor } from '../src/persistence/sql-executor';
import { dumpDatabase } from './helpers/backup-fixtures';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';

async function populatedV13(): Promise<SqlExecutor> {
  const sql = createMemorySqlExecutor();
  await sql.exec('PRAGMA foreign_keys = ON;');
  await sql.exec(LOCATION_SPIKE_SCHEMA);
  await sql.exec('PRAGMA user_version = 0');
  for (const migration of MIGRATIONS.filter((item) => item.version <= 13)) {
    await migration.up(sql, 1_000);
  }
  await sql.exec('PRAGMA user_version = 13');
  await sql.run(
    `INSERT INTO place (id, name, latitude, longitude, radius_meters, departure_radius_meters, arrival_radius_meters, status, created_at_ms)
     VALUES ('home', 'Home', 32.08, 34.78, 30, 100, 30, 'active', 1), ('work', 'Work', 32.09, 34.78, 30, 45, 70, 'active', 2)`,
  );
  for (const id of ['s1', 's2']) {
    await sql.run(
      `INSERT INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition)
       VALUES (?, 10, 20, 0, 'attempt', 'finished', 'saved')`,
      [id],
    );
    await sql.run(
      `INSERT INTO location_sample (id, session_id, recorded_at_ms, latitude, longitude, horizontal_accuracy_meters, speed_meters_per_second, heading_degrees)
       VALUES (?, ?, 12.5, 32.08, 34.78, 5, 1, 0)`,
      [`p-${id}`, id],
    );
  }
  await sql.run(
    `INSERT INTO attempt (id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
                          lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged,
                          reconciliation_status, reconciliation_version)
     VALUES ('a1', NULL, 'home', 'work', 'scooter', 's1', 'completed', 'valid', 9, 11.5, 19.25, 1, 'reconciled', 1),
            ('a2', NULL, 'home', NULL, 'scooter', 's2', 'ended', 'unranked', 30, 31, NULL, 1, 'reconciled', 1)`,
  );
  return sql;
}

describe('schema v14 competitive checkpoints migration (#81)', () => {
  it('is the latest migration and bumps the schema version', () => {
    assert.ok(CURRENT_SCHEMA_VERSION >= 14);
    assert.equal(MIGRATIONS[MIGRATIONS.length - 1]!.version, CURRENT_SCHEMA_VERSION);
    assert.ok(MIGRATIONS.some((migration) => migration.version === 14));
  });

  it('upgrades a populated v13 database without rewriting any existing row', async () => {
    const sql = await populatedV13();
    const before = await dumpDatabase(sql);

    await applyMigrations(sql, 5_000);

    assert.equal((await sql.getFirst<{ user_version: number }>('PRAGMA user_version'))!.user_version, CURRENT_SCHEMA_VERSION);
    const after = await dumpDatabase(sql);
    for (const table of Object.keys(before)) {
      if (table === 'attempt') {
        continue;
      }
      assert.deepEqual(after[table], before[table], `${table} untouched`);
    }
    // Attempt rows keep every original column value; the three new columns are the legacy defaults.
    assert.equal(after.attempt!.length, 2);
    for (const [index, row] of after.attempt!.entries()) {
      const { kind, start_checkpoint_id, checkpoint_config_version, ...original } = row as Record<string, unknown>;
      assert.deepEqual(original, before.attempt![index]);
      assert.equal(kind, 'full');
      assert.equal(start_checkpoint_id, null);
      assert.equal(checkpoint_config_version, null);
    }
    for (const table of ['competitive_checkpoint_config', 'competitive_checkpoint', 'attempt_segment_result']) {
      assert.deepEqual(after[table], [], `${table} starts empty: no automatic backfill`);
    }
  });

  it('legacy attempts read back as full with no checkpoint reference', async () => {
    const sql = await populatedV13();
    await applyMigrations(sql, 5_000);
    const attempts = new SqliteAttemptStore(async () => sql);
    const listed = await attempts.listAttempts();
    assert.deepEqual(listed.map((item) => item.id).sort(), ['a1', 'a2']);
    for (const attempt of listed) {
      assert.equal(attempt.kind, 'full');
      assert.equal(attempt.startCheckpointId, null);
      assert.equal(attempt.checkpointConfigVersion, null);
    }
    assert.equal((await attempts.getAttempt('a1'))!.finishedAtMs, 19.25, 'official times byte-identical');
  });

  it('is idempotent and re-running changes nothing', async () => {
    const sql = await populatedV13();
    await applyMigrations(sql, 5_000);
    const once = await dumpDatabase(sql);
    await applyMigrations(sql, 9_000);
    assert.deepEqual(await dumpDatabase(sql), once);
  });

  it('migrates a brand new database too', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    assert.equal((await sql.getFirst<{ user_version: number }>('PRAGMA user_version'))!.user_version, CURRENT_SCHEMA_VERSION);
  });

  it('enforces the data-model invariants in SQL', async () => {
    const sql = await populatedV13();
    await applyMigrations(sql, 5_000);
    await assert.rejects(() => sql.run(`UPDATE attempt SET kind = 'bogus' WHERE id = 'a1'`), /CHECK/);

    const insertConfig = (id: string, version: number, status: string) =>
      sql.run(
        `INSERT INTO competitive_checkpoint_config (id, origin_place_id, destination_place_id, transportation_mode, version, status, created_at_ms)
         VALUES (?, 'home', 'work', 'scooter', ?, ?, 1)`,
        [id, version, status],
      );
    await insertConfig('c1', 1, 'superseded');
    await insertConfig('c2', 2, 'current');
    await assert.rejects(() => insertConfig('c3', 3, 'current'), /UNIQUE/, 'one current configuration per pool');
    await assert.rejects(() => insertConfig('c4', 2, 'superseded'), /UNIQUE/, 'one row per pool version');

    await sql.run(
      `INSERT INTO competitive_checkpoint (config_id, checkpoint_id, seq, name, latitude, longitude, radius_meters)
       VALUES ('c2', 'b', 0, 'B', 32.085, 34.78, 20)`,
    );
    const insertResult = (id: string, from: string | null, to: string | null) =>
      sql.run(
        `INSERT INTO attempt_segment_result (id, attempt_id, config_version, derivation_version, from_checkpoint_id, to_checkpoint_id, status, derived_at_ms)
         VALUES (?, 'a1', 2, 1, ?, ?, 'unavailable', 1)`,
        [id, from, to],
      );
    await insertResult('r1', null, 'b');
    await assert.rejects(() => insertResult('r2', null, 'b'), /UNIQUE/, 'one result per endpoint pair, NULL boundaries included');
    await insertResult('r3', 'b', null);
    await assert.rejects(
      () => sql.run(
        `INSERT INTO attempt_segment_result (id, attempt_id, config_version, derivation_version, status, derived_at_ms)
         VALUES ('orphan', 'ghost', 1, 1, 'valid', 1)`,
      ),
      /FOREIGN KEY/,
    );

    // Cascades: deleting the attempt removes its results; deleting a place removes its configurations.
    await sql.run(`DELETE FROM attempt WHERE id = 'a1'`);
    assert.equal((await sql.getAll('SELECT id FROM attempt_segment_result')).length, 0);
    await sql.run(`DELETE FROM attempt WHERE id = 'a2'`);
    await sql.run(`DELETE FROM place WHERE id = 'work'`);
    assert.equal((await sql.getAll('SELECT id FROM competitive_checkpoint_config')).length, 0);
    assert.equal((await sql.getAll('SELECT config_id FROM competitive_checkpoint')).length, 0);
  });
});

describe('schema v15 segment job kind migration (#81)', () => {
  it('adds the job kind non-destructively: a legacy job stays a history job and the single-slot rule holds', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 14)) {
      await migration.up(sql, 1_000);
    }
    await sql.exec('PRAGMA user_version = 14');
    await sql.run(
      `INSERT INTO recalc_job (id, status, places_fingerprint, created_at_ms, updated_at_ms, candidate_count)
       VALUES ('legacy', 'running', 'f', 1, 1, 1)`,
    );
    await sql.run(`INSERT INTO recalc_job_item (job_id, attempt_id, seq) VALUES ('legacy', 'a1', 0)`);
    const before = await dumpDatabase(sql);

    await applyMigrations(sql, 5_000);

    const job = await sql.getFirst<Record<string, unknown>>(`SELECT * FROM recalc_job WHERE id = 'legacy'`);
    assert.equal(job!.kind, 'history');
    assert.equal(job!.scope_json, null);
    assert.equal(job!.status, 'running');
    const item = await sql.getFirst<Record<string, unknown>>(`SELECT * FROM recalc_job_item WHERE job_id = 'legacy'`);
    assert.equal(item!.staged_segments_json, null);
    const after = await dumpDatabase(sql);
    for (const table of Object.keys(before)) {
      if (table === 'recalc_job' || table === 'recalc_job_item') {
        continue;
      }
      assert.deepEqual(after[table], before[table], `${table} untouched`);
    }
    // One open job of ANY kind: a segments job cannot be opened next to the legacy one.
    await assert.rejects(
      () =>
        sql.run(
          `INSERT INTO recalc_job (id, status, places_fingerprint, created_at_ms, updated_at_ms, candidate_count, kind)
           VALUES ('seg', 'running', 'f', 1, 1, 1, 'segments')`,
        ),
      /UNIQUE/,
    );
    await assert.rejects(
      () => sql.run(`UPDATE recalc_job SET kind = 'bogus' WHERE id = 'legacy'`),
      /CHECK/,
    );
  });
});
