import {
  parseAttemptLocalTimeSource,
  type Attempt,
  type AttemptCheckpointCrossing,
  type AttemptLifecycle,
  type AttemptValidity,
} from '../domain/attempt';
import { parseAttemptReconciliationStatus } from '../domain/attempt-reconciliation';
import type { TransportationMode } from '../domain/route';
import { OpenAttemptExistsError, type AttemptStore } from './attempt-store';
import type { CompleteSessionInput } from './location-sample-store';
import type { AttemptCheckpointCrossingRow, AttemptRow } from './schema';
import type { SqlExecutor } from './sql-executor';

function mapCrossing(row: AttemptCheckpointCrossingRow): AttemptCheckpointCrossing {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    checkpointId: row.checkpoint_id,
    checkpointName: row.checkpoint_name,
    checkpointProgressMeters: row.checkpoint_progress_m,
    crossedAtMs: row.crossed_at_ms,
  };
}

function mapAttempt(row: AttemptRow, crossings: AttemptCheckpointCrossing[]): Attempt {
  return {
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
    crossings,
    reconciliationStatus: parseAttemptReconciliationStatus(row.reconciliation_status),
    reconciliationVersion: row.reconciliation_version ?? 0,
  };
}

export class SqliteAttemptStore implements AttemptStore {
  constructor(private readonly getSql: () => Promise<SqlExecutor>) {}

