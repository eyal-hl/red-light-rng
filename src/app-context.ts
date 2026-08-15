import { sqliteLocationSampleStore } from './persistence/sqlite-location-sample-store';
import { createExpoLocationPlatform } from './tracking/expo-location-platform';
import { SharedLocationTracker } from './tracking/shared-location-tracker';
import { TrackingSessionService } from './tracking/tracking-session-service';

export const locationSampleStore = sqliteLocationSampleStore;
export const trackingSessionService = new TrackingSessionService(locationSampleStore);
export const locationTracker = new SharedLocationTracker(
  createExpoLocationPlatform(),
  trackingSessionService,
  locationSampleStore,
);
