import { IDLE_TRACKING_STATE, resolveTrackingStatus, type TrackingState } from '../domain/tracking-state';
import type { LocationSampleStore } from '../persistence/location-sample-store';
import type { LocationPlatform, LocationTracker } from './location-tracker';
import type { TrackingSessionService } from './tracking-session-service';

export class SharedLocationTracker implements LocationTracker {
  private lastError: string | null = null;
  private lastWarning: string | null = null;

  constructor(
    private readonly platform: LocationPlatform,
    private readonly sessions: TrackingSessionService,
    private readonly store: LocationSampleStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async startTracking(): Promise<void> {
    this.lastError = null;
    this.lastWarning = null;

    const servicesEnabled = await this.platform.hasServicesEnabled();
    if (!servicesEnabled) {
      this.lastError = 'Location services are turned off.';
      throw new Error(this.lastError);
    }

    const foregroundGranted = await this.platform.requestForegroundPermission();
    if (!foregroundGranted) {
      this.lastError = 'Foreground location permission was denied.';
      throw new Error(this.lastError);
    }

    const background = await this.platform.requestBackgroundPermission();
    if (!background.granted) {
      this.lastWarning =
        'Background location permission was denied. Locked-screen recording may pause if the OS stops the foreground service.';
    }

    const sessionId = await this.sessions.startSession(this.now());
    try {
      await this.platform.startUpdates();
    } catch (error) {
      await this.sessions.stopSession(sessionId, this.now());
      this.lastError = error instanceof Error ? error.message : 'Failed to start location updates.';
      throw error;
    }
  }

  async stopTracking(): Promise<void> {
    this.lastError = null;
    this.lastWarning = null;
    const sessionId = await this.store.getActiveSessionId();
    try {
      await this.platform.stopUpdates();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Failed to stop location updates.';
      throw error;
    }
    if (sessionId) {
      await this.sessions.stopSession(sessionId, this.now());
    }
  }

  async getState(): Promise<TrackingState> {
    const osUpdating = await this.platform.isUpdating();
    let activeSessionId = await this.store.getActiveSessionId();

    if (!osUpdating && activeSessionId) {
      await this.store.stopSession(activeSessionId, this.now());
      activeSessionId = null;
    }

    const sessionId = activeSessionId ?? (await this.store.getLatestSessionId());
    const pointCount = sessionId ? await this.store.countSamples(sessionId) : 0;

    return {
      ...IDLE_TRACKING_STATE,
      status: resolveTrackingStatus({ osUpdating, activeSessionId }),
      sessionId,
      pointCount,
      lastError: this.lastError,
      lastWarning: this.lastWarning,
    };
  }
}
