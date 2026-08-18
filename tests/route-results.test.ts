import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addCheckpointFromPending,
  createCourseEditorDraft,
  previewMapTap,
  toCourseLayout,
} from '../src/domain/course-editor';
import { pointAtProgress } from '../src/domain/path-projection';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import { AttemptRuntime } from '../src/product/attempt-runtime';
import { RouteWorkspace } from '../src/product/route-workspace';
import { SharedLocationTracker } from '../src/tracking/shared-location-tracker';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { makeRoute, northPath } from './helpers/routes';
import { movingTrace, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace, FakeLocationPlatform } from './helpers/workspace';

describe('route results workspace', () => {
  it('updates route summary after a completed valid attempt without resetting app data', async () => {
    let attemptSeq = 0;
    const { workspace, sessions } = createMemoryWorkspace({
      createAttemptId: () => `attempt-${++attemptSeq}`,
    });
    await workspace.startRouteRecording();
    await sessions.appendSamples(movingTrace({ sessionId: 'id-1', points: 16, stepMeters: 15 }));
    await workspace.finishRecording();
    const saved = await workspace.saveRoute('id-1', 'Home → Work', 'scooter');
    assert.equal(saved.ok, true);
    if (!saved.ok) {
      return;
    }

    const empty = await workspace.analyzeRoute(saved.route.id);
    assert.equal(empty?.analysis.summary.rankedAttemptCount, 0);
    assert.equal(empty?.analysis.summary.pbTimeMs, null);

    const armed = await workspace.armRun(saved.route.id);
    assert.equal(armed.ok, true);
    await sessions.appendSamples(
      traceAlongPath(saved.route.referencePath, { sessionId: 'id-2', stepMeters: 5, count: 55 }),
    );
    const completed = await workspace.processActiveAttempt();
    assert.equal(completed?.lifecycle, 'completed');
    assert.equal(completed?.validity, 'valid');

    const analyzed = await workspace.analyzeRoute(saved.route.id);
    assert.equal(analyzed?.analysis.summary.rankedAttemptCount, 1);
    assert.equal(analyzed?.analysis.summary.pbAttemptId, completed?.id);
    assert.ok((analyzed?.analysis.summary.pbTimeMs ?? 0) > 0);
    assert.equal(analyzed?.analysis.summary.lastAttemptId, completed?.id);
    const focus = await workspace.analyzeAttempt(saved.route.id, completed!.id);
    assert.equal(focus?.isPb, true);
    assert.equal(focus?.rank, 1);
  });

  it('reconstructs the same current-layout analysis after sqlite reload and keeps raw telemetry', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const sessions = new SqliteLocationSampleStore(async () => sql);
    const routes = new SqliteRouteStore(async () => sql);
    const attemptStore = new SqliteAttemptStore(async () => sql);
    const platform = new FakeLocationPlatform();
    const trackingSessions = new TrackingSessionService(sessions, () => 'attempt-session');
    const tracker = new SharedLocationTracker(platform, trackingSessions, sessions, () => 1_700_000_000_000);
    const runtime = new AttemptRuntime(
      tracker,
      platform,
      sessions,
      routes,
      attemptStore,
      () => 1_700_000_100_000,
      () => 'attempt-1',
    );
    const workspace = new RouteWorkspace(
      tracker,
      sessions,
      routes,
      runtime,
      () => 1_700_000_100_000,
      () => 'route-1',
    );

    await sessions.createSession('source', 1, 'route_creation');
    await sessions.completeSession('source', {
      stoppedAtMs: 2,
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
    });
    const route = makeRoute({
      id: 'route-1',
      sourceRecordingId: 'source',
      referencePath: northPath({ points: 16, stepMeters: 20 }),
    });
    await routes.createRoute(route);
    const armed = await workspace.armRun(route.id);
    assert.equal(armed.ok, true);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'attempt-session', stepMeters: 5, count: 70 }),
    );
    const completed = await workspace.processActiveAttempt();
    assert.equal(completed?.lifecycle, 'completed');
    const before = await workspace.analyzeAttempt(route.id, 'attempt-1');
    assert.equal(before?.focus.eligible, true);
    const sampleCount = await sessions.countSamples('attempt-session');
    assert.ok(sampleCount > 10);

    const reloadedSessions = new SqliteLocationSampleStore(async () => sql);
    const reloadedRoutes = new SqliteRouteStore(async () => sql);
    const reloadedAttempts = new SqliteAttemptStore(async () => sql);
    const reloadedRuntime = new AttemptRuntime(
      tracker,
      platform,
      reloadedSessions,
      reloadedRoutes,
      reloadedAttempts,
      () => 1_700_000_100_000,
      () => 'attempt-2',
    );
    const reloaded = new RouteWorkspace(
      tracker,
      reloadedSessions,
      reloadedRoutes,
      reloadedRuntime,
      () => 1_700_000_100_000,
      () => 'route-1',
    );
    const after = await reloaded.analyzeAttempt(route.id, 'attempt-1');
    assert.equal(after?.focus.officialTimeMs, before?.focus.officialTimeMs);
    assert.equal(after?.rank, before?.rank);
    assert.equal(after?.summary.pbAttemptId, 'attempt-1');
    assert.equal(await reloadedSessions.countSamples('attempt-session'), sampleCount);
    assert.equal((await reloadedAttempts.getAttempt('attempt-1'))?.startedAtMs, completed?.startedAtMs);

    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(route.referencePath, 80));
    draft = addCheckpointFromPending(draft, () => 'cp-mid');
    const savedLayout = await reloaded.saveCourseLayout(route.id, toCourseLayout(draft));
    assert.equal(savedLayout.ok, true);
    assert.equal(await reloadedSessions.countSamples('attempt-session'), sampleCount);
    const replayed = await reloaded.analyzeRoute(route.id);
    assert.equal(replayed?.analysis.summary.rankedAttemptCount, 1);
    assert.equal(replayed?.analysis.derived[0]?.segments.length, 2);
    assert.equal(await reloadedAttempts.getAttempt('attempt-1') != null, true);
  });
});
