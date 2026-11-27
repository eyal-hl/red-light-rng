import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { incompleteAttemptLabel, isJourneyCompetitive, type Attempt } from '../src/domain/attempt';
import { replayPartialTrace, partialTimingPlaces } from '../src/domain/partial-timing';
import { replayPlaceTrace } from '../src/domain/place-timing';
import { deriveSegments, findOutboundCrossingMs, segmentKey } from '../src/domain/segment-derivation';
import {
  FULL_ROUTE_START,
  nearestStartJourney,
  sameStartSelection,
  startBoardPreview,
  START_SUGGESTION_MAX_EDGE_DISTANCE_METERS,
  suggestStartSelection,
  type StartOptionsJourney,
} from '../src/domain/start-options';
import { applyMigrations } from '../src/persistence/migrations';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { checkpoint, config, DESTINATION, ORIGIN, POOL, pt, ride, T0, track } from './helpers/segments';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const B = 'b';
const B2 = 'b2';
const PARTIAL = { pool: POOL, startCheckpointId: B };

type Ctx = ReturnType<typeof createMemoryWorkspace>;

async function makeCtx(kind: 'memory' | 'sqlite', checkpoints = [checkpoint(B, 150)]): Promise<Ctx & { sql?: ReturnType<typeof createMemorySqlExecutor> }> {
  let ctx: Ctx & { sql?: ReturnType<typeof createMemorySqlExecutor> };
  if (kind === 'memory') {
    ctx = createMemoryWorkspace();
  } else {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, T0);
    let n = 0;
    ctx = {
      ...(createSqliteWorkspace(sql, {
        createSessionId: () => `s-${++n}`,
        createAttemptId: () => `a-${n}`,
      }) as unknown as Ctx),
      sql,
    };
  }
  await ctx.places.createPlace(ORIGIN);
  await ctx.places.createPlace(DESTINATION);
  if (checkpoints.length > 0) {
    const saved = await ctx.segments!.saveCheckpoints(POOL, checkpoints);
    assert.equal(saved.ok, true);
  }
  return ctx;
}

async function arm(ctx: Ctx, partial: boolean) {
  const result = await ctx.workspace.startAttempt(partial ? { partial: PARTIAL } : {});
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  const session = (await ctx.sessions.getActiveSession())!;
  return { attempt: result.ok ? result.attempt : (null as never), sessionId: session.id };
}

async function feed(ctx: Ctx, sessionId: string, points: Array<[number, number, number?, number?]>) {
  const samples = track(points, sessionId).map((s, i) => ({ ...s, id: `${sessionId}-${Math.round(s.recordedAtMs)}-${i}` }));
  await ctx.sessions.appendSamples(samples);
  return samples;
}

