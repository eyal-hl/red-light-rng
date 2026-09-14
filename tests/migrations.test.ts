import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { utcOffsetMinutesAt } from '../src/domain/attempt-local-time';
import { pathDistanceMeters } from '../src/domain/geo';
import { listJourneyPools } from '../src/domain/journey-analysis';
import type { Place } from '../src/domain/place';
import { applyMigrations, MIGRATIONS } from '../src/persistence/migrations';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqlitePlaceStore } from '../src/persistence/sqlite-place-store';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import { CURRENT_SCHEMA_VERSION, LOCATION_SPIKE_SCHEMA } from '../src/persistence/schema';
import type { SqlExecutor } from '../src/persistence/sql-executor';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { makeRoute } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';
import { createSqliteWorkspace } from './helpers/workspace';

function withTimeZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

async function withTimeZoneAsync<T>(tz: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

describe('SQLite migrations', { concurrency: 1 }, () => {
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

  it('migrates v4 attempts onto seeded places without wiping telemetry, mode, or route ids', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    await MIGRATIONS[0]!.up(sql, 1000);
    await MIGRATIONS[1]!.up(sql, 1000);
    await MIGRATIONS[2]!.up(sql, 1000);
    await MIGRATIONS[3]!.up(sql, 1000);
    await sql.exec('PRAGMA user_version = 4');

    const home = { latitude: 32.08, longitude: 34.78 };
    const work = { latitude: 32.08 + 300 / 111_320, longitude: 34.78 };
    const cafe = { latitude: 32.08 + 15 / 111_320, longitude: 34.78 };

    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
      ['src-hw', 1000, 2000],
    );
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
      ['src-wh', 1100, 2100],
    );
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
      ['src-cafe', 1200, 2200],
    );
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'attempt', 'finished', 'saved', 0)`,
      ['att-hw', 3000, 4000],
    );
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'attempt', 'finished', 'saved', 0)`,
      ['att-wh', 5000, 6000],
    );
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'attempt', 'finished', 'saved', 0)`,
      ['att-dev', 7000, 8000],
    );
    await sql.run(
      `INSERT INTO location_sample (
         id, session_id, recorded_at_ms, latitude, longitude,
         horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['p-hw', 'att-hw', 3100, home.latitude, home.longitude, 5, 4, 0],
    );

    await sql.run(
      `INSERT INTO route (
         id, name, transportation_mode, created_at_ms, source_recording_id,
         start_latitude, start_longitude, start_radius_meters,
         finish_latitude, finish_longitude, finish_radius_meters,
         start_progress_m, finish_progress_m
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['route-hw', 'Home → Work', 'scooter', 2000, 'src-hw', home.latitude, home.longitude, 30, work.latitude, work.longitude, 30, 0, 300],
    );
    await sql.run(
      `INSERT INTO route (
         id, name, transportation_mode, created_at_ms, source_recording_id,
         start_latitude, start_longitude, start_radius_meters,
         finish_latitude, finish_longitude, finish_radius_meters,
         start_progress_m, finish_progress_m
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['route-wh', 'Work → Home', 'walk', 2100, 'src-wh', work.latitude, work.longitude, 30, home.latitude, home.longitude, 30, 0, 300],
    );
    await sql.run(
      `INSERT INTO route (
         id, name, transportation_mode, created_at_ms, source_recording_id,
         start_latitude, start_longitude, start_radius_meters,
         finish_latitude, finish_longitude, finish_radius_meters,
         start_progress_m, finish_progress_m
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['route-cafe', 'Cafe → Work', 'scooter', 2200, 'src-cafe', cafe.latitude, cafe.longitude, 30, work.latitude, work.longitude, 30, 0, 280],
    );

    await sql.run(
      `INSERT INTO attempt (
         id, route_id, session_id, lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
       ) VALUES (?, ?, ?, 'completed', 'valid', ?, ?, ?, 1)`,
      ['attempt-hw', 'route-hw', 'att-hw', 3000, 3100, 4000],
    );
    await sql.run(
      `INSERT INTO attempt (
         id, route_id, session_id, lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
       ) VALUES (?, ?, ?, 'completed', 'valid', ?, ?, ?, 1)`,
      ['attempt-wh', 'route-wh', 'att-wh', 5000, 5100, 6000],
    );

    await sql.run(
      `INSERT INTO attempt (
         id, route_id, session_id, lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
       ) VALUES (?, ?, ?, 'completed', 'unranked', ?, ?, ?, 1)`,
      ['attempt-dev', 'route-hw', 'att-dev', 7000, 7100, 8000],
    );

    await applyMigrations(sql, 9_000);

    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);

    const places = await sql.getAll<{ id: string; name: string }>('SELECT id, name FROM place ORDER BY name ASC');
    assert.ok(places.length >= 3);
    const cafePlace = places.find((place) => place.name === 'Cafe');
    const homePlace = places.find((place) => place.name === 'Home');
    assert.ok(cafePlace);
    assert.ok(homePlace);
    assert.notEqual(cafePlace.id, homePlace.id);

    const hw = await sql.getFirst<{
      route_id: string | null;
      origin_place_id: string;
      destination_place_id: string;
      transportation_mode: string;
      started_at_ms: number;
      finished_at_ms: number;
      validity: string;
    }>('SELECT * FROM attempt WHERE id = ?', ['attempt-hw']);
    const wh = await sql.getFirst<{
      origin_place_id: string;
      destination_place_id: string;
      transportation_mode: string;
    }>('SELECT * FROM attempt WHERE id = ?', ['attempt-wh']);
    assert.equal(hw?.route_id, 'route-hw');
    assert.equal(hw?.transportation_mode, 'scooter');
    assert.equal(hw?.started_at_ms, 3100);
    assert.equal(hw?.finished_at_ms, 4000);
    assert.equal(wh?.transportation_mode, 'walk');
    assert.notEqual(hw?.origin_place_id, wh?.origin_place_id);
    assert.equal(hw?.origin_place_id, wh?.destination_place_id);
    assert.equal(hw?.destination_place_id, wh?.origin_place_id);
    const diverted = await sql.getFirst<{ validity: string; origin_place_id: string }>(
      'SELECT validity, origin_place_id FROM attempt WHERE id = ?',
      ['attempt-dev'],
    );
    assert.equal(diverted?.validity, 'valid');
    assert.equal(diverted?.origin_place_id, hw?.origin_place_id);

    const sample = await sql.getFirst<{ id: string }>('SELECT id FROM location_sample WHERE id = ?', ['p-hw']);
    assert.equal(sample?.id, 'p-hw');
    const remaining = await sql.getAll<{ id: string }>('SELECT id FROM attempt ORDER BY id');
    assert.deepEqual(remaining.map((row) => row.id), ['attempt-dev', 'attempt-hw', 'attempt-wh']);

    const mode = await sql.getFirst<{ value: string }>(
      `SELECT value FROM app_setting WHERE key = 'active_transportation_mode'`,
    );
    assert.equal(mode?.value, 'scooter');
  });

  it('adds path-variant archive and discovery columns when upgrading from schema v5', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    const nowMs = 1_000;
    for (const migration of MIGRATIONS.filter((item) => item.version <= 5)) {
      await migration.up(sql, nowMs);
      await sql.exec(`PRAGMA user_version = ${migration.version}`);
    }
    const before = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(before?.user_version, 5);

    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
      ['src-main', 1000, 2000],
    );
    await sql.run(
      `INSERT INTO route (
         id, name, transportation_mode, created_at_ms, source_recording_id,
         start_latitude, start_longitude, start_radius_meters,
         finish_latitude, finish_longitude, finish_radius_meters,
         start_progress_m, finish_progress_m
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['route-main', 'Main road', 'scooter', 2000, 'src-main', 32.08, 34.78, 30, 32.09, 34.78, 30, 0, 300],
    );

    await applyMigrations(sql, 9_000);

    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
    const row = await sql.getFirst<{
      status: string;
      kind: string;
      cluster_signature: string | null;
      classification_version: number;
      name: string;
    }>('SELECT status, kind, cluster_signature, classification_version, name FROM route WHERE id = ?', [
      'route-main',
    ]);
    assert.equal(row?.name, 'Main road');
    assert.equal(row?.status, 'active');
    assert.equal(row?.kind, 'explicit');
    assert.equal(row?.cluster_signature, null);
    assert.equal(row?.classification_version, 1);
  });

  it('persists reconstructed start-time offsets for historical attempts and does not reclassify later', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    const nowMs = 1_000;
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
      await migration.up(sql, nowMs);
      await sql.exec(`PRAGMA user_version = ${migration.version}`);
    }
    const before = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(before?.user_version, 6);

    const startedAtMs = Date.parse('2026-09-14T05:05:00.000Z');
    await sql.run(
      `INSERT INTO tracking_session (
         id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
         background_permission_confirmed
       ) VALUES (?, ?, ?, 0, 'attempt', 'finished', 'saved', 0)`,
      ['att-tod', 3000, 4000],
    );
    await sql.run(
      `INSERT INTO attempt (
         id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
         lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
       ) VALUES (?, NULL, NULL, NULL, 'scooter', ?, 'completed', 'valid', ?, ?, ?, 1)`,
      ['attempt-tod', 'att-tod', startedAtMs - 60_000, startedAtMs, startedAtMs + 12 * 60_000],
    );

    const expectedOffset = withTimeZone('Asia/Jerusalem', () => utcOffsetMinutesAt(startedAtMs));
    await withTimeZoneAsync('Asia/Jerusalem', async () => {
      await applyMigrations(sql, 9_000);
    });

    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
    const migrated = await sql.getFirst<{
      started_utc_offset_minutes: number | null;
      started_timezone_id: string | null;
      started_local_time_source: string | null;
      started_at_ms: number;
    }>('SELECT started_utc_offset_minutes, started_timezone_id, started_local_time_source, started_at_ms FROM attempt WHERE id = ?', [
      'attempt-tod',
    ]);
    assert.equal(migrated?.started_at_ms, startedAtMs);
    assert.equal(migrated?.started_utc_offset_minutes, expectedOffset);
    assert.equal(migrated?.started_local_time_source, 'reconstructed');
    assert.equal(migrated?.started_timezone_id, 'Asia/Jerusalem');

    await withTimeZoneAsync('America/New_York', async () => {
      await applyMigrations(sql, 10_000);
    });
    const later = await sql.getFirst<{
      started_utc_offset_minutes: number | null;
      started_local_time_source: string | null;
    }>('SELECT started_utc_offset_minutes, started_local_time_source FROM attempt WHERE id = ?', [
      'attempt-tod',
    ]);
    assert.equal(later?.started_utc_offset_minutes, expectedOffset);
    assert.equal(later?.started_local_time_source, 'reconstructed');
  });

  it('repairs v5 duplicate Places, rewrites attempt endpoints, and collapses journey pools', async () => {
    const sql = createMemorySqlExecutor();
    await migrateThrough(sql, 5, 9_000);
    await seedReportedDuplicatePlaceInstall(sql);
    await applyMigrations(sql, 20_000);
    await assertReportedDuplicatePlaceInstallRepaired(sql);
  });

  it('repairs duplicate Places on databases already at current-main schema v6 or v7', async () => {
    for (const startingVersion of [6, 7] as const) {
      const sql = createMemorySqlExecutor();
      await migrateThrough(sql, startingVersion, 9_000);
      const homeCenter = { latitude: 32.08, longitude: 34.78 };
      const nearbyHome = offsetLatLng(32.08, 34.78, 12, 0);
      await insertPlace(sql, placeRow('home-a', 'Home', homeCenter, 17, 'active', 100));
      await insertPlace(sql, placeRow('home-b', 'Home', nearbyHome, 30, 'archived', 200));
      await insertSession(sql, 'sess-split', 1_000);
      await sql.run(
        `INSERT INTO attempt (
           id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
           lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
         ) VALUES (?, NULL, ?, NULL, 'scooter', ?, 'active', 'pending', ?, ?, NULL, 0)`,
        ['open-split', 'home-b', 'sess-split', 1_500, 2_000],
      );

      await applyMigrations(sql, 20_000);

      const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
      assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION, `from schema v${startingVersion}`);
      const places = await sql.getAll<{ id: string }>('SELECT id FROM place ORDER BY id');
      assert.deepEqual(
        places.map((place) => place.id),
        ['home-a'],
        `from schema v${startingVersion}`,
      );
      const open = await sql.getFirst<{ origin_place_id: string }>(
        'SELECT origin_place_id FROM attempt WHERE id = ?',
        ['open-split'],
      );
      assert.equal(open?.origin_place_id, 'home-a', `from schema v${startingVersion}`);
    }
  });

  it('heals old PR #50 preview v6 databases that claimed version 6 without route classification columns', async () => {
    const sql = createMemorySqlExecutor();
    await seedOldPr50PreviewV6(sql, 9_000);
    const before = await tableColumnNames(sql, 'route');
    assert.equal(before.has('status'), false);
    assert.equal(before.has('kind'), false);
    const versionBefore = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(versionBefore?.user_version, 6);

    await applyMigrations(sql, 20_000);
    await assertCanonicalRouteColumnsPresent(sql);
    await assertReportedDuplicatePlaceInstallRepaired(sql);
    await assertHealedPreviewCanBootstrap(sql);
  });

  it('heals a broken rebased preview already advanced to user_version 8 without route classification columns', async () => {
    const sql = createMemorySqlExecutor();
    await seedBrokenRebasedPreviewV8(sql, 9_000);
    const before = await tableColumnNames(sql, 'route');
    assert.equal(before.has('status'), false);
    const versionBefore = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(versionBefore?.user_version, 8);

    await applyMigrations(sql, 20_000);
    await assertCanonicalRouteColumnsPresent(sql);
    await assertReportedDuplicatePlaceInstallRepaired(sql);
    await assertHealedPreviewCanBootstrap(sql);
  });

  it('treats canonical main v6/v7/v8 installs as a no-op for already-present route columns', async () => {
    for (const startingVersion of [6, 7, 8] as const) {
      const sql = createMemorySqlExecutor();
      await migrateThrough(sql, startingVersion, 9_000);
      const before = await tableColumnNames(sql, 'route');
      assert.equal(before.has('status'), true, `from schema v${startingVersion}`);
      assert.equal(before.has('classification_version'), true, `from schema v${startingVersion}`);

      await applyMigrations(sql, 20_000);

      const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
      assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION, `from schema v${startingVersion}`);
      await assertCanonicalRouteColumnsPresent(sql);
    }
  });
});

