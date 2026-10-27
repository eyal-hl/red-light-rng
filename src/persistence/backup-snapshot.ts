import {
  BACKUP_SETTING_KEYS,
  serializeBackup,
  type BackupAttempt,
  type BackupAttemptCrossing,
  type BackupLocationSample,
  type BackupPayload,
  type BackupPlace,
  type BackupRoute,
  type BackupSettings,
  type BackupTrackingSession,
} from './backup-format';
import { CURRENT_SCHEMA_VERSION } from './schema';
import { runIsolated, type SqlExecutor } from './sql-executor';

/**
 * Every column of every durable table, and what the backup does with it. A test compares this map to
 * the real migrated schema, so a future column cannot silently drop out of backups: it must be
 * exported here or explicitly excluded with a reason.
 */
export const BACKUP_SCHEMA_COVERAGE: Record<string, Record<string, string>> = {
  place: {
    id: 'places[].id',
    name: 'places[].name',
    latitude: 'places[].latitude',
    longitude: 'places[].longitude',
    radius_meters: 'places[].radius_meters',
    status: 'places[].status',
    created_at_ms: 'places[].created_at_ms',
  },
  tracking_session: {
    id: 'tracking_sessions[].id',
    started_at_ms: 'tracking_sessions[].started_at_ms',
    stopped_at_ms: 'tracking_sessions[].stopped_at_ms',
    is_active: 'tracking_sessions[].is_active',
    purpose: 'tracking_sessions[].purpose',
    capture_outcome: 'tracking_sessions[].capture_outcome',
    review_disposition: 'tracking_sessions[].review_disposition',
    background_permission_confirmed: 'tracking_sessions[].background_permission_confirmed',
  },
  location_sample: {
    id: 'location_samples[].id',
    session_id: 'location_samples[].session_id',
    recorded_at_ms: 'location_samples[].recorded_at_ms',
    latitude: 'location_samples[].latitude',
    longitude: 'location_samples[].longitude',
    horizontal_accuracy_meters: 'location_samples[].horizontal_accuracy_meters',
    speed_meters_per_second: 'location_samples[].speed_meters_per_second',
    heading_degrees: 'location_samples[].heading_degrees',
  },
  route: {
    id: 'routes[].id',
    name: 'routes[].name',
    transportation_mode: 'routes[].transportation_mode',
    created_at_ms: 'routes[].created_at_ms',
    source_recording_id: 'routes[].source_recording_id',
    start_latitude: 'routes[].start_latitude',
    start_longitude: 'routes[].start_longitude',
    start_radius_meters: 'routes[].start_radius_meters',
    finish_latitude: 'routes[].finish_latitude',
    finish_longitude: 'routes[].finish_longitude',
    finish_radius_meters: 'routes[].finish_radius_meters',
    start_progress_m: 'routes[].start_progress_m',
    finish_progress_m: 'routes[].finish_progress_m',
    status: 'routes[].status',
    kind: 'routes[].kind',
    cluster_signature: 'routes[].cluster_signature',
    classification_version: 'routes[].classification_version',
  },
  route_reference_point: {
    route_id: 'implicit: nested under routes[]',
    seq: 'implicit: routes[].reference_path array order',
    latitude: 'routes[].reference_path[].latitude',
    longitude: 'routes[].reference_path[].longitude',
  },
  route_checkpoint: {
    id: 'routes[].checkpoints[].id',
    route_id: 'implicit: nested under routes[]',
    name: 'routes[].checkpoints[].name',
    progress_m: 'routes[].checkpoints[].progress_m',
  },
  attempt: {
    id: 'attempts[].id',
    route_id: 'attempts[].route_id',
    origin_place_id: 'attempts[].origin_place_id',
    destination_place_id: 'attempts[].destination_place_id',
    transportation_mode: 'attempts[].transportation_mode',
    session_id: 'attempts[].session_id',
    lifecycle: 'attempts[].lifecycle',
    validity: 'attempts[].validity',
    armed_at_ms: 'attempts[].armed_at_ms',
    started_at_ms: 'attempts[].started_at_ms',
    finished_at_ms: 'attempts[].finished_at_ms',
    started_utc_offset_minutes: 'attempts[].started_utc_offset_minutes',
    started_timezone_id: 'attempts[].started_timezone_id',
    started_local_time_source: 'attempts[].started_local_time_source',
    result_acknowledged: 'attempts[].result_acknowledged',
    hidden_incomplete: 'attempts[].hidden_incomplete',
    reconciliation_status: 'attempts[].reconciliation_status',
    reconciliation_version: 'attempts[].reconciliation_version',
  },
  attempt_checkpoint_crossing: {
    id: 'attempts[].crossings[].id',
    attempt_id: 'implicit: nested under attempts[]',
    checkpoint_id: 'attempts[].crossings[].checkpoint_id',
    checkpoint_name: 'attempts[].crossings[].checkpoint_name',
    checkpoint_progress_m: 'attempts[].crossings[].checkpoint_progress_m',
    crossed_at_ms: 'attempts[].crossings[].crossed_at_ms',
  },
  app_setting: {
    key: `settings: only keys ${BACKUP_SETTING_KEYS.join(', ')}`,
    value: `settings: only keys ${BACKUP_SETTING_KEYS.join(', ')}`,
  },
};

