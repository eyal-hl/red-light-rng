import { PendingRouteRecordingError, resolveGpsHealth, type SessionPurpose } from '../domain/session';
import { IDLE_TRACKING_STATE, resolveTrackingStatus, type TrackingState } from '../domain/tracking-state';
import type { LocationSampleStore, TrackingSessionRecord } from '../persistence/location-sample-store';
import {
  ATTEMPT_NOTIFICATION_BODY,
  ROUTE_RECORDING_NOTIFICATION_BODY,
  type LocationPlatform,
  type LocationTracker,
} from './location-tracker';
import type { TrackingSessionService } from './tracking-session-service';

function sessionFields(session: TrackingSessionRecord | null): Pick<
  TrackingState,
  | 'sessionId'
  | 'purpose'
  | 'captureOutcome'
  | 'reviewDisposition'
  | 'startedAtMs'
  | 'stoppedAtMs'
  | 'lastSampleAtMs'
  | 'status'
> {
  return {
    sessionId: session?.id ?? null,
    purpose: session?.purpose ?? null,
    captureOutcome: session?.captureOutcome ?? null,
    reviewDisposition: session?.reviewDisposition ?? null,
    startedAtMs: session?.startedAtMs ?? null,
    stoppedAtMs: session?.stoppedAtMs ?? null,
    lastSampleAtMs: session?.lastSampleAtMs ?? null,
    status: resolveTrackingStatus({
      isActive: session?.isActive ?? false,
      captureOutcome: session?.captureOutcome ?? null,
    }),
  };
}

export class SharedLocationTracker implements LocationTracker {
  private lastError: string | null = null;
  private lastWarning: string | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: LocationPlatform,
    private readonly sessions: TrackingSessionService,
    private readonly store: LocationSampleStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async startTracking(purpose: SessionPurpose = 'route_creation'): Promise<void> {
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

    await this.enqueue(async () => {
      const active = await this.store.getActiveSession();
      if (active) {
        if (background.granted) {
          await this.store.confirmBackgroundPermission(active.id);
        }
        return;
      }
      const pending = await this.store.findPendingRouteCreation();
      if (pending) {
        throw new PendingRouteRecordingError(pending.id);
      }

      const sessionId = await this.sessions.startSession(this.now(), purpose);
      try {
        await this.platform.startUpdates({
          notificationBody:
            purpose === 'attempt' ? ATTEMPT_NOTIFICATION_BODY : ROUTE_RECORDING_NOTIFICATION_BODY,
        });
      } catch (error) {
        await this.sessions.completeSession(sessionId, {
          stoppedAtMs: this.now(),
          captureOutcome: 'cancelled',
          reviewDisposition: 'discarded',
        });
        this.lastError = error instanceof Error ? error.message : 'Failed to start location updates.';
        throw error;
      }
      if (background.granted) {
        await this.store.confirmBackgroundPermission(sessionId);
      }
    });
  }

  async finishTracking(): Promise<void> {
    await this.endRouteCreationSession('finished', 'pending');
  }

  async cancelTracking(): Promise<void> {
    await this.endActiveSession('cancelled', 'discarded');
  }

  async interruptTracking(): Promise<void> {
    await this.endRouteCreationSession('interrupted', 'pending');
  }

  async stopLocationUpdates(): Promise<void> {
    this.lastError = null;
    await this.enqueue(async () => {
      try {
        await this.platform.stopUpdates();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to stop location updates.';
        throw error;
      }
    });
  }

  async recover(): Promise<void> {
    await this.enqueue(async () => {
      const active = await this.store.getActiveSession();
      if (!active) {
        return;
      }
      if (active.purpose !== 'route_creation') {
        const backgroundGranted = await this.platform.hasBackgroundPermission();
        if (backgroundGranted && !active.backgroundPermissionConfirmed) {
          await this.store.confirmBackgroundPermission(active.id);
        }
        return;
      }

      const osUpdating = await this.platform.isUpdating();
      const servicesEnabled = await this.platform.hasServicesEnabled();
      const foregroundGranted = await this.platform.hasForegroundPermission();
      const backgroundGranted = await this.platform.hasBackgroundPermission();
      if (backgroundGranted && !active.backgroundPermissionConfirmed) {
        await this.store.confirmBackgroundPermission(active.id);
      }
      const backgroundConfirmed = active.backgroundPermissionConfirmed || backgroundGranted;
      const backgroundLost = backgroundConfirmed && !backgroundGranted;
      const captureUnavailable =
        !osUpdating || !servicesEnabled || !foregroundGranted || backgroundLost;
      if (!captureUnavailable) {
        return;
      }

      try {
        await this.platform.stopUpdates();
      } catch {
        // Still terminalize the session so recovery is durable.
      }
      await this.sessions.completeSession(active.id, {
        stoppedAtMs: this.now(),
        captureOutcome: 'interrupted',
        reviewDisposition: 'pending',
      });
    });
  }

  async getState(): Promise<TrackingState> {
    return this.enqueue(async () => {
      const active = await this.store.getActiveSession();
      const pending = active ? null : await this.store.findPendingRouteCreation();
      const latestId = await this.store.getLatestSessionId();
      const session =
        active ??
        pending ??
        (latestId ? await this.store.getSession(latestId) : null);
      const pointCount = session ? await this.store.countSamples(session.id) : 0;
      const nowMs = this.now();
      const gpsHealth =
        session?.isActive && session.captureOutcome === 'active'
          ? resolveGpsHealth(session.lastSampleAtMs, nowMs)
          : null;

      return {
        ...IDLE_TRACKING_STATE,
        ...sessionFields(session),
        pointCount,
        gpsHealth,
        lastError: this.lastError,
        lastWarning: this.lastWarning,
      };
    });
  }

  private async endRouteCreationSession(
    captureOutcome: 'finished' | 'interrupted',
    reviewDisposition: 'pending',
  ): Promise<void> {
    this.lastError = null;
    this.lastWarning = null;
    await this.enqueue(async () => {
      const session = await this.store.getActiveSession();
      if (!session || session.purpose !== 'route_creation') {
        return;
      }
      try {
        await this.platform.stopUpdates();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to stop location updates.';
        throw error;
      }
      await this.sessions.completeSession(session.id, {
        stoppedAtMs: this.now(),
        captureOutcome,
        reviewDisposition,
      });
    });
  }

  private async endActiveSession(
    captureOutcome: 'finished' | 'cancelled' | 'interrupted',
    reviewDisposition: 'pending' | 'discarded',
  ): Promise<void> {
    this.lastError = null;
    if (captureOutcome !== 'interrupted') {
      this.lastWarning = null;
    }
    await this.enqueue(async () => {
      const sessionId = await this.store.getActiveSessionId();
      try {
        await this.platform.stopUpdates();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to stop location updates.';
        throw error;
      }
      if (sessionId) {
        await this.sessions.completeSession(sessionId, {
          stoppedAtMs: this.now(),
          captureOutcome,
          reviewDisposition,
        });
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
