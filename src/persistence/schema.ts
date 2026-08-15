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

export const CURRENT_SCHEMA_VERSION = 1;

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

export type TrackingSessionRow = {
  id: string;
  started_at_ms: number;
  stopped_at_ms: number | null;
  is_active: number;
  purpose: string;
  capture_outcome: string;
  review_disposition: string;
  last_sample_at_ms: number | null;
};

export type RouteRow = {
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
};

export type RouteReferencePointRow = {
  route_id: string;
  seq: number;
  latitude: number;
  longitude: number;
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

export const SESSION_SELECT = `
SELECT
  s.id,
  s.started_at_ms,
  s.stopped_at_ms,
  s.is_active,
  s.purpose,
  s.capture_outcome,
  s.review_disposition,
  (
    SELECT MAX(p.recorded_at_ms)
    FROM location_sample p
    WHERE p.session_id = s.id
  ) AS last_sample_at_ms
FROM tracking_session s
`;