async function tableColumnNames(sql: SqlExecutor, table: string): Promise<Set<string>> {
  const rows = await sql.getAll<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row) => row.name));
}

async function seedOldPr50PreviewV6(sql: SqlExecutor, nowMs: number): Promise<void> {
  await migrateThrough(sql, 5, nowMs);
  await seedReportedDuplicatePlaceInstall(sql);
  await sql.exec('PRAGMA user_version = 6');
}

async function seedBrokenRebasedPreviewV8(sql: SqlExecutor, nowMs: number): Promise<void> {
  await seedOldPr50PreviewV6(sql, nowMs);
  for (const migration of MIGRATIONS.filter((item) => item.version === 7 || item.version === 8)) {
    await migration.up(sql, nowMs);
  }
  await sql.exec('PRAGMA user_version = 8');
}

async function assertCanonicalRouteColumnsPresent(sql: SqlExecutor): Promise<void> {
  const columns = await tableColumnNames(sql, 'route');
  for (const name of ['status', 'kind', 'cluster_signature', 'classification_version']) {
    assert.ok(columns.has(name), `missing route.${name}`);
  }
  await sql.getFirst<{
    status: string;
    kind: string;
    cluster_signature: string | null;
    classification_version: number;
  }>('SELECT status, kind, cluster_signature, classification_version FROM route LIMIT 1');
}

