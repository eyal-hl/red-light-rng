import type { Attempt } from '../../src/domain/attempt';
import type { CompetitiveCheckpoint, CompetitiveCheckpointConfig } from '../../src/domain/competitive-checkpoint';
import type { LocationSample } from '../../src/domain/location-sample';
import type { Place } from '../../src/domain/place';
import { makePlace } from './places';
import { offsetLatLng, sample } from './samples';

export const LAT0 = 32.08;
export const LON0 = 34.78;
export const T0 = 1_700_000_000_000;

/** A point `north` metres north (and `east` metres east) of the origin place A. */
export function pt(north: number, east = 0) {
  return offsetLatLng(LAT0, LON0, north, east);
}

export const ORIGIN: Place = makePlace({ id: 'a', name: 'Work', center: pt(0), radiusMeters: 30 });
export const DESTINATION: Place = makePlace({ id: 'c', name: 'Home', center: pt(450), radiusMeters: 30 });
export const POOL = { originPlaceId: 'a', destinationPlaceId: 'c', transportationMode: 'scooter' as const };

export function checkpoint(id: string, north: number, radiusMeters = 20, east = 0): CompetitiveCheckpoint {
  return { id, name: id.toUpperCase(), center: pt(north, east), radiusMeters };
}

export function config(checkpoints: CompetitiveCheckpoint[], version = 1): CompetitiveCheckpointConfig {
  return {
    id: `config-${version}`,
    pool: { ...POOL },
    version,
    status: 'current',
    createdAtMs: T0,
    checkpoints,
  };
}

/** One sample per `[seconds since T0, north metres, east metres?]`, accuracy 5 m unless given. */
export function track(
  points: Array<[number, number, number?, number?]>,
  sessionId = 'session',
): LocationSample[] {
  return points.map(([seconds, north, east, accuracy], index) => {
    const at = pt(north, east ?? 0);
    return sample({
      id: `${sessionId}-${index}`,
      sessionId,
      recordedAtMs: T0 + seconds * 1000,
      latitude: at.latitude,
      longitude: at.longitude,
      horizontalAccuracyMeters: accuracy ?? 5,
    });
  });
}

/**
 * 1 Hz ride heading north at `speed` m/s from `fromNorth`, one sample per second from `fromSeconds`
 * to `toSeconds` inclusive. Position is clamped at `maxNorth`.
 */
export function ride(options: {
  fromNorth?: number;
  speed?: number;
  fromSeconds?: number;
  toSeconds?: number;
  maxNorth?: number;
  east?: number;
}): Array<[number, number, number?]> {
  const fromNorth = options.fromNorth ?? 0;
  const speed = options.speed ?? 6;
  const fromSeconds = options.fromSeconds ?? 0;
  const toSeconds = options.toSeconds ?? 80;
  const maxNorth = options.maxNorth ?? 480;
  const out: Array<[number, number, number?]> = [];
  for (let s = fromSeconds; s <= toSeconds; s += 1) {
    out.push([s, Math.min(maxNorth, fromNorth + speed * (s - fromSeconds)), options.east ?? 0]);
  }
  return out;
}

export function fullAttempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'attempt-1',
    routeId: null,
    originPlaceId: 'a',
    destinationPlaceId: 'c',
    transportationMode: 'scooter',
    sessionId: 'session',
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: T0 - 1000,
    // A leaves its 30 m departure radius at 30 m / 6 m/s = 5 s; C's 30 m arrival radius is
    // crossed at 420 m / 6 m/s = 70 s.
    startedAtMs: T0 + 5000,
    finishedAtMs: T0 + 70_000,
    startedUtcOffsetMinutes: null,
    startedTimezoneId: null,
    startedLocalTimeSource: null,
    resultAcknowledged: true,
    hiddenIncomplete: false,
    crossings: [],
    reconciliationStatus: 'reconciled',
    reconciliationVersion: 1,
    kind: 'full',
    startCheckpointId: null,
    checkpointConfigVersion: null,
    ...overrides,
  };
}

export function partialAttempt(
  startCheckpointId: string,
  startedAtMs: number,
  finishedAtMs: number,
  overrides: Partial<Attempt> = {},
): Attempt {
  return fullAttempt({
    id: 'attempt-partial',
    kind: 'partial',
    startCheckpointId,
    checkpointConfigVersion: 1,
    startedAtMs,
    finishedAtMs,
    ...overrides,
  });
}
