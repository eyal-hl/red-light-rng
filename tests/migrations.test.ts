import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathDistanceMeters } from '../src/domain/geo';
import { applyMigrations, MIGRATIONS } from '../src/persistence/migrations';
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

  it('adds a persisted background-permission flag when upgrading from schema v1', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    await sql.exec(`ALTER TABLE tracking_session ADD COLUMN purpose TEXT NOT NULL DEFAULT 'legacy'`);
    await sql.exec(
      `ALTER TABLE tracking_session ADD COLUMN capture_outcome TEXT NOT NULL DEFAULT 'unknown'`,
    );
    await sql.exec(
      `ALTER TABLE tracking_session ADD COLUMN review_disposition TEXT NOT NULL DEFAULT 'discarded'`,
    );
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS route (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        transportation_mode TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        source_recording_id TEXT NOT NULL UNIQUE,
        start_latitude REAL NOT NULL,
        start_longitude REAL NOT NULL,
        start_radius_meters REAL NOT NULL,
        finish_latitude REAL NOT NULL,
        finish_longitude REAL NOT NULL,
        finish_radius_meters REAL NOT NULL,
        FOREIGN KEY (source_recording_id) REFERENCES tracking_session(id)
      );
    `);
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS route_reference_point (
        route_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        PRIMARY KEY (route_id, seq),
        FOREIGN KEY (route_id) REFERENCES route(id) ON DELETE CASCADE
      );
    `);
    await sql.exec('PRAGMA user_version = 1');
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition
       ) VALUES (?, ?, NULL, 1, ?, ?, ?)`,
      ['v1-active', 1000, 'route_creation', 'active', 'pending'],
    );

    await applyMigrations(sql, 2000);

    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
    const row = await sql.getFirst<{
      is_active: number;
      background_permission_confirmed: number;
      purpose: string;
    }>(
      'SELECT is_active, background_permission_confirmed, purpose FROM tracking_session WHERE id = ?',
      ['v1-active'],
    );
    assert.equal(row?.is_active, 1);
    assert.equal(row?.purpose, 'route_creation');
    assert.equal(row?.background_permission_confirmed, 0);
  });

  it('migrates v2 routes in place with zero checkpoints and anchored start/finish progress', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    await MIGRATIONS[0]!.up(sql, 1000);
    await MIGRATIONS[1]!.up(sql, 1000);
    await sql.exec('PRAGMA user_version = 2');

    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
      ['issue-3-session', 1000, 2000],
    );
    const startLat = 32.08;
    const startLng = 34.78;
    const points = [
      { latitude: startLat, longitude: startLng },
      { latitude: startLat + 20 / 111_320, longitude: startLng },
      { latitude: startLat + 40 / 111_320, longitude: startLng },
      { latitude: startLat + 60 / 111_320, longitude: startLng },
    ];
    const finishCenterLat = points[3]!.latitude + 8 / 111_320;
    await sql.run(
      `INSERT INTO route (
         id, name, transportation_mode, created_at_ms, source_recording_id,
         start_latitude, start_longitude, start_radius_meters,
         finish_latitude, finish_longitude, finish_radius_meters
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'issue-3-route',
        'Home → Work',
        'scooter',
        3000,
        'issue-3-session',
        points[0]!.latitude,
        points[0]!.longitude,
        30,
        finishCenterLat,
        startLng,
        30,
      ],
    );
    for (const [index, point] of points.entries()) {
      await sql.run(
        'INSERT INTO route_reference_point (route_id, seq, latitude, longitude) VALUES (?, ?, ?, ?)',
        ['issue-3-route', index, point.latitude, point.longitude],
      );
    }

    await applyMigrations(sql, 4000);

    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
    const route = await sql.getFirst<{
      start_latitude: number;
      start_longitude: number;
      start_radius_meters: number;
      finish_latitude: number;
      finish_longitude: number;
      finish_radius_meters: number;
      start_progress_m: number;
      finish_progress_m: number;
    }>('SELECT * FROM route WHERE id = ?', ['issue-3-route']);
    assert.equal(route?.start_latitude, points[0]!.latitude);
    assert.equal(route?.start_longitude, points[0]!.longitude);
    assert.equal(route?.start_radius_meters, 30);
    assert.equal(route?.finish_latitude, finishCenterLat);
    assert.equal(route?.finish_longitude, startLng);
    assert.equal(route?.finish_radius_meters, 30);
    assert.equal(route?.start_progress_m, 0);
    assert.ok(Math.abs((route?.finish_progress_m ?? 0) - pathDistanceMeters(points)) < 0.0001);
    const checkpoints = await sql.getAll('SELECT id FROM route_checkpoint WHERE route_id = ?', [
      'issue-3-route',
    ]);
    assert.equal(checkpoints.length, 0);
    const source = await sql.getFirst<{ id: string }>('SELECT id FROM tracking_session WHERE id = ?', [
      'issue-3-session',
    ]);
    assert.equal(source?.id, 'issue-3-session');
  });

  it('keeps existing 30 m start and finish radiuses when upgrading through later schema versions', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    await MIGRATIONS[0]!.up(sql, 1000);
    await sql.exec('PRAGMA user_version = 1');
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition
       ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved')`,
      ['keep-radius-session', 1000, 2000],
    );
    await sql.run(
      `INSERT INTO route (
         id, name, transportation_mode, created_at_ms, source_recording_id,
         start_latitude, start_longitude, start_radius_meters,
         finish_latitude, finish_longitude, finish_radius_meters
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'keep-radius-route',
        'Existing',
        'scooter',
        3000,
        'keep-radius-session',
        32.08,
        34.78,
        30,
        32.09,
        34.78,
        30,
      ],
    );

    await applyMigrations(sql, 4000);
    const route = await sql.getFirst<{
      start_radius_meters: number;
      finish_radius_meters: number;
    }>('SELECT start_radius_meters, finish_radius_meters FROM route WHERE id = ?', [
      'keep-radius-route',
    ]);
    assert.equal(route?.start_radius_meters, 30);
    assert.equal(route?.finish_radius_meters, 30);
    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
  });

  it('adds attempt tables when upgrading from schema v3 without wiping routes', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    await MIGRATIONS[0]!.up(sql, 1000);
    await MIGRATIONS[1]!.up(sql, 1000);
    await MIGRATIONS[2]!.up(sql, 1000);
    await sql.exec('PRAGMA user_version = 3');

    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
      ['v3-session', 1000, 2000],
    );
    await sql.run(
      `INSERT INTO route (
         id, name, transportation_mode, created_at_ms, source_recording_id,
         start_latitude, start_longitude, start_radius_meters,
         finish_latitude, finish_longitude, finish_radius_meters,
         start_progress_m, finish_progress_m
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['v3-route', 'Keep me', 'scooter', 3000, 'v3-session', 32.08, 34.78, 30, 32.09, 34.78, 30, 0, 100],
    );

    await applyMigrations(sql, 4000);
    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
    const route = await sql.getFirst<{ name: string; start_progress_m: number }>('SELECT name, start_progress_m FROM route WHERE id = ?', [
      'v3-route',
    ]);
    assert.equal(route?.name, 'Keep me');
    assert.equal(route?.start_progress_m, 0);
    const attemptTable = await sql.getFirst<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempt'`,
    );
    assert.equal(attemptTable?.name, 'attempt');
  });

  it('is idempotent when the current schema version is already applied', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1000);
    await applyMigrations(sql, 2000);
    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
  });
});
