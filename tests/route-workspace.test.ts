import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryLocationSampleStore } from '../src/persistence/memory-location-sample-store';
import { MemoryRouteStore } from '../src/persistence/memory-route-store';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import { RouteWorkspace } from '../src/product/route-workspace';
import { SharedLocationTracker } from '../src/tracking/shared-location-tracker';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';
import type { LocationPlatform } from '../src/tracking/location-tracker';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { movingTrace } from './helpers/samples';

class FakeLocationPlatform implements LocationPlatform {
  servicesEnabled = true;
  foregroundGranted = true;
  backgroundGranted = true;
  updating = false;

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
    this.updating = true;
  }
  async stopUpdates() {
    this.updating = false;
  }
  async isUpdating() {
    return this.updating;
  }
}

function createMemoryWorkspace() {
  const sessions = new MemoryLocationSampleStore();
  const routes = new MemoryRouteStore();
  const platform = new FakeLocationPlatform();
  let nextId = 0;
  const trackingSessions = new TrackingSessionService(sessions, () => `id-${++nextId}`);
  const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, () => 1_700_000_000_000);
  const workspace = new RouteWorkspace(tracker, sessions, routes, () => 1_700_000_100_000, () => 'route-1');
  return { workspace, sessions, routes, platform };
}

describe('RouteWorkspace', () => {
  it('saves derived route geometry separately from raw telemetry and keeps source samples after delete', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    await workspace.startRouteRecording();
    await sessions.appendSamples(movingTrace({ sessionId: 'id-1', points: 16, stepMeters: 15 }));
    await workspace.finishRecording();

    const pending = await sessions.findPendingRouteCreation();
    assert.equal(pending?.id, 'id-1');
    assert.equal(pending?.captureOutcome, 'finished');

    const saved = await workspace.saveRoute('id-1', 'Home → Work', 'scooter');
    assert.equal(saved.ok, true);
    if (!saved.ok) {
      return;
    }
    assert.equal(saved.route.referencePath.length >= 3, true);
    assert.equal(await sessions.countSamples('id-1'), 16);
    assert.equal((await sessions.getSession('id-1'))?.reviewDisposition, 'saved');
    assert.equal(await sessions.findPendingRouteCreation(), null);

    await workspace.deleteRoute(saved.route.id);
    assert.equal(await workspace.getRoute(saved.route.id), null);
    assert.equal(await sessions.countSamples('id-1'), 16);
    assert.equal((await sessions.getSession('id-1'))?.id, 'id-1');
  });

  it('discards a pending recording without deleting raw telemetry and then allows a new recording', async () => {
    const { workspace, sessions, platform } = createMemoryWorkspace();
    await workspace.startRouteRecording();
    await sessions.appendSamples(movingTrace({ sessionId: 'id-1', points: 12, stepMeters: 15 }));
    await workspace.finishRecording();
    await workspace.discardRecording('id-1');

    assert.equal((await sessions.getSession('id-1'))?.reviewDisposition, 'discarded');
    assert.equal(await sessions.findPendingRouteCreation(), null);
    assert.equal(await sessions.countSamples('id-1'), 12);
    assert.equal(platform.updating, false);

    await workspace.startRouteRecording();
    assert.equal(await sessions.getActiveSessionId(), 'id-2');
  });

  it('cancels a recording as non-pending, creates no route, and retains samples', async () => {
    const { workspace, sessions, routes } = createMemoryWorkspace();
    await workspace.startRouteRecording();
    await sessions.appendSamples(movingTrace({ sessionId: 'id-1', points: 8, stepMeters: 15 }));
    await workspace.cancelRecording();

    const session = await sessions.getSession('id-1');
    assert.equal(session?.captureOutcome, 'cancelled');
    assert.equal(session?.reviewDisposition, 'discarded');
    assert.equal(await sessions.findPendingRouteCreation(), null);
    assert.equal((await routes.listRoutes()).length, 0);
    assert.equal(await sessions.countSamples('id-1'), 8);
  });

  it('blocks save when derivation cannot produce a viable route', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    await workspace.startRouteRecording();
    await sessions.appendSamples(
      movingTrace({ sessionId: 'id-1', points: 4, stepMeters: 1 }).map((item) => ({
        ...item,
        speedMetersPerSecond: 0,
      })),
    );
    await workspace.finishRecording();
    const result = await workspace.saveRoute('id-1', 'Too short', 'walk');
    assert.equal(result.ok, false);
    assert.equal(await sessions.findPendingRouteCreation()?.id, 'id-1');
  });

  it('persists a saved route through a sqlite reload of the same database', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const sessions = new SqliteLocationSampleStore(async () => sql);
    const routes = new SqliteRouteStore(async () => sql);
    const platform = new FakeLocationPlatform();
    const trackingSessions = new TrackingSessionService(sessions, () => 'sql-session');
    const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, () => 1_700_000_000_000);
    const workspace = new RouteWorkspace(tracker, sessions, routes, () => 1_700_000_100_000, () => 'sql-route');

    await workspace.startRouteRecording();
    await sessions.appendSamples(movingTrace({ sessionId: 'sql-session', points: 14, stepMeters: 18 }));
    await workspace.finishRecording();
    const saved = await workspace.saveRoute('sql-session', 'Bridge run', 'run');
    assert.equal(saved.ok, true);

    const reloadedSessions = new SqliteLocationSampleStore(async () => sql);
    const reloadedRoutes = new SqliteRouteStore(async () => sql);
    const route = await reloadedRoutes.getRoute('sql-route');
    assert.equal(route?.name, 'Bridge run');
    assert.equal(route?.transportationMode, 'run');
    assert.ok((route?.referencePath.length ?? 0) >= 3);
    assert.equal(await reloadedSessions.countSamples('sql-session'), 14);
    assert.equal((await reloadedSessions.getSession('sql-session'))?.reviewDisposition, 'saved');
  });
});
