import appConfig from '../app.json';
import { getSqlExecutor } from './persistence/database';
import { createExpoBackupFiles } from './persistence/expo-backup-files';
import { SqliteAttemptStore } from './persistence/sqlite-attempt-store';
import { SqliteLocationSampleStore } from './persistence/sqlite-location-sample-store';
import { SqlitePlaceStore } from './persistence/sqlite-place-store';
import { SqliteCompetitiveCheckpointStore } from './persistence/sqlite-competitive-checkpoint-store';
import { SqliteRecalculationJobStore } from './persistence/sqlite-recalculation-job-store';
import { SqliteRouteStore } from './persistence/sqlite-route-store';
import { SqliteSettingsStore } from './persistence/sqlite-settings-store';
import { AttemptRuntime } from './product/attempt-runtime';
import { BackupService } from './product/backup-service';
import { CompetitiveSegmentsService, SegmentRecalculationService } from './product/competitive-segments';
import { HistoryRecalculationService } from './product/history-recalculation';
import { RouteWorkspace } from './product/route-workspace';
import { createExpoLocationPlatform } from './tracking/expo-location-platform';
import { SharedLocationTracker } from './tracking/shared-location-tracker';
import { TrackingSessionService } from './tracking/tracking-session-service';

export const locationSampleStore = new SqliteLocationSampleStore(getSqlExecutor);
export const routeStore = new SqliteRouteStore(getSqlExecutor);
export const attemptStore = new SqliteAttemptStore(getSqlExecutor);
export const placeStore = new SqlitePlaceStore(getSqlExecutor);
export const settingsStore = new SqliteSettingsStore(getSqlExecutor);
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
  placeStore,
  settingsStore,
);
export const recalculationJobStore = new SqliteRecalculationJobStore(getSqlExecutor);
export const historyRecalculation = new HistoryRecalculationService({
  jobs: recalculationJobStore,
  attempts: attemptStore,
  sessions: locationSampleStore,
  places: placeStore,
  reassignPathVariant: (attempt, samples) => attemptRuntime.reassignPathVariant(attempt, samples),
});
export const competitiveCheckpointStore = new SqliteCompetitiveCheckpointStore(getSqlExecutor);
const competitiveSegmentDeps = {
  checkpoints: competitiveCheckpointStore,
  attempts: attemptStore,
  sessions: locationSampleStore,
  places: placeStore,
  jobs: recalculationJobStore,
};
export const competitiveSegments = new CompetitiveSegmentsService(competitiveSegmentDeps);
export const segmentRecalculation = new SegmentRecalculationService(competitiveSegmentDeps);
// Derive checkpoint segments off the critical path once a run finishes; failures never affect the result.
attemptRuntime.setOnAttemptCompleted((attempt) => {
  void competitiveSegments.deriveForAttempt(attempt.id);
});
export const routeWorkspace = new RouteWorkspace(
  locationTracker,
  locationSampleStore,
  routeStore,
  attemptRuntime,
  placeStore,
  settingsStore,
  locationPlatform,
  undefined,
  undefined,
  undefined,
  historyRecalculation,
  competitiveSegments,
  segmentRecalculation,
);

export const backupService = new BackupService(
  getSqlExecutor,
  createExpoBackupFiles(),
  {
    stopLocationUpdates: () => locationTracker.stopLocationUpdates(),
    invalidateDerivedCaches: () => routeWorkspace.invalidateDerivedCaches(),
    recomputeDerived: async () => {
      await routeWorkspace.reconcilePendingAttempts();
      await routeWorkspace.recomputePathVariants();
    },
  },
  appConfig.expo.version,
);
