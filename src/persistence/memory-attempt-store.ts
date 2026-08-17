import {
  isOpenAttempt,
  type Attempt,
  type AttemptCheckpointCrossing,
} from '../domain/attempt';
import { OpenAttemptExistsError, type AttemptStore } from './attempt-store';
import type { CompleteSessionInput, LocationSampleStore } from './location-sample-store';

function cloneAttempt(attempt: Attempt): Attempt {
  return {
    ...attempt,
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

  async listAttemptsForRoute(routeId: string): Promise<Attempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.routeId === routeId)
      .sort((a, b) => b.armedAtMs - a.armedAtMs)
      .map((attempt) => cloneAttempt(attempt));
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
