import { haversineMeters, pathDistanceMeters, type GeoZone, type LatLng } from './geo';
import type { LocationSample } from './location-sample';

export const MAX_HORIZONTAL_ACCURACY_METERS = 25;
export const MIN_STEP_METERS = 6;
export const MIN_MOVING_SPEED_MPS = 0.8;
export const SUSTAINED_MOVEMENT_SAMPLES = 3;
export const MIN_REFERENCE_POINTS = 3;
export const MIN_START_FINISH_SEPARATION_METERS = 10;
export const DEFAULT_ZONE_RADIUS_METERS = 30;

export type RouteDerivation = {
  saveable: boolean;
  reason: string | null;
  referencePath: LatLng[];
  distanceMeters: number;
  startZone: GeoZone | null;
  finishZone: GeoZone | null;
};

const UNSAVEABLE: RouteDerivation = {
  saveable: false,
  reason: 'This recording is too short or low-quality to save as a route.',
  referencePath: [],
  distanceMeters: 0,
  startZone: null,
  finishZone: null,
};

function toLatLng(sample: LocationSample): LatLng {
  return { latitude: sample.latitude, longitude: sample.longitude };
}

function isAccurateEnough(sample: LocationSample): boolean {
  if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) {
    return false;
  }
  if (sample.horizontalAccuracyMeters == null) {
    return true;
  }
  return sample.horizontalAccuracyMeters <= MAX_HORIZONTAL_ACCURACY_METERS;
}

function isMovingSample(sample: LocationSample, previous: LocationSample | null): boolean {
  if (sample.speedMetersPerSecond != null && sample.speedMetersPerSecond >= MIN_MOVING_SPEED_MPS) {
    return true;
  }
  if (previous == null) {
    return false;
  }
  return haversineMeters(toLatLng(previous), toLatLng(sample)) >= MIN_STEP_METERS;
}

function simplifyPath(samples: LocationSample[]): LocationSample[] {
  const kept: LocationSample[] = [];
  for (const sample of samples) {
    const last = kept[kept.length - 1];
    if (!last) {
      kept.push(sample);
      continue;
    }
    const stationary =
      sample.speedMetersPerSecond != null && sample.speedMetersPerSecond < MIN_MOVING_SPEED_MPS;
    if (stationary) {
      continue;
    }
    if (haversineMeters(toLatLng(last), toLatLng(sample)) < MIN_STEP_METERS) {
      continue;
    }
    kept.push(sample);
  }
  return kept;
}

function findSustainedMovementBounds(samples: LocationSample[]): { startIndex: number; finishIndex: number } | null {
  if (samples.length < SUSTAINED_MOVEMENT_SAMPLES) {
    return null;
  }

  const moving = samples.map((sample, index) => isMovingSample(sample, samples[index - 1] ?? null));

  let startIndex: number | null = null;
  for (let index = 0; index <= moving.length - SUSTAINED_MOVEMENT_SAMPLES; index += 1) {
    if (
      moving[index] &&
      moving[index + 1] &&
      moving[index + 2]
    ) {
      startIndex = index;
      break;
    }
  }

  let finishIndex: number | null = null;
  for (let index = moving.length - SUSTAINED_MOVEMENT_SAMPLES; index >= 0; index -= 1) {
    if (
      moving[index] &&
      moving[index + 1] &&
      moving[index + 2]
    ) {
      finishIndex = index + SUSTAINED_MOVEMENT_SAMPLES - 1;
      break;
    }
  }

  if (startIndex == null || finishIndex == null || finishIndex <= startIndex) {
    return null;
  }

  return { startIndex, finishIndex };
}

export function deriveRouteGeometry(samples: LocationSample[]): RouteDerivation {
  const qualitySamples = samples.filter(isAccurateEnough);
  if (qualitySamples.length < MIN_REFERENCE_POINTS) {
    return UNSAVEABLE;
  }

  const bounds = findSustainedMovementBounds(qualitySamples);
  if (!bounds) {
    return UNSAVEABLE;
  }

  const startSample = qualitySamples[bounds.startIndex];
  const finishSample = qualitySamples[bounds.finishIndex];
  if (!startSample || !finishSample) {
    return UNSAVEABLE;
  }

  const startCenter = toLatLng(startSample);
  const finishCenter = toLatLng(finishSample);
  const separation = haversineMeters(startCenter, finishCenter);
  if (separation < MIN_START_FINISH_SEPARATION_METERS) {
    return {
      ...UNSAVEABLE,
      reason: 'Start and finish are too close to save as a route.',
    };
  }

  const trimmed = qualitySamples.slice(bounds.startIndex, bounds.finishIndex + 1);
  const referenceSamples = simplifyPath(trimmed);
  if (referenceSamples.length < MIN_REFERENCE_POINTS) {
    return UNSAVEABLE;
  }

  const referencePath = referenceSamples.map(toLatLng);
  return {
    saveable: true,
    reason: null,
    referencePath,
    distanceMeters: pathDistanceMeters(referencePath),
    startZone: { center: startCenter, radiusMeters: DEFAULT_ZONE_RADIUS_METERS },
    finishZone: { center: finishCenter, radiusMeters: DEFAULT_ZONE_RADIUS_METERS },
  };
}