function near(actual: number | null, expected: number, tolerance = 300) {
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} !~ ${expected}`);
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`partial start arming and timing [${kind}] (#81)`, () => {
    it('arms with kind/checkpoint/version persisted and the journey identity, and stays untimed', async () => {
      const ctx = await makeCtx(kind);
      const { attempt } = await arm(ctx, true);
      assert.deepEqual(
        [attempt.kind, attempt.startCheckpointId, attempt.checkpointConfigVersion, attempt.originPlaceId, attempt.destinationPlaceId, attempt.lifecycle, attempt.startedAtMs],
        ['partial', B, 1, 'a', 'c', 'armed', null],
      );
      assert.equal(attempt.transportationMode, 'scooter');
      const stored = (await ctx.attempts.getAttempt(attempt.id))!;
      assert.deepEqual([stored.kind, stored.startCheckpointId, stored.checkpointConfigVersion], ['partial', B, 1]);
    });

    it('a walking approach is not timed: timing starts only on the departure from the checkpoint', async () => {
      const ctx = await makeCtx(kind);
      const { sessionId } = await arm(ctx, true);
      // Walk from 0 m at 3 m/s: enters B (130 m) at ~43 s, leaves it (170 m) at ~57 s. Stop inside B first.
      await feed(ctx, sessionId, ride({ speed: 3, toSeconds: 50 }));
      const approaching = (await ctx.attemptRuntime.processActive())!;
      assert.deepEqual([approaching.lifecycle, approaching.startedAtMs], ['armed', null], 'inside B but not departed: still waiting');
      await feed(ctx, sessionId, ride({ speed: 3, fromSeconds: 51, fromNorth: 3 * 51, toSeconds: 70, maxNorth: 480 }).map(([s, n]) => [s, n] as [number, number]));
      const started = (await ctx.attemptRuntime.processActive())!;
      assert.equal(started.lifecycle, 'active');
      near(started.startedAtMs! - T0, (170 / 3) * 1000);
      assert.ok(started.startedAtMs! > T0 + 56_000, 'never before leaving the checkpoint');
      assert.equal(started.kind, 'partial');
    });

    it('armed inside the checkpoint: the same departure crossing starts timing', async () => {
      const ctx = await makeCtx(kind);
      const { sessionId } = await arm(ctx, true);
      await feed(ctx, sessionId, [[0, 148], [1, 150], [2, 152], [3, 154]]);
      assert.equal((await ctx.attemptRuntime.processActive())!.startedAtMs, null);
      await feed(ctx, sessionId, ride({ fromNorth: 154, fromSeconds: 4, toSeconds: 20, speed: 6 }).map(([s, n]) => [s, n] as [number, number]));
      const started = (await ctx.attemptRuntime.processActive())!;
      assert.equal(started.lifecycle, 'active');
      near(started.startedAtMs! - T0, 4_000 + ((170 - 154) / 6) * 1000, 400);
    });

    it('a departure away from the destination is rejected; a later valid departure starts', async () => {
      const ctx = await makeCtx(kind);
      const { sessionId } = await arm(ctx, true);
      // Inside B, then walks back toward A (wrong way) well past the departure sustain.
      await feed(ctx, sessionId, [[0, 150], [1, 150], [2, 140], [3, 120], [4, 105], [5, 95], [6, 85], [7, 75]]);
      const wrong = (await ctx.attemptRuntime.processActive())!;
      assert.deepEqual([wrong.lifecycle, wrong.startedAtMs], ['armed', null]);
      // Returns to B and leaves toward the destination.
      await feed(ctx, sessionId, [[8, 100], [9, 125], [10, 150], [11, 160], [12, 172], [13, 180], [14, 190], [15, 200], [16, 210]]);
      const valid = (await ctx.attemptRuntime.processActive())!;
      assert.equal(valid.lifecycle, 'active');
      assert.ok(valid.startedAtMs! > T0 + 11_000 && valid.startedAtMs! < T0 + 13_000, `${valid.startedAtMs! - T0}`);
    });

    it('jitter at the checkpoint edge does not start timing; the confirmed departure does', async () => {
      const ctx = await makeCtx(kind);
      const { sessionId } = await arm(ctx, true);
      await feed(ctx, sessionId, [[0, 150], [1, 155], [2, 168], [3, 150], [4, 169], [5, 150], [6, 160]]);
      assert.equal((await ctx.attemptRuntime.processActive())!.startedAtMs, null);
      await feed(ctx, sessionId, [[7, 171], [8, 177], [9, 185], [10, 195], [11, 205]]);
      const started = (await ctx.attemptRuntime.processActive())!;
      assert.equal(started.lifecycle, 'active');
      assert.ok(started.startedAtMs! > T0 + 6_000, 'the flicker exits at 2 s and 4 s never started the run');
    });

    it('through-ride and checkpoint start use the same edge on the same trace', async () => {
      const ctx = await makeCtx(kind);
      const { attempt, sessionId } = await arm(ctx, true);
      const samples = await feed(ctx, sessionId, ride({ speed: 6, toSeconds: 80 }).map(([s, n]) => [s, n] as [number, number]));
      const done = (await ctx.attemptRuntime.processActive())!;
      assert.equal(done.lifecycle, 'completed');
      // The partial's official start IS the checkpoint's outbound crossing...
      near(done.startedAtMs, findOutboundCrossingMs(samples, checkpoint(B, 150))!, 1);
      // ...which is exactly where a through-ride's B->finish segment starts on the same trace.
      const through = deriveSegments({
        attempt: { ...done, kind: 'full', startCheckpointId: null, checkpointConfigVersion: null, startedAtMs: T0 + 5000 },
        samples,
        config: config([checkpoint(B, 150)]),
        origin: ORIGIN,
        destination: DESTINATION,
      });
      const suffix = through.segments.find((item) => item.key === segmentKey(B, null))!;
      near(suffix.startedAtMs, done.startedAtMs!, 1);
      assert.equal(attempt.id, done.id);
    });

    it('crossing an intermediate checkpoint never finishes the run; it finishes at the destination', async () => {
      const ctx = await makeCtx(kind, [checkpoint(B, 150), checkpoint(B2, 300)]);
      const { sessionId } = await arm(ctx, true);
      await feed(ctx, sessionId, ride({ speed: 6, toSeconds: 60 }).map(([s, n]) => [s, n] as [number, number]));
      const mid = (await ctx.attemptRuntime.processActive())!;
      assert.equal(mid.lifecycle, 'active', 'b2 (at 300 m) was crossed at ~50 s without ending the run');
      assert.equal(mid.finishedAtMs, null);
      await feed(ctx, sessionId, ride({ fromNorth: 360, fromSeconds: 61, toSeconds: 85, speed: 6 }).map(([s, n]) => [s, n] as [number, number]));
      const done = (await ctx.attemptRuntime.processActive())!;
      assert.equal(done.lifecycle, 'completed');
      assert.equal(done.destinationPlaceId, 'c');
      assert.equal(done.originPlaceId, 'a');
      assert.equal(done.kind, 'partial');
      // Live derivation (deferred) yields only segments from the start checkpoint on.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const keys = (await ctx.checkpoints.listSegmentResults(done.id)).map((row) => segmentKey(row.fromCheckpointId, row.toCheckpointId)).sort();
      assert.deepEqual(keys, [segmentKey(B, B2), segmentKey(B, null), segmentKey(B2, null)].sort());
      assert.equal(done.routeId, null, 'a partial run is never assigned a path variant');
      assert.equal(done.reconciliationStatus, 'reconciled');
    });

    it('a partial run never reaches full-route ranks, PB or statistics, but ranks on the suffix board', async () => {
      const ctx = await makeCtx(kind);
      // A full run first.
      const full = await arm(ctx, false);
      await feed(ctx, full.sessionId, ride({ speed: 5, toSeconds: 100 }).map(([s, n]) => [s, n] as [number, number]));
      const fullDone = (await ctx.attemptRuntime.processActive())!;
      assert.equal(fullDone.lifecycle, 'completed');
      assert.equal(fullDone.kind ?? 'full', 'full');
      assert.equal(fullDone.originPlaceId, 'a');
      await new Promise((resolve) => setTimeout(resolve, 30));
      await ctx.attempts.acknowledgeResult(fullDone.id);
      // Then a faster partial.
      const partial = await arm(ctx, true);
      await feed(ctx, partial.sessionId, ride({ speed: 9, fromNorth: 140, toSeconds: 40 }).map(([s, n]) => [s, n] as [number, number]).map(([s, n]) => [s + 1000, n] as [number, number]));
      const partialDone = (await ctx.attemptRuntime.processActive())!;
      assert.equal(partialDone.lifecycle, 'completed');
      assert.equal(isJourneyCompetitive(partialDone), false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const journey = (await ctx.workspace.loadJourney(POOL))!;
      assert.equal(journey.summary.rankedAttemptCount, 1);
      assert.equal(journey.summary.pbAttemptId, fullDone.id);
      assert.deepEqual(journey.history.map((row) => row.attemptId), [fullDone.id]);
      assert.deepEqual(journey.partialRuns.map((row) => row.attemptId), [partialDone.id]);
      const board = (await ctx.segments!.loadSegmentBoards(POOL)).boards.find((b) => b.key === segmentKey(B, null))!;
      assert.deepEqual(board.entries.map((e) => [e.attemptId, e.attemptKind]), [
        [partialDone.id, 'partial'],
        [fullDone.id, 'full'],
      ]);
    });

    it('cancel from armed and active never counts and keeps the partial label out of results', async () => {
      const ctx = await makeCtx(kind);
      const { attempt, sessionId } = await arm(ctx, true);
      const cancelledArmed = (await ctx.workspace.cancelAttempt())!;
      assert.deepEqual([cancelledArmed.id, cancelledArmed.lifecycle, cancelledArmed.validity], [attempt.id, 'cancelled', 'unranked']);
      assert.equal(await ctx.workspace.getOpenAttempt(), null);
      assert.equal(sessionId.length > 0, true);

      const second = await arm(ctx, true);
      await feed(ctx, second.sessionId, ride({ fromNorth: 140, toSeconds: 15 }).map(([s, n]) => [s, n] as [number, number]));
      assert.equal((await ctx.attemptRuntime.processActive())!.lifecycle, 'active');
      const cancelledActive = (await ctx.workspace.cancelAttempt())!;
      assert.equal(cancelledActive.lifecycle, 'cancelled');
      assert.deepEqual((await ctx.checkpoints.listSegmentResults(cancelledActive.id)), []);
    });

    it('ending a started partial early is a labeled partial non-result, hideable, never a full DNF', async () => {
      const ctx = await makeCtx(kind);
      const { sessionId } = await arm(ctx, true);
      await feed(ctx, sessionId, ride({ fromNorth: 140, toSeconds: 20 }).map(([s, n]) => [s, n] as [number, number]));
      await ctx.attemptRuntime.processActive();
      const ended = (await ctx.workspace.endAndInspectAttempt())!;
      assert.deepEqual([ended.lifecycle, ended.kind], ['ended', 'partial']);
      assert.notEqual(ended.startedAtMs, null);
      assert.equal(incompleteAttemptLabel(ended), 'PARTIAL DID NOT FINISH');
      const home = await ctx.workspace.loadHome();
      assert.deepEqual(home.incompleteAttempts.map((a) => a.id), [ended.id]);
      assert.equal(home.journeys.length, 0, 'no full-route journey exists');
      const hidden = await ctx.attemptRuntime.hideIncompleteAttempt(ended.id);
      assert.equal(hidden.ok, true);
      const journey = await ctx.workspace.loadJourney(POOL);
      assert.equal(journey?.partialRuns.length ?? 0, 0, 'hidden partial non-results leave the list');
    });

    it('never started: waiting forever then ending is PARTIAL DID NOT START', async () => {
      const ctx = await makeCtx(kind);
      const { sessionId } = await arm(ctx, true);
      await feed(ctx, sessionId, [[0, 0], [1, 10], [2, 20]]);
      const ended = (await ctx.workspace.endAndInspectAttempt())!;
      assert.equal(incompleteAttemptLabel(ended), 'PARTIAL DID NOT START');
      assert.equal(ended.startedAtMs, null);
    });

    it('holds the checkpoint edit lock while the partial run is armed or active', async () => {
      const ctx = await makeCtx(kind);
      const { sessionId } = await arm(ctx, true);
      const armed = await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150, 25)]);
      assert.equal(armed.ok, false);
      await feed(ctx, sessionId, ride({ fromNorth: 140, toSeconds: 15 }).map(([s, n]) => [s, n] as [number, number]));
      await ctx.attemptRuntime.processActive();
      assert.equal((await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150, 25)])).ok, false);
      await ctx.workspace.cancelAttempt();
      assert.equal((await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150, 25)])).ok, true);
    });

    it('refuses to arm a checkpoint that does not exist or on an unconfigured journey', async () => {
      const ctx = await makeCtx(kind);
      const missing = await ctx.workspace.startAttempt({ partial: { pool: POOL, startCheckpointId: 'ghost' } });
      assert.equal(missing.ok, false);
      assert.equal(await ctx.workspace.getOpenAttempt(), null);
      const bare = await makeCtx(kind, []);
      const none = await bare.workspace.startAttempt({ partial: PARTIAL });
      assert.equal(none.ok, false);
      assert.deepEqual(await bare.segments!.listStartOptions('scooter'), []);
    });

    it('a plain START is unchanged by the feature and a checkpoint is not a finish place', async () => {
      const ctx = await makeCtx(kind);
      const { attempt, sessionId } = await arm(ctx, false);
      assert.equal(attempt.kind ?? 'full', 'full');
      assert.deepEqual([attempt.originPlaceId, attempt.destinationPlaceId], [null, null]);
      await feed(ctx, sessionId, ride({ speed: 6, toSeconds: 80 }).map(([s, n]) => [s, n] as [number, number]));
      const done = (await ctx.attemptRuntime.processActive())!;
      assert.deepEqual([done.lifecycle, done.originPlaceId, done.destinationPlaceId], ['completed', 'a', 'c']);
      near(done.startedAtMs! - T0, 5_000, 300);
      near(done.finishedAtMs! - T0, 70_000, 300);
      assert.equal(isJourneyCompetitive(done), true);
    });

    it('listStartOptions offers configured journeys of the active mode only', async () => {
      const ctx = await makeCtx(kind);
      const options = await ctx.segments!.listStartOptions('scooter');
      assert.deepEqual(options.map((o) => [o.originName, o.destinationName, o.configVersion, o.checkpoints.map((c) => c.id)]), [['Work', 'Home', 1, [B]]]);
      assert.deepEqual(await ctx.segments!.listStartOptions('bike'), []);
    });
  });
}

