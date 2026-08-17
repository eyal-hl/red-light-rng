import * as Location from 'expo-location';

import {
  ROUTE_RECORDING_NOTIFICATION_BODY,
  type LocationPlatform,
  type LocationUpdateOptions,
} from './location-tracker';
import { BACKGROUND_LOCATION_TASK } from './background-location-task';

export function createExpoLocationPlatform(): LocationPlatform {
  return {
    async hasServicesEnabled() {
      return Location.hasServicesEnabledAsync();
    },
    async hasForegroundPermission() {
      const result = await Location.getForegroundPermissionsAsync();
      return result.granted;
    },
    async hasBackgroundPermission() {
      const result = await Location.getBackgroundPermissionsAsync();
      return result.granted;
    },
    async requestForegroundPermission() {
      const result = await Location.requestForegroundPermissionsAsync();
      return result.granted;
    },
    async requestBackgroundPermission() {
      const result = await Location.requestBackgroundPermissionsAsync();
      return { granted: result.granted };
    },
    async startUpdates(options?: LocationUpdateOptions) {
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 1,
        deferredUpdatesInterval: 0,
        deferredUpdatesDistance: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        activityType: Location.ActivityType.OtherNavigation,
        foregroundService: {
          notificationTitle: 'Red Light RNG',
          notificationBody: options?.notificationBody ?? ROUTE_RECORDING_NOTIFICATION_BODY,
          killServiceOnDestroy: false,
        },
      });
    },
    async stopUpdates() {
      const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      if (started) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      }
    },
    async isUpdating() {
      return Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    },
  };
}
