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

/**
 * Which attempt kinds a list query returns. Every list that feeds full-route ranking, PB, median,
 * statistics or history DEFAULTS to `full` (DEC-016): a partial attempt only appears when a caller
 * asks for `partial` or `all` explicitly.
 */
export type AttemptKindFilter = 'full' | 'partial' | 'all';

export type AttemptListOptions = {
  kind?: AttemptKindFilter;
};

export interface AttemptStore {
  createAttempt(attempt: Attempt): Promise<void>;
  saveAttempt(attempt: Attempt): Promise<void>;
  finalizeAttempt(attempt: Attempt, session: CompleteSessionInput): Promise<void>;
  getAttempt(attemptId: string): Promise<Attempt | null>;
  getAttemptBySessionId(sessionId: string): Promise<Attempt | null>;
  getOpenAttempt(): Promise<Attempt | null>;
  getUnacknowledgedResult(): Promise<Attempt | null>;
  listAttempts(options?: AttemptListOptions): Promise<Attempt[]>;
  listAttemptsForRoute(routeId: string, options?: AttemptListOptions): Promise<Attempt[]>;
  listAttemptsForJourney(
    originPlaceId: string,
    destinationPlaceId: string,
    transportationMode: string,
    options?: AttemptListOptions,
  ): Promise<Attempt[]>;
  isPlaceReferenced(placeId: string): Promise<boolean>;
  countAttemptsReferencingPlace(placeId: string): Promise<number>;
  listAttemptsNeedingReconciliation(currentVersion: number): Promise<Attempt[]>;
  peekFailedReconciliationAttemptId(): Promise<string | null>;
  deleteAttempt(attemptId: string): Promise<void>;
  acknowledgeResult(attemptId: string): Promise<void>;
}
