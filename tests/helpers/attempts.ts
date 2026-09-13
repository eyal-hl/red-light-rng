import type { Attempt } from '../../src/domain/attempt';

export function attemptIdentity(
  overrides: Partial<Pick<Attempt, 'originPlaceId' | 'destinationPlaceId' | 'transportationMode' | 'routeId'>> = {},
): Pick<Attempt, 'originPlaceId' | 'destinationPlaceId' | 'transportationMode' | 'routeId'> {
  return {
    routeId: 'route-1',
    originPlaceId: 'place-home',
    destinationPlaceId: 'place-work',
    transportationMode: 'scooter',
    ...overrides,
  };
}
