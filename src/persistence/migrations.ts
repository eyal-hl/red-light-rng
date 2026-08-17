import { pathDistanceMeters } from '../domain/geo';
import { LOCATION_SPIKE_SCHEMA, CURRENT_SCHEMA_VERSION } from './schema';
import type { SqlExecutor } from './sql-executor';

export type Migration = {
  version: number;
  up: (sql: SqlExecutor, nowMs: number) => Promise<void>;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    async up(sql, nowMs) {
      await sql.exec(`ALTER TABLE tracking_session ADD COLUMN purpose TEXT NOT NULL DEFAULT 'legacy'`);
      await sql.exec(
        `ALTER TABLE tracking_session ADD COLUMN capture_outcome TEXT NOT NULL DEFAULT 'unknown'`,
      );
      await sql.exec(
        `ALTER TABLE tracking_session ADD COLUMN review_disposition TEXT NOT NULL DEFAULT 'discarded'`,
      );
      await sql.run(
        `UPDATE tracking_session
         SET is_active = 0,
             stopped_at_ms = COALESCE(stopped_at_ms, ?),
             purpose = 'legacy',
             capture_outcome = 'unknown',
             review_disposition = 'discarded'
         WHERE is_active = 1`,
        [nowMs],
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
    },
  },
  {
    version: 2,
    async up(sql) {
      await sql.exec(
        `ALTER TABLE tracking_session ADD COLUMN background_permission_confirmed INTEGER NOT NULL DEFAULT 0`,
      );
    },
  },
  {
    version: 3,
    async up(sql) {
      await sql.exec(`ALTER TABLE route ADD COLUMN start_progress_m REAL NOT NULL DEFAULT 0`);
      await sql.exec(`ALTER TABLE route ADD COLUMN finish_progress_m REAL NOT NULL DEFAULT 0`);
      await sql.exec(`
        CREATE TABLE IF NOT EXISTS route_checkpoint (
          id TEXT PRIMARY KEY NOT NULL,
          route_id TEXT NOT NULL,
          name TEXT NOT NULL,
          progress_m REAL NOT NULL,
          FOREIGN KEY (route_id) REFERENCES route(id) ON DELETE CASCADE
        );
      `);
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_route_checkpoint_route_progress
        ON route_checkpoint(route_id, progress_m);
      `);

      const routes = await sql.getAll<{ id: string }>('SELECT id FROM route');
      for (const route of routes) {
        const points = await sql.getAll<{ latitude: number; longitude: number }>(
          'SELECT latitude, longitude FROM route_reference_point WHERE route_id = ? ORDER BY seq ASC',
          [route.id],
        );
        const finishProgressMeters = pathDistanceMeters(points);
        await sql.run('UPDATE route SET start_progress_m = 0, finish_progress_m = ? WHERE id = ?', [
          finishProgressMeters,
          route.id,
        ]);
      }
    },
  },
  {
    version: 4,
    async up(sql) {
      await sql.exec(`
        CREATE TABLE IF NOT EXISTS attempt (
          id TEXT PRIMARY KEY NOT NULL,
          route_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          lifecycle TEXT NOT NULL,
          validity TEXT NOT NULL,
          armed_at_ms INTEGER NOT NULL,
          started_at_ms INTEGER,
          finished_at_ms INTEGER,
          result_acknowledged INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (route_id) REFERENCES route(id),
          FOREIGN KEY (session_id) REFERENCES tracking_session(id)
        );
      `);
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attempt_route_armed
        ON attempt(route_id, armed_at_ms);
      `);
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attempt_open
        ON attempt(lifecycle);
      `);
      await sql.exec(`
        CREATE TABLE IF NOT EXISTS attempt_checkpoint_crossing (
          id TEXT PRIMARY KEY NOT NULL,
          attempt_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          checkpoint_name TEXT NOT NULL,
          checkpoint_progress_m REAL NOT NULL,
          crossed_at_ms INTEGER NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES attempt(id) ON DELETE CASCADE
        );
      `);
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attempt_crossing_attempt
        ON attempt_checkpoint_crossing(attempt_id, crossed_at_ms);
      `);
    },
  },
];

async function tableExists(sql: SqlExecutor, name: string): Promise<boolean> {
  const row = await sql.getFirst<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return row != null;
}

async function readUserVersion(sql: SqlExecutor): Promise<number> {
  const row = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

export async function applyMigrations(sql: SqlExecutor, nowMs: number = Date.now()): Promise<void> {
  await sql.exec('PRAGMA foreign_keys = ON;');

  if (!(await tableExists(sql, 'tracking_session'))) {
    await sql.exec(LOCATION_SPIKE_SCHEMA);
  }

  let version = await readUserVersion(sql);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) {
      continue;
    }
    await sql.withTransaction(async () => {
      await migration.up(sql, nowMs);
      await sql.exec(`PRAGMA user_version = ${migration.version}`);
    });
    version = migration.version;
  }

  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Expected schema version ${CURRENT_SCHEMA_VERSION}, found ${version}`);
  }
}
