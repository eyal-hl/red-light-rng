import {
  isOpenAttempt,
  type Attempt,
  type AttemptCheckpointCrossing,
} from '../domain/attempt';
import {
  attemptNeedsReconciliation,
  parseAttemptReconciliationStatus,
} from '../domain/attempt-reconciliation';
import { OpenAttemptExistsError, type AttemptStore } from './attempt-store';
import type { CompleteSessionInput, LocationSampleStore } from './location-sample-store';

function cloneAttempt(attempt: Attempt): Attempt {
  return {
    ...attempt,
    reconciliationStatus: parseAttemptReconciliationStatus(attempt.reconciliationStatus),
    reconciliationVersion: attempt.reconciliationVersion ?? 0,
    crossings: attempt.crossings.map((crossing) => ({ ...crossing })),
  };
}

export class MemoryAttemptStore implements AttemptStore {
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly sessions?: LocationSampleStore) {}

  async createAttempt(attempt: Attempt): Promise<void> {
    for (const existing of this.attempts.values()) {
      if (isOpenAttempt(existing)) {
        throw new OpenAttemptExistsError(existing.id);
      }
    }
    this.attempts.set(attempt.id, cloneAttempt(attempt));
  }

  async saveAttempt(attempt: Attempt): Promise<void> {
    this.attempts.set(attempt.id, cloneAttempt(attempt));
  }

  async finalizeAttempt(attempt: Attempt, session: CompleteSessionInput): Promise<void> {
    this.attempts.set(attempt.id, cloneAttempt(attempt));
    if (this.sessions) {
      await this.sessions.completeSession(attempt.sessionId, session);
    }
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    const attempt = this.attempts.get(attemptId);
    return attempt ? cloneAttempt(attempt) : null;
  }

  async getAttemptBySessionId(sessionId: string): Promise<Attempt | null> {
    for (const attempt of this.attempts.values()) {
      if (attempt.sessionId === sessionId) {
        return cloneAttempt(attempt);
      }
    }
    return null;
  }

  async getOpenAttempt(): Promise<Attempt | null> {
    for (const attempt of this.attempts.values()) {
      if (isOpenAttempt(attempt)) {
        return cloneAttempt(attempt);
      }
    }
    return null;
  }

  async getUnacknowledgedResult(): Promise<Attempt | null> {
    let latest: Attempt | null = null;
    for (const attempt of this.attempts.values()) {
      if (isOpenAttempt(attempt) || attempt.resultAcknowledged) {
        continue;
      }
      if (!latest || attempt.armedAtMs > latest.armedAtMs) {
        latest = attempt;
      }
    }
    return latest ? cloneAttempt(latest) : null;
  }

  async listAttempts(): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .sort((a, b) => b.armedAtMs - a.armedAtMs)
      .map((attempt) => cloneAttempt(attempt));
  }

  async listAttemptsForRoute(routeId: string): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.routeId === routeId)
      .sort((a, b) => b.armedAtMs - a.armedAtMs)
      .map((attempt) => cloneAttempt(attempt));
  }

  async listAttemptsForJourney(
    originPlaceId: string,
    destinationPlaceId: string,
    transportationMode: string,
  ): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter(
        (attempt) =>
          attempt.originPlaceId === originPlaceId &&
          attempt.destinationPlaceId === destinationPlaceId &&
          attempt.transportationMode === transportationMode,
      )
      .sort((a, b) => b.armedAtMs - a.armedAtMs)
      .map((attempt) => cloneAttempt(attempt));
  }

  async isPlaceReferenced(placeId: string): Promise<boolean> {
    return (await this.countAttemptsReferencingPlace(placeId)) > 0;
  }

  async countAttemptsReferencingPlace(placeId: string): Promise<number> {
    let count = 0;
    for (const attempt of this.attempts.values()) {
      if (attempt.originPlaceId === placeId || attempt.destinationPlaceId === placeId) {
        count += 1;
      }
    }
    return count;
  }

  async listAttemptsNeedingReconciliation(currentVersion: number): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attemptNeedsReconciliation(attempt, currentVersion))
      .sort((a, b) => b.armedAtMs - a.armedAtMs)
      .map((attempt) => cloneAttempt(attempt));
  }

  async peekFailedReconciliationAttemptId(): Promise<string | null> {
    let latest: Attempt | null = null;
    for (const attempt of this.attempts.values()) {
      if (attempt.reconciliationStatus !== 'failed') {
        continue;
      }
      if (!latest || attempt.armedAtMs > latest.armedAtMs) {
        latest = attempt;
      }
    }
    return latest?.id ?? null;
  }

  async deleteAttempt(attemptId: string): Promise<void> {
    this.attempts.delete(attemptId);
  }

  async acknowledgeResult(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return;
    }
    attempt.resultAcknowledged = true;
  }

  peekCrossings(attemptId: string): AttemptCheckpointCrossing[] {
    return this.attempts.get(attemptId)?.crossings.map((crossing) => ({ ...crossing })) ?? [];
  }
}
