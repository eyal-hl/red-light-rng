import type { RouteCheckpoint } from './course-layout';
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

export type RouteStatus = 'active' | 'archived';
export type RouteKind = 'explicit' | 'discovered';

export type Route = {
  id: string;
  name: string;
  transportationMode: TransportationMode;
  createdAtMs: number;
  sourceRecordingId: string;
  referencePath: LatLng[];
  startZone: GeoZone;
  finishZone: GeoZone;
  startProgressMeters: number;
  finishProgressMeters: number;
  checkpoints: RouteCheckpoint[];
  status: RouteStatus;
  kind: RouteKind;
  clusterSignature: string | null;
  classificationVersion: number;
};

export const INVALID_ROUTE_NAME_REASON = 'Every path variant needs a name.';

export function isActiveRoute(route: Pick<Route, 'status'>): boolean {
  return route.status === 'active';
}

export function validateRouteName(name: string): { valid: boolean; reason: string | null } {
  if (name.trim().length === 0) {
    return { valid: false, reason: INVALID_ROUTE_NAME_REASON };
  }
  return { valid: true, reason: null };
}
