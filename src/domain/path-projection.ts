import { haversineMeters, type LatLng } from './geo';

export const MAX_EDITOR_SNAP_DISTANCE_METERS = 30;
export const PROJECTION_TIE_EPSILON_METERS = 0.5;
export const MATCH_PROGRESS_COST_PER_METER = 0.3;
export const MATCH_BACKWARD_COST_METERS = 8;
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

type SegmentProjection = PathProjection & {
  segmentStartProgressMeters: number;
  segmentEndProgressMeters: number;
};

type IndexedSegment = {
  start: LatLng;
  end: LatLng;
  segmentStartProgressMeters: number;
  segmentLength: number;
};

type PathProgressIndex = {
  segments: IndexedSegment[];
};

const pathProgressIndexes = new WeakMap<LatLng[], PathProgressIndex>();

function pathProgressIndex(path: LatLng[]): PathProgressIndex {
  const cached = pathProgressIndexes.get(path);
  if (cached) {
    return cached;
  }
  const segments: IndexedSegment[] = [];
  let cumulativeMeters = 0;
  for (let index = 1; index < path.length; index += 1) {
    const start = path[index - 1];
    const end = path[index];
    if (!start || !end) {
      continue;
    }
    const segmentLength = haversineMeters(start, end);
    segments.push({
      start,
      end,
      segmentStartProgressMeters: cumulativeMeters,
      segmentLength,
    });
    cumulativeMeters += segmentLength;
  }
  const created = { segments };
  pathProgressIndexes.set(path, created);
  return created;
}

function projectIndexedSegment(segment: IndexedSegment, point: LatLng): SegmentProjection {
  const closest = closestPointOnSegment(segment.start, segment.end, point);
  const segmentEndProgressMeters = segment.segmentStartProgressMeters + segment.segmentLength;
  return {
    snapped: closest.point,
    progressMeters: segment.segmentStartProgressMeters + closest.t * segment.segmentLength,
    snapDistanceMeters: haversineMeters(closest.point, point),
    segmentStartProgressMeters: segment.segmentStartProgressMeters,
    segmentEndProgressMeters,
  };
}

function firstSegmentReaching(segments: IndexedSegment[], windowStart: number): number {
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid];
    if (!segment) {
      break;
    }
    const segmentEnd = segment.segmentStartProgressMeters + segment.segmentLength;
    if (segmentEnd < windowStart) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function progressWindowBounds(options: {
  centerProgressMeters: number;
  forwardWindowMeters: number;
  backwardWindowMeters: number;
}): { windowStart: number; windowEnd: number } {
  return {
    windowStart: options.centerProgressMeters - options.backwardWindowMeters,
    windowEnd: options.centerProgressMeters + options.forwardWindowMeters,
  };
}

function segmentsInProgressWindow(
  segments: IndexedSegment[],
  windowStart: number,
  windowEnd: number,
): IndexedSegment[] {
  const inWindow: IndexedSegment[] = [];
  for (let index = firstSegmentReaching(segments, windowStart); index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segment.segmentStartProgressMeters > windowEnd) {
      break;
    }
    inWindow.push(segment);
  }
  return inWindow;
}

export function referencePathSegmentCount(path: LatLng[]): number {
  if (path.length <= 1) {
    return 0;
  }
  return pathProgressIndex(path).segments.length;
}

/** Segments the near-progress projection actually scores, not the whole reference path. */
export function progressWindowSegmentCount(
  path: LatLng[],
  options: {
    centerProgressMeters: number;
    forwardWindowMeters: number;
    backwardWindowMeters: number;
  },
): number {
  if (path.length <= 1) {
    return 0;
  }
  const bounds = progressWindowBounds(options);
  return segmentsInProgressWindow(pathProgressIndex(path).segments, bounds.windowStart, bounds.windowEnd).length;
}

function collectSegmentProjections(path: LatLng[], point: LatLng): SegmentProjection[] {
  return pathProgressIndex(path).segments.map((segment) => projectIndexedSegment(segment, point));
}

function pickNearestProjection(
  candidates: PathProjection[],
  score: (candidate: PathProjection) => number,
): PathProjection | null {
  if (candidates.length === 0) {
    return null;
  }

  const ranked = [...candidates].sort((a, b) => {
    const aScore = score(a);
    const bScore = score(b);
    if (aScore !== bScore) {
      return aScore - bScore;
    }
    return b.progressMeters - a.progressMeters;
  });
  const winner = ranked[0];
  if (!winner) {
    return null;
  }
  return {
    snapped: winner.snapped,
    progressMeters: winner.progressMeters,
    snapDistanceMeters: winner.snapDistanceMeters,
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

  const candidates = collectSegmentProjections(path, tap);
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
  const winner = tied[0];
  if (!winner) {
    return null;
  }
  return {
    snapped: winner.snapped,
    progressMeters: winner.progressMeters,
    snapDistanceMeters: winner.snapDistanceMeters,
  };
}

export function projectOntoReferencePathNearProgress(
  path: LatLng[],
  point: LatLng,
  options: {
    centerProgressMeters: number;
    forwardWindowMeters: number;
    backwardWindowMeters: number;
  },
): PathProjection | null {
  if (path.length === 0) {
    return null;
  }
  if (path.length === 1) {
    return projectOntoReferencePath(path, point);
  }

  const bounds = progressWindowBounds(options);
  const inWindow = segmentsInProgressWindow(
    pathProgressIndex(path).segments,
    bounds.windowStart,
    bounds.windowEnd,
  ).map((segment) => projectIndexedSegment(segment, point));

  return pickNearestProjection(inWindow, (candidate) => {
    const delta = candidate.progressMeters - options.centerProgressMeters;
    return (
      candidate.snapDistanceMeters +
      MATCH_PROGRESS_COST_PER_METER * Math.abs(delta) +
      (delta < 0 ? MATCH_BACKWARD_COST_METERS : 0)
    );
  });
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
