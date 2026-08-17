import type { TrackingState } from '../domain/tracking-state';
import type { SessionPurpose } from '../domain/session';

export type BackgroundPermissionResult = {
  granted: boolean;
};

export type LocationUpdateOptions = {
  notificationBody: string;
};

export const ROUTE_RECORDING_NOTIFICATION_BODY =
  'Recording your route. You can lock your phone and keep traveling.';
export const ATTEMPT_NOTIFICATION_BODY =
  'Timing an armed run. You can lock your phone and keep traveling.';

export interface LocationPlatform {
  hasServicesEnabled(): Promise<boolean>;
  hasForegroundPermission(): Promise<boolean>;
  hasBackgroundPermission(): Promise<boolean>;
  requestForegroundPermission(): Promise<boolean>;
  requestBackgroundPermission(): Promise<BackgroundPermissionResult>;
  startUpdates(options?: LocationUpdateOptions): Promise<void>;
  stopUpdates(): Promise<void>;
  isUpdating(): Promise<boolean>;
}

export interface LocationTracker {
  startTracking(purpose?: SessionPurpose): Promise<void>;
  finishTracking(): Promise<void>;
  cancelTracking(): Promise<void>;
  interruptTracking(): Promise<void>;
  recover(): Promise<void>;
  getState(): Promise<TrackingState>;
  stopLocationUpdates(): Promise<void>;
}
