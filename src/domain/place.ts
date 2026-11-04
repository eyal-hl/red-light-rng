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
  /** Outward crossing of this radius starts the clock when the Place is the journey origin. */
  departureRadiusMeters: number;
  /** Inward crossing of this radius stops the clock when the Place is the journey destination. */
  arrivalRadiusMeters: number;
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
export const INVALID_PLACE_DEPARTURE_RADIUS_REASON = `Departure radius must be between ${MIN_ZONE_RADIUS_METERS} and ${MAX_ZONE_RADIUS_METERS} m.`;
export const INVALID_PLACE_ARRIVAL_RADIUS_REASON = `Arrival radius must be between ${MIN_ZONE_RADIUS_METERS} and ${MAX_ZONE_RADIUS_METERS} m.`;
export const PLACE_RADIUS_OPEN_ATTEMPT_REASON =
  'Finish or cancel the current run before changing a place radius. Editing it now would change how that run is timed.';
export const PLACE_DEPARTURE_RADIUS_HELP = 'Departure: clock starts on outward crossing';
export const PLACE_ARRIVAL_RADIUS_HELP = 'Arrival: clock stops on inward crossing';
export const PLACE_RADIUS_PREVIEW_LEGEND =
  'Green ring: departure radius. Red ring: arrival radius. Equal radii draw as one overlapping ring.';
export const PLACE_LIVE_ATTEMPT_REASON =
  'Finish or cancel the current run before deleting this place.';

export type PlaceValidation = {
  valid: boolean;
  reason: string | null;
};

export type PlaceRadiusRole = 'departure' | 'arrival';

export type PlaceRadii = Pick<Place, 'departureRadiusMeters' | 'arrivalRadiusMeters'>;

export function placeRadiusFor(place: PlaceRadii, role: PlaceRadiusRole): number {
  return role === 'departure' ? place.departureRadiusMeters : place.arrivalRadiusMeters;
}

/** Zone of a Place in the given role: `departure` when it is the origin, `arrival` when it is the destination. */
export function placeZone(
  place: Pick<Place, 'center'> & PlaceRadii,
  role: PlaceRadiusRole,
): GeoZone {
  return {
    center: { latitude: place.center.latitude, longitude: place.center.longitude },
    radiusMeters: placeRadiusFor(place, role),
  };
}

/** Editor preview: departure ring drawn as the start zone, arrival ring as the finish zone, same center. */
export function placeEditorPreviewZones(draft: Pick<Place, 'center'> & PlaceRadii): {
  startZone: GeoZone;
  finishZone: GeoZone;
} {
  return { startZone: placeZone(draft, 'departure'), finishZone: placeZone(draft, 'arrival') };
}

export function placeRadiiEqual(a: PlaceRadii, b: PlaceRadii): boolean {
  return (
    a.departureRadiusMeters === b.departureRadiusMeters &&
    a.arrivalRadiusMeters === b.arrivalRadiusMeters
  );
}

export function clonePlace(place: Place): Place {
  return {
    ...place,
    center: { latitude: place.center.latitude, longitude: place.center.longitude },
  };
}

export function validatePlaceInput(input: { name: string } & PlaceRadii): PlaceValidation {
  const name = input.name.trim();
  if (!name) {
    return { valid: false, reason: INVALID_PLACE_NAME_REASON };
  }
  if (!isValidZoneRadiusMeters(input.departureRadiusMeters)) {
    return { valid: false, reason: INVALID_PLACE_DEPARTURE_RADIUS_REASON };
  }
  if (!isValidZoneRadiusMeters(input.arrivalRadiusMeters)) {
    return { valid: false, reason: INVALID_PLACE_ARRIVAL_RADIUS_REASON };
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
