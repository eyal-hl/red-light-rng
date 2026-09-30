import type { Attempt, AttemptLifecycle, AttemptValidity } from '../domain/attempt';
import { parseAttemptLocalTimeSource } from '../domain/attempt';
import { parseAttemptReconciliationStatus } from '../domain/attempt-reconciliation';
import type { LocationSample } from '../domain/location-sample';
import type { Place } from '../domain/place';
import type { Route, TransportationMode } from '../domain/route';
import type { CaptureOutcome, ReviewDisposition, SessionPurpose } from '../domain/session';
import {
  isDurableProductSetting,
  type BackupSnapshot,
} from './backup-document';
import type { TrackingSessionRecord } from './location-sample-store';
import { ACTIVE_TRANSPORTATION_MODE_KEY, DEFAULT_ACTIVE_TRANSPORTATION_MODE } from './settings-store';
import type { SqlExecutor } from './sql-executor';

export const RESTORE_BLOCKED_MESSAGE =
  'Finish or cancel the current run before restoring a backup.';

export class BackupRestoreRefusedError extends Error {
  constructor() {
    super(RESTORE_BLOCKED_MESSAGE);
    this.name = 'BackupRestoreRefusedError';
  }
}

export async function deviceHasLiveTracking(sql: SqlExecutor): Promise<boolean> {
  const openAttempt = await sql.getFirst<{ id: string }>(
    `SELECT id FROM attempt WHERE lifecycle IN ('armed', 'active') LIMIT 1`,
  );
  if (openAttempt) {
    return true;
  }
  const activeSession = await sql.getFirst<{ id: string }>(
    'SELECT id FROM tracking_session WHERE is_active = 1 LIMIT 1',
  );
  return activeSession != null;
}

export async function readDurableSnapshot(
  sql: SqlExecutor,
  meta: Pick<BackupSnapshot, 'createdAtMs' | 'sourceSchemaVersion' | 'sourceAppVersion'>,
): Promise<BackupSnapshot> {
  return sql.withTransaction(async () => {
    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    const places = await readPlaces(sql);
    const sessions = await readSessions(sql);
    const samples = await readSamples(sql);
    const routes = await readRoutes(sql);
    const attempts = await readAttempts(sql);
    const settings = await readSettings(sql);
    return {
      createdAtMs: meta.createdAtMs,
      sourceSchemaVersion: version?.user_version ?? meta.sourceSchemaVersion,
      sourceAppVersion: meta.sourceAppVersion,
      places,
      routes,
      sessions,
      samples,
      attempts,
      settings,
    };
  });
}

