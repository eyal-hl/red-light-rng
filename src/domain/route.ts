import type { GeoZone, LatLng } from './geo';

export type TransportationMode = 'scooter' | 'bike' | 'run' | 'walk';

export const TRANSPORTATION_MODES: { id: TransportationMode; label: string; icon: string }[] = [
  { id: 'scooter', label: 'Scooter', icon: '🛴' },
  { id: 'bike', label: 'Bike', icon: '🚲' },
  { id: 'run', label: 'Run', icon: '🏃' },
  { id: 'walk', label: 'Walk', icon: '🚶' },
];

export function transportationModeLabel(mode: TransportationMode): string {
  return TRANSPORTATION_MODES.find((item) => item.id === mode)?.label ?? mode;
}

export function transportationModeIcon(mode: TransportationMode): string {
  return TRANSPORTATION_MODES.find((item) => item.id === mode)?.icon ?? '';
}

export type Route = {
  id: string;
  name: string;
  transportationMode: TransportationMode;
  createdAtMs: number;
  sourceRecordingId: string;
  referencePath: LatLng[];
  startZone: GeoZone;
  finishZone: GeoZone;
};
