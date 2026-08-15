export const LOCATION_SPIKE_SCHEMA = `
CREATE TABLE IF NOT EXISTS tracking_session (
  id TEXT PRIMARY KEY NOT NULL,
  started_at_ms INTEGER NOT NULL,
  stopped_at_ms INTEGER,
  is_active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS location_sample (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  horizontal_accuracy_meters REAL,
  speed_meters_per_second REAL,
  heading_degrees REAL,
  FOREIGN KEY (session_id) REFERENCES tracking_session(id)
);

CREATE INDEX IF NOT EXISTS idx_location_sample_session_time
  ON location_sample(session_id, recorded_at_ms);
`;

export type LocationSampleRow = {
  id: string;
  session_id: string;
  recorded_at_ms: number;
  latitude: number;
  longitude: number;
  horizontal_accuracy_meters: number | null;
  speed_meters_per_second: number | null;
  heading_degrees: number | null;
};

export function mapLocationSampleRow(row: LocationSampleRow) {
  return {
    id: row.id,
    sessionId: row.session_id,
    recordedAtMs: row.recorded_at_ms,
    latitude: row.latitude,
    longitude: row.longitude,
    horizontalAccuracyMeters: row.horizontal_accuracy_meters,
    speedMetersPerSecond: row.speed_meters_per_second,
    headingDegrees: row.heading_degrees,
  };
}
