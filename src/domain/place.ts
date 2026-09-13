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

export const INVALID_PLACE_NAME_REASON = 'Every place needs a name.';
export const INVALID_PLACE_RADIUS_REASON = `Place radius must be between ${MIN_ZONE_RADIUS_METERS} and ${MAX_ZONE_RADIUS_METERS} m.`;
export const PLACE_IN_USE_REASON = 'This place is used by historical attempts and cannot be deleted.';

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
