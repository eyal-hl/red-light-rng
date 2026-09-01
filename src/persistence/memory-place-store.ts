import { clonePlace, type Place } from '../domain/place';
import type { PlaceStore } from './place-store';

export class MemoryPlaceStore implements PlaceStore {
  private readonly places = new Map<string, Place>();

  async createPlace(place: Place): Promise<void> {
    this.places.set(place.id, clonePlace(place));
  }

  async savePlace(place: Place): Promise<void> {
    this.places.set(place.id, clonePlace(place));
  }

  async getPlace(placeId: string): Promise<Place | null> {
    const place = this.places.get(placeId);
    return place ? clonePlace(place) : null;
  }

  async listPlaces(): Promise<Place[]> {
    return [...this.places.values()]
      .sort((a, b) => {
        if (a.createdAtMs !== b.createdAtMs) {
          return a.createdAtMs - b.createdAtMs;
        }
        return a.id.localeCompare(b.id);
      })
      .map((place) => clonePlace(place));
  }

  async listActivePlaces(): Promise<Place[]> {
    return (await this.listPlaces()).filter((place) => place.status === 'active');
  }

  async archivePlace(placeId: string): Promise<void> {
    const place = this.places.get(placeId);
    if (!place) {
      return;
    }
    place.status = 'archived';
  }

  async deletePlace(placeId: string): Promise<void> {
    this.places.delete(placeId);
  }

  async isPlaceReferenced(_placeId: string): Promise<boolean> {
    return false;
  }
}
