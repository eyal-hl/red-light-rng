import type { TrackingState } from '../domain/tracking-state';

export type BackgroundPermissionResult = {
  granted: boolean;
};

export interface LocationPlatform {
  hasServicesEnabled(): Promise<boolean>;
  hasForegroundPermission(): Promise<boolean>;
  hasBackgroundPermission(): Promise<boolean>;
  requestForegroundPermission(): Promise<boolean>;
  requestBackgroundPermission(): Promise<BackgroundPermissionResult>;
  startUpdates(): Promise<void>;
  stopUpdates(): Promise<void>;
  isUpdating(): Promise<boolean>;
}

export interface LocationTracker {
  startTracking(): Promise<void>;
  finishTracking(): Promise<void>;
  cancelTracking(): Promise<void>;
  interruptTracking(): Promise<void>;
  recover(): Promise<void>;
  getState(): Promise<TrackingState>;
}
