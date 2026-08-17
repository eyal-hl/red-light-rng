import * as TaskManager from 'expo-task-manager';

import { attemptRuntime, trackingSessionService } from '../app-context';
import { BACKGROUND_LOCATION_TASK } from './background-location-task';

type LocationTaskLocation = {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    speed: number | null;
    heading: number | null;
  };
};

type LocationTaskData = {
  locations?: LocationTaskLocation[];
};

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    return;
  }

  const locations = (data as LocationTaskData | undefined)?.locations ?? [];
  if (locations.length === 0) {
    return;
  }

  await trackingSessionService.recordActiveSessionFixes(locations);
  await attemptRuntime.processActive();
});
