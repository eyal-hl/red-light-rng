import { geoZoneExtentPoints, haversineMeters, type LatLng } from './geo';
import { MAX_SAMPLE_ACCURACY_METERS } from './course-matching';
import type { PlaceStartZoneStatus, PlaceTimingPlace } from './place-timing';

/**
 * Read-only presentation data for the ARMED/ACTIVE attempt map.
 *
 * Everything here is derived from data the attempt engine already loaded in a
 * single `processActiveWithStartZoneStatus` call: the persisted samples and the
 * exact place set `placesForAttempt` fed to the engine. Nothing in this module
 * (or the map UI that consumes it) may start a watcher, poll the OS for a
 * position, or query places separately.
 */

/** A fix older than this is shown only as a muted last-known position. */
export const LIVE_MAP_FRESH_FIX_MAX_AGE_MS = 15_000;
/** Initial viewport includes at most this many places... */
export const LIVE_MAP_MAX_VIEWPORT_PLACES = 3;
/** ...and only places within this distance of the current position. */
export const LIVE_MAP_VIEWPORT_RADIUS_METERS = 3_000;

export type AttemptLiveMapPlace = {
  id: string;
  name: string;
  center: LatLng;
  /** Configured detection radius only; no confirmation thresholds. */
  radiusMeters: number;
};

export type AttemptLiveMapFix = {
  latitude: number;
  longitude: number;
  horizontalAccuracyMeters: number | null;
  recordedAtMs: number;
};

export type AttemptLiveMapData = {
  /** Exact engine-effective place set (active places plus origin/destination extras). */
  places: AttemptLiveMapPlace[];
  /** Latest persisted attempt sample, if any. */
  latestFix: AttemptLiveMapFix | null;
  /** Runtime clock at the moment this snapshot was computed. */
  observedAtMs: number;
};

export const EMPTY_ATTEMPT_LIVE_MAP: AttemptLiveMapData = {
  places: [],
  latestFix: null,
  observedAtMs: 0,
};

export function liveMapPlaces(places: PlaceTimingPlace[]): AttemptLiveMapPlace[] {
  return places.map((place) => ({
    id: place.id,
    name: place.name,
    center: { latitude: place.center.latitude, longitude: place.center.longitude },
    radiusMeters: place.radiusMeters,
  }));
}

export function liveMapFix(
  sample: {
    latitude: number;
    longitude: number;
    horizontalAccuracyMeters: number | null;
    recordedAtMs: number;
  } | null | undefined,
): AttemptLiveMapFix | null {
  if (!sample) {
    return null;
  }
  return {
    latitude: sample.latitude,
    longitude: sample.longitude,
    horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
    recordedAtMs: sample.recordedAtMs,
  };
}

export type CurrentPositionMarker =
  | {
      kind: 'fresh';
      point: LatLng;
      accuracyMeters: number | null;
      ageMs: number;
    }
  | {
      kind: 'last-known';
      point: LatLng;
      accuracyMeters: number | null;
      ageMs: number;
      reason: 'poor-accuracy' | 'stale' | 'poor-accuracy-and-stale';
    }
  | { kind: 'unavailable'; point: null; accuracyMeters: null; ageMs: null };

/**
 * Trustworthy = same accuracy gate the engine uses (`isAccuracyAccepted`:
 * null or at most `MAX_SAMPLE_ACCURACY_METERS`) and recorded within 15 s. Anything else with coordinates is a
 * muted last-known position; no coordinates is honestly unavailable.
 */
