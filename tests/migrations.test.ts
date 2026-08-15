import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyMigrations } from '../src/persistence/migrations';
import { CURRENT_SCHEMA_VERSION, LOCATION_SPIKE_SCHEMA } from '../src/persistence/schema';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';

describe('SQLite migrations', () => {
  it('migrates spike schema rows, including an active legacy session, to non-product legacy data', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');

    await sql.run(
      'INSERT INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active) VALUES (?, ?, ?, ?)',
      ['stopped-legacy', 1000, 2000, 0],
    );
    await sql.run(
      'INSERT INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active) VALUES (?, ?, ?, ?)',
      ['active-legacy', 3000, null, 1],
    );
    await sql.run(
      `INSERT INTO location_sample (
         id, session_id, recorded_at_ms, latitude, longitude,
         horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['p1', 'active-legacy', 3100, 32.08, 34.78, 5, 1, 90],
    );

    const migratedAt = 9_000;
    await applyMigrations(sql, migratedAt);

    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);

    const stopped = await sql.getFirst<{
      purpose: string;
      capture_outcome: string;
      review_disposition: string;
      is_active: number;
      stopped_at_ms: number | null;
    }>('SELECT purpose, capture_outcome, review_disposition, is_active, stopped_at_ms FROM tracking_session WHERE id = ?', [
      'stopped-legacy',
    ]);
    assert.equal(stopped?.purpose, 'legacy');
    assert.equal(stopped?.capture_outcome, 'unknown');
    assert.equal(stopped?.review_disposition, 'discarded');
    assert.equal(stopped?.is_active, 0);
    assert.equal(stopped?.stopped_at_ms, 2000);

    const active = await sql.getFirst<{
      purpose: string;
      capture_outcome: string;
      review_disposition: string;
      is_active: number;
      stopped_at_ms: number | null;
    }>('SELECT purpose, capture_outcome, review_disposition, is_active, stopped_at_ms FROM tracking_session WHERE id = ?', [
      'active-legacy',
    ]);
    assert.equal(active?.purpose, 'legacy');
    assert.equal(active?.capture_outcome, 'unknown');
    assert.equal(active?.review_disposition, 'discarded');
    assert.equal(active?.is_active, 0);
    assert.equal(active?.stopped_at_ms, migratedAt);

    const store = new SqliteLocationSampleStore(async () => sql);
    assert.equal(await store.getActiveSessionId(), null);
    assert.equal(await store.findPendingRouteCreation(), null);
    assert.equal(await store.countSamples('active-legacy'), 1);

    const routeTable = await sql.getFirst<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'route'`,
    );
    assert.equal(routeTable?.name, 'route');
  });

  it('is idempotent when the current schema version is already applied', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1000);
    await applyMigrations(sql, 2000);
    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
  });
});