describe('partial timing engine (#81)', () => {
  const cp = checkpoint(B, 150);
  const places = partialTimingPlaces(cp, DESTINATION);
  const run = (points: Array<[number, number, number?]>) =>
    replayPartialTrace(places, DESTINATION.center, track(points), { armedAtMs: T0, nowMs: T0 + 200_000 });

  it('only the checkpoint and the destination are places: other places and checkpoints cannot start or finish it', () => {
    assert.deepEqual(places.map((p) => p.id), [B, 'c']);
    // A trace that walks past the ORIGIN place and a second checkpoint never changes the outcome.
    const engine = run(ride({ speed: 6, toSeconds: 80 }));
    assert.equal(engine.lifecycle, 'completed');
    assert.equal(engine.originPlaceId, B);
    assert.equal(engine.destinationPlaceId, 'c');
  });

  it('matches the plain place engine when the departure heads toward the destination', () => {
    const points = ride({ fromNorth: 140, speed: 6, toSeconds: 50 });
    const partial = run(points);
    const plain = replayPlaceTrace(places, track(points), { armedAtMs: T0, nowMs: T0 + 200_000 });
    assert.equal(partial.startedAtMs, plain.startedAtMs);
    assert.equal(partial.finishedAtMs, plain.finishedAtMs);
  });

  it('is deterministic', () => {
    const points = ride({ fromNorth: 140, speed: 6, toSeconds: 60 });
    assert.deepEqual(run(points), run(points));
  });
});

