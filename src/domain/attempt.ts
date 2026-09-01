import type { TransportationMode } from './route';

export type AttemptLifecycle = 'armed' | 'active' | 'completed' | 'cancelled' | 'abandoned' | 'ended';

export type AttemptValidity = 'pending' | 'valid' | 'unranked';

export type AttemptCheckpointCrossing = {
  id: string;
  attemptId: string;
  checkpointId: string;
  checkpointName: string;
  checkpointProgressMeters: number;
  crossedAtMs: number;
};

export type Attempt = {
  id: string;
  routeId: string | null;
  originPlaceId: string | null;
  destinationPlaceId: string | null;
  transportationMode: TransportationMode;
  sessionId: string;
  lifecycle: AttemptLifecycle;
  validity: AttemptValidity;
  armedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  resultAcknowledged: boolean;
  crossings: AttemptCheckpointCrossing[];
};

export function isOpenAttempt(attempt: Attempt): boolean {
  return attempt.lifecycle === 'armed' || attempt.lifecycle === 'active';
}

export function officialTimeMs(attempt: Attempt): number | null {
  if (attempt.startedAtMs == null || attempt.finishedAtMs == null) {
    return null;
  }
  return Math.max(0, attempt.finishedAtMs - attempt.startedAtMs);
}

export function isOfficialAttempt(attempt: Attempt): boolean {
  return attempt.lifecycle === 'completed' && attempt.validity === 'valid';
}

export function isJourneyCompetitive(attempt: Attempt): boolean {
  return (
    attempt.lifecycle === 'completed' &&
    attempt.validity === 'valid' &&
    attempt.originPlaceId != null &&
    attempt.destinationPlaceId != null &&
    attempt.startedAtMs != null &&
    attempt.finishedAtMs != null
  );
}

export type IncompleteAttemptLabel = 'DID NOT START' | 'DID NOT FINISH';

export function incompleteAttemptLabel(attempt: Pick<Attempt, 'lifecycle' | 'startedAtMs'>): IncompleteAttemptLabel | null {
  if (attempt.lifecycle !== 'ended') {
    return null;
  }
  return attempt.startedAtMs == null ? 'DID NOT START' : 'DID NOT FINISH';
}
