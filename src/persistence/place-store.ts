import type { Place } from '../domain/place';

export class PlaceInUseError extends Error {
  constructor(placeId: string) {
    super(`Place ${placeId} is referenced by historical attempts`);
    this.name = 'PlaceInUseError';
  }
}

export interface PlaceStore {
  createPlace(place: Place): Promise<void>;
  savePlace(place: Place): Promise<void>;
  getPlace(placeId: string): Promise<Place | null>;
  listPlaces(): Promise<Place[]>;
  listActivePlaces(): Promise<Place[]>;
  archivePlace(placeId: string): Promise<void>;
  deletePlace(placeId: string): Promise<void>;
  isPlaceReferenced(placeId: string): Promise<boolean>;
}