describe('start suggestion and board preview (#81)', () => {
  const checkpoints = [checkpoint(B, 150), checkpoint(B2, 300)];
  const origin = { center: ORIGIN.center, departureRadiusMeters: 30 };

  it('suggests the nearest checkpoint within range, the full route at the origin or with no fix', () => {
    assert.deepEqual(suggestStartSelection({ position: null, origin, checkpoints }), FULL_ROUTE_START);
    assert.deepEqual(suggestStartSelection({ position: pt(5), origin, checkpoints }), FULL_ROUTE_START, 'at the origin');
    assert.deepEqual(suggestStartSelection({ position: pt(150), origin, checkpoints }), { kind: 'checkpoint', checkpointId: B });
    assert.deepEqual(suggestStartSelection({ position: pt(290), origin, checkpoints }), { kind: 'checkpoint', checkpointId: B2 });
    // Walking toward B: nearer the origin edge it is still the full route; closer to B it flips.
    assert.deepEqual(suggestStartSelection({ position: pt(70), origin, checkpoints }), FULL_ROUTE_START);
    assert.deepEqual(suggestStartSelection({ position: pt(100), origin, checkpoints }), { kind: 'checkpoint', checkpointId: B });
    assert.deepEqual(suggestStartSelection({ position: pt(0, 400), origin, checkpoints }), FULL_ROUTE_START);
    assert.ok(START_SUGGESTION_MAX_EDGE_DISTANCE_METERS > 0);
    assert.deepEqual(suggestStartSelection({ position: pt(150), origin, checkpoints: [] }), FULL_ROUTE_START);
  });

  it('previews the eligible boards: full route has prefixes and suffixes, a checkpoint start only what follows', () => {
    const full = startBoardPreview({ selection: FULL_ROUTE_START, checkpoints, originName: 'Work', destinationName: 'Home' }).map((r) => r.label);
    assert.ok(full.includes('Work → B') && full.includes('B → Home'));
    const partial = startBoardPreview({ selection: { kind: 'checkpoint', checkpointId: B }, checkpoints, originName: 'Work', destinationName: 'Home' }).map((r) => r.label);
    assert.deepEqual(partial.sort(), ['B → B2', 'B → Home', 'B2 → Home'].sort());
    assert.deepEqual(startBoardPreview({ selection: { kind: 'checkpoint', checkpointId: 'x' }, checkpoints, originName: 'W', destinationName: 'H' }), []);
    assert.equal(sameStartSelection({ kind: 'full' }, FULL_ROUTE_START), true);
    assert.equal(sameStartSelection({ kind: 'checkpoint', checkpointId: B }, FULL_ROUTE_START), false);
  });

  it('picks the nearest configured journey for the start panel', () => {
    const journey = (id: string, north: number): StartOptionsJourney => ({
      pool: { originPlaceId: id, destinationPlaceId: 'z', transportationMode: 'scooter' },
      originName: id,
      destinationName: 'Z',
      origin: { center: pt(north), departureRadiusMeters: 30, arrivalRadiusMeters: 30 },
      destination: { center: pt(north + 500), departureRadiusMeters: 30, arrivalRadiusMeters: 30 },
      configVersion: 1,
      checkpoints: [checkpoint(`${id}-cp`, north + 150)],
    });
    const journeys = [journey('far', 3000), journey('near', 0)];
    assert.equal(nearestStartJourney(pt(160), journeys)!.pool.originPlaceId, 'near');
    assert.equal(nearestStartJourney(null, journeys)!.pool.originPlaceId, 'far');
    assert.equal(nearestStartJourney(pt(0), []), null);
  });
});

