import type { GpsHealth, CaptureOutcome, ReviewDisposition, SessionPurpose } from './session';

export type TrackingStatus = 'idle' | 'tracking' | 'interrupted';

export type TrackingState = {
  status: TrackingStatus;
  sessionId: string | null;
  purpose: SessionPurpose | null;
  captureOutcome: CaptureOutcome | null;
  reviewDisposition: ReviewDisposition | null;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  lastSampleAtMs: number | null;
  pointCount: number;
  gpsHealth: GpsHealth | null;
  lastError: string | null;
  lastWarning: string | null;
};

export const IDLE_TRACKING_STATE: TrackingState = {
  status: 'idle',
  sessionId: null,
  purpose: null,
  captureOutcome: null,
  reviewDisposition: null,
  startedAtMs: null,
  stoppedAtMs: null,
  lastSampleAtMs: null,
  pointCount: 0,
  gpsHealth: null,
  lastError: null,
  lastWarning: null,
};

export function resolveTrackingStatus(params: {
  isActive: boolean;
  captureOutcome: CaptureOutcome | null;
}): TrackingStatus {
  if (params.captureOutcome === 'interrupted') {
    return 'interrupted';
  }
  if (params.isActive && params.captureOutcome === 'active') {
    return 'tracking';
  }
  return 'idle';
}
