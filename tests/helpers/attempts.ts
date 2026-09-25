import { CURRENT_ATTEMPT_RECONCILIATION_VERSION } from '../../src/domain/attempt-reconciliation';
import { EMPTY_ATTEMPT_LOCAL_START, type Attempt, type AttemptLocalStartMetadata } from '../../src/domain/attempt';

export const RECONCILED_ATTEMPT = {
  reconciliationStatus: 'reconciled' as const,
  reconciliationVersion: CURRENT_ATTEMPT_RECONCILIATION_VERSION,
};

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

export function capturedLocalStart(
  utcOffsetMinutes: number,
  timezoneId = 'UTC',
): AttemptLocalStartMetadata {
  return {
    startedUtcOffsetMinutes: utcOffsetMinutes,
    startedTimezoneId: timezoneId,
    startedLocalTimeSource: 'captured',
  };
}

export { EMPTY_ATTEMPT_LOCAL_START };
