import { haversineMeters, type LatLng } from './geo';

export const MAX_EDITOR_SNAP_DISTANCE_METERS = 30;
export const PROJECTION_TIE_EPSILON_METERS = 0.5;
export const TAP_TOO_FAR_REASON = 'Tap closer to the route.';

export type PathProjection = {
  snapped: LatLng;
  progressMeters: number;
  snapDistanceMeters: number;
};

export type EditorSnapResult =
  | { ok: true; projection: PathProjection }
  | { ok: false; reason: string };

const METERS_PER_DEGREE_LAT = 111_320;

function toLocalMeters(origin: LatLng, point: LatLng): { x: number; y: number } {
  const lngMeters = METERS_PER_DEGREE_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  return {
    x: (point.longitude - origin.longitude) * lngMeters,
    y: (point.latitude - origin.latitude) * METERS_PER_DEGREE_LAT,
  };
}

function fromLocalMeters(origin: LatLng, local: { x: number; y: number }): LatLng {
  const lngMeters = METERS_PER_DEGREE_LAT * Math.cos((origin.latitude * Math.PI) / 180);
  return {
    latitude: origin.latitude + local.y / METERS_PER_DEGREE_LAT,
    longitude: origin.longitude + local.x / lngMeters,
  };
}

function closestPointOnSegment(
  start: LatLng,
  end: LatLng,
  tap: LatLng,
): { point: LatLng; t: number } {
  const endLocal = toLocalMeters(start, end);
  const tapLocal = toLocalMeters(start, tap);
  const lengthSquared = endLocal.x * endLocal.x + endLocal.y * endLocal.y;
  let t = 0;
  if (lengthSquared > 0) {
    t = (tapLocal.x * endLocal.x + tapLocal.y * endLocal.y) / lengthSquared;
    t = Math.min(1, Math.max(0, t));
  }
  return {
    point: fromLocalMeters(start, { x: endLocal.x * t, y: endLocal.y * t }),
    t,
  };
}

export function projectOntoReferencePath(path: LatLng[], tap: LatLng): PathProjection | null {
  if (path.length === 0) {
    return null;
  }
  if (path.length === 1) {
    const only = path[0];
    if (!only) {
      return null;
    }
    return {
      snapped: { ...only },
      progressMeters: 0,
      snapDistanceMeters: haversineMeters(only, tap),
    };
  }

  const candidates: PathProjection[] = [];
  let cumulativeMeters = 0;

  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    if (!start || !end) {
      continue;
    }
    const segmentLength = haversineMeters(start, end);
    const closest = closestPointOnSegment(start, end, tap);
    candidates.push({
      snapped: closest.point,
      progressMeters: cumulativeMeters + closest.t * segmentLength,
      snapDistanceMeters: haversineMeters(closest.point, tap),
    });
    cumulativeMeters += segmentLength;
  }

  if (candidates.length === 0) {
    return null;
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.snapDistanceMeters < minDistance) {
      minDistance = candidate.snapDistanceMeters;
    }
  }

  const tied = candidates.filter(
    (candidate) => candidate.snapDistanceMeters <= minDistance + PROJECTION_TIE_EPSILON_METERS,
  );
  tied.sort((a, b) => a.progressMeters - b.progressMeters);
  return tied[0] ?? null;
}

export function pointAtProgress(path: LatLng[], progressMeters: number): LatLng {
  const first = path[0];
  if (!first) {
    return { latitude: 0, longitude: 0 };
  }
  if (path.length === 1 || progressMeters <= 0) {
    return { ...first };
  }

  let remaining = progressMeters;
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    if (!start || !end) {
      continue;
    }
    const segmentLength = haversineMeters(start, end);
    if (remaining <= segmentLength || index === path.length - 1) {
      const t = segmentLength > 0 ? Math.min(1, Math.max(0, remaining / segmentLength)) : 0;
      const endLocal = toLocalMeters(start, end);
      return fromLocalMeters(start, { x: endLocal.x * t, y: endLocal.y * t });
    }
    remaining -= segmentLength;
  }

  const last = path[path.length - 1] ?? first;
  return { ...last };
}

export function snapEditorTap(path: LatLng[], tap: LatLng): EditorSnapResult {
  const projection = projectOntoReferencePath(path, tap);
  if (!projection) {
    return { ok: false, reason: TAP_TOO_FAR_REASON };
  }
  if (projection.snapDistanceMeters > MAX_EDITOR_SNAP_DISTANCE_METERS) {
    return { ok: false, reason: TAP_TOO_FAR_REASON };
  }
  return { ok: true, projection };
}
