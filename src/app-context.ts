import { getSqlExecutor } from './persistence/database';
import { SqliteLocationSampleStore } from './persistence/sqlite-location-sample-store';
import { SqliteRouteStore } from './persistence/sqlite-route-store';
import { RouteWorkspace } from './product/route-workspace';
import { createExpoLocationPlatform } from './tracking/expo-location-platform';
import { SharedLocationTracker } from './tracking/shared-location-tracker';
import { TrackingSessionService } from './tracking/tracking-session-service';

export const locationSampleStore = new SqliteLocationSampleStore(getSqlExecutor);
export const routeStore = new SqliteRouteStore(getSqlExecutor);
export const trackingSessionService = new TrackingSessionService(locationSampleStore);
export const locationTracker = new SharedLocationTracker(
  createExpoLocationPlatform(),
  trackingSessionService,
  locationSampleStore,
);
export const routeWorkspace = new RouteWorkspace(locationTracker, locationSampleStore, routeStore);
