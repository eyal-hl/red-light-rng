import { offsetLatLng } from './samples';
import type { LatLng } from '../../src/domain/geo';
import { DEFAULT_ZONE_RADIUS_METERS } from '../../src/domain/route-derivation';
import { defaultCourseProgress } from '../../src/domain/course-layout';
import type { Route } from '../../src/domain/route';

export function northPath(options?: {
  points?: number;
  stepMeters?: number;
  startLat?: number;
  startLng?: number;
}): LatLng[] {
  const points = options?.points ?? 6;
  const stepMeters = options?.stepMeters ?? 20;
  const startLat = options?.startLat ?? 32.08;
  const startLng = options?.startLng ?? 34.78;
  const path: LatLng[] = [];
  for (let index = 0; index < points; index += 1) {
    path.push(offsetLatLng(startLat, startLng, index * stepMeters, 0));
  }
  return path;
}

export function outAndBackPath(stepMeters = 20, legs = 5): LatLng[] {
  const outbound = northPath({ points: legs + 1, stepMeters });
  const inbound = outbound.slice(0, -1).reverse();
  return [...outbound, ...inbound];
}

export function makeRoute(overrides: Partial<Route> = {}): Route {
  const referencePath = overrides.referencePath ?? northPath();
  const progress = defaultCourseProgress(referencePath);
  const start = referencePath[0] ?? { latitude: 32.08, longitude: 34.78 };
  const finish = referencePath[referencePath.length - 1] ?? start;
  return {
    id: 'route-1',
    name: 'Home → Work',
    transportationMode: 'scooter',
    createdAtMs: 1_700_000_100_000,
    sourceRecordingId: 'session-1',
    referencePath,
    startZone: { center: { ...start }, radiusMeters: DEFAULT_ZONE_RADIUS_METERS },
    finishZone: { center: { ...finish }, radiusMeters: DEFAULT_ZONE_RADIUS_METERS },
    startProgressMeters: progress.startProgressMeters,
    finishProgressMeters: progress.finishProgressMeters,
    checkpoints: [],
    ...overrides,
  };
}