  async createAttempt(attempt: Attempt): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      const open = await sql.getFirst<{ id: string }>(
        `SELECT id FROM attempt WHERE lifecycle IN ('armed', 'active') LIMIT 1`,
      );
      if (open) {
        throw new OpenAttemptExistsError(open.id);
      }
      await this.writeAttempt(sql, attempt);
    });
  }

  async saveAttempt(attempt: Attempt): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      await this.writeAttempt(sql, attempt);
    });
  }

  async finalizeAttempt(attempt: Attempt, session: CompleteSessionInput): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      await this.writeAttempt(sql, attempt);
      await sql.run(
        `UPDATE tracking_session
         SET is_active = 0,
             stopped_at_ms = ?,
             capture_outcome = ?,
             review_disposition = ?
         WHERE id = ?`,
        [session.stoppedAtMs, session.captureOutcome, session.reviewDisposition, attempt.sessionId],
      );
    });
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<AttemptRow>('SELECT * FROM attempt WHERE id = ?', [attemptId]);
    if (!row) {
      return null;
    }
    return mapAttempt(row, await this.loadCrossings(sql, attemptId));
  }

  async getAttemptBySessionId(sessionId: string): Promise<Attempt | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<AttemptRow>('SELECT * FROM attempt WHERE session_id = ?', [sessionId]);
    if (!row) {
      return null;
    }
    return mapAttempt(row, await this.loadCrossings(sql, row.id));
  }

  async getOpenAttempt(): Promise<Attempt | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<AttemptRow>(
      `SELECT * FROM attempt WHERE lifecycle IN ('armed', 'active') ORDER BY armed_at_ms DESC LIMIT 1`,
    );
    if (!row) {
      return null;
    }
    return mapAttempt(row, await this.loadCrossings(sql, row.id));
  }

  async getUnacknowledgedResult(): Promise<Attempt | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<AttemptRow>(
      `SELECT * FROM attempt
       WHERE result_acknowledged = 0
         AND lifecycle NOT IN ('armed', 'active')
       ORDER BY armed_at_ms DESC
       LIMIT 1`,
    );
    if (!row) {
      return null;
    }
    return mapAttempt(row, await this.loadCrossings(sql, row.id));
  }

  async listAttempts(): Promise<Attempt[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<AttemptRow>('SELECT * FROM attempt ORDER BY armed_at_ms DESC');
    const attempts: Attempt[] = [];
    for (const row of rows) {
      attempts.push(mapAttempt(row, await this.loadCrossings(sql, row.id)));
    }
    return attempts;
  }

  async listAttemptsForRoute(routeId: string): Promise<Attempt[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<AttemptRow>(
      'SELECT * FROM attempt WHERE route_id = ? ORDER BY armed_at_ms DESC',
      [routeId],
    );
    const attempts: Attempt[] = [];
    for (const row of rows) {
      attempts.push(mapAttempt(row, await this.loadCrossings(sql, row.id)));
    }
    return attempts;
  }

  async listAttemptsForJourney(
    originPlaceId: string,
    destinationPlaceId: string,
    transportationMode: string,
  ): Promise<Attempt[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<AttemptRow>(
      `SELECT * FROM attempt
       WHERE origin_place_id = ? AND destination_place_id = ? AND transportation_mode = ?
       ORDER BY armed_at_ms DESC`,
      [originPlaceId, destinationPlaceId, transportationMode],
    );
    const attempts: Attempt[] = [];
    for (const row of rows) {
      attempts.push(mapAttempt(row, await this.loadCrossings(sql, row.id)));
    }
    return attempts;
  }

  async isPlaceReferenced(placeId: string): Promise<boolean> {
    return (await this.countAttemptsReferencingPlace(placeId)) > 0;
  }

  async countAttemptsReferencingPlace(placeId: string): Promise<number> {
    const sql = await this.getSql();
    const row = await sql.getFirst<{ count: number }>(
      `SELECT COUNT(*) as count FROM attempt
       WHERE origin_place_id = ? OR destination_place_id = ?`,
      [placeId, placeId],
    );
    return row?.count ?? 0;
  }

  async listAttemptsNeedingReconciliation(currentVersion: number): Promise<Attempt[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<AttemptRow>(
      `SELECT * FROM attempt
       WHERE lifecycle NOT IN ('armed', 'active')
         AND (
           reconciliation_status IN ('pending', 'failed')
           OR reconciliation_version IS NULL
           OR reconciliation_version != ?
         )
       ORDER BY armed_at_ms DESC`,
      [currentVersion],
    );
    const attempts: Attempt[] = [];
    for (const row of rows) {
      attempts.push(mapAttempt(row, await this.loadCrossings(sql, row.id)));
    }
    return attempts;
  }

  async peekFailedReconciliationAttemptId(): Promise<string | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<{ id: string }>(
      `SELECT id FROM attempt
       WHERE reconciliation_status = 'failed'
       ORDER BY armed_at_ms DESC
       LIMIT 1`,
    );
    return row?.id ?? null;
  }

  async deleteAttempt(attemptId: string): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      await sql.run('DELETE FROM attempt_checkpoint_crossing WHERE attempt_id = ?', [attemptId]);
      await sql.run('DELETE FROM attempt WHERE id = ?', [attemptId]);
    });
  }

  async acknowledgeResult(attemptId: string): Promise<void> {
    const sql = await this.getSql();
    await sql.run('UPDATE attempt SET result_acknowledged = 1 WHERE id = ?', [attemptId]);
  }

  private async writeAttempt(sql: SqlExecutor, attempt: Attempt): Promise<void> {
    await sql.run(
      `INSERT INTO attempt (
         id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
         lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms,
         started_utc_offset_minutes, started_timezone_id, started_local_time_source, result_acknowledged,
         reconciliation_status, reconciliation_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         route_id = excluded.route_id,
         origin_place_id = excluded.origin_place_id,
         destination_place_id = excluded.destination_place_id,
         transportation_mode = excluded.transportation_mode,
         lifecycle = excluded.lifecycle,
         validity = excluded.validity,
         started_at_ms = excluded.started_at_ms,
         finished_at_ms = excluded.finished_at_ms,
         started_utc_offset_minutes = excluded.started_utc_offset_minutes,
         started_timezone_id = excluded.started_timezone_id,
         started_local_time_source = excluded.started_local_time_source,
         result_acknowledged = excluded.result_acknowledged,
         reconciliation_status = excluded.reconciliation_status,
         reconciliation_version = excluded.reconciliation_version`,
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
        parseAttemptReconciliationStatus(attempt.reconciliationStatus),
        attempt.reconciliationVersion ?? 0,
      ],
    );
    await sql.run('DELETE FROM attempt_checkpoint_crossing WHERE attempt_id = ?', [attempt.id]);
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

  private async loadCrossings(sql: SqlExecutor, attemptId: string): Promise<AttemptCheckpointCrossing[]> {
    const rows = await sql.getAll<AttemptCheckpointCrossingRow>(
      `SELECT id, attempt_id, checkpoint_id, checkpoint_name, checkpoint_progress_m, crossed_at_ms
       FROM attempt_checkpoint_crossing
       WHERE attempt_id = ?
       ORDER BY crossed_at_ms ASC, checkpoint_progress_m ASC`,
      [attemptId],
    );
    return rows.map(mapCrossing);
  }
}
