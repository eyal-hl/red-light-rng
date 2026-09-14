import { pathDistanceMeters } from '../domain/geo';
import { seedPlacesFromRoutes } from '../domain/place-seeding';
import type { Route, TransportationMode } from '../domain/route';
import {
  ACTIVE_TRANSPORTATION_MODE_KEY,
  DEFAULT_ACTIVE_TRANSPORTATION_MODE,
  parseTransportationMode,
} from './settings-store';
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
          FOREIGN KEY (route_id) REFERENCES route(id) ON DELETE CASCADE,
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
  {
    version: 5,
    async up(sql, nowMs) {
      await sql.exec(`
        CREATE TABLE IF NOT EXISTS place (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          radius_meters REAL NOT NULL,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
      `);
      await sql.exec(`
        CREATE TABLE IF NOT EXISTS app_setting (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);

      const routeRows = await sql.getAll<{
        id: string;
        name: string;
        transportation_mode: string;
        created_at_ms: number;
        source_recording_id: string;
        start_latitude: number;
        start_longitude: number;
        start_radius_meters: number;
        finish_latitude: number;
        finish_longitude: number;
        finish_radius_meters: number;
        start_progress_m: number;
        finish_progress_m: number;
      }>('SELECT * FROM route ORDER BY created_at_ms ASC, id ASC');

      const routes: Route[] = routeRows.map((row) => ({
        id: row.id,
        name: row.name,
        transportationMode: parseTransportationMode(row.transportation_mode),
        createdAtMs: row.created_at_ms,
        sourceRecordingId: row.source_recording_id,
        referencePath: [],
        startZone: {
          center: { latitude: row.start_latitude, longitude: row.start_longitude },
          radiusMeters: row.start_radius_meters,
        },
        finishZone: {
          center: { latitude: row.finish_latitude, longitude: row.finish_longitude },
          radiusMeters: row.finish_radius_meters,
        },
        startProgressMeters: row.start_progress_m,
        finishProgressMeters: row.finish_progress_m,
        checkpoints: [],
        status: 'active',
        kind: 'explicit',
        clusterSignature: null,
        classificationVersion: 1,
      }));

      const seeded = seedPlacesFromRoutes(routes, { nowMs });
      for (const place of seeded.places) {
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
      const assignmentByRoute = new Map(
        seeded.assignments.map((item) => [item.routeId, item] as const),
      );
      const modeByRoute = new Map(routes.map((route) => [route.id, route.transportationMode]));

      const modeCounts = new Map<TransportationMode, number>();
      for (const route of routes) {
        modeCounts.set(route.transportationMode, (modeCounts.get(route.transportationMode) ?? 0) + 1);
      }
      let defaultMode = DEFAULT_ACTIVE_TRANSPORTATION_MODE;
      let bestCount = -1;
      for (const [mode, count] of [...modeCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (count > bestCount) {
          defaultMode = mode;
          bestCount = count;
        }
      }
      await sql.run(`INSERT INTO app_setting (key, value) VALUES (?, ?)`, [
        ACTIVE_TRANSPORTATION_MODE_KEY,
        defaultMode,
      ]);

      await sql.exec(`
        CREATE TABLE attempt_new (
          id TEXT PRIMARY KEY NOT NULL,
          route_id TEXT,
          origin_place_id TEXT,
          destination_place_id TEXT,
          transportation_mode TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          lifecycle TEXT NOT NULL,
          validity TEXT NOT NULL,
          armed_at_ms INTEGER NOT NULL,
          started_at_ms INTEGER,
          finished_at_ms INTEGER,
          result_acknowledged INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (route_id) REFERENCES route(id) ON DELETE SET NULL,
          FOREIGN KEY (origin_place_id) REFERENCES place(id) ON DELETE RESTRICT,
          FOREIGN KEY (destination_place_id) REFERENCES place(id) ON DELETE RESTRICT,
          FOREIGN KEY (session_id) REFERENCES tracking_session(id)
        );
      `);

      const oldAttempts = await sql.getAll<{
        id: string;
        route_id: string;
        session_id: string;
        lifecycle: string;
        validity: string;
        armed_at_ms: number;
        started_at_ms: number | null;
        finished_at_ms: number | null;
        result_acknowledged: number;
      }>('SELECT * FROM attempt');

      for (const row of oldAttempts) {
        const assignment = assignmentByRoute.get(row.route_id);
        const mode = modeByRoute.get(row.route_id) ?? DEFAULT_ACTIVE_TRANSPORTATION_MODE;
        const validity =
          row.lifecycle === 'completed' && row.validity === 'unranked' ? 'valid' : row.validity;
        await sql.run(
          `INSERT INTO attempt_new (
             id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
             lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.route_id,
            assignment?.startPlaceId ?? null,
            assignment?.finishPlaceId ?? null,
            mode,
            row.session_id,
            row.lifecycle,
            validity,
            row.armed_at_ms,
            row.started_at_ms,
            row.finished_at_ms,
            row.result_acknowledged,
          ],
        );
      }

      await sql.exec(`
        CREATE TABLE attempt_checkpoint_crossing_new (
          id TEXT PRIMARY KEY NOT NULL,
          attempt_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          checkpoint_name TEXT NOT NULL,
          checkpoint_progress_m REAL NOT NULL,
          crossed_at_ms INTEGER NOT NULL,
          FOREIGN KEY (attempt_id) REFERENCES attempt_new(id) ON DELETE CASCADE
        );
      `);
      const crossings = await sql.getAll<{
        id: string;
        attempt_id: string;
        checkpoint_id: string;
        checkpoint_name: string;
        checkpoint_progress_m: number;
        crossed_at_ms: number;
      }>('SELECT * FROM attempt_checkpoint_crossing');
      for (const row of crossings) {
        await sql.run(
          `INSERT INTO attempt_checkpoint_crossing_new (
             id, attempt_id, checkpoint_id, checkpoint_name, checkpoint_progress_m, crossed_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.attempt_id,
            row.checkpoint_id,
            row.checkpoint_name,
            row.checkpoint_progress_m,
            row.crossed_at_ms,
          ],
        );
      }

      await sql.exec('DROP TABLE attempt_checkpoint_crossing');
      await sql.exec('DROP TABLE attempt');
      await sql.exec('ALTER TABLE attempt_new RENAME TO attempt');
      await sql.exec('ALTER TABLE attempt_checkpoint_crossing_new RENAME TO attempt_checkpoint_crossing');
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attempt_route_armed
        ON attempt(route_id, armed_at_ms);
      `);
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attempt_open
        ON attempt(lifecycle);
      `);
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attempt_journey
        ON attempt(origin_place_id, destination_place_id, transportation_mode, armed_at_ms);
      `);
      await sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_attempt_crossing_attempt
        ON attempt_checkpoint_crossing(attempt_id, crossed_at_ms);
      `);
    },
  },
  {
    version: 6,
    async up(sql) {
      await sql.exec(`ALTER TABLE route ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
      await sql.exec(`ALTER TABLE route ADD COLUMN kind TEXT NOT NULL DEFAULT 'explicit'`);
      await sql.exec(`ALTER TABLE route ADD COLUMN cluster_signature TEXT`);
      await sql.exec(
        `ALTER TABLE route ADD COLUMN classification_version INTEGER NOT NULL DEFAULT 1`,
      );
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
