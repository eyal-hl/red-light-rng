import { haversineMeters, type LatLng } from '../../src/domain/geo';
import type { LocationSample } from '../../src/domain/location-sample';
import { DEFAULT_PLACE_RADIUS_METERS, type Place } from '../../src/domain/place';
import { ensurePlacesForRoute } from '../../src/domain/place-seeding';
import type { PlaceStore } from '../../src/persistence/place-store';
import type { Route } from '../../src/domain/route';
import { offsetLatLng, sample } from './samples';

export function makePlace(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    center: { latitude: 32.08, longitude: 34.78 },
    radiusMeters: DEFAULT_PLACE_RADIUS_METERS,
    status: 'active',
    createdAtMs: 1,
    ...overrides,
  };
}

export function interpolateLatLng(from: LatLng, to: LatLng, t: number): LatLng {
  const clamped = Math.min(1, Math.max(0, t));
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * clamped,
    longitude: from.longitude + (to.longitude - from.longitude) * clamped,
  };
}

export function sampleAt(
  point: LatLng,
  options: {
    sessionId: string;
    recordedAtMs: number;
    id?: string;
    accuracyMeters?: number | null;
    speedMps?: number;
  },
): LocationSample {
  return sample({
    id: options.id ?? `${options.sessionId}-${options.recordedAtMs}`,
    sessionId: options.sessionId,
    recordedAtMs: options.recordedAtMs,
    latitude: point.latitude,
    longitude: point.longitude,
    horizontalAccuracyMeters: options.accuracyMeters === undefined ? 5 : options.accuracyMeters,
    speedMetersPerSecond: options.speedMps ?? 4,
    headingDegrees: 0,
  });
}

export function linearSamples(
  from: LatLng,
  to: LatLng,
  options: {
    sessionId: string;
    startMs: number;
    speedMps: number;
    intervalMs?: number;
    eastMeters?: number;
    startIndex?: number;
  },
): LocationSample[] {
  const intervalMs = options.intervalMs ?? 1000;
  const total = Math.max(haversineMeters(from, to), 0.01);
  const step = Math.max(options.speedMps * (intervalMs / 1000), 0.1);
  const count = Math.max(1, Math.ceil(total / step));
  if (count > 5_000) {
    throw new Error(
      `linearSamples would generate ${count} points over ${total.toFixed(1)} m at ${options.speedMps} m/s`,
    );
  }
  const samples: LocationSample[] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = Math.min(1, (index * step) / total);
    let point = interpolateLatLng(from, to, t);
    if (options.eastMeters) {
      point = offsetLatLng(point.latitude, point.longitude, 0, options.eastMeters);
    }
    samples.push(
      sampleAt(point, {
        sessionId: options.sessionId,
        recordedAtMs: options.startMs + index * intervalMs,
        id: `${options.sessionId}-${(options.startIndex ?? 0) + index}`,
        speedMps: options.speedMps,
      }),
    );
  }
  return samples;
}

export function dwellSamples(
  point: LatLng,
  options: {
    sessionId: string;
    startMs: number;
    count: number;
    intervalMs?: number;
    startIndex?: number;
    speedMps?: number;
  },
): LocationSample[] {
  const intervalMs = options.intervalMs ?? 1000;
  return Array.from({ length: options.count }, (_, index) =>
    sampleAt(point, {
      sessionId: options.sessionId,
      recordedAtMs: options.startMs + index * intervalMs,
      id: `${options.sessionId}-dwell-${(options.startIndex ?? 0) + index}`,
      speedMps: options.speedMps ?? 0.2,
    }),
  );
}

export function completeJourneySamples(options: {
  origin: Pick<Place, 'center' | 'radiusMeters'>;
  destination: Pick<Place, 'center' | 'radiusMeters'>;
  sessionId: string;
  startMs?: number;
  intervalMs?: number;
  speedMps?: number;
  eastJitterMeters?: number;
}): LocationSample[] {
  const distance = haversineMeters(options.origin.center, options.destination.center);
  if (distance < 80) {
    throw new Error(`completeJourneySamples needs well-separated places, got ${distance.toFixed(1)} m`);
  }
  const startMs = options.startMs ?? 1_700_000_000_000;
  const intervalMs = options.intervalMs ?? 1000;
  const speedMps = options.speedMps ?? 4;
  const dwell = dwellSamples(options.origin.center, {
    sessionId: options.sessionId,
    startMs,
    count: 2,
    intervalMs,
    speedMps: 0.2,
  });
  const travelStart = (dwell[dwell.length - 1]?.recordedAtMs ?? startMs) + intervalMs;
  const travel = linearSamples(options.origin.center, options.destination.center, {
    sessionId: options.sessionId,
    startMs: travelStart,
    speedMps,
    intervalMs,
    eastMeters: options.eastJitterMeters,
    startIndex: dwell.length,
  });
  const arriveStart = (travel[travel.length - 1]?.recordedAtMs ?? travelStart) + intervalMs;
  const arrive = dwellSamples(options.destination.center, {
    sessionId: options.sessionId,
    startMs: arriveStart,
    count: 4,
    intervalMs,
    startIndex: dwell.length + travel.length,
    speedMps: 0.4,
  });
  return [...dwell, ...travel, ...arrive];
}

export function departureOnlySamples(options: {
  origin: Pick<Place, 'center' | 'radiusMeters'>;
  sessionId: string;
  startMs?: number;
  intervalMs?: number;
  speedMps?: number;
  extraMeters?: number;
  headingEastMeters?: number;
}): LocationSample[] {
  const startMs = options.startMs ?? 1_700_000_000_000;
  const intervalMs = options.intervalMs ?? 1000;
  const speedMps = options.speedMps ?? 4;
  const extraMeters = options.extraMeters ?? 25;
  const targetNorth = options.origin.radiusMeters + extraMeters;
  const target = offsetLatLng(
    options.origin.center.latitude,
    options.origin.center.longitude,
    targetNorth,
    options.headingEastMeters ?? 0,
  );
  const dwell = dwellSamples(options.origin.center, {
    sessionId: options.sessionId,
    startMs,
    count: 2,
    intervalMs,
  });
  const travel = linearSamples(options.origin.center, target, {
    sessionId: options.sessionId,
    startMs: (dwell[dwell.length - 1]?.recordedAtMs ?? startMs) + intervalMs,
    speedMps,
    intervalMs,
    startIndex: dwell.length,
  });
  return [...dwell, ...travel];
}

export async function seedPlacesForRoute(
  places: PlaceStore,
  route: Route,
  createPlaceId?: (index: number) => string,
): Promise<{ origin: Place; destination: Place }> {
  const existing = await places.listPlaces();
  const seeded = ensurePlacesForRoute(existing, route, {
    createPlaceId,
    nowMs: route.createdAtMs,
  });
  for (const place of seeded.placesToCreate) {
    await places.createPlace(place);
  }
  const all = await places.listPlaces();
  const origin = all.find((place) => place.id === seeded.assignment.startPlaceId);
  const destination = all.find((place) => place.id === seeded.assignment.finishPlaceId);
  if (!origin || !destination) {
    throw new Error('expected seeded origin and destination places');
  }
  return { origin, destination };
}

export function findSeededPlaces(places: Place[], route: Route): { origin: Place; destination: Place } {
  const origin = places.find(
    (place) => haversineMeters(place.center, route.startZone.center) <= 10,
  );
  const destination = places.find(
    (place) => haversineMeters(place.center, route.finishZone.center) <= 10,
  );
  if (!origin || !destination) {
    throw new Error('expected Home/Work places for route endpoints');
  }
  return { origin, destination };
}
