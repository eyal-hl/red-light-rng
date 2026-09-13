import type { Attempt } from '../domain/attempt';
import type { CompleteSessionInput } from './location-sample-store';

export class OpenAttemptExistsError extends Error {
  readonly existingAttemptId: string;

  constructor(existingAttemptId: string) {
    super(`An armed or active attempt already exists: ${existingAttemptId}`);
    this.name = 'OpenAttemptExistsError';
    this.existingAttemptId = existingAttemptId;
  }
}

export interface AttemptStore {
  createAttempt(attempt: Attempt): Promise<void>;
  saveAttempt(attempt: Attempt): Promise<void>;
  finalizeAttempt(attempt: Attempt, session: CompleteSessionInput): Promise<void>;
  getAttempt(attemptId: string): Promise<Attempt | null>;
  getAttemptBySessionId(sessionId: string): Promise<Attempt | null>;
  getOpenAttempt(): Promise<Attempt | null>;
  getUnacknowledgedResult(): Promise<Attempt | null>;
  listAttempts(): Promise<Attempt[]>;
  listAttemptsForRoute(routeId: string): Promise<Attempt[]>;
  listAttemptsForJourney(
    originPlaceId: string,
    destinationPlaceId: string,
    transportationMode: string,
  ): Promise<Attempt[]>;
  isPlaceReferenced(placeId: string): Promise<boolean>;
  acknowledgeResult(attemptId: string): Promise<void>;
}
