import type { LocationSample } from '../domain/location-sample';
import type { LocationSampleStore, TrackingSessionRecord } from './location-sample-store';

type MemorySession = TrackingSessionRecord & { samples: LocationSample[] };

export class MemoryLocationSampleStore implements LocationSampleStore {
  private readonly sessions = new Map<string, MemorySession>();

  async createSession(sessionId: string, startedAtMs: number): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        session.isActive = false;
        session.stoppedAtMs = startedAtMs;
      }
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      startedAtMs,
      stoppedAtMs: null,
      isActive: true,
      samples: [],
    });
  }

  async stopSession(sessionId: string, stoppedAtMs: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.isActive = false;
    session.stoppedAtMs = stoppedAtMs;
  }

  async getActiveSessionId(): Promise<string | null> {
    for (const session of this.sessions.values()) {
      if (session.isActive) {
        return session.id;
      }
    }
    return null;
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

  async appendSamples(samples: LocationSample[]): Promise<void> {
    for (const sample of samples) {
      const session = this.sessions.get(sample.sessionId);
      if (!session) {
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
    if (!session) {
      return undefined;
    }
    return {
      id: session.id,
      startedAtMs: session.startedAtMs,
      stoppedAtMs: session.stoppedAtMs,
      isActive: session.isActive,
    };
  }
}
