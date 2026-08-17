import { MemoryAttemptStore } from '../../src/persistence/memory-attempt-store';
import { MemoryLocationSampleStore } from '../../src/persistence/memory-location-sample-store';
import { MemoryRouteStore } from '../../src/persistence/memory-route-store';
import { AttemptRuntime } from '../../src/product/attempt-runtime';
import { RouteWorkspace } from '../../src/product/route-workspace';
import { SharedLocationTracker } from '../../src/tracking/shared-location-tracker';
import { TrackingSessionService } from '../../src/tracking/tracking-session-service';
import type { LocationPlatform, LocationUpdateOptions } from '../../src/tracking/location-tracker';

export class FakeLocationPlatform implements LocationPlatform {
  servicesEnabled = true;
  foregroundGranted = true;
  backgroundGranted = true;
  updating = false;
  lastNotificationBody: string | null = null;

  async hasServicesEnabled() {
    return this.servicesEnabled;
  }
  async hasForegroundPermission() {
    return this.foregroundGranted;
  }
  async hasBackgroundPermission() {
    return this.backgroundGranted;
  }
  async requestForegroundPermission() {
    return this.foregroundGranted;
  }
  async requestBackgroundPermission() {
    return { granted: this.backgroundGranted };
  }
  async startUpdates(options?: LocationUpdateOptions) {
    this.updating = true;
    this.lastNotificationBody = options?.notificationBody ?? null;
  }
  async stopUpdates() {
    this.updating = false;
  }
  async isUpdating() {
    return this.updating;
  }
}

export function createMemoryWorkspace(options?: {
  now?: () => number;
  routeId?: string;
  attemptId?: string;
  createAttemptId?: () => string;
}) {
  const sessions = new MemoryLocationSampleStore();
  const routes = new MemoryRouteStore();
  const attempts = new MemoryAttemptStore(sessions);
  const platform = new FakeLocationPlatform();
  let nextId = 0;
  const now = options?.now ?? (() => 1_700_000_000_000);
  const trackingSessions = new TrackingSessionService(sessions, () => `id-${++nextId}`);
  const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, now);
  const attemptRuntime = new AttemptRuntime(
    tracker,
    platform,
    sessions,
    routes,
    attempts,
    now,
    () => options?.createAttemptId?.() ?? options?.attemptId ?? 'attempt-1',
  );
  const workspace = new RouteWorkspace(
    tracker,
    sessions,
    routes,
    attemptRuntime,
    now,
    () => options?.routeId ?? 'route-1',
  );
  return { workspace, sessions, routes, attempts, platform, tracker, attemptRuntime };
}
