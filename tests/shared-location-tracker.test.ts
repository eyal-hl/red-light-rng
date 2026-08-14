import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryLocationSampleStore } from '../src/persistence/memory-location-sample-store';
import type { LocationPlatform } from '../src/tracking/location-tracker';
import { SharedLocationTracker } from '../src/tracking/shared-location-tracker';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';

class FakeLocationPlatform implements LocationPlatform {
  servicesEnabled = true;
  foregroundGranted = true;
  backgroundGranted = true;
  updating = false;
  startError: Error | null = null;

  async hasServicesEnabled() {
    return this.servicesEnabled;
  }

  async requestForegroundPermission() {
    return this.foregroundGranted;
  }

  async requestBackgroundPermission() {
    return { granted: this.backgroundGranted };
  }

  async startUpdates() {
    if (this.startError) {
      throw this.startError;
    }
    this.updating = true;
  }

  async stopUpdates() {
    this.updating = false;
  }

  async isUpdating() {
    return this.updating;
  }
}

function createTracker(platform: FakeLocationPlatform, store = new MemoryLocationSampleStore()) {
  let nextId = 0;
  const sessions = new TrackingSessionService(store, () => `id-${++nextId}`);
  const tracker = new SharedLocationTracker(platform, sessions, store, () => 1_700_000_000_000);
  return { tracker, store, sessions };
}

describe('SharedLocationTracker', () => {
  it('starts a session after permissions succeed and exposes tracking state', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store, sessions } = createTracker(platform);

    await tracker.startTracking();
    await sessions.recordFixes('id-1', [
      {
        timestamp: 1_700_000_000_500,
        coords: {
          latitude: 32.08,
          longitude: 34.78,
          accuracy: 6,
          speed: 2,
          heading: 10,
        },
      },
    ]);

    const state = await tracker.getState();
    assert.equal(state.status, 'tracking');
    assert.equal(state.sessionId, 'id-1');
    assert.equal(state.pointCount, 1);
    assert.equal(state.lastError, null);
    assert.equal(await store.getActiveSessionId(), 'id-1');
  });

  it('keeps recorded points after stop so they can be inspected later', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store, sessions } = createTracker(platform);

    await tracker.startTracking();
    await sessions.recordFixes('id-1', [
      {
        timestamp: 1_700_000_000_500,
        coords: {
          latitude: 32.08,
          longitude: 34.78,
          accuracy: 6,
          speed: 2,
          heading: 10,
        },
      },
    ]);
    await tracker.stopTracking();

    const state = await tracker.getState();
    assert.equal(state.status, 'idle');
    assert.equal(state.pointCount, 1);
    assert.equal(await store.countSamples('id-1'), 1);
    assert.equal(platform.updating, false);
  });

  it('records a warning when background permission is denied but still starts', async () => {
    const platform = new FakeLocationPlatform();
    platform.backgroundGranted = false;
    const { tracker } = createTracker(platform);

    await tracker.startTracking();
    const state = await tracker.getState();
    assert.equal(state.status, 'tracking');
    assert.match(state.lastWarning ?? '', /Background location permission was denied/);
  });

  it('does not start a session when foreground permission is denied', async () => {
    const platform = new FakeLocationPlatform();
    platform.foregroundGranted = false;
    const { tracker, store } = createTracker(platform);

    await assert.rejects(() => tracker.startTracking(), /Foreground location permission was denied/);
    const state = await tracker.getState();
    assert.equal(state.status, 'idle');
    assert.equal(await store.getActiveSessionId(), null);
    assert.equal(state.lastError, 'Foreground location permission was denied.');
  });

  it('rolls back the session if the platform fails to start updates', async () => {
    const platform = new FakeLocationPlatform();
    platform.startError = new Error('native start failed');
    const { tracker, store } = createTracker(platform);

    await assert.rejects(() => tracker.startTracking(), /native start failed/);
    assert.equal(await store.getActiveSessionId(), null);
    const state = await tracker.getState();
    assert.equal(state.status, 'idle');
    assert.equal(state.lastError, 'native start failed');
  });

  it('marks a stale active session idle when the OS is no longer updating', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store } = createTracker(platform);
    await store.createSession('stale-session', 1);
    const state = await tracker.getState();
    assert.equal(state.status, 'idle');
    assert.equal(await store.getActiveSessionId(), null);
    assert.equal(state.sessionId, 'stale-session');
  });
});
