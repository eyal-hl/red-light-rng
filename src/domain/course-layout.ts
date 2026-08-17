import { pathDistanceMeters, type GeoZone, type LatLng } from './geo';
import { pointAtProgress } from './path-projection';

export const MIN_COURSE_MARKER_SEPARATION_METERS = 10;
export const MIN_ZONE_RADIUS_METERS = 8;
export const MAX_ZONE_RADIUS_METERS = 250;

export type RouteCheckpoint = {
  id: string;
  name: string;
  progressMeters: number;
};

export type CourseLayout = {
  startZone: GeoZone;
  finishZone: GeoZone;
  startProgressMeters: number;
  finishProgressMeters: number;
  checkpoints: RouteCheckpoint[];
};

export type CourseLayoutValidation = {
  valid: boolean;
  reason: string | null;
};

export const MARKERS_TOO_CLOSE_REASON =
  'Course markers must stay at least 10 m apart along the route.';
export const EMPTY_CHECKPOINT_NAME_REASON = 'Every checkpoint needs a name.';
export const INVALID_START_RADIUS_REASON = `Auto-start radius must be between ${MIN_ZONE_RADIUS_METERS} and ${MAX_ZONE_RADIUS_METERS} m.`;
export const INVALID_FINISH_RADIUS_REASON = `Auto-finish radius must be between ${MIN_ZONE_RADIUS_METERS} and ${MAX_ZONE_RADIUS_METERS} m.`;

export function isValidZoneRadiusMeters(radiusMeters: number): boolean {
  return (
    Number.isFinite(radiusMeters) &&
    radiusMeters >= MIN_ZONE_RADIUS_METERS &&
    radiusMeters <= MAX_ZONE_RADIUS_METERS
  );
}

export function parseZoneRadiusInput(text: string): number {
  const normalized = text.trim().replace(',', '.');
  if (normalized.length === 0) {
    return Number.NaN;
  }
  return Number(normalized);
}

export function cloneGeoZone(zone: GeoZone): GeoZone {
  return {
    center: { latitude: zone.center.latitude, longitude: zone.center.longitude },
    radiusMeters: zone.radiusMeters,
  };
}

export function cloneCourseLayout(layout: CourseLayout): CourseLayout {
  return {
    startZone: cloneGeoZone(layout.startZone),
    finishZone: cloneGeoZone(layout.finishZone),
    startProgressMeters: layout.startProgressMeters,
    finishProgressMeters: layout.finishProgressMeters,
    checkpoints: layout.checkpoints.map((checkpoint) => ({ ...checkpoint })),
  };
}

export function orderedCheckpoints(checkpoints: RouteCheckpoint[]): RouteCheckpoint[] {
  return [...checkpoints].sort((a, b) => {
    if (a.progressMeters !== b.progressMeters) {
      return a.progressMeters - b.progressMeters;
    }
    return a.id.localeCompare(b.id);
  });
}

export function defaultCourseProgress(path: LatLng[]): {
  startProgressMeters: number;
  finishProgressMeters: number;
} {
  return {
    startProgressMeters: 0,
    finishProgressMeters: pathDistanceMeters(path),
  };
}

export function checkpointMapPoints(
  path: LatLng[],
  checkpoints: RouteCheckpoint[],
): { id: string; name: string; point: LatLng }[] {
  return orderedCheckpoints(checkpoints).map((checkpoint) => ({
    id: checkpoint.id,
    name: checkpoint.name,
    point: pointAtProgress(path, checkpoint.progressMeters),
  }));
}

export function validateCourseLayout(layout: CourseLayout): CourseLayoutValidation {
  if (!isValidZoneRadiusMeters(layout.startZone.radiusMeters)) {
    return { valid: false, reason: INVALID_START_RADIUS_REASON };
  }
  if (!isValidZoneRadiusMeters(layout.finishZone.radiusMeters)) {
    return { valid: false, reason: INVALID_FINISH_RADIUS_REASON };
  }
  if (layout.checkpoints.some((checkpoint) => checkpoint.name.trim().length === 0)) {
    return { valid: false, reason: EMPTY_CHECKPOINT_NAME_REASON };
  }

  const progresses = [
    layout.startProgressMeters,
    ...orderedCheckpoints(layout.checkpoints).map((checkpoint) => checkpoint.progressMeters),
    layout.finishProgressMeters,
  ];

  for (let index = 1; index < progresses.length; index += 1) {
    const previous = progresses[index - 1];
    const current = progresses[index];
    if (previous == null || current == null) {
      continue;
    }
    if (current - previous < MIN_COURSE_MARKER_SEPARATION_METERS) {
      return { valid: false, reason: MARKERS_TOO_CLOSE_REASON };
    }
  }

  return { valid: true, reason: null };
}
