import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STALE_FIX_THRESHOLD_MS } from '../src/domain/session';
import { MemoryLocationSampleStore } from '../src/persistence/memory-location-sample-store';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import type { LocationPlatform } from '../src/tracking/location-tracker';
import { SharedLocationTracker } from '../src/tracking/shared-location-tracker';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';

class FakeLocationPlatform implements LocationPlatform {
  servicesEnabled = true;
  foregroundGranted = true;
  backgroundGranted = true;
  updating = false;
  startError: Error | null = null;
  startHold: Promise<void> | null = null;

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
  async startUpdates() {
    if (this.startError) {
      throw this.startError;
    }
    if (this.startHold) {
      await this.startHold;
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

const SAMPLE_FIX = {
  timestamp: 1_700_000_000_500,
  coords: {
    latitude: 32.08,
    longitude: 34.78,
    accuracy: 6,
    speed: 2,
    heading: 10,
  },
};

async function waitForActiveSession(store: MemoryLocationSampleStore, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sessionId = await store.getActiveSessionId();
    if (sessionId) {
      return sessionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for an active tracking session');
}

function createTracker(
  platform: FakeLocationPlatform,
  store = new MemoryLocationSampleStore(),
  now: () => number = () => 1_700_000_000_000,
) {
  let nextId = 0;
  const sessions = new TrackingSessionService(store, () => `id-${++nextId}`);
  const tracker = new SharedLocationTracker(platform, sessions, store, now);
  return { tracker, store, sessions };
}

describe('SharedLocationTracker', () => {
  it('starts a session after permissions succeed and exposes tracking state', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store, sessions } = createTracker(platform);

    await tracker.startTracking();
    await sessions.recordFixes('id-1', [SAMPLE_FIX]);

    const state = await tracker.getState();
    assert.equal(state.status, 'tracking');
    assert.equal(state.sessionId, 'id-1');
    assert.equal(state.pointCount, 1);
    assert.equal(state.startedAtMs, 1_700_000_000_000);
    assert.equal(state.lastError, null);
    assert.equal(await store.getActiveSessionId(), 'id-1');
  });

  it('keeps recorded points after a deliberate finish so they can be reviewed later', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store, sessions } = createTracker(platform);

    await tracker.startTracking();
    await sessions.recordFixes('id-1', [SAMPLE_FIX]);
    await tracker.finishTracking();

    const state = await tracker.getState();
    assert.equal(state.status, 'idle');
    assert.equal(state.captureOutcome, 'finished');
    assert.equal(state.reviewDisposition, 'pending');
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
    const session = await store.getSession('id-1');
    assert.equal(session?.captureOutcome, 'cancelled');
    assert.equal(session?.reviewDisposition, 'discarded');
    const state = await tracker.getState();
    assert.equal(state.status, 'idle');
    assert.equal(state.lastError, 'native start failed');
  });

  it('does not mutate lifecycle state when getState observes OS tracking as stopped', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store } = createTracker(platform);
    await store.createSession('stale-session', 1);
    const state = await tracker.getState();
    assert.equal(state.status, 'tracking');
    assert.equal(await store.getActiveSessionId(), 'stale-session');
    assert.equal(store.peekSession('stale-session')?.isActive, true);
  });

  it('does not treat an in-flight start as a stale session when getState overlaps startUpdates', async () => {
    const platform = new FakeLocationPlatform();
    let releaseStart: () => void = () => {};
    platform.startHold = new Promise((resolve) => {
      releaseStart = resolve;
    });
    const { tracker, store } = createTracker(platform);

    const startPromise = tracker.startTracking();
    await waitForActiveSession(store);

    const statePromise = tracker.getState();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await store.getActiveSessionId(), 'id-1');
    assert.equal(store.peekSession('id-1')?.stoppedAtMs, null);
    assert.equal(store.peekSession('id-1')?.isActive, true);

    releaseStart();
    await startPromise;
    const state = await statePromise;
    assert.equal(state.status, 'tracking');
    assert.equal(state.sessionId, 'id-1');
    assert.equal(await store.getActiveSessionId(), 'id-1');
    assert.equal(store.peekSession('id-1')?.stoppedAtMs, null);
    assert.equal(platform.updating, true);

    await tracker.finishTracking();
    assert.equal(await store.getActiveSessionId(), null);
    assert.equal(store.peekSession('id-1')?.isActive, false);
    assert.equal(store.peekSession('id-1')?.stoppedAtMs, 1_700_000_000_000);
  });

  it('reuses an already-active session instead of starting a second recording', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store } = createTracker(platform);
    await tracker.startTracking();
    await tracker.startTracking();
    assert.equal(await store.getActiveSessionId(), 'id-1');
    assert.equal(await store.getSession('id-2'), null);
  });

  it('refuses to start while a pending route recording exists', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store } = createTracker(platform);
    await tracker.startTracking();
    await tracker.finishTracking();
    await assert.rejects(() => tracker.startTracking(), /pending route recording/i);
    assert.equal((await store.findPendingRouteCreation())?.id, 'id-1');
  });

  it('exposes waiting-for-first-fix without terminalizing after the stale interval', async () => {
    let now = 1_700_000_000_000;
    const platform = new FakeLocationPlatform();
    const { tracker } = createTracker(platform, new MemoryLocationSampleStore(), () => now);
    await tracker.startTracking();
    now += STALE_FIX_THRESHOLD_MS + 5_000;
    const state = await tracker.getState();
    assert.equal(state.status, 'tracking');
    assert.equal(state.gpsHealth, 'waiting_for_first_fix');
    assert.equal(platform.updating, true);
  });

  it('marks GPS stale without interrupting when samples are old but capture is still available', async () => {
    let now = 1_700_000_000_000;
    const platform = new FakeLocationPlatform();
    const { tracker, store, sessions } = createTracker(platform, new MemoryLocationSampleStore(), () => now);
    await tracker.startTracking();
    await sessions.recordFixes('id-1', [SAMPLE_FIX]);
    now += STALE_FIX_THRESHOLD_MS + 1_000;
    await tracker.recover();
    const state = await tracker.getState();
    assert.equal(state.status, 'tracking');
    assert.equal(state.gpsHealth, 'stale');
    assert.equal(await store.getActiveSessionId(), 'id-1');
    assert.equal(platform.updating, true);
  });

  it('interrupts and unregisters tracking when recovery sees corroborating capture failure', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store, sessions } = createTracker(platform);
    await tracker.startTracking();
    await sessions.recordFixes('id-1', [SAMPLE_FIX]);
    platform.updating = false;
    platform.servicesEnabled = false;
    await tracker.recover();

    const session = await store.getSession('id-1');
    assert.equal(session?.captureOutcome, 'interrupted');
    assert.equal(session?.reviewDisposition, 'pending');
    assert.equal(session?.isActive, false);
    assert.equal(platform.updating, false);
    const state = await tracker.getState();
    assert.equal(state.status, 'interrupted');
  });

  it('interrupts when required foreground permission is lost', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store } = createTracker(platform);
    await tracker.startTracking();
    platform.foregroundGranted = false;
    await tracker.recover();
    assert.equal((await store.getSession('id-1'))?.captureOutcome, 'interrupted');
    assert.equal(platform.updating, false);
  });

  it('interrupts when required background permission is lost even if the OS task still reports updating', async () => {
    const platform = new FakeLocationPlatform();
    const { tracker, store } = createTracker(platform);
    await tracker.startTracking();
    platform.backgroundGranted = false;
    assert.equal(platform.updating, true);
    await tracker.recover();
    assert.equal((await store.getSession('id-1'))?.captureOutcome, 'interrupted');
    assert.equal((await store.getSession('id-1'))?.reviewDisposition, 'pending');
    assert.equal((await store.getSession('id-1'))?.isActive, false);
    assert.equal(platform.updating, false);
  });

  it('does not interrupt a recording that started without background permission', async () => {
    const platform = new FakeLocationPlatform();
    platform.backgroundGranted = false;
    const { tracker, store } = createTracker(platform);

    await tracker.startTracking();
    assert.equal(platform.updating, true);
    await tracker.recover();

    const session = await store.getSession('id-1');
    assert.equal(session?.captureOutcome, 'active');
    assert.equal(session?.isActive, true);
    assert.equal(platform.updating, true);
    const state = await tracker.getState();
    assert.equal(state.status, 'tracking');
    assert.match(state.lastWarning ?? '', /Background location permission was denied/);
  });

  it('interrupts after background permission is later granted and then revoked', async () => {
    const platform = new FakeLocationPlatform();
    platform.backgroundGranted = false;
    const { tracker, store } = createTracker(platform);

    await tracker.startTracking();
    platform.backgroundGranted = true;
    await tracker.recover();
    assert.equal((await store.getSession('id-1'))?.captureOutcome, 'active');
    assert.equal(platform.updating, true);

    platform.backgroundGranted = false;
    await tracker.recover();
    assert.equal((await store.getSession('id-1'))?.captureOutcome, 'interrupted');
    assert.equal((await store.getSession('id-1'))?.reviewDisposition, 'pending');
    assert.equal(platform.updating, false);
  });

  it('still interrupts a foreground-only recording when the OS task is gone', async () => {
    const platform = new FakeLocationPlatform();
    platform.backgroundGranted = false;
    const { tracker, store } = createTracker(platform);

    await tracker.startTracking();
    platform.updating = false;
    await tracker.recover();
    assert.equal((await store.getSession('id-1'))?.captureOutcome, 'interrupted');
    assert.equal((await store.getSession('id-1'))?.reviewDisposition, 'pending');
    assert.equal(platform.updating, false);
  });

  it('persists a confirmed background grant so a new tracker process can detect later revocation', async () => {
    const platform = new FakeLocationPlatform();
    const store = new MemoryLocationSampleStore();
    const first = createTracker(platform, store);
    await first.tracker.startTracking();
    assert.equal((await store.getSession('id-1'))?.backgroundPermissionConfirmed, true);

    platform.backgroundGranted = false;
    assert.equal(platform.updating, true);

    const relaunched = createTracker(platform, store);
    await relaunched.tracker.recover();

    const session = await store.getSession('id-1');
    assert.equal(session?.captureOutcome, 'interrupted');
    assert.equal(session?.reviewDisposition, 'pending');
    assert.equal(session?.isActive, false);
    assert.equal(platform.updating, false);
  });

  it('does not interrupt a foreground-only recording after a new tracker process recovers', async () => {
    const platform = new FakeLocationPlatform();
    platform.backgroundGranted = false;
    const store = new MemoryLocationSampleStore();
    const first = createTracker(platform, store);
    await first.tracker.startTracking();
    assert.equal((await store.getSession('id-1'))?.backgroundPermissionConfirmed, false);

    const relaunched = createTracker(platform, store);
    await relaunched.tracker.recover();

    const session = await store.getSession('id-1');
    assert.equal(session?.captureOutcome, 'active');
    assert.equal(session?.isActive, true);
    assert.equal(session?.backgroundPermissionConfirmed, false);
    assert.equal(platform.updating, true);
  });

  it('persists a later background grant so revocation after process relaunch still interrupts', async () => {
    const platform = new FakeLocationPlatform();
    platform.backgroundGranted = false;
    const store = new MemoryLocationSampleStore();
    const first = createTracker(platform, store);
    await first.tracker.startTracking();

    platform.backgroundGranted = true;
    await first.tracker.recover();
    assert.equal((await store.getSession('id-1'))?.backgroundPermissionConfirmed, true);
    assert.equal((await store.getSession('id-1'))?.captureOutcome, 'active');

    platform.backgroundGranted = false;
    const relaunched = createTracker(platform, store);
    await relaunched.tracker.recover();
    assert.equal((await store.getSession('id-1'))?.captureOutcome, 'interrupted');
    assert.equal(platform.updating, false);
  });

  it('interrupts after a sqlite-backed process relaunch when a persisted background grant is revoked', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const store = new SqliteLocationSampleStore(async () => sql);
    const platform = new FakeLocationPlatform();
    const sessions = new TrackingSessionService(store, () => 'sql-session');
    const tracker = new SharedLocationTracker(platform, sessions, store, () => 1_700_000_000_000);
    await tracker.startTracking();
    assert.equal((await store.getSession('sql-session'))?.backgroundPermissionConfirmed, true);

    platform.backgroundGranted = false;
    assert.equal(platform.updating, true);

    const reloadedStore = new SqliteLocationSampleStore(async () => sql);
    const reloadedSessions = new TrackingSessionService(reloadedStore, () => 'unused');
    const relaunched = new SharedLocationTracker(
      platform,
      reloadedSessions,
      reloadedStore,
      () => 1_700_000_000_000,
    );
    await relaunched.recover();

    const session = await reloadedStore.getSession('sql-session');
    assert.equal(session?.captureOutcome, 'interrupted');
    assert.equal(session?.reviewDisposition, 'pending');
    assert.equal(session?.isActive, false);
    assert.equal(platform.updating, false);
  });
});
