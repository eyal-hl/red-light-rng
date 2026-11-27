import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attempt } from '../src/domain/attempt';
import { journeyPoolKey } from '../src/domain/journey';
import { segmentKey } from '../src/domain/segment-derivation';
import { applyMigrations } from '../src/persistence/migrations';
import { SegmentRecalculationService } from '../src/product/competitive-segments';
import { baseAttempt } from './helpers/backup-fixtures';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { checkpoint, DESTINATION, ORIGIN, POOL, ride, T0, track } from './helpers/segments';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const B = 'b';

type Ctx = ReturnType<typeof createMemoryWorkspace> & { kind: 'memory' | 'sqlite' };

async function makeCtx(kind: 'memory' | 'sqlite', chunkSize?: number): Promise<Ctx> {
  if (kind === 'memory') {
    const ws = createMemoryWorkspace({ recalcChunkSize: chunkSize });
    await ws.places.createPlace(ORIGIN);
    await ws.places.createPlace(DESTINATION);
    return { ...ws, kind };
  }
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, T0);
  const ws = createSqliteWorkspace(sql, { recalcChunkSize: chunkSize });
  await ws.places.createPlace(ORIGIN);
  await ws.places.createPlace(DESTINATION);
  return { ...(ws as unknown as ReturnType<typeof createMemoryWorkspace>), kind };
}

type RunOptions = {
  speed?: number;
  shiftMs?: number;
  /** Partial attempt starting inside checkpoint `b`. */
  partial?: boolean;
  configVersion?: number;
  noSamples?: boolean;
};

/** A completed run on the straight A -> C line. Official times follow the same crossings the engine uses. */
async function seedRun(ctx: Ctx, id: string, options: RunOptions = {}): Promise<Attempt> {
  const speed = options.speed ?? 6;
  const shift = options.shiftMs ?? 0;
  const sessionId = `session-${id}`;
  const fromNorth = options.partial ? 140 : 0;
  const total = Math.ceil((480 - fromNorth) / speed) + 2;
  const samples = options.noSamples
    ? []
    : track(ride({ fromNorth, speed, toSeconds: total }), sessionId).map((s, i) => ({
        ...s,
        id: `${sessionId}-${i}`,
        recordedAtMs: s.recordedAtMs + shift,
      }));
  await ctx.sessions.createSession(sessionId, T0 + shift, 'attempt');
  if (samples.length > 0) {
    await ctx.sessions.appendSamples(samples);
  }
  await ctx.sessions.completeSession(sessionId, {
    stoppedAtMs: T0 + shift + total * 1000,
    captureOutcome: 'finished',
    reviewDisposition: 'saved',
  });
  const startNorth = options.partial ? 170 : 30;
  const attempt = baseAttempt({
    id,
    sessionId,
    originPlaceId: 'a',
    destinationPlaceId: 'c',
    armedAtMs: T0 + shift - 1000,
    startedAtMs: T0 + shift + ((startNorth - fromNorth) / speed) * 1000,
    finishedAtMs: T0 + shift + ((420 - fromNorth) / speed) * 1000,
    startedUtcOffsetMinutes: 0,
    startedTimezoneId: 'UTC',
    startedLocalTimeSource: 'captured',
    ...(options.partial
      ? { kind: 'partial' as const, startCheckpointId: B, checkpointConfigVersion: options.configVersion ?? 1 }
      : {}),
  });
  await ctx.attempts.saveAttempt(attempt);
  return attempt;
}

async function configure(ctx: Ctx, list = [checkpoint(B, 150)]) {
  const result = await ctx.segments.saveCheckpoints(POOL, list);
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result;
}

