import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('platform boundary', () => {
  it('keeps expo location and task APIs inside the platform adapter files', () => {
    const sharedFiles = [
      'src/domain/location-sample.ts',
      'src/domain/tracking-state.ts',
      'src/domain/route.ts',
      'src/domain/route-derivation.ts',
      'src/domain/path-projection.ts',
      'src/domain/course-layout.ts',
      'src/domain/course-editor.ts',
      'src/domain/course-matching.ts',
      'src/domain/attempt.ts',
      'src/domain/attempt-timing.ts',
      'src/domain/attempt-debug.ts',
      'src/domain/attempt-analysis.ts',
      'src/domain/movement-analysis.ts',
      'src/domain/wait-events.ts',
      'src/domain/wait-comparison.ts',
      'src/domain/ghost-comparison.ts',
      'src/domain/ghost-chart.ts',
      'src/domain/result-explanation.ts',
      'src/domain/place.ts',
      'src/domain/place-timing.ts',
      'src/domain/gps-readiness.ts',
      'src/domain/place-debug.ts',
      'src/domain/place-seeding.ts',
      'src/domain/place-repair.ts',
      'src/domain/journey.ts',
      'src/domain/journey-analysis.ts',
      'src/domain/journey-statistics.ts',
      'src/domain/journey-departure.ts',
      'src/domain/attempt-local-time.ts',
      'src/domain/path-variant.ts',
      'src/domain/path-variant-discovery.ts',
      'src/domain/session.ts',
      'src/persistence/location-sample-store.ts',
      'src/persistence/memory-location-sample-store.ts',
      'src/persistence/sqlite-location-sample-store.ts',
      'src/persistence/schema.ts',
      'src/persistence/migrations.ts',
      'src/persistence/route-store.ts',
      'src/persistence/sqlite-route-store.ts',
      'src/persistence/memory-route-store.ts',
      'src/persistence/attempt-store.ts',
      'src/persistence/sqlite-attempt-store.ts',
      'src/persistence/memory-attempt-store.ts',
      'src/persistence/place-store.ts',
      'src/persistence/sqlite-place-store.ts',
      'src/persistence/memory-place-store.ts',
      'src/persistence/settings-store.ts',
      'src/persistence/sqlite-settings-store.ts',
      'src/persistence/memory-settings-store.ts',
      'src/product/route-workspace.ts',
      'src/product/attempt-runtime.ts',
      'src/tracking/location-tracker.ts',
      'src/tracking/shared-location-tracker.ts',
      'src/tracking/tracking-session-service.ts',
      'src/ui/AppRoot.tsx',
      'src/ui/HomeScreen.tsx',
      'src/ui/RecordingScreen.tsx',
      'src/ui/ReviewScreen.tsx',
      'src/ui/RouteDetailScreen.tsx',
      'src/ui/CourseEditorScreen.tsx',
      'src/ui/AttemptScreen.tsx',
      'src/ui/AttemptResultScreen.tsx',
      'src/ui/GhostDeltaChart.tsx',
      'src/ui/HistoryScreen.tsx',
      'src/ui/JourneyDetailScreen.tsx',
      'src/ui/JourneyStatisticsDashboard.tsx',
      'src/ui/PlacesScreen.tsx',
      'src/ui/PlaceEditorScreen.tsx',
      'src/ui/SettingsScreen.tsx',
    ];

    for (const file of sharedFiles) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        source,
        /expo-location|expo-task-manager|android\.permission|UIBackgroundModes/,
        `${file} should not import platform location APIs`,
      );
    }

    const adapter = readFileSync('src/tracking/expo-location-platform.ts', 'utf8');
    assert.match(adapter, /expo-location/);
    assert.match(adapter, /foregroundService/);
    assert.match(adapter, /notificationBody/);
    const tracker = readFileSync('src/tracking/shared-location-tracker.ts', 'utf8');
    assert.match(tracker, /ATTEMPT_NOTIFICATION_BODY/);
    assert.match(tracker, /ROUTE_RECORDING_NOTIFICATION_BODY/);
  });

  it('keeps MapLibre types inside the map boundary', () => {
    const domainFiles = [
      'src/domain/geo.ts',
      'src/domain/route.ts',
      'src/domain/route-derivation.ts',
      'src/domain/path-projection.ts',
      'src/domain/course-layout.ts',
      'src/domain/course-editor.ts',
      'src/domain/course-matching.ts',
      'src/domain/attempt.ts',
      'src/domain/attempt-timing.ts',
      'src/domain/attempt-debug.ts',
      'src/domain/attempt-analysis.ts',
      'src/domain/movement-analysis.ts',
      'src/domain/wait-events.ts',
      'src/domain/wait-comparison.ts',
      'src/domain/ghost-comparison.ts',
      'src/domain/ghost-chart.ts',
      'src/domain/result-explanation.ts',
      'src/domain/place.ts',
      'src/domain/place-timing.ts',
      'src/domain/gps-readiness.ts',
      'src/domain/place-debug.ts',
      'src/domain/place-seeding.ts',
      'src/domain/place-repair.ts',
      'src/domain/journey.ts',
      'src/domain/journey-analysis.ts',
      'src/domain/journey-statistics.ts',
      'src/domain/journey-departure.ts',
      'src/domain/attempt-local-time.ts',
      'src/domain/path-variant.ts',
      'src/domain/path-variant-discovery.ts',
      'src/persistence/schema.ts',
      'src/persistence/sqlite-route-store.ts',
      'src/persistence/memory-route-store.ts',
      'src/persistence/sqlite-attempt-store.ts',
      'src/persistence/memory-attempt-store.ts',
      'src/persistence/sqlite-place-store.ts',
      'src/persistence/memory-place-store.ts',
      'src/persistence/sqlite-settings-store.ts',
      'src/persistence/memory-settings-store.ts',
      'src/persistence/migrations.ts',
      'src/product/route-workspace.ts',
      'src/product/attempt-runtime.ts',
    ];
    for (const file of domainFiles) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(
        source,
        /@maplibre\/maplibre-react-native|maplibre/,
        `${file} should not import MapLibre`,
      );
    }

    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const style = readFileSync('src/map/openfreemap-style.ts', 'utf8');
    const chart = readFileSync('src/ui/GhostDeltaChart.tsx', 'utf8');
    assert.match(map, /@maplibre\/maplibre-react-native/);
    assert.match(style, /tiles.openfreemap.org\/styles\/liberty/);
    assert.doesNotMatch(chart, /@maplibre\/maplibre-react-native|maplibre/);
  });

  it('records background fixes only onto the active session', () => {
    const source = readFileSync('src/tracking/register-background-location-task.ts', 'utf8');
    assert.match(source, /recordActiveSessionFixes/);
    assert.match(source, /processActive/);
    assert.doesNotMatch(source, /getLatestSessionId/);
  });

  it('declares RECEIVE_BOOT_COMPLETED so Expo TaskManager can schedule persistable jobs', () => {
    const appConfig = JSON.parse(readFileSync('app.json', 'utf8')) as {
      expo: { android: { permissions: string[] } };
    };
    const permissions = appConfig.expo.android.permissions;

    assert.ok(
      permissions.includes('android.permission.RECEIVE_BOOT_COMPLETED'),
      'Android app config must declare RECEIVE_BOOT_COMPLETED. Expo TaskManager schedules persistable JobScheduler work, and Android throws IllegalArgumentException without this permission.',
    );
  });
});
