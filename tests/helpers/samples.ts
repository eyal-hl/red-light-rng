import type { LocationSample } from '../../src/domain/location-sample';

const METERS_PER_DEGREE_LAT = 111_320;

export function offsetLatLng(
  latitude: number,
  longitude: number,
  northMeters: number,
  eastMeters: number,
): { latitude: number; longitude: number } {
  const latitudeDelta = northMeters / METERS_PER_DEGREE_LAT;
  const longitudeDelta =
    eastMeters / (METERS_PER_DEGREE_LAT * Math.cos((latitude * Math.PI) / 180));
  return {
    latitude: latitude + latitudeDelta,
    longitude: longitude + longitudeDelta,
  };
}

export function sample(overrides: Partial<LocationSample>): LocationSample {
  return {
    id: overrides.id ?? 'sample',
    sessionId: overrides.sessionId ?? 'session',
    recordedAtMs: overrides.recordedAtMs ?? 1_700_000_000_000,
    latitude: overrides.latitude ?? 32.08,
    longitude: overrides.longitude ?? 34.78,
    horizontalAccuracyMeters: overrides.horizontalAccuracyMeters ?? 5,
    speedMetersPerSecond: overrides.speedMetersPerSecond ?? 4,
    headingDegrees: overrides.headingDegrees ?? 0,
  };
}

export function movingTrace(options?: {
  sessionId?: string;
  startMs?: number;
  points?: number;
  stepMeters?: number;
  startLat?: number;
  startLng?: number;
}): LocationSample[] {
  const sessionId = options?.sessionId ?? 'session';
  const startMs = options?.startMs ?? 1_700_000_000_000;
  const points = options?.points ?? 20;
  const stepMeters = options?.stepMeters ?? 12;
  const startLat = options?.startLat ?? 32.08;
  const startLng = options?.startLng ?? 34.78;
  const samples: LocationSample[] = [];
  for (let index = 0; index < points; index += 1) {
    const coord = offsetLatLng(startLat, startLng, index * stepMeters, 0);
    samples.push(
      sample({
        id: `${sessionId}-${index}`,
        sessionId,
        recordedAtMs: startMs + index * 1000,
        latitude: coord.latitude,
        longitude: coord.longitude,
        speedMetersPerSecond: 4,
        headingDegrees: 0,
      }),
    );
  }
  return samples;
}
