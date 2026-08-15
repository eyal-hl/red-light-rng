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
