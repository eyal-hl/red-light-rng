import type { GpsReadiness } from './gps-readiness';
import { geoZoneExtentPoints, haversineMeters, type LatLng } from './geo';
import type { LocationSample } from './location-sample';
import type { Place } from './place';
import type { PlaceStartZoneStatus } from './place-timing';

/** Display-only. Does not change GPS acceptance, start/finish, or stored samples. */
export const ATTEMPT_MAP_CURRENT_MAX_AGE_MS = 15_000;
export const ATTEMPT_MAP_NEARBY_PLACE_LIMIT = 3;
export const ATTEMPT_MAP_NEARBY_PLACE_METERS = 3_000;

export type AttemptLiveMapLifecycle = 'armed' | 'active';
export type AttemptMapViewMode = 'auto' | 'manual';

export type AttemptLiveMapPlace = {
  id: string;
  name: string;
  center: LatLng;
  radiusMeters: number;
  emphasized: boolean;
};

export type AttemptLiveMapMarker =
  | {
      confidence: 'hidden';
      point: null;
      horizontalAccuracyMeters: null;
      ageMs: null;
      label: null;
    }
  | {
      confidence: 'current' | 'last-known';
      point: LatLng;
      horizontalAccuracyMeters: number | null;
      ageMs: number;
      label: string;
    };

export type AttemptLiveMapModel = {
  interactive: boolean;
  places: AttemptLiveMapPlace[];
  marker: AttemptLiveMapMarker;
  /** Coordinate used to choose the initial frame. Null when no sample exists. */
  anchor: LatLng | null;
  nearbyPlaceIds: string[];
  viewportPoints: LatLng[];
  statusNote: string | null;
  emptyPlacesNote: string | null;
  distantPlacesNote: string | null;
  emphasizesInsidePlace: boolean;
};

export function shouldRenderAttemptMap(appState: string): boolean {
  return appState === 'active';
}

export function nextAttemptMapViewMode(input: {
  mode: AttemptMapViewMode;
  interactive: boolean;
  userInteraction: boolean;
  recenterRequested: boolean;
}): AttemptMapViewMode {
  if (!input.interactive || input.recenterRequested) {
    return 'auto';
  }
  if (input.userInteraction) {
    return 'manual';
  }
  return input.mode;
}

/**
 * One duration-0 fit when an armed, possibly panned map becomes the passive active map.
 * Active has no pan or recenter, so the visible frame must come back to the rider.
 */
export function shouldSnapActiveAttemptCamera(input: {
  interactive: boolean;
  wasInteractive: boolean;
}): boolean {
  return input.wasInteractive && !input.interactive;
}

/**
 * Active glance map: one duration-0 fit when the rider leaves the frame that was
 * actually fitted. Armed maps stay put so a manual pan is not overwritten.
 */
export function shouldFollowActiveAttemptCamera(input: {
  interactive: boolean;
  hasAnchor: boolean;
  anchorOutsideFrame: boolean;
}): boolean {
  return !input.interactive && input.hasAnchor && input.anchorOutsideFrame;
}

export function anchorOutsideCameraBounds(
  anchor: LatLng | null,
  bounds: readonly [number, number, number, number] | null,
): boolean {
  if (!anchor || !bounds) {
    return false;
  }
  const [west, south, east, north] = bounds;
  return (
    anchor.longitude < west ||
    anchor.longitude > east ||
    anchor.latitude < south ||
    anchor.latitude > north
  );
}

/**
 * One catch-up fit when the first frame had no position and a sample later arrives.
 * Manual pan and an already-framed map do not follow later samples.
 */
export function shouldRefitAttemptCamera(input: {
  mode: AttemptMapViewMode;
  hasAnchor: boolean;
  initialHadAnchor: boolean;
  caughtUp: boolean;
}): boolean {
  if (input.mode === 'manual' || input.caughtUp || input.initialHadAnchor || !input.hasAnchor) {
    return false;
  }
  return true;
}

export function sameAttemptLocationSample(
  left: LocationSample | null,
  right: LocationSample | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.id === right.id &&
    left.recordedAtMs === right.recordedAtMs &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.horizontalAccuracyMeters === right.horizontalAccuracyMeters
  );
}

export function sameAttemptPlaces(left: readonly Place[], right: readonly Place[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) {
      return false;
    }
    if (
      a.id !== b.id ||
      a.name !== b.name ||
      a.status !== b.status ||
      a.radiusMeters !== b.radiusMeters ||
      a.center.latitude !== b.center.latitude ||
      a.center.longitude !== b.center.longitude
    ) {
      return false;
    }
  }
  return true;
}

