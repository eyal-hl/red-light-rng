export type LocationSample = {
  id: string;
  sessionId: string;
  recordedAtMs: number;
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number | null;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
};

export type RawLocationFix = {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
  };
};

export function nonNegativeOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

export function headingOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 360) {
    return null;
  }
  return value;
}

export function toLocationSample(
  sessionId: string,
  id: string,
  fix: RawLocationFix,
): LocationSample | null {
  const { latitude, longitude } = fix.coords;
  if (!Number.isFinite(fix.timestamp) || fix.timestamp <= 0) {
    return null;
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }

  return {
    id,
    sessionId,
    recordedAtMs: fix.timestamp,
    latitude,
    longitude,
    horizontalAccuracyMeters: nonNegativeOrNull(fix.coords.accuracy),
    speedMetersPerSecond: nonNegativeOrNull(fix.coords.speed),
    headingDegrees: headingOrNull(fix.coords.heading),
  };
}
