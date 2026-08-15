export type TrackingStatus = 'idle' | 'tracking';

export type TrackingState = {
  status: TrackingStatus;
  sessionId: string | null;
  pointCount: number;
  lastError: string | null;
  lastWarning: string | null;
};

export const IDLE_TRACKING_STATE: TrackingState = {
  status: 'idle',
  sessionId: null,
  pointCount: 0,
  lastError: null,
  lastWarning: null,
};

export function resolveTrackingStatus(params: {
  osUpdating: boolean;
  activeSessionId: string | null;
}): TrackingStatus {
  return params.osUpdating || params.activeSessionId != null ? 'tracking' : 'idle';
}