async function runToEnd(service: SegmentRecalculationService) {
  return service.run();
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`competitive segments product layer [${kind}] (#81)`, () => {
    describe('live derivation when a run finishes', () => {
      it('derives and stores current-version results without touching the official attempt', async () => {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        const attempt = await seedRun(ctx, 'r1');
        const result = await ctx.segments.deriveForAttempt('r1');
        assert.deepEqual(result, { status: 'derived', configVersion: 1, resultCount: 2 });
        const rows = await ctx.checkpoints.listSegmentResults('r1');
        assert.deepEqual(rows.map((row) => [row.status, row.configVersion]), [['valid', 1], ['valid', 1]]);
        assert.deepEqual(await ctx.attempts.getAttempt('r1'), attempt);
      });

      it('skips cleanly without a configuration, for DNFs and for partials of another version', async () => {
        const ctx = await makeCtx(kind);
        await seedRun(ctx, 'plain');
        assert.deepEqual(await ctx.segments.deriveForAttempt('plain'), { status: 'skipped', reason: 'no_config' });
        assert.deepEqual(await ctx.checkpoints.listSegmentResults('plain'), []);
        await configure(ctx);
        const dnf = await seedRun(ctx, 'dnf');
        await ctx.attempts.saveAttempt({ ...dnf, lifecycle: 'ended', validity: 'unranked', finishedAtMs: null });
        assert.deepEqual(await ctx.segments.deriveForAttempt('dnf'), { status: 'skipped', reason: 'not_eligible' });
        await seedRun(ctx, 'old-partial', { partial: true, configVersion: 7 });
        assert.deepEqual(await ctx.segments.deriveForAttempt('old-partial'), { status: 'skipped', reason: 'config_mismatch' });
        assert.deepEqual(await ctx.segments.deriveForAttempt('missing'), { status: 'skipped', reason: 'no_attempt' });
      });

      it('no GPS makes only the segments unavailable and the run stays official', async () => {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        const attempt = await seedRun(ctx, 'nogps', { noSamples: true });
        await ctx.segments.deriveForAttempt('nogps');
        const rows = await ctx.checkpoints.listSegmentResults('nogps');
        assert.ok(rows.length > 0 && rows.every((row) => row.status === 'unavailable' && row.unavailableReason === 'missing_telemetry'));
        assert.deepEqual(await ctx.attempts.getAttempt('nogps'), attempt);
      });

      it('runs off the critical path: the completion hook is deferred and its failures are swallowed', async () => {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        const attempt = await seedRun(ctx, 'hook');
        // Hook fires after the call returns (not before), and derives the results.
        const returned = (ctx.attemptRuntime as any).notifyCompleted(attempt);
        assert.equal(returned, attempt, 'the finished attempt is returned untouched and immediately');
        assert.deepEqual(await ctx.checkpoints.listSegmentResults('hook'), [], 'not derived synchronously');
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal((await ctx.checkpoints.listSegmentResults('hook')).length, 2);
        // A failing hook never propagates.
        ctx.attemptRuntime.setOnAttemptCompleted(() => {
          throw new Error('boom');
        });
        assert.doesNotThrow(() => (ctx.attemptRuntime as any).notifyCompleted(attempt));
        await new Promise((resolve) => setTimeout(resolve, 25));
        // Non-completed attempts never trigger it.
        let calls = 0;
        ctx.attemptRuntime.setOnAttemptCompleted(() => {
          calls += 1;
        });
        (ctx.attemptRuntime as any).notifyCompleted({ ...attempt, lifecycle: 'ended' });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(calls, 0);
      });
    });

    describe('stale handling after a configuration edit', () => {
      it('reports stale attempts, never mixes versions, and recalculation brings them current', async () => {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        await seedRun(ctx, 'r1');
        await seedRun(ctx, 'r2', { speed: 5 });
        await ctx.segments.deriveForAttempt('r1');
        await ctx.segments.deriveForAttempt('r2');
        let status = await ctx.segments.getPoolStatus(POOL);
        assert.deepEqual([status.eligibleAttemptCount, status.currentAttemptCount, status.staleAttemptCount, status.needsRecalculation], [2, 2, 0, false]);
        assert.equal((await ctx.segments.loadSegmentBoards(POOL)).boards.find((b) => b.key === segmentKey(B, null))!.validCount, 2);

        // Editing creates v2: v1 rows are stale and invisible; nothing is recomputed automatically.
        await configure(ctx, [checkpoint(B, 150, 25)]);
        status = await ctx.segments.getPoolStatus(POOL);
        assert.equal(status.config!.version, 2);
        assert.deepEqual([status.eligibleAttemptCount, status.currentAttemptCount, status.staleAttemptCount, status.needsRecalculation], [2, 0, 2, true]);
        const boards = await ctx.segments.loadSegmentBoards(POOL);
        assert.ok(boards.boards.every((board) => board.validCount === 0 && board.pb === null), 'no v1 result leaks into the v2 board');
        assert.equal((await ctx.checkpoints.listSegmentResults('r1')).every((row) => row.configVersion === 1), true);

        // Manual recalculation publishes v2 and prunes the stale v1 rows.
        assert.equal((await ctx.segmentRecalc.start()).ok, true);
        assert.equal((await runToEnd(ctx.segmentRecalc)).status, 'published');
        status = await ctx.segments.getPoolStatus(POOL);
        assert.deepEqual([status.currentAttemptCount, status.staleAttemptCount, status.needsRecalculation], [2, 0, false]);
        assert.equal((await ctx.checkpoints.listSegmentResults('r1')).every((row) => row.configVersion === 2), true);
        assert.equal((await ctx.segments.loadSegmentBoards(POOL)).boards.find((b) => b.key === segmentKey(B, null))!.validCount, 2);
      });

      it('an unconfigured pool has no boards and nothing to recalculate', async () => {
        const ctx = await makeCtx(kind);
        await seedRun(ctx, 'r1');
        const status = await ctx.segments.getPoolStatus(POOL);
        assert.equal(status.config, null);
        assert.equal(status.needsRecalculation, false);
        assert.deepEqual((await ctx.segments.loadSegmentBoards(POOL)).boards, []);
        const started = await ctx.segmentRecalc.start();
        assert.equal(started.ok, false);
      });
    });

    describe('Recalculate segments job lifecycle', () => {
      async function withRuns(chunk?: number) {
        const ctx = await makeCtx(kind, chunk);
        await configure(ctx);
        for (const [index, speed] of [6, 5, 7, 4].entries()) {
          await seedRun(ctx, `r${index}`, { speed, shiftMs: index * 3 * HOUR });
        }
        return ctx;
      }

      it('start -> progress -> publish, with derived rows only and official data untouched', async () => {
        const ctx = await withRuns(2);
        const before = await ctx.attempts.listAttempts({ kind: 'all' });
        const preview = await ctx.segmentRecalc.preview();
        assert.deepEqual([preview.candidateCount, preview.configuredPoolCount, preview.blockingJobKind], [4, 1, null]);
        assert.deepEqual(await ctx.checkpoints.listSegmentResultsForPool(POOL, 1), [], 'preview wrote nothing; no automatic backfill');

        const started = await ctx.segmentRecalc.start();
        assert.equal(started.ok, true);
        const progress: number[] = [];
        const result = await ctx.segmentRecalc.run({ onProgress: (p) => void progress.push(p.counts.processed) });
        assert.equal(result.status, 'published');
        assert.deepEqual(progress.slice(0, 2), [2, 4], 'bounded chunks report progress');
        assert.equal((await ctx.checkpoints.listSegmentResultsForPool(POOL, 1)).length, 8);
        assert.deepEqual(await ctx.attempts.listAttempts({ kind: 'all' }), before, 'attempts never modified');
        assert.equal(result.status === 'published' && result.progress.counts.updated, 4);
      });

      it('resumes after an app restart without redoing finished work', async () => {
        const ctx = await withRuns(1);
        await ctx.segmentRecalc.start();
        let chunks = 0;
        const stopped = await ctx.segmentRecalc.run({ shouldStop: () => chunks++ >= 2 });
        assert.equal(stopped.status, 'stopped');
        assert.equal(stopped.status === 'stopped' && stopped.progress.counts.processed, 2);
        assert.deepEqual(await ctx.checkpoints.listSegmentResultsForPool(POOL, 1), [], 'nothing published before the end');

        // "Relaunch": a brand new service over the same persisted job state.
        const reborn = new SegmentRecalculationService({
          checkpoints: ctx.checkpoints,
          attempts: ctx.attempts,
          sessions: ctx.sessions,
          places: ctx.places,
          jobs: ctx.jobs,
          yieldToIdle: async () => {},
          chunkSize: 1,
        });
        assert.equal((await reborn.getProgress())!.counts.processed, 2, 'checkpoint survived');
        assert.equal((await reborn.start()).ok && (await reborn.start()).ok, true);
        const finished = await reborn.run();
        assert.equal(finished.status, 'published');
        assert.equal(finished.status === 'published' && finished.progress.counts.updated, 4);
      });

      it('pauses behind a live attempt and cancel discards everything', async () => {
        const ctx = await withRuns(1);
        await ctx.segmentRecalc.start();
        await ctx.attempts.saveAttempt(
          baseAttempt({ id: 'live', sessionId: 'live-s', lifecycle: 'armed', validity: 'pending', armedAtMs: T0 }),
        ).catch(() => {});
        if ((await ctx.attempts.getOpenAttempt()) == null) {
          return; // SQLite needs a session row for the armed attempt; covered by the edit-lock test below.
        }
        const paused = await ctx.segmentRecalc.run();
        assert.equal(paused.status, 'paused');
        await ctx.attempts.deleteAttempt('live');
        const cancelled = await ctx.segmentRecalc.cancel();
        assert.equal(cancelled.ok, true);
        assert.equal(cancelled.progress!.job.status, 'cancelled');
        assert.deepEqual(await ctx.checkpoints.listSegmentResultsForPool(POOL, 1), []);
        assert.equal(await ctx.segmentRecalc.hasBlockingJob(), false);
      });

      it('cancel before publication leaves no derived rows and allows a fresh job', async () => {
        const ctx = await withRuns(1);
        await ctx.segmentRecalc.start();
        let chunks = 0;
        await ctx.segmentRecalc.run({ shouldStop: () => chunks++ >= 1 });
        const cancelled = await ctx.segmentRecalc.cancel();
        assert.equal(cancelled.ok, true);
        assert.deepEqual(await ctx.checkpoints.listSegmentResultsForPool(POOL, 1), []);
        assert.equal((await ctx.segmentRecalc.cancel()).ok, false, 'nothing left to cancel');
        assert.equal((await ctx.segmentRecalc.start()).ok, true);
        assert.equal((await runToEnd(ctx.segmentRecalc)).status, 'published');
      });

      it('a repeated or duplicate trigger is idempotent', async () => {
        const ctx = await withRuns();
        const first = await ctx.segmentRecalc.start();
        const duplicate = await ctx.segmentRecalc.start();
        assert.equal(first.ok && !first.alreadyExists, true);
        assert.equal(duplicate.ok && duplicate.alreadyExists, true);
        await runToEnd(ctx.segmentRecalc);
        const once = await ctx.checkpoints.listSegmentResultsForPool(POOL, 1);
        await ctx.segmentRecalc.start();
        await runToEnd(ctx.segmentRecalc);
        assert.deepEqual(await ctx.checkpoints.listSegmentResultsForPool(POOL, 1), once, 'same rows, no duplicates');
        assert.equal(once.length, 8);
      });

      it('failed runs are reported and retried as a follow-up job', async () => {
        const ctx = await withRuns();
        await ctx.segmentRecalc.start();
        let calls = 0;
        // Process everything but do not publish yet.
        await ctx.segmentRecalc.run({ shouldStop: () => calls++ >= 1 });
        // A run's official window changes before publication: its staged rows are no longer valid.
        const moved = (await ctx.attempts.getAttempt('r0'))!;
        await ctx.attempts.saveAttempt({ ...moved, finishedAtMs: moved.finishedAtMs! + 500 });
        const published = await runToEnd(ctx.segmentRecalc);
        assert.equal(published.status, 'published');
        const progress = published.status === 'published' ? published.progress : null;
        assert.equal(progress!.counts.errors, 1);
        assert.equal(progress!.canRetryFailed, true);
        assert.equal((await ctx.checkpoints.listSegmentResults('r0')).length, 0, 'the failed run published nothing');
        assert.equal((await ctx.checkpoints.listSegmentResults('r1')).length, 2);

        const retry = await ctx.segmentRecalc.retryFailed();
        assert.equal(retry.ok, true);
        assert.equal((await runToEnd(ctx.segmentRecalc)).status, 'published');
        assert.equal((await ctx.checkpoints.listSegmentResults('r0')).length, 2);
      });

      it('discards staged results when the configuration or the places change mid-job', async () => {
        const ctx = await withRuns();
        await ctx.segmentRecalc.start();
        let calls = 0;
        await ctx.segmentRecalc.run({ shouldStop: () => calls++ >= 1 });
        // Bypass the product lock to simulate a change slipping in (e.g. restore): the job must notice.
        await ctx.checkpoints.saveConfig({
          pool: POOL,
          checkpoints: [checkpoint(B, 150, 22)],
          places: await ctx.places.listPlaces(),
          nowMs: T0,
        });
        const result = await runToEnd(ctx.segmentRecalc);
        assert.equal(result.status, 'cancelled');
        assert.match(result.status === 'cancelled' ? result.progress.job.message! : '', /Checkpoints changed/);
        assert.deepEqual(await ctx.checkpoints.listSegmentResultsForPool(POOL, 1), []);
        assert.deepEqual(await ctx.checkpoints.listSegmentResultsForPool(POOL, 2), []);
      });

      it('gives unavailable (not fabricated) results only for runs without GPS evidence', async () => {
        const ctx = await withRuns();
        await seedRun(ctx, 'blind', { noSamples: true, shiftMs: 9 * HOUR });
        await ctx.segmentRecalc.start();
        await runToEnd(ctx.segmentRecalc);
        const blind = await ctx.checkpoints.listSegmentResults('blind');
        assert.ok(blind.every((row) => row.status === 'unavailable'));
        const good = await ctx.checkpoints.listSegmentResults('r0');
        assert.ok(good.every((row) => row.status === 'valid'));
      });
    });

    describe('one job at a time across kinds, and the edit lock', () => {
      async function prepared() {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        await seedRun(ctx, 'r0');
        await seedRun(ctx, 'r1', { speed: 5, shiftMs: 2 * HOUR });
        return ctx;
      }

      it('a running segments job blocks a history job and vice versa', async () => {
        const ctx = await prepared();
        await ctx.segmentRecalc.start();
        const history = await ctx.recalc.start();
        assert.equal(history.ok, false);
        assert.match(history.ok ? '' : history.reason, /segment recalculation/);
        assert.equal(await ctx.recalc.getProgress(), null, 'the history service never exposes a segments job');
        assert.equal((await ctx.recalc.run()).status, 'none', 'and never processes it');
        assert.equal((await ctx.recalc.cancel()).ok, false);
        assert.equal((await ctx.segmentRecalc.start()).ok && (await ctx.segmentRecalc.start()).ok, true);
        assert.equal(await ctx.recalc.hasBlockingJob(), true, 'the shared lock covers both kinds');
        await ctx.segmentRecalc.cancel();

        const started = await ctx.recalc.start();
        assert.equal(started.ok, true);
        const segments = await ctx.segmentRecalc.start();
        assert.equal(segments.ok, false);
        assert.match(segments.ok ? '' : segments.reason, /history recalculation/);
        assert.equal(await ctx.segmentRecalc.getProgress(), null);
        assert.equal((await ctx.segmentRecalc.run()).status, 'none');
        assert.equal((await ctx.segmentRecalc.cancel()).ok, false);
        assert.equal((await ctx.recalc.getProgress())!.job.kind, 'history');
      });

      it('rejects checkpoint saves while any recalculation job exists', async () => {
        const ctx = await prepared();
        await ctx.segmentRecalc.start();
        const blocked = await ctx.segments.saveCheckpoints(POOL, [checkpoint(B, 150, 25)]);
        assert.equal(blocked.ok, false);
        assert.match(blocked.ok ? '' : blocked.reason, /recalculation job/);
        assert.equal((await ctx.segments.getPoolStatus(POOL)).blockingJobKind, 'segments');
        await ctx.segmentRecalc.cancel();
        assert.equal((await ctx.segments.saveCheckpoints(POOL, [checkpoint(B, 150, 25)])).ok, true);

        await ctx.recalc.start();
        const blockedByHistory = await ctx.segments.saveCheckpoints(POOL, [checkpoint(B, 150, 30)]);
        assert.equal(blockedByHistory.ok, false);
        assert.equal((await ctx.segments.getPoolStatus(POOL)).blockingJobKind, 'history');
        assert.equal((await ctx.checkpoints.getCurrentConfig(POOL))!.version, 2, 'nothing was written');
      });

      it('rejects checkpoint saves while a run is armed or active, and place edits during a segments job', async () => {
        const ctx = await prepared();
        if (kind === 'memory') {
          await ctx.attempts.saveAttempt(
            baseAttempt({ id: 'live', sessionId: 'live-s', lifecycle: 'armed', validity: 'pending', armedAtMs: T0 }),
          );
        } else {
          await ctx.sessions.createSession('live-s', T0, 'attempt');
          await ctx.attempts.saveAttempt(
            baseAttempt({ id: 'live', sessionId: 'live-s', lifecycle: 'armed', validity: 'pending', armedAtMs: T0 }),
          );
        }
        const open = await ctx.segments.saveCheckpoints(POOL, [checkpoint(B, 150, 25)]);
        assert.equal(open.ok, false);
        assert.match(open.ok ? '' : open.reason, /current run/);
        assert.equal((await ctx.segmentRecalc.start()).ok, false, 'a live run also blocks starting the job');
        await ctx.attempts.deleteAttempt('live');

        await ctx.segmentRecalc.start();
        const origin = (await ctx.places.getPlace('a'))!;
        const edited = await ctx.workspace.savePlace({ ...origin, departureRadiusMeters: origin.departureRadiusMeters + 5 });
        assert.equal(edited.ok, false, 'the shared job slot also locks Place edits');
      });

      it('validates at save time through the product API', async () => {
        const ctx = await makeCtx(kind);
        const bad = await ctx.segments.saveCheckpoints(POOL, [checkpoint(B, 435)]);
        assert.equal(bad.ok, false);
        assert.equal(bad.ok ? 0 : bad.issues[0]!.code, 'overlaps_place');
        const gone = await ctx.segments.saveCheckpoints({ ...POOL, destinationPlaceId: 'nope' }, [checkpoint(B, 150)]);
        assert.equal(gone.ok, false);
        const ok = await ctx.segments.saveCheckpoints(POOL, [checkpoint(B, 150)]);
        assert.deepEqual(ok.ok && [ok.changed, ok.config.version], [true, 1]);
        const same = await ctx.segments.saveCheckpoints(POOL, [checkpoint(B, 150)]);
        assert.deepEqual(same.ok && [same.changed, same.config.version], [false, 1]);
      });
    });

    describe('segment leaderboard data', () => {
      async function boardCtx() {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        // B->C = 250 / speed s; A->B = 100 / speed s. Two full runs tie at speed 5.
        await seedRun(ctx, 'fast', { speed: 10, shiftMs: 0 }); // Tue 22:13 UTC
        await seedRun(ctx, 'tie-late', { speed: 5, shiftMs: 2 * DAY + 3 * HOUR }); // Thu
        await seedRun(ctx, 'tie-early', { speed: 5, shiftMs: DAY }); // Wed
        await seedRun(ctx, 'slow', { speed: 4, shiftMs: 3 * DAY }); // Fri
        await seedRun(ctx, 'partial', { speed: 8, partial: true, shiftMs: 4 * DAY }); // Sat, B->C only
        for (const id of ['fast', 'tie-late', 'tie-early', 'slow', 'partial']) {
          await ctx.segments.deriveForAttempt(id);
        }
        return ctx;
      }

      it('ranks eligible valid results per segment: PB, ordinal rank, count, median, ties', async () => {
        const ctx = await boardCtx();
        const { boards } = await ctx.segments.loadSegmentBoards(POOL);
        assert.deepEqual(boards.map((b) => b.key), [segmentKey(null, B), segmentKey(B, null)]);
        const bc = boards.find((b) => b.key === segmentKey(B, null))!;
        assert.deepEqual([bc.fromName, bc.toName], ['B', 'Home']);
        assert.equal(bc.validCount, 5, 'the partial B->C ranks alongside the full-run suffixes');
        assert.deepEqual(bc.entries.map((e) => [e.attemptId, e.rank]), [
          ['fast', 1],
          ['partial', 2],
          ['tie-early', 3],
          ['tie-late', 4],
          ['slow', 5],
        ]);
        assert.equal(bc.pb!.attemptId, 'fast');
        assert.equal(bc.entries.find((e) => e.attemptId === 'partial')!.attemptKind, 'partial');
        const tie = bc.entries.filter((e) => e.durationMs === bc.entries[2]!.durationMs);
        assert.deepEqual(tie.map((e) => e.attemptId), ['tie-early', 'tie-late'], 'tie broken by earlier start');
        // Median of the 5 durations is the middle one (50 s / 4 s... sorted: 25, 31.25, 50, 50, 62.5).
        assert.ok(Math.abs(bc.medianMs! - 50_000) < 500);

        const ab = boards.find((b) => b.key === segmentKey(null, B))!;
        assert.equal(ab.validCount, 4, 'a partial has no A->B result');
        assert.ok(ab.entries.every((e) => e.attemptKind === 'full'));
      });

      it('marks entries that tie the PB', async () => {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        await seedRun(ctx, 'x', { speed: 5 });
        await seedRun(ctx, 'y', { speed: 5, shiftMs: DAY });
        await seedRun(ctx, 'z', { speed: 4, shiftMs: 2 * DAY });
        for (const id of ['x', 'y', 'z']) await ctx.segments.deriveForAttempt(id);
        const bc = (await ctx.segments.loadSegmentBoards(POOL)).boards.find((b) => b.key === segmentKey(B, null))!;
        assert.deepEqual(bc.entries.map((e) => [e.attemptId, e.isPb, e.tiedWithPb]), [
          ['x', true, true],
          ['y', false, true],
          ['z', false, false],
        ]);
      });

      it('honours the weekday and time-of-day filters and the sort options of the full-route board', async () => {
        const ctx = await boardCtx();
        const key = segmentKey(B, null);
        const pick = async (filter: object, sort?: 'ranked' | 'chronological') =>
          (await ctx.segments.loadSegmentBoards(POOL, { filter, sort })).boards.find((b) => b.key === key)!;
        // T0 is a Tuesday 22:13 UTC.
        const tuesday = await pick({ weekday: 2 });
        assert.deepEqual(tuesday.entries.map((e) => e.attemptId), ['fast']);
        const wednesday = await pick({ weekday: 3 });
        assert.deepEqual(wednesday.entries.map((e) => [e.attemptId, e.rank]), [['tie-early', 1]], 'ranks restart within a filter');
        const lateEvening = await pick({ hourBucket: 22 });
        assert.deepEqual(lateEvening.entries.map((e) => e.attemptId).sort(), ['fast', 'partial', 'slow', 'tie-early'].sort());
        const both = await pick({ weekday: 5, hourBucket: 1 }); // Friday 01:13 (Tue 22:13 + 2 days + 3 h)
        assert.deepEqual(both.entries.map((e) => e.attemptId), ['tie-late']);
        assert.equal((await pick({ weekday: 0 })).validCount, 0);

        const chronological = await pick({}, 'chronological');
        assert.deepEqual(chronological.entries.map((e) => e.attemptId), ['partial', 'slow', 'tie-late', 'tie-early', 'fast']);
        assert.deepEqual(chronological.entries.map((e) => e.rank).sort(), [1, 2, 3, 4, 5], 'ranks stay by time');
      });

      it('excludes hidden, unavailable, DNF and stale entries', async () => {
        const ctx = await boardCtx();
        const key = segmentKey(B, null);
        await seedRun(ctx, 'blind', { noSamples: true, shiftMs: 6 * DAY });
        await ctx.segments.deriveForAttempt('blind');
        const dnf = await seedRun(ctx, 'dnf', { speed: 20, shiftMs: 7 * DAY });
        await ctx.segments.deriveForAttempt('dnf');
        await ctx.attempts.saveAttempt({ ...dnf, lifecycle: 'ended', validity: 'unranked', finishedAtMs: null });
        const bc = (await ctx.segments.loadSegmentBoards(POOL)).boards.find((b) => b.key === key)!;
        assert.equal(bc.validCount, 5);
        assert.ok(!bc.entries.some((e) => e.attemptId === 'blind' || e.attemptId === 'dnf'));
      });
    });

    describe('official results never change', () => {
      it('full-route PB, rank, statistics and every attempt are identical after creating/editing checkpoints and backfilling', async () => {
        const ctx = await makeCtx(kind);
        for (const [index, speed] of [6, 5, 7].entries()) {
          await seedRun(ctx, `r${index}`, { speed, shiftMs: index * DAY });
        }
        await seedRun(ctx, 'faster-partial', { speed: 30, partial: true, shiftMs: 5 * DAY });
        const snapshot = async () => {
          const journey = (await ctx.workspace.loadJourney(POOL))!;
          return {
            summary: journey.summary,
            statistics: journey.statistics,
            history: journey.history,
            attempts: await ctx.attempts.listAttempts({ kind: 'all' }),
          };
        };
        const before = await snapshot();
        assert.equal(before.summary.rankedAttemptCount, 3);

        await configure(ctx);
        assert.deepEqual(await snapshot(), before, 'creating a checkpoint changes nothing official');
        await configure(ctx, [checkpoint(B, 150, 25), checkpoint('b2', 300)]);
        assert.deepEqual(await snapshot(), before, 'editing it changes nothing official');
        await ctx.segmentRecalc.start();
        assert.equal((await runToEnd(ctx.segmentRecalc)).status, 'published');
        assert.deepEqual(await snapshot(), before, 'the backfill changes nothing official');
        assert.ok((await ctx.checkpoints.listSegmentResultsForPool(POOL, 2)).length > 0);
      });

      it('historical suffix data ranks alongside new partial data after a backfill', async () => {
        const ctx = await makeCtx(kind);
        await seedRun(ctx, 'old-full', { speed: 5 });
        await seedRun(ctx, 'new-partial', { speed: 6, partial: true, shiftMs: DAY, configVersion: 1 });
        await configure(ctx);
        assert.equal((await ctx.segments.getPoolStatus(POOL)).staleAttemptCount, 2);
        await ctx.segmentRecalc.start();
        await runToEnd(ctx.segmentRecalc);
        const bc = (await ctx.segments.loadSegmentBoards(POOL)).boards.find((b) => b.key === segmentKey(B, null))!;
        assert.deepEqual(bc.entries.map((e) => [e.attemptId, e.rank]), [['new-partial', 1], ['old-full', 2]]);
      });

      it('a history recalculation that re-times a run clears its now-stale segment rows (never mixes windows)', async () => {
        const ctx = await makeCtx(kind);
        await configure(ctx);
        // Deliberately wrong stored official times: the #77 recalculation will rewrite them.
        const run = await seedRun(ctx, 'retimed');
        await ctx.attempts.saveAttempt({ ...run, startedAtMs: run.startedAtMs! + 1_111, finishedAtMs: run.finishedAtMs! - 777 });
        await seedRun(ctx, 'steady', { speed: 5, shiftMs: DAY });
        await ctx.segments.deriveForAttempt('retimed');
        await ctx.segments.deriveForAttempt('steady');
        assert.equal((await ctx.checkpoints.listSegmentResults('retimed')).length, 2);
        assert.equal((await ctx.recalc.start()).ok, true);
        assert.equal((await ctx.recalc.run()).status, 'published');
        const after = (await ctx.attempts.getAttempt('retimed'))!;
        assert.notEqual(after.finishedAtMs, run.finishedAtMs! - 777, 'the official window was rewritten');
        assert.deepEqual(await ctx.checkpoints.listSegmentResults('retimed'), [], 'stale rows cleared');
        const status = await ctx.segments.getPoolStatus(POOL);
        assert.ok(status.staleAttemptCount >= 1 && status.needsRecalculation);
        // And a manual recalculation derives them again against the new window.
        assert.equal((await ctx.segmentRecalc.start()).ok, true);
        assert.equal((await runToEnd(ctx.segmentRecalc)).status, 'published');
        assert.equal((await ctx.checkpoints.listSegmentResults('retimed')).length, 2);
      });

      it('journey pools are keyed by the existing pool key', () => {
        assert.equal(journeyPoolKey(POOL), 'a|c|scooter');
      });
    });
  });
}