async function assertHealedPreviewCanBootstrap(sql: SqlExecutor): Promise<void> {
  await insertSession(sql, 'sess-heal-route', 80_000);
  const routeStore = new SqliteRouteStore(async () => sql);
  await routeStore.createRoute(
    makeRoute({
      id: 'route-healed',
      sourceRecordingId: 'sess-heal-route',
    }),
  );
  const saved = await routeStore.getRoute('route-healed');
  assert.equal(saved?.status, 'active');
  assert.equal(saved?.kind, 'explicit');
  assert.equal(saved?.classificationVersion, 1);

  const { workspace } = createSqliteWorkspace(sql);
  const home = await workspace.bootstrap();
  assert.ok(home.places.some((place) => place.id === 'home-17'));
  assert.ok(
    home.journeys.some(
      (journey) =>
        journey.originPlaceId === 'home-17' &&
        journey.destinationPlaceId === 'work-30' &&
        journey.transportationMode === 'scooter',
    ),
  );
}

async function migrateThrough(sql: SqlExecutor, version: number, nowMs: number): Promise<void> {
  await sql.exec('PRAGMA foreign_keys = ON;');
  await sql.exec(LOCATION_SPIKE_SCHEMA);
  await sql.exec('PRAGMA user_version = 0');
  for (const migration of MIGRATIONS) {
    if (migration.version > version) {
      break;
    }
    await migration.up(sql, nowMs);
  }
  await sql.exec(`PRAGMA user_version = ${version}`);
}