export function classifyCurrentPosition(
  fix: AttemptLiveMapFix | null,
  observedAtMs: number,
): CurrentPositionMarker {
  if (
    !fix ||
    !Number.isFinite(fix.latitude) ||
    !Number.isFinite(fix.longitude) ||
    !Number.isFinite(fix.recordedAtMs)
  ) {
    return { kind: 'unavailable', point: null, accuracyMeters: null, ageMs: null };
  }
  const ageMs = Math.max(0, observedAtMs - fix.recordedAtMs);
  const point = { latitude: fix.latitude, longitude: fix.longitude };
  const accurate =
    fix.horizontalAccuracyMeters == null || fix.horizontalAccuracyMeters <= MAX_SAMPLE_ACCURACY_METERS;
  const recent = ageMs <= LIVE_MAP_FRESH_FIX_MAX_AGE_MS;
  if (accurate && recent) {
    return { kind: 'fresh', point, accuracyMeters: fix.horizontalAccuracyMeters, ageMs };
  }
  return {
    kind: 'last-known',
    point,
    accuracyMeters: fix.horizontalAccuracyMeters,
    ageMs,
    reason: !accurate && !recent ? 'poor-accuracy-and-stale' : !accurate ? 'poor-accuracy' : 'stale',
  };
}

export function formatLiveMapCaption(marker: CurrentPositionMarker): string {
  if (marker.kind === 'unavailable') {
    return 'Waiting for a GPS fix';
  }
  const accuracy = marker.accuracyMeters != null ? `±${Math.round(marker.accuracyMeters)} m` : 'accuracy unknown';
  const seconds = Math.round(marker.ageMs / 1000);
  const age = seconds < 60 ? `${seconds} s ago` : `${Math.floor(seconds / 60)} min ago`;
  if (marker.kind === 'fresh') {
    return `Current position · ${accuracy}`;
  }
  return `Last known position (not current) · ${accuracy} · ${age}`;
}

/** At most 3 nearest places within 3 km of the position, nearest first. */
export function selectViewportPlaces(
  position: LatLng | null,
  places: AttemptLiveMapPlace[],
): AttemptLiveMapPlace[] {
  if (!position) {
    return [];
  }
  return places
    .map((place) => ({ place, distance: haversineMeters(position, place.center) }))
    .filter((item) => item.distance <= LIVE_MAP_VIEWPORT_RADIUS_METERS)
    .sort((a, b) => a.distance - b.distance || (a.place.id < b.place.id ? -1 : 1))
    .slice(0, LIVE_MAP_MAX_VIEWPORT_PLACES)
    .map((item) => item.place);
}

export type LiveMapBounds = [number, number, number, number];

