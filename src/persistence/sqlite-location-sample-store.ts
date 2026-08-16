import type { LocationSample } from '../domain/location-sample';
import type { CaptureOutcome, ReviewDisposition, SessionPurpose } from '../domain/session';
import { ActiveSessionExistsError } from '../domain/session';
import type {
  CompleteSessionInput,
  LocationSampleStore,
  TrackingSessionRecord,
} from './location-sample-store';
import { mapLocationSampleRow, SESSION_SELECT, type LocationSampleRow, type TrackingSessionRow } from './schema';
import type { SqlExecutor } from './sql-executor';

function mapSessionRow(row: TrackingSessionRow): TrackingSessionRecord {
  return {
    id: row.id,
    startedAtMs: row.started_at_ms,
    stoppedAtMs: row.stopped_at_ms,
    isActive: row.is_active === 1,
    purpose: row.purpose as SessionPurpose,
    captureOutcome: row.capture_outcome as CaptureOutcome,
    reviewDisposition: row.review_disposition as ReviewDisposition,
    lastSampleAtMs: row.last_sample_at_ms,
    backgroundPermissionConfirmed: row.background_permission_confirmed === 1,
  };
}

export class SqliteLocationSampleStore implements LocationSampleStore {
  constructor(private readonly getSql: () => Promise<SqlExecutor>) {}

  async createSession(
    sessionId: string,
    startedAtMs: number,
    purpose: SessionPurpose = 'route_creation',
  ): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      const active = await sql.getFirst<{ id: string }>(
        'SELECT id FROM tracking_session WHERE is_active = 1 LIMIT 1',
      );
      if (active) {
        throw new ActiveSessionExistsError(active.id);
      }
      await sql.run(
        `INSERT INTO tracking_session (
           id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
           background_permission_confirmed
         ) VALUES (?, ?, NULL, 1, ?, 'active', 'pending', 0)`,
        [sessionId, startedAtMs, purpose],
      );
    });
  }

  async confirmBackgroundPermission(sessionId: string): Promise<void> {
    const sql = await this.getSql();
    await sql.run('UPDATE tracking_session SET background_permission_confirmed = 1 WHERE id = ?', [
      sessionId,
    ]);
  }

  async completeSession(sessionId: string, input: CompleteSessionInput): Promise<void> {
    const sql = await this.getSql();
    await sql.run(
      `UPDATE tracking_session
       SET is_active = 0,
           stopped_at_ms = ?,
           capture_outcome = ?,
           review_disposition = ?
       WHERE id = ?`,
      [input.stoppedAtMs, input.captureOutcome, input.reviewDisposition, sessionId],
    );
  }

  async setReviewDisposition(sessionId: string, disposition: ReviewDisposition): Promise<void> {
    const sql = await this.getSql();
    await sql.run('UPDATE tracking_session SET review_disposition = ? WHERE id = ?', [
      disposition,
      sessionId,
    ]);
  }

  async getSession(sessionId: string): Promise<TrackingSessionRecord | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<TrackingSessionRow>(`${SESSION_SELECT} WHERE s.id = ?`, [
      sessionId,
    ]);
    return row ? mapSessionRow(row) : null;
  }

  async getActiveSession(): Promise<TrackingSessionRecord | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<TrackingSessionRow>(
      `${SESSION_SELECT} WHERE s.is_active = 1 ORDER BY s.started_at_ms DESC LIMIT 1`,
    );
    return row ? mapSessionRow(row) : null;
  }

  async getActiveSessionId(): Promise<string | null> {
    return (await this.getActiveSession())?.id ?? null;
  }

  async getLatestSessionId(): Promise<string | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<{ id: string }>(
      'SELECT id FROM tracking_session ORDER BY started_at_ms DESC LIMIT 1',
    );
    return row?.id ?? null;
  }

  async findPendingRouteCreation(): Promise<TrackingSessionRecord | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<TrackingSessionRow>(
      `${SESSION_SELECT}
       WHERE s.purpose = 'route_creation'
         AND s.capture_outcome IN ('finished', 'interrupted')
         AND s.review_disposition = 'pending'
       ORDER BY s.started_at_ms DESC
       LIMIT 1`,
    );
    return row ? mapSessionRow(row) : null;
  }

  async appendSamples(samples: LocationSample[]): Promise<void> {
    if (samples.length === 0) {
      return;
    }
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      const active = await sql.getFirst<{ id: string }>(
        'SELECT id FROM tracking_session WHERE is_active = 1 LIMIT 1',
      );
      for (const sample of samples) {
        if (!active || sample.sessionId !== active.id) {
          continue;
        }
        await sql.run(
          `INSERT OR REPLACE INTO location_sample (
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
    });
  }

  async listSamples(sessionId: string): Promise<LocationSample[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<LocationSampleRow>(
      `SELECT id, session_id, recorded_at_ms, latitude, longitude,
              horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
       FROM location_sample
       WHERE session_id = ?
       ORDER BY recorded_at_ms ASC`,
      [sessionId],
    );
    return rows.map(mapLocationSampleRow);
  }

  async countSamples(sessionId: string): Promise<number> {
    const sql = await this.getSql();
    const row = await sql.getFirst<{ count: number }>(
      'SELECT COUNT(*) as count FROM location_sample WHERE session_id = ?',
      [sessionId],
    );
    return row?.count ?? 0;
  }
}