describe('armed partial runtime restart (#81)', () => {
  it('a fresh runtime over the same database resumes an armed partial and times it with the stored config version', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, T0);
    const first = createSqliteWorkspace(sql) as unknown as Ctx;
    await first.places.createPlace(ORIGIN);
    await first.places.createPlace(DESTINATION);
    assert.equal((await first.segments!.saveCheckpoints(POOL, [checkpoint(B, 150)])).ok, true);
    const armed = await first.workspace.startAttempt({ partial: PARTIAL });
    assert.equal(armed.ok, true);
    const sessionId = (await first.sessions.getActiveSession())!.id;
    await feed(first, sessionId, [[0, 100], [1, 125], [2, 148]]);

    // "Process restart": brand new workspace/runtime. A new configuration version appears in the
    // meantime (bypassing the product lock) and must not change how the stored attempt is timed.
    const second = createSqliteWorkspace(sql) as unknown as Ctx;
    await second.checkpoints.saveConfig({
      pool: POOL,
      checkpoints: [checkpoint(B, 250)],
      places: await second.places.listPlaces(),
      nowMs: T0,
    });
    const resumed = (await second.attemptRuntime.processActive())!;
    assert.deepEqual([resumed.lifecycle, resumed.kind, resumed.checkpointConfigVersion], ['armed', 'partial', 1]);
    await feed(second, sessionId, ride({ fromNorth: 150, fromSeconds: 3, toSeconds: 70, speed: 6 }).map(([s, n]) => [s, n] as [number, number]));
    const done = (await second.attemptRuntime.processActive())!;
    assert.equal(done.lifecycle, 'completed');
    near(done.startedAtMs! - T0, 3_000 + (20 / 6) * 1000, 500);
    assert.equal((await new SqliteAttemptStore(async () => sql).getAttempt(done.id))!.checkpointConfigVersion, 1);
  });
});
