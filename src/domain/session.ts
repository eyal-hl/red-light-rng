export type SessionPurpose = 'legacy' | 'route_creation';

export type CaptureOutcome = 'active' | 'finished' | 'cancelled' | 'interrupted' | 'unknown';

export type ReviewDisposition = 'pending' | 'saved' | 'discarded';

export const STALE_FIX_THRESHOLD_MS = 120_000;

export class ActiveSessionExistsError extends Error {
  readonly existingSessionId: string;

  constructor(existingSessionId: string) {
    super(`An active tracking session already exists: ${existingSessionId}`);
    this.name = 'ActiveSessionExistsError';
    this.existingSessionId = existingSessionId;
  }
}

export class PendingRouteRecordingError extends Error {
  readonly pendingSessionId: string;

  constructor(pendingSessionId: string) {
    super(`A pending route recording must be saved or discarded first: ${pendingSessionId}`);
    this.name = 'PendingRouteRecordingError';
    this.pendingSessionId = pendingSessionId;
  }
}

export type GpsHealth = 'waiting_for_first_fix' | 'healthy' | 'stale';

export function resolveGpsHealth(lastSampleAtMs: number | null, nowMs: number): GpsHealth {
  if (lastSampleAtMs == null) {
    return 'waiting_for_first_fix';
  }
  if (nowMs - lastSampleAtMs >= STALE_FIX_THRESHOLD_MS) {
    return 'stale';
  }
  return 'healthy';
}

export function formatFixAge(lastSampleAtMs: number, nowMs: number): string {
  const ageSeconds = Math.max(0, Math.floor((nowMs - lastSampleAtMs) / 1000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }
  const minutes = Math.floor(ageSeconds / 60);
  const seconds = ageSeconds % 60;
  return `${minutes}m ${seconds}s ago`;
}

export function isPendingRouteCreation(session: {
  purpose: SessionPurpose;
  captureOutcome: CaptureOutcome;
  reviewDisposition: ReviewDisposition;
}): boolean {
  return (
    session.purpose === 'route_creation' &&
    (session.captureOutcome === 'finished' || session.captureOutcome === 'interrupted') &&
    session.reviewDisposition === 'pending'
  );
}
