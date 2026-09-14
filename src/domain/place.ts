import {
  isValidZoneRadiusMeters,
  MAX_ZONE_RADIUS_METERS,
  MIN_ZONE_RADIUS_METERS,
} from './course-layout';
import type { GeoZone, LatLng } from './geo';
import { DEFAULT_ZONE_RADIUS_METERS } from './route-derivation';

export type PlaceStatus = 'active' | 'archived';

export type Place = {
  id: string;
  name: string;
  center: LatLng;
  radiusMeters: number;
  status: PlaceStatus;
  createdAtMs: number;
};

export const DEFAULT_PLACE_RADIUS_METERS = DEFAULT_ZONE_RADIUS_METERS;
export const PLACE_SEED_CENTER_TOLERANCE_METERS = 10;
export const PLACE_SEED_RADIUS_TOLERANCE_METERS = 10;
/** Migration-only duplicate repair: complete-linkage neighborhood, ignoring radius. */
export const PLACE_REPAIR_DISTANCE_METERS = 25;
/** Live route/path-variant sync: match an existing Place by center only. */
export const PLACE_ROUTE_MATCH_DISTANCE_METERS = 25;

export const INVALID_PLACE_NAME_REASON = 'Every place needs a name.';
export const INVALID_PLACE_RADIUS_REASON = `Place radius must be between ${MIN_ZONE_RADIUS_METERS} and ${MAX_ZONE_RADIUS_METERS} m.`;
export const PLACE_LIVE_ATTEMPT_REASON =
  'Finish or cancel the current run before deleting this place.';

export type PlaceValidation = {
  valid: boolean;
  reason: string | null;
};

export function placeZone(place: Pick<Place, 'center' | 'radiusMeters'>): GeoZone {
  return {
    center: { latitude: place.center.latitude, longitude: place.center.longitude },
    radiusMeters: place.radiusMeters,
  };
}

export function clonePlace(place: Place): Place {
  return {
    ...place,
    center: { latitude: place.center.latitude, longitude: place.center.longitude },
  };
}

export function validatePlaceInput(input: { name: string; radiusMeters: number }): PlaceValidation {
  const name = input.name.trim();
  if (!name) {
    return { valid: false, reason: INVALID_PLACE_NAME_REASON };
  }
  if (!isValidZoneRadiusMeters(input.radiusMeters)) {
    return { valid: false, reason: INVALID_PLACE_RADIUS_REASON };
  }
  return { valid: true, reason: null };
}

export function isActivePlace(place: Place): boolean {
  return place.status === 'active';
}

export function attemptReferencesPlace(
  attempt: { originPlaceId: string | null; destinationPlaceId: string | null },
  placeId: string,
): boolean {
  return attempt.originPlaceId === placeId || attempt.destinationPlaceId === placeId;
}

export function openAttemptBlocksPlaceDeletion(
  open: {
    originPlaceId: string | null;
    destinationPlaceId: string | null;
    lifecycle: string;
  } | null,
  place: Pick<Place, 'id' | 'status'>,
): boolean {
  if (!open || (open.lifecycle !== 'armed' && open.lifecycle !== 'active')) {
    return false;
  }
  if (attemptReferencesPlace(open, place.id)) {
    return true;
  }
  return place.status === 'active';
}

export function placePermanentDeletionMessage(placeName: string, attemptCount: number): string {
  if (attemptCount <= 0) {
    return `This permanently deletes ${placeName}. No run history references it. This cannot be undone.`;
  }
  const runLabel = attemptCount === 1 ? '1 associated run' : `${attemptCount} associated runs`;
  return `This permanently deletes ${placeName} and ${runLabel}. Unrelated places and history stay. This cannot be undone.`;
}

export function partitionPlacesByStatus(places: readonly Place[]): {
  active: Place[];
  archived: Place[];
} {
  const active: Place[] = [];
  const archived: Place[] = [];
  for (const place of places) {
    if (place.status === 'archived') {
      archived.push(place);
    } else {
      active.push(place);
    }
  }
  return { active, archived };
}