export async function replaceDurableSnapshot(
  sql: SqlExecutor,
  snapshot: BackupSnapshot,
  options?: { beforeCommit?: () => Promise<void> | void },
): Promise<void> {
  await sql.withTransaction(async () => {
    if (await deviceHasLiveTracking(sql)) {
      throw new BackupRestoreRefusedError();
    }
    if (snapshot.attempts.some((attempt) => attempt.lifecycle === 'armed' || attempt.lifecycle === 'active')) {
      throw new Error('Refusing to write an open attempt during backup restore.');
    }
    if (snapshot.sessions.some((session) => session.isActive)) {
      throw new Error('Refusing to write an active tracking session during backup restore.');
    }

    await sql.run('DELETE FROM attempt_checkpoint_crossing');
    await sql.run('DELETE FROM attempt');
    await sql.run('DELETE FROM route_checkpoint');
    await sql.run('DELETE FROM route_reference_point');
    await sql.run('DELETE FROM route');
    await sql.run('DELETE FROM location_sample');
    await sql.run('DELETE FROM tracking_session');
    await sql.run('DELETE FROM place');
    await sql.run('DELETE FROM app_setting');

    for (const place of snapshot.places) {
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

    for (const session of snapshot.sessions) {
      await sql.run(
        `INSERT INTO tracking_session (
           id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
           background_permission_confirmed
         ) VALUES (?, ?, ?, 0, ?, ?, ?, 0)`,
        [
          session.id,
          session.startedAtMs,
          session.stoppedAtMs,
          session.purpose,
          session.captureOutcome,
          session.reviewDisposition,
        ],
      );
    }

    for (const sample of snapshot.samples) {
      await sql.run(
        `INSERT INTO location_sample (
           id, session_id, recorded_at_ms, latitude, longitude,
           horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sample.id,
          sample.sessionId,
          sample.recordedAtMs,
          sample.latitude,
          sample.longitude,
          sample.horizontalAccuracyMeters,
          sample.speedMetersPerSecond,
          sample.headingDegrees,
        ],
      );
    }

    for (const route of snapshot.routes) {
      await sql.run(
        `INSERT INTO route (
           id, name, transportation_mode, created_at_ms, source_recording_id,
           start_latitude, start_longitude, start_radius_meters,
           finish_latitude, finish_longitude, finish_radius_meters,
           start_progress_m, finish_progress_m, status, kind, cluster_signature, classification_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          route.id,
          route.name,
          route.transportationMode,
          route.createdAtMs,
          route.sourceRecordingId,
          route.startZone.center.latitude,
          route.startZone.center.longitude,
          route.startZone.radiusMeters,
          route.finishZone.center.latitude,
          route.finishZone.center.longitude,
          route.finishZone.radiusMeters,
          route.startProgressMeters,
          route.finishProgressMeters,
          route.status,
          route.kind,
          route.clusterSignature,
          route.classificationVersion,
        ],
      );
      for (const [index, point] of route.referencePath.entries()) {
        await sql.run(
          'INSERT INTO route_reference_point (route_id, seq, latitude, longitude) VALUES (?, ?, ?, ?)',
          [route.id, index, point.latitude, point.longitude],
        );
      }
      for (const checkpoint of route.checkpoints) {
        await sql.run(
          'INSERT INTO route_checkpoint (id, route_id, name, progress_m) VALUES (?, ?, ?, ?)',
          [checkpoint.id, route.id, checkpoint.name, checkpoint.progressMeters],
        );
      }
    }

    for (const attempt of snapshot.attempts) {
      await sql.run(
        `INSERT INTO attempt (
           id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
           lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms,
           started_utc_offset_minutes, started_timezone_id, started_local_time_source,
           result_acknowledged, hidden_incomplete, reconciliation_status, reconciliation_version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attempt.id,
          attempt.routeId,
          attempt.originPlaceId,
          attempt.destinationPlaceId,
          attempt.transportationMode,
          attempt.sessionId,
          attempt.lifecycle,
          attempt.validity,
          attempt.armedAtMs,
          attempt.startedAtMs,
          attempt.finishedAtMs,
          attempt.startedUtcOffsetMinutes,
          attempt.startedTimezoneId,
          attempt.startedLocalTimeSource,
          attempt.resultAcknowledged ? 1 : 0,
          attempt.hiddenIncomplete === true ? 1 : 0,
          attempt.reconciliationStatus ?? 'pending',
          attempt.reconciliationVersion ?? 0,
        ],
      );
      for (const crossing of attempt.crossings) {
        await sql.run(
          `INSERT INTO attempt_checkpoint_crossing (
             id, attempt_id, checkpoint_id, checkpoint_name, checkpoint_progress_m, crossed_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            crossing.id,
            attempt.id,
            crossing.checkpointId,
            crossing.checkpointName,
            crossing.checkpointProgressMeters,
            crossing.crossedAtMs,
          ],
        );
      }
    }

    const settings = snapshot.settings.filter((setting) => isDurableProductSetting(setting.key));
    const mode =
      settings.find((setting) => setting.key === ACTIVE_TRANSPORTATION_MODE_KEY)?.value ??
      DEFAULT_ACTIVE_TRANSPORTATION_MODE;
    await sql.run('INSERT INTO app_setting (key, value) VALUES (?, ?)', [ACTIVE_TRANSPORTATION_MODE_KEY, mode]);

    if (options?.beforeCommit) {
      await options.beforeCommit();
    }
  });
}

async function readPlaces(sql: SqlExecutor): Promise<Place[]> {
  const rows = await sql.getAll<{
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    radius_meters: number;
    status: string;
    created_at_ms: number;
  }>('SELECT id, name, latitude, longitude, radius_meters, status, created_at_ms FROM place');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    center: { latitude: row.latitude, longitude: row.longitude },
    radiusMeters: row.radius_meters,
    status: row.status === 'archived' ? 'archived' : 'active',
    createdAtMs: row.created_at_ms,
  }));
}

async function readSessions(sql: SqlExecutor): Promise<TrackingSessionRecord[]> {
  const rows = await sql.getAll<{
    id: string;
    started_at_ms: number;
    stopped_at_ms: number | null;
    is_active: number;
    purpose: string;
    capture_outcome: string;
    review_disposition: string;
  }>(
    `SELECT id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition
     FROM tracking_session`,
  );
  return rows.map((row) => ({
    id: row.id,
    startedAtMs: row.started_at_ms,
    stoppedAtMs: row.stopped_at_ms,
    isActive: row.is_active === 1,
    purpose: row.purpose as SessionPurpose,
    captureOutcome: row.capture_outcome as CaptureOutcome,
    reviewDisposition: row.review_disposition as ReviewDisposition,
    lastSampleAtMs: null,
    backgroundPermissionConfirmed: false,
  }));
}

async function readSamples(sql: SqlExecutor): Promise<LocationSample[]> {
  const rows = await sql.getAll<{
    id: string;
    session_id: string;
    recorded_at_ms: number;
    latitude: number;
    longitude: number;
    horizontal_accuracy_meters: number | null;
    speed_meters_per_second: number | null;
    heading_degrees: number | null;
  }>(
    `SELECT id, session_id, recorded_at_ms, latitude, longitude,
            horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
     FROM location_sample`,
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    recordedAtMs: row.recorded_at_ms,
    latitude: row.latitude,
    longitude: row.longitude,
    horizontalAccuracyMeters: row.horizontal_accuracy_meters,
    speedMetersPerSecond: row.speed_meters_per_second,
    headingDegrees: row.heading_degrees,
  }));
}