/** app_setting keys that are deliberately not exported, with the reason. */
export const BACKUP_EXCLUDED_SETTING_KEYS: Record<string, string> = {
  path_variant_recompute_fingerprint:
    'Recomputable cache key for path-variant discovery. Restore clears it so discovery recomputes.',
};

type Row = Record<string, string | number | null>;

async function readPayload(sql: SqlExecutor): Promise<BackupPayload> {
  const places = await sql.getAll<BackupPlace>(
    `SELECT id, name, latitude, longitude, radius_meters, status, created_at_ms
     FROM place ORDER BY id`,
  );
  const sessions = await sql.getAll<BackupTrackingSession>(
    `SELECT id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome,
            review_disposition, background_permission_confirmed
     FROM tracking_session ORDER BY id`,
  );
  const samples = await sql.getAll<BackupLocationSample>(
    `SELECT id, session_id, recorded_at_ms, latitude, longitude,
            horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
     FROM location_sample ORDER BY session_id, recorded_at_ms, id`,
  );
  const routeRows = await sql.getAll<Row>(
    `SELECT id, name, transportation_mode, created_at_ms, source_recording_id,
            start_latitude, start_longitude, start_radius_meters,
            finish_latitude, finish_longitude, finish_radius_meters,
            start_progress_m, finish_progress_m, status, kind, cluster_signature,
            classification_version
     FROM route ORDER BY id`,
  );
  const pointRows = await sql.getAll<{ route_id: string; latitude: number; longitude: number }>(
    `SELECT route_id, latitude, longitude FROM route_reference_point ORDER BY route_id, seq`,
  );
  const checkpointRows = await sql.getAll<{ id: string; route_id: string; name: string; progress_m: number }>(
    `SELECT id, route_id, name, progress_m FROM route_checkpoint ORDER BY route_id, progress_m, id`,
  );
  const attemptRows = await sql.getAll<Row>(
    `SELECT id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
            lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms,
            started_utc_offset_minutes, started_timezone_id, started_local_time_source,
            result_acknowledged, hidden_incomplete, reconciliation_status, reconciliation_version
     FROM attempt ORDER BY id`,
  );
  const crossingRows = await sql.getAll<BackupAttemptCrossing & { attempt_id: string }>(
    `SELECT id, attempt_id, checkpoint_id, checkpoint_name, checkpoint_progress_m, crossed_at_ms
     FROM attempt_checkpoint_crossing ORDER BY attempt_id, crossed_at_ms, checkpoint_progress_m, id`,
  );
  const settingRows = await sql.getAll<{ key: string; value: string }>(
    `SELECT key, value FROM app_setting ORDER BY key`,
  );

  const pointsByRoute = new Map<string, { latitude: number; longitude: number }[]>();
  for (const row of pointRows) {
    const list = pointsByRoute.get(row.route_id) ?? [];
    list.push({ latitude: row.latitude, longitude: row.longitude });
    pointsByRoute.set(row.route_id, list);
  }
  const checkpointsByRoute = new Map<string, { id: string; name: string; progress_m: number }[]>();
  for (const row of checkpointRows) {
    const list = checkpointsByRoute.get(row.route_id) ?? [];
    list.push({ id: row.id, name: row.name, progress_m: row.progress_m });
    checkpointsByRoute.set(row.route_id, list);
  }
  const crossingsByAttempt = new Map<string, BackupAttemptCrossing[]>();
  for (const { attempt_id: attemptId, ...crossing } of crossingRows) {
    const list = crossingsByAttempt.get(attemptId) ?? [];
    list.push(crossing);
    crossingsByAttempt.set(attemptId, list);
  }

  const settings: BackupSettings = {};
  for (const row of settingRows) {
    if ((BACKUP_SETTING_KEYS as readonly string[]).includes(row.key)) {
      (settings as Record<string, string>)[row.key] = row.value;
    }
  }

  return {
    places,
    tracking_sessions: sessions,
    location_samples: samples,
    routes: routeRows.map(
      (row) =>
        ({
          ...row,
          reference_path: pointsByRoute.get(row.id as string) ?? [],
          checkpoints: checkpointsByRoute.get(row.id as string) ?? [],
        }) as unknown as BackupRoute,
    ),
    attempts: attemptRows.map(
      (row) =>
        ({
          ...row,
          crossings: crossingsByAttempt.get(row.id as string) ?? [],
        }) as unknown as BackupAttempt,
    ),
    settings,
  };
}

/**
 * Reads every durable table inside one isolated read transaction, so relations and counts describe a
 * single database state even while the app keeps running. Read-only: the database is never modified,
 * so a failed export leaves local data untouched.
 */
export function readBackupSnapshot(sql: SqlExecutor): Promise<BackupPayload> {
  return runIsolated(sql, (tx) => readPayload(tx));
}

export type ExportBackupInput = {
  nowMs: number;
  appVersion: string;
};

export type ExportedBackup = {
  text: string;
  createdAtMs: number;
  payload: BackupPayload;
};

export async function exportBackup(sql: SqlExecutor, input: ExportBackupInput): Promise<ExportedBackup> {
  const payload = await readBackupSnapshot(sql);
  const text = serializeBackup(payload, {
    createdAtMs: input.nowMs,
    source: { app_version: input.appVersion, schema_version: CURRENT_SCHEMA_VERSION },
  });
  return { text, createdAtMs: input.nowMs, payload };
}
