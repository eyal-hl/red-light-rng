import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../domain/attempt';
import { reconstructAttemptLocalStart } from '../domain/attempt-local-time';
import { CURRENT_ATTEMPT_RECONCILIATION_VERSION } from '../domain/attempt-reconciliation';
import { replayPlaceTrace, type PlaceTimingPlace } from '../domain/place-timing';
import {
  BackupError,
  countBackupRecords,
  type BackupAttempt,
  type BackupCounts,
  type BackupPayload,
  type BackupTrackingSession,
} from '../persistence/backup-format';
import { mapLocationSampleRow } from '../persistence/schema';
import { runIsolated, type SqlExecutor, type SqlValue } from '../persistence/sql-executor';
import { terminalSessionInput } from './attempt-runtime';

export const RESTORE_LIVE_ATTEMPT_MESSAGE =
  'A run is armed or active on this device. Finish or cancel it before restoring a backup.';
export const RESTORE_LIVE_SESSION_MESSAGE =
  'A location recording is active on this device. Finish or cancel it before restoring a backup.';

export type TerminalizedAttempt = {
  attemptId: string;
  outcome: 'completed' | 'incomplete';
};

export type TerminalizationReport = {
  attempts: TerminalizedAttempt[];
  sessionIds: string[];
};

function isOpenLifecycle(lifecycle: string): boolean {
  return lifecycle === 'armed' || lifecycle === 'active';
}

/**
 * Backups may contain a formerly ARMED/ACTIVE attempt or an is_active tracking session. A backup is
 * history, never proof that an OS location task is live, so every such row is terminalized before it
 * is written, using the same durable lifecycle evidence as `AttemptRuntime.endAndInspect`:
 * a trustworthy official start and finish in the stored samples keeps a true completed result,
 * anything else becomes an inspectable incomplete ('ended', never hidden 'abandoned').
 *
 * Pure and deterministic: the stop time is derived from the backup's own samples, not the clock.
 */
