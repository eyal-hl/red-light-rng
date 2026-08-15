import type { LocationSample } from '../domain/location-sample';

export type TrackingSessionRecord = {
  id: string;
  startedAtMs: number;
  stoppedAtMs: number | null;
  isActive: boolean;
};

export interface LocationSampleStore {
  createSession(sessionId: string, startedAtMs: number): Promise<void>;
  stopSession(sessionId: string, stoppedAtMs: number): Promise<void>;
  getActiveSessionId(): Promise<string | null>;
  getLatestSessionId(): Promise<string | null>;
  appendSamples(samples: LocationSample[]): Promise<void>;
  listSamples(sessionId: string): Promise<LocationSample[]>;
  countSamples(sessionId: string): Promise<number>;
}
