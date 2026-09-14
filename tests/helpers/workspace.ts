import { MemoryAttemptStore } from '../../src/persistence/memory-attempt-store';
import { MemoryLocationSampleStore } from '../../src/persistence/memory-location-sample-store';
import { MemoryPlaceStore } from '../../src/persistence/memory-place-store';
import { MemoryRouteStore } from '../../src/persistence/memory-route-store';
import { MemorySettingsStore } from '../../src/persistence/memory-settings-store';
import { SqliteAttemptStore } from '../../src/persistence/sqlite-attempt-store';
import { SqliteLocationSampleStore } from '../../src/persistence/sqlite-location-sample-store';
import { SqlitePlaceStore } from '../../src/persistence/sqlite-place-store';
import { SqliteRouteStore } from '../../src/persistence/sqlite-route-store';
import { SqliteSettingsStore } from '../../src/persistence/sqlite-settings-store';
import type { SqlExecutor } from '../../src/persistence/sql-executor';
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
  startUpdatesCalls = 0;
  getCurrentPositionCalls = 0;
  currentPosition: { latitude: number; longitude: number } | null = {
    latitude: 32.08,
    longitude: 34.78,
  };

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
    this.startUpdatesCalls += 1;
    this.updating = true;
    this.lastNotificationBody = options?.notificationBody ?? null;
  }
  async stopUpdates() {
    this.updating = false;
  }
  async isUpdating() {
    return this.updating;
  }
  async getCurrentPosition() {
    this.getCurrentPositionCalls += 1;
    return this.currentPosition;
  }
}

export function createMemoryWorkspace(options?: {
  now?: () => number;
  routeId?: string;
  attemptId?: string;
  placeId?: string;
  createAttemptId?: () => string;
  createPlaceId?: () => string;
}) {
  const sessions = new MemoryLocationSampleStore();
  const routes = new MemoryRouteStore();
  const attempts = new MemoryAttemptStore(sessions);
  const places = new MemoryPlaceStore();
  const settings = new MemorySettingsStore();
  const platform = new FakeLocationPlatform();
  let nextId = 0;
  let nextPlace = 0;
  let nextAttempt = 0;
  const now = options?.now ?? (() => 1_700_000_000_000);
  const trackingSessions = new TrackingSessionService(sessions, () => `id-${++nextId}`);
  const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, now);
  const attemptRuntime = new AttemptRuntime(
    tracker,
    platform,
    sessions,
    routes,
    attempts,
    places,
    settings,
    now,
    () => options?.createAttemptId?.() ?? options?.attemptId ?? `attempt-${++nextAttempt}`,
  );
  const workspace = new RouteWorkspace(
    tracker,
    sessions,
    routes,
    attemptRuntime,
    places,
    settings,
    platform,
    now,
    () => options?.routeId ?? 'route-1',
    () => options?.createPlaceId?.() ?? options?.placeId ?? `place-${++nextPlace}`,
  );
  return { workspace, sessions, routes, attempts, places, settings, platform, tracker, attemptRuntime };
}

export function createSqliteWorkspace(
  sql: SqlExecutor,
  options?: {
    now?: () => number;
    routeId?: string;
    attemptId?: string;
    sessionId?: string;
    createAttemptId?: () => string;
    createPlaceId?: () => string;
    createSessionId?: () => string;
  },
) {
  const sessions = new SqliteLocationSampleStore(async () => sql);
  const routes = new SqliteRouteStore(async () => sql);
  const attempts = new SqliteAttemptStore(async () => sql);
  const places = new SqlitePlaceStore(async () => sql);
  const settings = new SqliteSettingsStore(async () => sql);
  const platform = new FakeLocationPlatform();
  let nextPlace = 0;
  const now = options?.now ?? (() => 1_700_000_000_000);
  const trackingSessions = new TrackingSessionService(
    sessions,
    () => options?.createSessionId?.() ?? options?.sessionId ?? 'sql-session',
  );
  const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, now);
  const attemptRuntime = new AttemptRuntime(
    tracker,
    platform,
    sessions,
    routes,
    attempts,
    places,
    settings,
    now,
    () => options?.createAttemptId?.() ?? options?.attemptId ?? 'sql-attempt',
  );
  const workspace = new RouteWorkspace(
    tracker,
    sessions,
    routes,
    attemptRuntime,
    places,
    settings,
    platform,
    now,
    () => options?.routeId ?? 'sql-route',
    () => options?.createPlaceId?.() ?? `sql-place-${++nextPlace}`,
  );
  return { workspace, sessions, routes, attempts, places, settings, platform, tracker, attemptRuntime };
}
