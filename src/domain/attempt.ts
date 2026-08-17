export type AttemptLifecycle = 'armed' | 'active' | 'completed' | 'cancelled' | 'abandoned';

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
  routeId: string;
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
