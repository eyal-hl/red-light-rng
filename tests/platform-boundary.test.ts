import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('platform boundary', () => {
  it('keeps expo location and task APIs inside the platform adapter files', () => {
    const sharedFiles = [
      'src/domain/location-sample.ts',
      'src/domain/tracking-state.ts',
      'src/persistence/location-sample-store.ts',
      'src/persistence/memory-location-sample-store.ts',
      'src/persistence/schema.ts',
      'src/tracking/location-tracker.ts',
      'src/tracking/shared-location-tracker.ts',
      'src/tracking/tracking-session-service.ts',
      'src/ui/BackgroundLocationSpikeScreen.tsx',
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
  });

  it('records background fixes only onto the active session', () => {
    const source = readFileSync('src/tracking/register-background-location-task.ts', 'utf8');
    assert.match(source, /recordActiveSessionFixes/);
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
