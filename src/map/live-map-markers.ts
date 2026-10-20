import type { LatLng } from '../domain/geo';

export type LiveMapPlaceMarker = {
  id: string;
  name: string;
  center: LatLng;
  radiusMeters: number;
  emphasized: boolean;
};

export type LiveMapUserMarker = {
  point: LatLng;
  confidence: 'current' | 'last-known';
  horizontalAccuracyMeters: number | null;
  label: string;
};
