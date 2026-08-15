import type { LocationSample } from '../domain/location-sample';
import type { CaptureOutcome, ReviewDisposition, SessionPurpose } from '../domain/session';

export type TrackingSessionRecord = {
  id: string;
  startedAtMs: number;
  stoppedAtMs: number | null;
  isActive: boolean;
  purpose: SessionPurpose;
  captureOutcome: CaptureOutcome;
  reviewDisposition: ReviewDisposition;
  lastSampleAtMs: number | null;
};

export type CompleteSessionInput = {
  stoppedAtMs: number;
  captureOutcome: Exclude<CaptureOutcome, 'active'>;
  reviewDisposition: ReviewDisposition;
};

export interface LocationSampleStore {
  createSession(sessionId: string, startedAtMs: number, purpose?: SessionPurpose): Promise<void>;
  completeSession(sessionId: string, input: CompleteSessionInput): Promise<void>;
  setReviewDisposition(sessionId: string, disposition: ReviewDisposition): Promise<void>;
  getSession(sessionId: string): Promise<TrackingSessionRecord | null>;
  getActiveSession(): Promise<TrackingSessionRecord | null>;
  getActiveSessionId(): Promise<string | null>;
  getLatestSessionId(): Promise<string | null>;
  findPendingRouteCreation(): Promise<TrackingSessionRecord | null>;
  appendSamples(samples: LocationSample[]): Promise<void>;
  listSamples(sessionId: string): Promise<LocationSample[]>;
  countSamples(sessionId: string): Promise<number>;
}
