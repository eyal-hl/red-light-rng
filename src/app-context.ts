import { getSqlExecutor } from './persistence/database';
import { SqliteAttemptStore } from './persistence/sqlite-attempt-store';
import { SqliteLocationSampleStore } from './persistence/sqlite-location-sample-store';
import { SqliteRouteStore } from './persistence/sqlite-route-store';
import { AttemptRuntime } from './product/attempt-runtime';
import { RouteWorkspace } from './product/route-workspace';
import { createExpoLocationPlatform } from './tracking/expo-location-platform';
import { SharedLocationTracker } from './tracking/shared-location-tracker';
import { TrackingSessionService } from './tracking/tracking-session-service';

export const locationSampleStore = new SqliteLocationSampleStore(getSqlExecutor);
export const routeStore = new SqliteRouteStore(getSqlExecutor);
export const attemptStore = new SqliteAttemptStore(getSqlExecutor);
export const trackingSessionService = new TrackingSessionService(locationSampleStore);
export const locationPlatform = createExpoLocationPlatform();
export const locationTracker = new SharedLocationTracker(
  locationPlatform,
  trackingSessionService,
  locationSampleStore,
);
export const attemptRuntime = new AttemptRuntime(
  locationTracker,
  locationPlatform,
  locationSampleStore,
  routeStore,
  attemptStore,
);
export const routeWorkspace = new RouteWorkspace(
  locationTracker,
  locationSampleStore,
  routeStore,
  attemptRuntime,
);