function boundsOf(points: LatLng[]): LiveMapBounds | null {
  if (points.length === 0) {
    return null;
  }
  const lats = points.map((item) => item.latitude);
  const lngs = points.map((item) => item.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latPad = Math.max((maxLat - minLat) * 0.15, 0.0008);
  const lngPad = Math.max((maxLng - minLng) * 0.15, 0.0008);
  return [minLng - lngPad, minLat - latPad, maxLng + lngPad, maxLat + latPad];
}

/**
 * Initial viewport. With a position: the position plus its nearby places
 * (including their radii). Without any position: all effective places, so a
 * missing fix still shows where the saved places are. Null when nothing to show.
 */
export function initialViewportBounds(
  position: LatLng | null,
  places: AttemptLiveMapPlace[],
): LiveMapBounds | null {
  const chosen = position ? selectViewportPlaces(position, places) : places;
  const points: LatLng[] = position ? [position] : [];
  for (const place of chosen) {
    points.push(place.center, ...geoZoneExtentPoints(place));
  }
  return boundsOf(points);
}

export function positionOutsideBounds(position: LatLng, bounds: LiveMapBounds, insetFraction = 0.1): boolean {
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const lngInset = (maxLng - minLng) * insetFraction;
  const latInset = (maxLat - minLat) * insetFraction;
  return (
    position.longitude < minLng + lngInset ||
    position.longitude > maxLng - lngInset ||
    position.latitude < minLat + latInset ||
    position.latitude > maxLat - latInset
  );
}

/**
 * Only an official-start-zone `inside` status may highlight a place. While the
 * start zone is LOCATING (no good GPS) or after the attempt has left ARMED the
 * engine reports `locating`, so nothing is highlighted.
 */
export function inZonePlaceId(status: PlaceStartZoneStatus, places: AttemptLiveMapPlace[]): string | null {
  if (status.status !== 'inside' || status.placeId == null) {
    return null;
  }
  return places.some((place) => place.id === status.placeId) ? status.placeId : null;
}

// ---------------------------------------------------------------------------
// Interactivity
// ---------------------------------------------------------------------------

export type LiveMapInteractivity = {
  dragPan: boolean;
  touchZoom: boolean;
  doubleTapZoom: boolean;
  doubleTapHoldZoom: boolean;
  touchRotate: boolean;
  touchPitch: boolean;
  recenterControl: boolean;
  /** Passive maps must not intercept touches (scrolling / buttons stay usable). */
  capturesTouches: boolean;
};

export function liveMapInteractivity(lifecycle: 'armed' | 'active'): LiveMapInteractivity {
  if (lifecycle === 'armed') {
    return {
      dragPan: true,
      touchZoom: true,
      doubleTapZoom: true,
      doubleTapHoldZoom: false,
      touchRotate: false,
      touchPitch: false,
      recenterControl: true,
      capturesTouches: true,
    };
  }
  return {
    dragPan: false,
    touchZoom: false,
    doubleTapZoom: false,
    doubleTapHoldZoom: false,
    touchRotate: false,
    touchPitch: false,
    recenterControl: false,
    capturesTouches: false,
  };
}

// ---------------------------------------------------------------------------
// Camera state machine
// ---------------------------------------------------------------------------

export type LiveMapCameraState = {
  /**
   * awaiting-fit: nothing positioned yet (or only placeholder places framing)
   * fitted: initial/recenter fit applied
   * user: the user panned/zoomed; no automatic camera movement until recenter
   */
  mode: 'awaiting-fit' | 'fitted' | 'user';
  /** Increments on every programmatic fit; the view applies a fit only when it changes. */
  fitSeq: number;
  fitBounds: LiveMapBounds | null;
  /** True once the fit used a real position (not just places). */
  fittedToPosition: boolean;
};

export const INITIAL_LIVE_MAP_CAMERA: LiveMapCameraState = {
  mode: 'awaiting-fit',
  fitSeq: 0,
  fitBounds: null,
  fittedToPosition: false,
};

export type LiveMapCameraEvent =
  | { type: 'view'; position: LatLng | null; places: AttemptLiveMapPlace[]; lifecycle: 'armed' | 'active' }
  | { type: 'user-gesture' }
  | { type: 'recenter'; position: LatLng | null; places: AttemptLiveMapPlace[] };

function fitted(
  state: LiveMapCameraState,
  bounds: LiveMapBounds,
  toPosition: boolean,
): LiveMapCameraState {
  return { mode: 'fitted', fitSeq: state.fitSeq + 1, fitBounds: bounds, fittedToPosition: toPosition };
}

/**
 * Pure camera policy:
 * - first view fits places (no fix yet) or position + nearby places;
 * - the first real position refits once, unless the user already moved the map;
 * - after a user gesture the camera is never moved again except by an explicit
 *   recenter (ARMED only; ACTIVE has no gestures or recenter control);
 * - a passive ACTIVE map jumps (no animation) only when the position leaves the
 *   framed area.
 */
export function reduceLiveMapCamera(
  state: LiveMapCameraState,
  event: LiveMapCameraEvent,
): LiveMapCameraState {
  if (event.type === 'user-gesture') {
    return state.mode === 'user' ? state : { ...state, mode: 'user' };
  }
  if (event.type === 'recenter') {
    const bounds = initialViewportBounds(event.position, event.places);
    return bounds ? fitted(state, bounds, event.position != null) : state;
  }
  if (state.mode === 'user' && event.lifecycle === 'armed') {
    return state;
  }
  const bounds = initialViewportBounds(event.position, event.places);
  if (!bounds) {
    return state;
  }
  if (state.mode === 'awaiting-fit') {
    return fitted(state, bounds, event.position != null);
  }
  if (!state.fittedToPosition && event.position && state.mode === 'fitted') {
    return fitted(state, bounds, true);
  }
  if (
    event.lifecycle === 'active' &&
    event.position &&
    state.fitBounds &&
    positionOutsideBounds(event.position, state.fitBounds)
  ) {
    return fitted(state, bounds, true);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Visibility and display mode
// ---------------------------------------------------------------------------

/** The map is displayed only in the foreground; never affects tracking. */
export function isLiveMapDisplayAllowed(appState: string): boolean {
  return appState === 'active';
}

export type LiveMapDisplayMode = 'map' | 'fallback' | 'hidden';

export function resolveLiveMapDisplay(input: {
  appState: string;
  rendererFailed: boolean;
  tilesFailed: boolean;
}): LiveMapDisplayMode {
  if (!isLiveMapDisplayAllowed(input.appState)) {
    return 'hidden';
  }
  return input.rendererFailed || input.tilesFailed ? 'fallback' : 'map';
}

export type LiveMapVisibilitySource = {
  getState: () => string;
  subscribe: (listener: (state: string) => void) => () => void;
};

/**
 * Tracks foreground visibility for the map only. It deliberately holds no
 * reference to the tracker, platform or runtime.
 */
export function createLiveMapVisibility(source: LiveMapVisibilitySource) {
  let visible = isLiveMapDisplayAllowed(source.getState());
  const listeners = new Set<(visible: boolean) => void>();
  const unsubscribe = source.subscribe((state) => {
    const next = isLiveMapDisplayAllowed(state);
    if (next === visible) {
      return;
    }
    visible = next;
    for (const listener of listeners) {
      listener(visible);
    }
  });
  return {
    isVisible: () => visible,
    subscribe(listener: (visible: boolean) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers shared by the MapLibre and fallback renderers
// ---------------------------------------------------------------------------

export function placeCirclePolygon(center: LatLng, radiusMeters: number, steps = 48): number[][] {
  const latMeters = 111_320;
  const lngMeters = Math.max(1e-6, 111_320 * Math.cos((center.latitude * Math.PI) / 180));
  const coordinates: number[][] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    coordinates.push([
      center.longitude + (radiusMeters * Math.cos(angle)) / lngMeters,
      center.latitude + (radiusMeters * Math.sin(angle)) / latMeters,
    ]);
  }
  return coordinates;
}

export type FallbackLiveMapLayout = {
  places: { id: string; name: string; xPercent: number; yPercent: number; diameterPercent: number }[];
  marker: { xPercent: number; yPercent: number } | null;
};

/** Offline schematic: normalised positions inside the same bounds the map would frame. */
export function fallbackLiveMapLayout(
  bounds: LiveMapBounds | null,
  places: AttemptLiveMapPlace[],
  position: LatLng | null,
): FallbackLiveMapLayout {
  if (!bounds) {
    return { places: [], marker: null };
  }
  const [minLng, minLat, maxLng, maxLat] = bounds;
  const width = Math.max(maxLng - minLng, 1e-9);
  const height = Math.max(maxLat - minLat, 1e-9);
  const clamp = (value: number) => Math.min(100, Math.max(0, value));
  const toPoint = (point: LatLng) => ({
    xPercent: clamp(((point.longitude - minLng) / width) * 100),
    yPercent: clamp(100 - ((point.latitude - minLat) / height) * 100),
  });
  return {
    places: places
      .filter(
        (place) =>
          place.center.longitude >= minLng &&
          place.center.longitude <= maxLng &&
          place.center.latitude >= minLat &&
          place.center.latitude <= maxLat,
      )
      .map((place) => {
        const [dLng] = geoZoneExtentPoints({ center: place.center, radiusMeters: place.radiusMeters }).slice(2, 3);
        const radiusLng = dLng ? dLng.longitude - place.center.longitude : 0;
        return {
          id: place.id,
          name: place.name,
          ...toPoint(place.center),
          diameterPercent: Math.min(100, Math.max(4, ((radiusLng * 2) / width) * 100)),
        };
      }),
    marker: position ? toPoint(position) : null,
  };
}
