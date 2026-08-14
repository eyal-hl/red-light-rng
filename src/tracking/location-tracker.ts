import type { TrackingState } from '../domain/tracking-state';

export type BackgroundPermissionResult = {
  granted: boolean;
};

export interface LocationPlatform {
  hasServicesEnabled(): Promise<boolean>;
  requestForegroundPermission(): Promise<boolean>;
  requestBackgroundPermission(): Promise<BackgroundPermissionResult>;
  startUpdates(): Promise<void>;
  stopUpdates(): Promise<void>;
  isUpdating(): Promise<boolean>;
}

export interface LocationTracker {
  startTracking(): Promise<void>;
  stopTracking(): Promise<void>;
  getState(): Promise<TrackingState>;
}
