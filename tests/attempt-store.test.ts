import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addCheckpointFromPending,
  createCourseEditorDraft,
  previewMapTap,
  toCourseLayout,
} from '../src/domain/course-editor';
import { pointAtProgress } from '../src/domain/path-projection';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { makeRoute, northPath } from './helpers/routes';

async function insertSourceSession(sessionId: string) {
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, 1);
  await sql.run(
    `INSERT INTO tracking_session (
       id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
       background_permission_confirmed
     ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
    [sessionId, 1000, 2000],
  );
  await sql.run(
    `INSERT INTO tracking_session (
       id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
       background_permission_confirmed
     ) VALUES (?, ?, ?, 0, 'attempt', 'finished', 'saved', 0)`,
    ['attempt-session', 3000, 4000],
  );
  return sql;
}

describe('attempt persistence', () => {
  it('keeps historical checkpoint crossings after the route layout is replaced', async () => {
    const sql = await insertSourceSession('source-1');
    const routes = new SqliteRouteStore(async () => sql);
    const attempts = new SqliteAttemptStore(async () => sql);
    const path = northPath();
    const route = makeRoute({ id: 'route-1', sourceRecordingId: 'source-1', referencePath: path });
    await routes.createRoute(route);

    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(path, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-park');
    await routes.replaceCourseLayout(route.id, toCourseLayout(draft));

    await attempts.createAttempt({
      id: 'attempt-1',
      routeId: route.id,
      sessionId: 'attempt-session',
      lifecycle: 'completed',
      validity: 'valid',
      armedAtMs: 3000,
      startedAtMs: 3100,
      finishedAtMs: 4000,
      resultAcknowledged: false,
      crossings: [
        {
          id: 'cross-1',
          attemptId: 'attempt-1',
          checkpointId: 'cp-park',
          checkpointName: 'Park',
          checkpointProgressMeters: 40,
          crossedAtMs: 3500,
        },
      ],
    });

    const loadedRoute = await routes.getRoute(route.id);
    assert.ok(loadedRoute);
    let nextDraft = createCourseEditorDraft(loadedRoute);
    nextDraft = previewMapTap(nextDraft, pointAtProgress(path, 55));
    nextDraft = addCheckpointFromPending(nextDraft, () => 'cp-bridge');
    await routes.replaceCourseLayout(route.id, toCourseLayout(nextDraft));

    const reloaded = await attempts.getAttempt('attempt-1');
    assert.equal(reloaded?.crossings.length, 1);
    assert.equal(reloaded?.crossings[0]?.checkpointId, 'cp-park');
    assert.equal(reloaded?.crossings[0]?.checkpointName, 'Park');
    assert.equal(reloaded?.crossings[0]?.checkpointProgressMeters, 40);
    const fk = await sql.getFirst<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempt_checkpoint_crossing'`,
    );
    assert.doesNotMatch(fk?.sql ?? '', /route_checkpoint/);
  });

  it('migrates existing v3 routes in place and adds attempt tables', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, 4);
    const attemptTable = await sql.getFirst<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempt'`,
    );
    const crossingTable = await sql.getFirst<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempt_checkpoint_crossing'`,
    );
    assert.equal(attemptTable?.name, 'attempt');
    assert.equal(crossingTable?.name, 'attempt_checkpoint_crossing');
  });
});