async function readRoutes(sql: SqlExecutor): Promise<Route[]> {
  const rows = await sql.getAll<{
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
    status: string;
    kind: string;
    cluster_signature: string | null;
    classification_version: number;
  }>(
    `SELECT id, name, transportation_mode, created_at_ms, source_recording_id,
            start_latitude, start_longitude, start_radius_meters,
            finish_latitude, finish_longitude, finish_radius_meters,
            start_progress_m, finish_progress_m, status, kind, cluster_signature, classification_version
     FROM route`,
  );
  const routes: Route[] = [];
  for (const row of rows) {
    const points = await sql.getAll<{ latitude: number; longitude: number }>(
      'SELECT latitude, longitude FROM route_reference_point WHERE route_id = ? ORDER BY seq ASC',
      [row.id],
    );
    const checkpoints = await sql.getAll<{ id: string; name: string; progress_m: number }>(
      'SELECT id, name, progress_m FROM route_checkpoint WHERE route_id = ? ORDER BY progress_m ASC, id ASC',
      [row.id],
    );
    routes.push({
      id: row.id,
      name: row.name,
      transportationMode: row.transportation_mode as TransportationMode,
      createdAtMs: row.created_at_ms,
      sourceRecordingId: row.source_recording_id,
      referencePath: points,
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
      checkpoints: checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        name: checkpoint.name,
        progressMeters: checkpoint.progress_m,
      })),
      status: row.status === 'archived' ? 'archived' : 'active',
      kind: row.kind === 'discovered' ? 'discovered' : 'explicit',
      clusterSignature: row.cluster_signature,
      classificationVersion: row.classification_version,
    });
  }
  return routes;
}

async function readAttempts(sql: SqlExecutor): Promise<Attempt[]> {
  const rows = await sql.getAll<{
    id: string;
    route_id: string | null;
    origin_place_id: string | null;
    destination_place_id: string | null;
    transportation_mode: string;
    session_id: string;
    lifecycle: string;
    validity: string;
    armed_at_ms: number;
    started_at_ms: number | null;
    finished_at_ms: number | null;
    started_utc_offset_minutes: number | null;
    started_timezone_id: string | null;
    started_local_time_source: string | null;
    result_acknowledged: number;
    hidden_incomplete: number;
    reconciliation_status: string;
    reconciliation_version: number;
  }>('SELECT * FROM attempt');
  const attempts: Attempt[] = [];
  for (const row of rows) {
    const crossings = await sql.getAll<{
      id: string;
      checkpoint_id: string;
      checkpoint_name: string;
      checkpoint_progress_m: number;
      crossed_at_ms: number;
    }>(
      `SELECT id, checkpoint_id, checkpoint_name, checkpoint_progress_m, crossed_at_ms
       FROM attempt_checkpoint_crossing WHERE attempt_id = ?`,
      [row.id],
    );
    attempts.push({
      id: row.id,
      routeId: row.route_id,
      originPlaceId: row.origin_place_id,
      destinationPlaceId: row.destination_place_id,
      transportationMode: row.transportation_mode as TransportationMode,
      sessionId: row.session_id,
      lifecycle: row.lifecycle as AttemptLifecycle,
      validity: row.validity as AttemptValidity,
      armedAtMs: row.armed_at_ms,
      startedAtMs: row.started_at_ms,
      finishedAtMs: row.finished_at_ms,
      startedUtcOffsetMinutes: row.started_utc_offset_minutes,
      startedTimezoneId: row.started_timezone_id,
      startedLocalTimeSource: parseAttemptLocalTimeSource(row.started_local_time_source),
      resultAcknowledged: row.result_acknowledged === 1,
      hiddenIncomplete: Number(row.hidden_incomplete) === 1,
      crossings: crossings.map((crossing) => ({
        id: crossing.id,
        attemptId: row.id,
        checkpointId: crossing.checkpoint_id,
        checkpointName: crossing.checkpoint_name,
        checkpointProgressMeters: crossing.checkpoint_progress_m,
        crossedAtMs: crossing.crossed_at_ms,
      })),
      reconciliationStatus: parseAttemptReconciliationStatus(row.reconciliation_status),
      reconciliationVersion: row.reconciliation_version ?? 0,
    });
  }
  return attempts;
}

async function readSettings(sql: SqlExecutor): Promise<BackupSnapshot['settings']> {
  const rows = await sql.getAll<{ key: string; value: string }>('SELECT key, value FROM app_setting');
  return rows
    .filter((row) => isDurableProductSetting(row.key))
    .map((row) => ({ key: row.key, value: row.value }));
}
