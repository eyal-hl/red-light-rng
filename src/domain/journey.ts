import type { TransportationMode } from './route';

export type JourneyPoolId = {
  originPlaceId: string;
  destinationPlaceId: string;
  transportationMode: TransportationMode;
};

export function journeyPoolKey(pool: JourneyPoolId): string {
  return `${pool.originPlaceId}|${pool.destinationPlaceId}|${pool.transportationMode}`;
}

export function parseJourneyPoolKey(key: string): JourneyPoolId | null {
  const [originPlaceId, destinationPlaceId, transportationMode] = key.split('|');
  if (!originPlaceId || !destinationPlaceId || !transportationMode) {
    return null;
  }
  return {
    originPlaceId,
    destinationPlaceId,
    transportationMode: transportationMode as TransportationMode,
  };
}

export function journeyTitle(originName: string, destinationName: string): string {
  return `${originName} → ${destinationName}`;
}

export function sameJourneyPool(a: JourneyPoolId, b: JourneyPoolId): boolean {
  return (
    a.originPlaceId === b.originPlaceId &&
    a.destinationPlaceId === b.destinationPlaceId &&
    a.transportationMode === b.transportationMode
  );
}
