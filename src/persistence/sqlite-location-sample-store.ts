import type { LocationSample } from '../domain/location-sample';
import { getDatabase } from './database';
import type { LocationSampleStore } from './location-sample-store';
import { mapLocationSampleRow, type LocationSampleRow } from './schema';

export class SqliteLocationSampleStore implements LocationSampleStore {
  async createSession(sessionId: string, startedAtMs: number): Promise<void> {
    const database = await getDatabase();
    await database.withTransactionAsync(async () => {
      await database.runAsync(
        'UPDATE tracking_session SET is_active = 0, stopped_at_ms = COALESCE(stopped_at_ms, ?) WHERE is_active = 1',
        startedAtMs,
      );
      await database.runAsync(
        'INSERT INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active) VALUES (?, ?, NULL, 1)',
        sessionId,
        startedAtMs,
      );
    });
  }

  async stopSession(sessionId: string, stoppedAtMs: number): Promise<void> {
    const database = await getDatabase();
    await database.runAsync(
      'UPDATE tracking_session SET is_active = 0, stopped_at_ms = ? WHERE id = ?',
      stoppedAtMs,
      sessionId,
    );
  }

  async getActiveSessionId(): Promise<string | null> {
    const database = await getDatabase();
    const row = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM tracking_session WHERE is_active = 1 ORDER BY started_at_ms DESC LIMIT 1',
    );
    return row?.id ?? null;
  }

  async getLatestSessionId(): Promise<string | null> {
    const database = await getDatabase();
    const row = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM tracking_session ORDER BY started_at_ms DESC LIMIT 1',
    );
    return row?.id ?? null;
  }

  async appendSamples(samples: LocationSample[]): Promise<void> {
    if (samples.length === 0) {
      return;
    }
    const database = await getDatabase();
    await database.withTransactionAsync(async () => {
      for (const sample of samples) {
        await database.runAsync(
          `INSERT OR REPLACE INTO location_sample (
            id, session_id, recorded_at_ms, latitude, longitude,
            horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sample.id,
          sample.sessionId,
          sample.recordedAtMs,
          sample.latitude,
          sample.longitude,
          sample.horizontalAccuracyMeters,
          sample.speedMetersPerSecond,
          sample.headingDegrees,
        );
      }
    });
  }

  async listSamples(sessionId: string): Promise<LocationSample[]> {
    const database = await getDatabase();
    const rows = await database.getAllAsync<LocationSampleRow>(
      `SELECT id, session_id, recorded_at_ms, latitude, longitude,
              horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
       FROM location_sample
       WHERE session_id = ?
       ORDER BY recorded_at_ms ASC`,
      sessionId,
    );
    return rows.map(mapLocationSampleRow);
  }

  async countSamples(sessionId: string): Promise<number> {
    const database = await getDatabase();
    const row = await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM location_sample WHERE session_id = ?',
      sessionId,
    );
    return row?.count ?? 0;
  }
}

export const sqliteLocationSampleStore = new SqliteLocationSampleStore();