function placeRow(
  id: string,
  name: string,
  center: { latitude: number; longitude: number },
  radiusMeters: number,
  status: Place['status'],
  createdAtMs: number,
): Place {
  return {
    id,
    name,
    center,
    radiusMeters,
    status,
    createdAtMs,
  };
}

async function insertPlace(sql: SqlExecutor, place: Place): Promise<void> {
  await sql.run(
    `INSERT INTO place (id, name, latitude, longitude, radius_meters, status, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      place.id,
      place.name,
      place.center.latitude,
      place.center.longitude,
      place.radiusMeters,
      place.status,
      place.createdAtMs,
    ],
  );
}

async function insertSession(sql: SqlExecutor, id: string, startedAtMs: number): Promise<void> {
  await sql.run(
    `INSERT INTO tracking_session (
       id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
       background_permission_confirmed
     ) VALUES (?, ?, ?, 0, 'attempt', 'finished', 'saved', 0)`,
    [id, startedAtMs, startedAtMs + 1_000],
  );
}

type RepairAttemptSpec = {
  id: string;
  sessionId: string;
  originId: string;
  destinationId: string | null;
  mode: string;
  lifecycle: string;
  validity: string;
  startedAtMs: number | null;
  finishedAtMs: number | null;
};

async function seedReportedDuplicatePlaceInstall(sql: SqlExecutor): Promise<void> {
  const homeCenter = { latitude: 32.08, longitude: 34.78 };
  const workCenter = offsetLatLng(32.08, 34.78, 300, 0);
  const workOffset = offsetLatLng(32.08, 34.78, 312, 0);
  const gymCenter = offsetLatLng(32.08, 34.78, 800, 0);
  const distinctHome3 = offsetLatLng(32.08, 34.78, 80, 0);

  const homeActive = placeRow('home-17', 'Home', homeCenter, 17, 'active', 300);
  const home10 = placeRow('home-10', 'Home', homeCenter, 10, 'archived', 100);
  const home3 = placeRow('home-3', 'Home 3', homeCenter, 30, 'archived', 200);
  const workActive = placeRow('work-30', 'Work', workCenter, 30, 'active', 400);
  const work10 = placeRow('work-10', 'Work', workCenter, 10, 'archived', 110);
  const work30b = placeRow('work-30-b', 'Work', workOffset, 30, 'archived', 210);
  const gym = placeRow('gym-archived', 'Gym', gymCenter, 25, 'archived', 500);
  const farHome3 = placeRow('home-3-far', 'Home 3', distinctHome3, 30, 'active', 600);

  for (const place of [homeActive, home10, home3, workActive, work10, work30b, gym, farHome3]) {
    await insertPlace(sql, place);
  }

  await insertSession(sql, 'sess-open', 1_000);
  await insertSession(sql, 'sess-sample', 2_000);
  const attemptSpecs: RepairAttemptSpec[] = [];

  let sessionSeq = 0;
  const addCompleted = async (
    id: string,
    originId: string,
    destinationId: string,
    officialMs: number,
    mode = 'scooter',
  ) => {
    sessionSeq += 1;
    const sessionId = `sess-${sessionSeq}`;
    await insertSession(sql, sessionId, 10_000 + sessionSeq);
    attemptSpecs.push({
      id,
      sessionId,
      originId,
      destinationId,
      mode,
      lifecycle: 'completed',
      validity: 'valid',
      startedAtMs: 20_000,
      finishedAtMs: 20_000 + officialMs,
    });
  };

  for (let index = 0; index < 6; index += 1) {
    await addCompleted(`hw-legacy-${index}`, 'home-10', 'work-10', 388_000 + index * 1_000);
  }
  for (let index = 0; index < 9; index += 1) {
    await addCompleted(`hw-active-${index}`, 'home-17', 'work-30', 416_000 + index * 1_000);
  }
  await addCompleted('hw-home3', 'home-3', 'work-30-b', 455_000);
  for (let index = 0; index < 7; index += 1) {
    await addCompleted(`wh-legacy-${index}`, 'work-10', 'home-10', 495_000 + index * 1_000);
  }
  await addCompleted('wh-home3-a', 'work-30-b', 'home-3', 466_000);
  await addCompleted('wh-home3-b', 'work-30', 'home-3', 470_000);
  await addCompleted('hw-walk', 'home-10', 'work-10', 900_000, 'walk');

  attemptSpecs.push({
    id: 'in-flight',
    sessionId: 'sess-open',
    originId: 'home-10',
    destinationId: null,
    mode: 'scooter',
    lifecycle: 'active',
    validity: 'pending',
    startedAtMs: 30_000,
    finishedAtMs: null,
  });

  await sql.run(
    `INSERT INTO route (
       id, name, transportation_mode, created_at_ms, source_recording_id,
       start_latitude, start_longitude, start_radius_meters,
       finish_latitude, finish_longitude, finish_radius_meters,
       start_progress_m, finish_progress_m
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'route-hw',
      'Home → Work',
      'scooter',
      2_000,
      'sess-sample',
      homeCenter.latitude,
      homeCenter.longitude,
      30,
      workCenter.latitude,
      workCenter.longitude,
      30,
      0,
      300,
    ],
  );

  for (const spec of attemptSpecs) {
    await sql.run(
      `INSERT INTO attempt (
         id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
         lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        spec.id,
        spec.id === 'hw-legacy-0' ? 'route-hw' : null,
        spec.originId,
        spec.destinationId,
        spec.mode,
        spec.sessionId,
        spec.lifecycle,
        spec.validity,
        15_000,
        spec.startedAtMs,
        spec.finishedAtMs,
      ],
    );
  }

  await sql.run(
    `INSERT INTO location_sample (
       id, session_id, recorded_at_ms, latitude, longitude,
       horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['p-open', 'sess-open', 31_000, homeCenter.latitude, homeCenter.longitude, 5, 1, 0],
  );
}

async function assertReportedDuplicatePlaceInstallRepaired(sql: SqlExecutor): Promise<void> {
  const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
  assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);

  const places = await sql.getAll<{ id: string; name: string; radius_meters: number; status: string }>(
    'SELECT id, name, radius_meters, status FROM place ORDER BY id',
  );
  assert.deepEqual(
    places.map((place) => place.id).sort(),
    ['gym-archived', 'home-17', 'home-3-far', 'work-30'],
  );
  const canonicalHome = places.find((place) => place.id === 'home-17');
  const canonicalWork = places.find((place) => place.id === 'work-30');
  assert.equal(canonicalHome?.name, 'Home');
  assert.equal(canonicalHome?.radius_meters, 17);
  assert.equal(canonicalHome?.status, 'active');
  assert.equal(canonicalWork?.name, 'Work');
  assert.equal(canonicalWork?.radius_meters, 30);
  assert.equal(canonicalWork?.status, 'active');

  const attempts = await sql.getAll<{
    id: string;
    origin_place_id: string | null;
    destination_place_id: string | null;
    transportation_mode: string;
    lifecycle: string;
    validity: string;
    started_at_ms: number | null;
    finished_at_ms: number | null;
    route_id: string | null;
  }>('SELECT * FROM attempt ORDER BY id');
  assert.equal(attempts.length, 6 + 9 + 1 + 7 + 2 + 1 + 1);

  for (const attempt of attempts) {
    if (attempt.origin_place_id) {
      assert.ok(['home-17', 'work-30', 'home-3-far', 'gym-archived'].includes(attempt.origin_place_id));
    }
    if (attempt.destination_place_id) {
      assert.ok(['home-17', 'work-30', 'home-3-far', 'gym-archived'].includes(attempt.destination_place_id));
    }
  }

  const inFlight = attempts.find((attempt) => attempt.id === 'in-flight');
  assert.equal(inFlight?.origin_place_id, 'home-17');
  assert.equal(inFlight?.destination_place_id, null);
  assert.equal(inFlight?.lifecycle, 'active');
  assert.equal(inFlight?.validity, 'pending');

  const rewritten = attempts.find((attempt) => attempt.id === 'hw-legacy-0');
  assert.equal(rewritten?.origin_place_id, 'home-17');
  assert.equal(rewritten?.destination_place_id, 'work-30');
  assert.equal(rewritten?.route_id, 'route-hw');
  assert.equal(rewritten?.transportation_mode, 'scooter');
  assert.equal(rewritten?.started_at_ms, 20_000);
  assert.equal(rewritten?.finished_at_ms, 20_000 + 388_000);

  const sample = await sql.getFirst<{ id: string }>('SELECT id FROM location_sample WHERE id = ?', ['p-open']);
  assert.equal(sample?.id, 'p-open');

  const placeStore = new SqlitePlaceStore(async () => sql);
  const attemptStore = new SqliteAttemptStore(async () => sql);
  const storedPlaces = await placeStore.listPlaces();
  const storedAttempts = await attemptStore.listAttempts();
  const pools = listJourneyPools(
    storedAttempts.map((attempt) => ({ attempt, samples: [] })),
    new Map(storedPlaces.map((place) => [place.id, place])),
  );
  const scooterHw = pools.find(
    (pool) =>
      pool.originPlaceId === 'home-17' &&
      pool.destinationPlaceId === 'work-30' &&
      pool.transportationMode === 'scooter',
  );
  const scooterWh = pools.find(
    (pool) =>
      pool.originPlaceId === 'work-30' &&
      pool.destinationPlaceId === 'home-17' &&
      pool.transportationMode === 'scooter',
  );
  const walkHw = pools.find((pool) => pool.transportationMode === 'walk');
  assert.equal(scooterHw?.rankedAttemptCount, 16);
  assert.equal(scooterHw?.pbTimeMs, 388_000);
  assert.equal(scooterHw?.title, 'Home → Work');
  assert.equal(scooterWh?.rankedAttemptCount, 9);
  assert.equal(scooterWh?.title, 'Work → Home');
  assert.equal(walkHw?.rankedAttemptCount, 1);
  assert.equal(
    pools.filter((pool) => pool.transportationMode === 'scooter' && pool.title === 'Home → Work').length,
    1,
  );
  assert.equal(
    pools.filter((pool) => pool.transportationMode === 'scooter' && pool.title === 'Work → Home').length,
    1,
  );

  const snapshot = places.map((place) => ({ ...place }));
  await applyMigrations(sql, 30_000);
  const afterRestart = await sql.getAll<{ id: string }>('SELECT id FROM place ORDER BY id');
  assert.deepEqual(
    afterRestart.map((place) => place.id),
    snapshot.map((place) => place.id),
  );
  const attemptCount = await sql.getFirst<{ count: number }>('SELECT COUNT(*) AS count FROM attempt');
  assert.equal(attemptCount?.count, storedAttempts.length);
}
