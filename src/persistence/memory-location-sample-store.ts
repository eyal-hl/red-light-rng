import type { LocationSample } from '../domain/location-sample';
import type { CaptureOutcome, ReviewDisposition, SessionPurpose } from '../domain/session';
import { ActiveSessionExistsError } from '../domain/session';
import type {
  CompleteSessionInput,
  LocationSampleStore,
  TrackingSessionRecord,
} from './location-sample-store';

type MemorySession = TrackingSessionRecord & { samples: LocationSample[] };

function cloneSession(session: MemorySession): TrackingSessionRecord {
  const lastSampleAtMs =
    session.samples.length === 0
      ? null
      : Math.max(...session.samples.map((sample) => sample.recordedAtMs));
  return {
    id: session.id,
    startedAtMs: session.startedAtMs,
    stoppedAtMs: session.stoppedAtMs,
    isActive: session.isActive,
    purpose: session.purpose,
    captureOutcome: session.captureOutcome,
    reviewDisposition: session.reviewDisposition,
    lastSampleAtMs,
  };
}

export class MemoryLocationSampleStore implements LocationSampleStore {
  private readonly sessions = new Map<string, MemorySession>();

  async createSession(
    sessionId: string,
    startedAtMs: number,
    purpose: SessionPurpose = 'route_creation',
  ): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        throw new ActiveSessionExistsError(session.id);
      }
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      startedAtMs,
      stoppedAtMs: null,
      isActive: true,
      purpose,
      captureOutcome: 'active',
      reviewDisposition: 'pending',
      lastSampleAtMs: null,
      samples: [],
    });
  }

  async completeSession(sessionId: string, input: CompleteSessionInput): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.isActive = false;
    session.stoppedAtMs = input.stoppedAtMs;
    session.captureOutcome = input.captureOutcome;
    session.reviewDisposition = input.reviewDisposition;
  }

  async setReviewDisposition(sessionId: string, disposition: ReviewDisposition): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.reviewDisposition = disposition;
  }

  async getSession(sessionId: string): Promise<TrackingSessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : null;
  }

  async getActiveSession(): Promise<TrackingSessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        return cloneSession(session);
      }
    }
    return null;
  }

  async getActiveSessionId(): Promise<string | null> {
    return (await this.getActiveSession())?.id ?? null;
  }

  async getLatestSessionId(): Promise<string | null> {
    let latest: MemorySession | null = null;
    for (const session of this.sessions.values()) {
      if (!latest || session.startedAtMs > latest.startedAtMs) {
        latest = session;
      }
    }
    return latest?.id ?? null;
  }

  async findPendingRouteCreation(): Promise<TrackingSessionRecord | null> {
    let pending: MemorySession | null = null;
    for (const session of this.sessions.values()) {
      if (
        session.purpose === 'route_creation' &&
        (session.captureOutcome === 'finished' || session.captureOutcome === 'interrupted') &&
        session.reviewDisposition === 'pending'
      ) {
        if (!pending || session.startedAtMs > pending.startedAtMs) {
          pending = session;
        }
      }
    }
    return pending ? cloneSession(pending) : null;
  }

  async appendSamples(samples: LocationSample[]): Promise<void> {
    for (const sample of samples) {
      const session = this.sessions.get(sample.sessionId);
      if (!session || !session.isActive) {
        continue;
      }
      session.samples.push(sample);
    }
  }

  async listSamples(sessionId: string): Promise<LocationSample[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return [...session.samples].sort((a, b) => a.recordedAtMs - b.recordedAtMs);
  }

  async countSamples(sessionId: string): Promise<number> {
    return this.sessions.get(sessionId)?.samples.length ?? 0;
  }

  peekSession(sessionId: string): TrackingSessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    return session ? cloneSession(session) : undefined;
  }

  seedSession(record: TrackingSessionRecord, samples: LocationSample[] = []): void {
    this.sessions.set(record.id, {
      ...record,
      samples: [...samples],
    });
  }
}