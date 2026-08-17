import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addCheckpointFromPending,
  createCourseEditorDraft,
  previewMapTap,
  renameSelectedCheckpoint,
  setFinishZoneRadiusMeters,
  setStartZoneRadiusMeters,
  toCourseLayout,
} from '../src/domain/course-editor';
import { pointAtProgress } from '../src/domain/path-projection';
import { MemoryRouteStore } from '../src/persistence/memory-route-store';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import type { SqlExecutor } from '../src/persistence/sql-executor';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { makeRoute, northPath } from './helpers/routes';

async function insertSourceSession(sql: SqlExecutor, sessionId: string): Promise<void> {
  await sql.run(
    `INSERT INTO tracking_session (
       id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
       background_permission_confirmed
     ) VALUES (?, ?, ?, 0, 'route_creation', 'finished', 'saved', 0)`,
    [sessionId, 1000, 2000],
  );
}

describe('course layout persistence', () => {
  it('round-trips checkpoint identity, name, and progress through sqlite and derives the same display point', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    await insertSourceSession(sql, 'session-1');
    const store = new SqliteRouteStore(async () => sql);
    const path = northPath();
    const route = makeRoute({ referencePath: path });
    await store.createRoute(route);

    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(path, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-park');
    draft = renameSelectedCheckpoint(draft, 'Park');
    await store.replaceCourseLayout(route.id, toCourseLayout(draft));

    const reloaded = new SqliteRouteStore(async () => sql);
    const loaded = await reloaded.getRoute(route.id);
    assert.ok(loaded);
    assert.equal(loaded.checkpoints.length, 1);
    assert.equal(loaded.checkpoints[0]?.id, 'cp-park');
    assert.equal(loaded.checkpoints[0]?.name, 'Park');
    const expectedPoint = pointAtProgress(path, loaded.checkpoints[0]!.progressMeters);
    assert.ok(Math.abs(expectedPoint.latitude - pointAtProgress(path, 40).latitude) < 0.00001);
    assert.equal(loaded.startZone.radiusMeters, route.startZone.radiusMeters);
    assert.equal(loaded.finishZone.radiusMeters, route.finishZone.radiusMeters);
    assert.deepEqual(loaded.referencePath, path);
  });

  it('persists independently edited start and finish radiuses across reload', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    await insertSourceSession(sql, 'session-1');
    const store = new SqliteRouteStore(async () => sql);
    const route = makeRoute({
      startZone: { center: { latitude: 32.08, longitude: 34.78 }, radiusMeters: 30 },
      finishZone: { center: { latitude: 32.09, longitude: 34.78 }, radiusMeters: 30 },
    });
    await store.createRoute(route);

    let draft = createCourseEditorDraft(route);
    draft = setStartZoneRadiusMeters(draft, 42);
    draft = setFinishZoneRadiusMeters(draft, 16);
    await store.replaceCourseLayout(route.id, toCourseLayout(draft));

    const loaded = await new SqliteRouteStore(async () => sql).getRoute(route.id);
    assert.equal(loaded?.startZone.radiusMeters, 42);
    assert.equal(loaded?.finishZone.radiusMeters, 16);
    assert.deepEqual(loaded?.startZone.center, route.startZone.center);
    assert.deepEqual(loaded?.finishZone.center, route.finishZone.center);
  });

  it('mirrors whole-layout replace in the memory store', async () => {
    const store = new MemoryRouteStore();
    const route = makeRoute();
    await store.createRoute(route);
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(route.referencePath, 55));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    await store.replaceCourseLayout(route.id, toCourseLayout(draft));
    const loaded = await store.getRoute(route.id);
    assert.equal(loaded?.checkpoints[0]?.id, 'cp-1');
    assert.equal(loaded?.checkpoints[0]?.name, 'Checkpoint 1');
  });

  it('leaves the persisted layout unchanged when a transactional save fails', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    await insertSourceSession(sql, 'session-1');
    const store = new SqliteRouteStore(async () => sql);
    const route = makeRoute();
    await store.createRoute(route);
    const original = await store.getRoute(route.id);

    const wrapped: SqlExecutor = {
      exec: (statement) => sql.exec(statement),
      run: async (statement, params) => {
        if (statement.includes('INSERT INTO route_checkpoint')) {
          throw new Error('injected failure');
        }
        return sql.run(statement, params);
      },
      getFirst: (statement, params) => sql.getFirst(statement, params),
      getAll: (statement, params) => sql.getAll(statement, params),
      withTransaction: (fn) => sql.withTransaction(fn),
    };
    const failingStore = new SqliteRouteStore(async () => wrapped);
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(route.referencePath, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    await assert.rejects(() => failingStore.replaceCourseLayout(route.id, toCourseLayout(draft)));

    const after = await store.getRoute(route.id);
    assert.deepEqual(after, original);
  });

  it('deletes checkpoint rows with the route while retaining source telemetry elsewhere', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    await insertSourceSession(sql, 'session-1');
    await sql.run(
      `INSERT INTO location_sample (
         id, session_id, recorded_at_ms, latitude, longitude,
         horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['p1', 'session-1', 1100, 32.08, 34.78, 5, 4, 0],
    );
    const store = new SqliteRouteStore(async () => sql);
    const route = makeRoute();
    await store.createRoute(route);
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(route.referencePath, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    await store.replaceCourseLayout(route.id, toCourseLayout(draft));
    assert.equal((await sql.getAll('SELECT id FROM route_checkpoint WHERE route_id = ?', [route.id])).length, 1);

    await store.deleteRoute(route.id);
    assert.equal((await sql.getAll('SELECT id FROM route WHERE id = ?', [route.id])).length, 0);
    assert.equal((await sql.getAll('SELECT id FROM route_checkpoint WHERE route_id = ?', [route.id])).length, 0);
    assert.equal((await sql.getAll('SELECT id FROM location_sample WHERE session_id = ?', ['session-1'])).length, 1);
    assert.equal((await sql.getAll('SELECT id FROM tracking_session WHERE id = ?', ['session-1'])).length, 1);
  });
});
