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
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { completeJourneySamples, seedPlacesForRoute } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { movingTrace } from './helpers/samples';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

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
    const places = await workspace.listPlaces();
    const origin = places.find((place) => place.name === 'Home');
    const destination = places.find((place) => place.name === 'Work');
    assert.ok(origin && destination);
    await sessions.appendSamples(
      completeJourneySamples({ origin, destination, sessionId: 'id-2' }),
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
    const { workspace, sessions, routes, places, attempts } = createSqliteWorkspace(sql, {
      now: () => 1_700_000_100_000,
      sessionId: 'attempt-session',
      routeId: 'route-1',
      attemptId: 'attempt-1',
    });

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
    const seeded = await seedPlacesForRoute(places, route);
    const armed = await workspace.armRun(route.id);
    assert.equal(armed.ok, true);
    await sessions.appendSamples(
      completeJourneySamples({
        origin: seeded.origin,
        destination: seeded.destination,
        sessionId: 'attempt-session',
      }),
    );
    const completed = await workspace.processActiveAttempt();
    assert.equal(completed?.lifecycle, 'completed');
    const before = await workspace.analyzeAttempt(route.id, 'attempt-1');
    assert.equal(before?.focus.eligible, true);
    const sampleCount = await sessions.countSamples('attempt-session');
    assert.ok(sampleCount > 10);

    const reloaded = createSqliteWorkspace(sql, {
      now: () => 1_700_000_100_000,
      sessionId: 'unused',
      routeId: 'route-1',
      attemptId: 'attempt-2',
    });
    const after = await reloaded.workspace.analyzeAttempt(route.id, 'attempt-1');
    assert.equal(after?.focus.officialTimeMs, before?.focus.officialTimeMs);
    assert.equal(after?.rank, before?.rank);
    assert.equal(after?.summary.pbAttemptId, 'attempt-1');
    assert.equal(await reloaded.sessions.countSamples('attempt-session'), sampleCount);
    assert.equal((await reloaded.attempts.getAttempt('attempt-1'))?.startedAtMs, completed?.startedAtMs);

    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(route.referencePath, 80));
    draft = addCheckpointFromPending(draft, () => 'cp-mid');
    const savedLayout = await reloaded.workspace.saveCourseLayout(route.id, toCourseLayout(draft));
    assert.equal(savedLayout.ok, true);
    assert.equal(await reloaded.sessions.countSamples('attempt-session'), sampleCount);
    const replayed = await reloaded.workspace.analyzeRoute(route.id);
    assert.equal(replayed?.analysis.summary.rankedAttemptCount, 1);
    assert.equal(replayed?.analysis.derived[0]?.segments.length, 2);
    assert.equal(await reloaded.attempts.getAttempt('attempt-1') != null, true);
  });
});
