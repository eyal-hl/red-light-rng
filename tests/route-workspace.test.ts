import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyMigrations } from '../src/persistence/migrations';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import { AttemptRuntime } from '../src/product/attempt-runtime';
import { RouteWorkspace } from '../src/product/route-workspace';
import { SharedLocationTracker } from '../src/tracking/shared-location-tracker';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';
import {
  addCheckpointFromPending,
  createCourseEditorDraft,
  previewMapTap,
  toCourseLayout,
} from '../src/domain/course-editor';
import { pointAtProgress } from '../src/domain/path-projection';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { movingTrace } from './helpers/samples';
import { createMemoryWorkspace, FakeLocationPlatform } from './helpers/workspace';

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
    assert.equal(saved.route.checkpoints.length, 0);
    assert.equal(saved.route.startProgressMeters, 0);
    assert.ok(saved.route.finishProgressMeters > 0);
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
      Array.from({ length: 12 }, (_, index) => ({
        id: `still-${index}`,
        sessionId: 'id-1',
        recordedAtMs: 1_700_000_000_000 + index * 1000,
        latitude: 32.08,
        longitude: 34.78,
        horizontalAccuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: 0,
      })),
    );
    await workspace.finishRecording();
    assert.equal((await sessions.findPendingRouteCreation())?.id, 'id-1');
    const result = await workspace.saveRoute('id-1', 'Too short', 'walk');
    assert.equal(result.ok, false);
    assert.equal((await sessions.findPendingRouteCreation())?.id, 'id-1');
  });

  it('persists a saved route through a sqlite reload of the same database', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const sessions = new SqliteLocationSampleStore(async () => sql);
    const routes = new SqliteRouteStore(async () => sql);
    const attemptStore = new SqliteAttemptStore(async () => sql);
    const platform = new FakeLocationPlatform();
    const trackingSessions = new TrackingSessionService(sessions, () => 'sql-session');
    const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, () => 1_700_000_000_000);
    const attemptRuntime = new AttemptRuntime(
      tracker,
      platform,
      sessions,
      routes,
      attemptStore,
      () => 1_700_000_100_000,
      () => 'sql-attempt',
    );
    const workspace = new RouteWorkspace(
      tracker,
      sessions,
      routes,
      attemptRuntime,
      () => 1_700_000_100_000,
      () => 'sql-route',
    );

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

  it('deletes sqlite route rows and cascaded reference points while keeping source samples', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const sessions = new SqliteLocationSampleStore(async () => sql);
    const routes = new SqliteRouteStore(async () => sql);
    const attemptStore = new SqliteAttemptStore(async () => sql);
    const platform = new FakeLocationPlatform();
    const trackingSessions = new TrackingSessionService(sessions, () => 'sql-session');
    const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, () => 1_700_000_000_000);
    const attemptRuntime = new AttemptRuntime(
      tracker,
      platform,
      sessions,
      routes,
      attemptStore,
      () => 1_700_000_100_000,
      () => 'sql-attempt',
    );
    const workspace = new RouteWorkspace(
      tracker,
      sessions,
      routes,
      attemptRuntime,
      () => 1_700_000_100_000,
      () => 'sql-route',
    );

    await workspace.startRouteRecording();
    await sessions.appendSamples(movingTrace({ sessionId: 'sql-session', points: 14, stepMeters: 18 }));
    await workspace.finishRecording();
    const saved = await workspace.saveRoute('sql-session', 'Bridge run', 'run');
    assert.equal(saved.ok, true);
    if (!saved.ok) {
      return;
    }

    const referencePointsBefore = await sql.getAll<{ route_id: string }>(
      'SELECT route_id FROM route_reference_point WHERE route_id = ?',
      [saved.route.id],
    );
    assert.ok(referencePointsBefore.length >= 3);

    await workspace.deleteRoute(saved.route.id);

    const reloadedRoutes = new SqliteRouteStore(async () => sql);
    const reloadedSessions = new SqliteLocationSampleStore(async () => sql);
    assert.equal(await reloadedRoutes.getRoute(saved.route.id), null);
    assert.equal((await sql.getAll('SELECT id FROM route WHERE id = ?', [saved.route.id])).length, 0);
    assert.equal(
      (await sql.getAll('SELECT route_id FROM route_reference_point WHERE route_id = ?', [saved.route.id]))
        .length,
      0,
    );
    assert.equal(await reloadedSessions.countSamples('sql-session'), 14);
    assert.equal((await reloadedSessions.getSession('sql-session'))?.id, 'sql-session');
    assert.equal((await reloadedSessions.getSession('sql-session'))?.reviewDisposition, 'saved');
  });

  it('saves a course layout through the workspace without changing source telemetry', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    await workspace.startRouteRecording();
    await sessions.appendSamples(movingTrace({ sessionId: 'id-1', points: 16, stepMeters: 15 }));
    await workspace.finishRecording();
    const saved = await workspace.saveRoute('id-1', 'Home → Work', 'scooter');
    assert.equal(saved.ok, true);
    if (!saved.ok) {
      return;
    }

    let draft = createCourseEditorDraft(saved.route);
    draft = previewMapTap(draft, pointAtProgress(saved.route.referencePath, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    const result = await workspace.saveCourseLayout(saved.route.id, toCourseLayout(draft));
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.route.checkpoints.length, 1);
    assert.equal(await sessions.countSamples('id-1'), 16);
    assert.deepEqual(result.route.referencePath, saved.route.referencePath);

    const rejected = await workspace.saveCourseLayout(saved.route.id, {
      ...toCourseLayout(draft),
      checkpoints: [
        { id: 'a', name: 'A', progressMeters: 20 },
        { id: 'b', name: 'B', progressMeters: 22 },
      ],
    });
    assert.equal(rejected.ok, false);
    const unchanged = await workspace.getRoute(saved.route.id);
    assert.equal(unchanged?.checkpoints.length, 1);
  });
});