export function sameGpsReadiness(left: GpsReadiness, right: GpsReadiness): boolean {
  return left.state === right.state && left.horizontalAccuracyMeters === right.horizontalAccuracyMeters;
}

export function formatAttemptMapAccuracy(meters: number | null): string | null {
  if (meters == null || !Number.isFinite(meters)) {
    return null;
  }
  return `±${Math.round(meters)} m`;
}

export function formatLastKnownAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds <= 0) {
    return 'Last known just now';
  }
  if (seconds < 60) {
    return `Last known ${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  return `Last known ${minutes}m ago`;
}

function samplePoint(sample: LocationSample): LatLng {
  return { latitude: sample.latitude, longitude: sample.longitude };
}

function nearbyPlaces(anchor: LatLng, places: readonly Place[]): Place[] {
  return places
    .map((place) => ({ place, distance: haversineMeters(anchor, place.center) }))
    .filter((item) => item.distance <= ATTEMPT_MAP_NEARBY_PLACE_METERS)
    .sort((a, b) => a.distance - b.distance || a.place.id.localeCompare(b.place.id))
    .slice(0, ATTEMPT_MAP_NEARBY_PLACE_LIMIT)
    .map((item) => item.place);
}

export function presentAttemptLiveMap(input: {
  lifecycle: AttemptLiveMapLifecycle;
  latestSample: LocationSample | null;
  sampleGpsReadiness: GpsReadiness;
  places: readonly Place[];
  startZoneStatus: PlaceStartZoneStatus;
  nowMs: number;
}): AttemptLiveMapModel {
  const anchor = input.latestSample ? samplePoint(input.latestSample) : null;
  const nearby = anchor ? nearbyPlaces(anchor, input.places) : [];
  const insidePlaceId =
    input.startZoneStatus.status === 'inside' ? input.startZoneStatus.placeId : null;
  const places = input.places.map((place) => ({
    id: place.id,
    name: place.name,
    center: { latitude: place.center.latitude, longitude: place.center.longitude },
    radiusMeters: place.radiusMeters,
    emphasized: insidePlaceId != null && place.id === insidePlaceId,
  }));
  const marker = presentMarker(input.latestSample, input.sampleGpsReadiness, input.nowMs);
  const viewportPoints: LatLng[] = [];
  if (anchor) {
    viewportPoints.push(anchor);
  }
  for (const place of nearby) {
    const zone = { center: place.center, radiusMeters: place.radiusMeters };
    viewportPoints.push(place.center, ...geoZoneExtentPoints(zone));
  }

  return {
    interactive: input.lifecycle === 'armed',
    places,
    marker,
    anchor,
    nearbyPlaceIds: nearby.map((place) => place.id),
    viewportPoints,
    statusNote: marker.confidence === 'hidden' ? 'Waiting for GPS location' : marker.label,
    emptyPlacesNote: input.places.length === 0 ? 'No saved places yet.' : null,
    distantPlacesNote:
      input.places.length > nearby.length ? 'Other saved places are outside this view.' : null,
    emphasizesInsidePlace: places.some((place) => place.emphasized),
  };
}

function presentMarker(
  sample: LocationSample | null,
  readiness: GpsReadiness,
  nowMs: number,
): AttemptLiveMapMarker {
  if (!sample || readiness.state === 'waiting') {
    return {
      confidence: 'hidden',
      point: null,
      horizontalAccuracyMeters: null,
      ageMs: null,
      label: null,
    };
  }
  const ageMs = Math.max(0, nowMs - sample.recordedAtMs);
  const accuracy = sample.horizontalAccuracyMeters;
  const accuracyText = formatAttemptMapAccuracy(accuracy);
  if (readiness.state === 'poor' || ageMs > ATTEMPT_MAP_CURRENT_MAX_AGE_MS) {
    const ageText = formatLastKnownAge(ageMs);
    return {
      confidence: 'last-known',
      point: samplePoint(sample),
      horizontalAccuracyMeters: accuracy,
      ageMs,
      label: accuracyText ? `${ageText} · ${accuracyText}` : ageText,
    };
  }
  return {
    confidence: 'current',
    point: samplePoint(sample),
    horizontalAccuracyMeters: accuracy,
    ageMs,
    label: accuracyText ?? 'Current location',
  };
}