export function terminalizeRestoredLiveState(payload: BackupPayload): {
  payload: BackupPayload;
  report: TerminalizationReport;
} {
  const sessionsById = new Map(payload.tracking_sessions.map((session) => [session.id, session]));
  const samplesBySession = new Map<string, BackupPayload['location_samples']>();
  for (const sample of payload.location_samples) {
    const list = samplesBySession.get(sample.session_id) ?? [];
    list.push(sample);
    samplesBySession.set(sample.session_id, list);
  }
  const stopTimeFor = (sessionId: string, floorMs: number): number => {
    const samples = samplesBySession.get(sessionId) ?? [];
    const session = sessionsById.get(sessionId);
    let latest = Math.max(floorMs, session?.started_at_ms ?? 0);
    for (const sample of samples) {
      latest = Math.max(latest, sample.recorded_at_ms);
    }
    return latest;
  };
  const placesById = new Map(payload.places.map((place) => [place.id, place]));
  const activePlaces = payload.places.filter((place) => place.status === 'active');

  const report: TerminalizationReport = { attempts: [], sessionIds: [] };
  const lifecycleBySession = new Map<string, string>();
  const openAttemptSessions = new Set(
    payload.attempts.filter((attempt) => isOpenLifecycle(attempt.lifecycle)).map((attempt) => attempt.session_id),
  );
  const attempts: BackupAttempt[] = payload.attempts.map((attempt) => {
    if (!isOpenLifecycle(attempt.lifecycle)) {
      lifecycleBySession.set(attempt.session_id, attempt.lifecycle);
      return attempt;
    }
    const stoppedAtMs = stopTimeFor(attempt.session_id, attempt.armed_at_ms);
    const knownIds = new Set(activePlaces.map((place) => place.id));
    const extras = [attempt.origin_place_id, attempt.destination_place_id]
      .filter((id): id is string => id != null && !knownIds.has(id))
      .map((id) => placesById.get(id))
      .filter((place) => place != null);
    const places: PlaceTimingPlace[] = [...activePlaces, ...extras].map((place) => ({
      id: place.id,
      name: place.name,
      center: { latitude: place.latitude, longitude: place.longitude },
      radiusMeters: place.radius_meters,
      status: place.status === 'archived' ? 'archived' : 'active',
    }));
    const samples = [...(samplesBySession.get(attempt.session_id) ?? [])]
      .sort((a, b) => a.recorded_at_ms - b.recorded_at_ms || a.id.localeCompare(b.id))
      .map(mapLocationSampleRow);
    const engine = replayPlaceTrace(places, samples, { armedAtMs: attempt.armed_at_ms, nowMs: stoppedAtMs });

    const completed =
      engine.lifecycle === 'completed' &&
      engine.validity === 'valid' &&
      engine.startedAtMs != null &&
      engine.finishedAtMs != null &&
      engine.originPlaceId != null &&
      engine.destinationPlaceId != null;
    const lifecycle: Attempt['lifecycle'] = completed ? 'completed' : 'ended';
    const startedAtMs = engine.startedAtMs;
    const sameStart =
      startedAtMs != null &&
      attempt.started_at_ms === startedAtMs &&
      attempt.started_utc_offset_minutes != null &&
      attempt.started_local_time_source != null;
    const localStart =
      startedAtMs == null
        ? EMPTY_ATTEMPT_LOCAL_START
        : sameStart
          ? {
              startedUtcOffsetMinutes: attempt.started_utc_offset_minutes,
              startedTimezoneId: attempt.started_timezone_id,
              startedLocalTimeSource: attempt.started_local_time_source as Attempt['startedLocalTimeSource'],
            }
          : reconstructAttemptLocalStart(startedAtMs);

    lifecycleBySession.set(attempt.session_id, lifecycle);
    report.attempts.push({ attemptId: attempt.id, outcome: completed ? 'completed' : 'incomplete' });
    return {
      ...attempt,
      lifecycle,
      validity: completed ? 'valid' : 'unranked',
      origin_place_id: engine.originPlaceId,
      destination_place_id: engine.destinationPlaceId,
      started_at_ms: startedAtMs,
      finished_at_ms: completed ? engine.finishedAtMs : null,
      started_utc_offset_minutes: localStart.startedUtcOffsetMinutes,
      started_timezone_id: localStart.startedTimezoneId,
      started_local_time_source: localStart.startedLocalTimeSource,
      // A restored stale run must not pop up as a fresh result; a true completed result still surfaces once.
      result_acknowledged: completed ? attempt.result_acknowledged : 1,
      hidden_incomplete: 0,
      route_id: null,
      crossings: [],
      // Derived path/checkpoint assignment is recomputed from the stored samples on next startup.
      reconciliation_status: completed ? 'pending' : 'reconciled',
      reconciliation_version: completed ? 0 : CURRENT_ATTEMPT_RECONCILIATION_VERSION,
    };
  });

  const sessions: BackupTrackingSession[] = payload.tracking_sessions.map((session) => {
    const attemptLifecycle = lifecycleBySession.get(session.id);
    if (session.is_active !== 1 && !openAttemptSessions.has(session.id)) {
      return session;
    }
    report.sessionIds.push(session.id);
    const stoppedAtMs = session.stopped_at_ms ?? stopTimeFor(session.id, session.started_at_ms);
    let captureOutcome: string;
    let reviewDisposition: string;
    if (attemptLifecycle) {
      const terminal = terminalSessionInput({ lifecycle: attemptLifecycle as Attempt['lifecycle'] }, stoppedAtMs);
      captureOutcome = terminal.captureOutcome;
      reviewDisposition = terminal.reviewDisposition;
    } else if (session.purpose === 'route_creation') {
      // Same as tracker recovery: an unfinished route recording stays reviewable.
      captureOutcome = 'interrupted';
      reviewDisposition = 'pending';
    } else {
      captureOutcome = 'interrupted';
      reviewDisposition = 'discarded';
    }
    return {
      ...session,
      is_active: 0,
      stopped_at_ms: stoppedAtMs,
      capture_outcome: captureOutcome,
      review_disposition: reviewDisposition,
    };
  });

  return { payload: { ...payload, attempts, tracking_sessions: sessions }, report };
}

/** Throws a BackupError('live_state') when this device has an open attempt or an active tracking session. */
export async function assertNoLiveState(sql: SqlExecutor): Promise<void> {
  const openAttempt = await sql.getFirst<{ id: string }>(
    `SELECT id FROM attempt WHERE lifecycle IN ('armed', 'active') LIMIT 1`,
  );
  if (openAttempt) {
    throw new BackupError('live_state', RESTORE_LIVE_ATTEMPT_MESSAGE);
  }
  const activeSession = await sql.getFirst<{ id: string }>(
    `SELECT id FROM tracking_session WHERE is_active = 1 LIMIT 1`,
  );
  if (activeSession) {
    throw new BackupError('live_state', RESTORE_LIVE_SESSION_MESSAGE);
  }
}

const WIPE_ORDER = [
  'attempt_checkpoint_crossing',
  'attempt',
  'route_checkpoint',
  'route_reference_point',
  'route',
  'location_sample',
  'tracking_session',
  'place',
  'app_setting',
] as const;

const MAX_SQL_PARAMS = 900;

async function insertRows(
  sql: SqlExecutor,
  table: string,
  columns: readonly string[],
  rows: readonly SqlValue[][],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const perStatement = Math.max(1, Math.floor(MAX_SQL_PARAMS / columns.length));
  const group = `(${columns.map(() => '?').join(', ')})`;
  for (let offset = 0; offset < rows.length; offset += perStatement) {
    const chunk = rows.slice(offset, offset + perStatement);
    await sql.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => group).join(', ')}`,
      chunk.flat(),
    );
  }
}

async function writePayload(sql: SqlExecutor, payload: BackupPayload): Promise<void> {
  await insertRows(
    sql,
    'place',
    ['id', 'name', 'latitude', 'longitude', 'radius_meters', 'status', 'created_at_ms'],
    payload.places.map((p) => [p.id, p.name, p.latitude, p.longitude, p.radius_meters, p.status, p.created_at_ms]),
  );
  await insertRows(
    sql,
    'tracking_session',
    [
      'id',
      'started_at_ms',
      'stopped_at_ms',
      'is_active',
      'purpose',
      'capture_outcome',
      'review_disposition',
      'background_permission_confirmed',
    ],
    payload.tracking_sessions.map((s) => [
      s.id,
      s.started_at_ms,
      s.stopped_at_ms,
      s.is_active,
      s.purpose,
      s.capture_outcome,
      s.review_disposition,
      s.background_permission_confirmed,
    ]),
  );
  await insertRows(
    sql,
    'location_sample',
    [
      'id',
      'session_id',
      'recorded_at_ms',
      'latitude',
      'longitude',
      'horizontal_accuracy_meters',
      'speed_meters_per_second',
      'heading_degrees',
    ],
    payload.location_samples.map((s) => [
      s.id,
      s.session_id,
      s.recorded_at_ms,
      s.latitude,
      s.longitude,
      s.horizontal_accuracy_meters,
      s.speed_meters_per_second,
      s.heading_degrees,
    ]),
  );
  await insertRows(
    sql,
    'route',
    [
      'id',
      'name',
      'transportation_mode',
      'created_at_ms',
      'source_recording_id',
      'start_latitude',
      'start_longitude',
      'start_radius_meters',
      'finish_latitude',
      'finish_longitude',
      'finish_radius_meters',
      'start_progress_m',
      'finish_progress_m',
      'status',
      'kind',
      'cluster_signature',
      'classification_version',
    ],
    payload.routes.map((r) => [
      r.id,
      r.name,
      r.transportation_mode,
      r.created_at_ms,
      r.source_recording_id,
      r.start_latitude,
      r.start_longitude,
      r.start_radius_meters,
      r.finish_latitude,
      r.finish_longitude,
      r.finish_radius_meters,
      r.start_progress_m,
      r.finish_progress_m,
      r.status,
      r.kind,
      r.cluster_signature,
      r.classification_version,
    ]),
  );
  await insertRows(
    sql,
    'route_reference_point',
    ['route_id', 'seq', 'latitude', 'longitude'],
    payload.routes.flatMap((r) => r.reference_path.map((p, seq) => [r.id, seq, p.latitude, p.longitude])),
  );
  await insertRows(
    sql,
    'route_checkpoint',
    ['id', 'route_id', 'name', 'progress_m'],
    payload.routes.flatMap((r) => r.checkpoints.map((c) => [c.id, r.id, c.name, c.progress_m])),
  );
  await insertRows(
    sql,
    'attempt',
    [
      'id',
      'route_id',
      'origin_place_id',
      'destination_place_id',
      'transportation_mode',
      'session_id',
      'lifecycle',
      'validity',
      'armed_at_ms',
      'started_at_ms',
      'finished_at_ms',
      'started_utc_offset_minutes',
      'started_timezone_id',
      'started_local_time_source',
      'result_acknowledged',
      'hidden_incomplete',
      'reconciliation_status',
      'reconciliation_version',
    ],
    payload.attempts.map((a) => [
      a.id,
      a.route_id,
      a.origin_place_id,
      a.destination_place_id,
      a.transportation_mode,
      a.session_id,
      a.lifecycle,
      a.validity,
      a.armed_at_ms,
      a.started_at_ms,
      a.finished_at_ms,
      a.started_utc_offset_minutes,
      a.started_timezone_id,
      a.started_local_time_source,
      a.result_acknowledged,
      a.hidden_incomplete,
      a.reconciliation_status,
      a.reconciliation_version,
    ]),
  );
  await insertRows(
    sql,
    'attempt_checkpoint_crossing',
    ['id', 'attempt_id', 'checkpoint_id', 'checkpoint_name', 'checkpoint_progress_m', 'crossed_at_ms'],
    payload.attempts.flatMap((a) =>
      a.crossings.map((c) => [c.id, a.id, c.checkpoint_id, c.checkpoint_name, c.checkpoint_progress_m, c.crossed_at_ms]),
    ),
  );
  await insertRows(
    sql,
    'app_setting',
    ['key', 'value'],
    Object.entries(payload.settings).map(([key, value]) => [key, value as string]),
  );
}

async function tableCount(sql: SqlExecutor, table: string): Promise<number> {
  const row = await sql.getFirst<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return row?.count ?? 0;
}

export type RestoreResult = {
  counts: BackupCounts;
  terminalization: TerminalizationReport;
};

/**
 * Replace-only restore of an already parsed and validated payload. One atomic transaction: the live
 * state check, wipe, insert, terminalization and relational verification either all commit or all roll
 * back, leaving the original database exactly as it was.
 */
export async function restoreBackupPayload(sql: SqlExecutor, parsed: BackupPayload): Promise<RestoreResult> {
  const { payload, report } = terminalizeRestoredLiveState(parsed);
  try {
    await runIsolated(sql, async (tx) => {
      await assertNoLiveState(tx);
      for (const table of WIPE_ORDER) {
        await tx.run(`DELETE FROM ${table}`);
      }
      await writePayload(tx, payload);

      const violations = await tx.getAll<Record<string, unknown>>('PRAGMA foreign_key_check');
      if (violations.length > 0) {
        throw new BackupError('broken_reference', 'The restored data has broken references.');
      }
      const expected = countBackupRecords(payload);
      const actual: Record<string, number> = {
        place: await tableCount(tx, 'place'),
        route: await tableCount(tx, 'route'),
        attempt: await tableCount(tx, 'attempt'),
        tracking_session: await tableCount(tx, 'tracking_session'),
        location_sample: await tableCount(tx, 'location_sample'),
        route_reference_point: await tableCount(tx, 'route_reference_point'),
        route_checkpoint: await tableCount(tx, 'route_checkpoint'),
        attempt_checkpoint_crossing: await tableCount(tx, 'attempt_checkpoint_crossing'),
        app_setting: await tableCount(tx, 'app_setting'),
      };
      if (
        actual.place !== expected.places ||
        actual.route !== expected.routes ||
        actual.attempt !== expected.attempts ||
        actual.tracking_session !== expected.tracking_sessions ||
        actual.location_sample !== expected.location_samples ||
        actual.route_reference_point !== expected.route_reference_points ||
        actual.route_checkpoint !== expected.route_checkpoints ||
        actual.attempt_checkpoint_crossing !== expected.attempt_checkpoint_crossings ||
        actual.app_setting !== expected.settings
      ) {
        throw new BackupError('restore_failed', 'Restored record counts do not match the backup.');
      }
    });
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(
      'restore_failed',
      `Restore failed and your existing data was left unchanged. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
  return { counts: countBackupRecords(payload), terminalization: report };
}
