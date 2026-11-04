import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attempt } from '../src/domain/attempt';
import { haversineMeters, type LatLng } from '../src/domain/geo';
import {
  PLACE_RECALCULATION_JOB_REASON,
  RECALCULATION_LIVE_ATTEMPT_REASON,
  RECALCULATION_PLACES_CHANGED_MESSAGE,
  evaluateAttemptRecalculation,
} from '../src/domain/history-recalculation';
import type { LocationSample } from '../src/domain/location-sample';
import type { Place } from '../src/domain/place';
import { parseBackup } from '../src/persistence/backup-format';
import { exportBackup } from '../src/persistence/backup-snapshot';
import { applyMigrations, MIGRATIONS } from '../src/persistence/migrations';
import { CURRENT_SCHEMA_VERSION, LOCATION_SPIKE_SCHEMA } from '../src/persistence/schema';
import type { SqlExecutor, SqlValue } from '../src/persistence/sql-executor';
import { restoreBackupPayload } from '../src/product/backup-restore';
import { HistoryRecalculationService } from '../src/product/history-recalculation';
import { baseAttempt, dumpDatabase } from './helpers/backup-fixtures';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { completeJourneySamples, dwellSamples, linearSamples, makePlace } from './helpers/places';
import { makeRoute } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const HOME_CENTER = { latitude: 32.08, longitude: 34.78 };
const WORK_CENTER = offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 400, 0);
const PARK_CENTER = offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 0, 900);
const T0 = 1_700_000_000_000;

type Ctx = ReturnType<typeof createMemoryWorkspace> & {
  kind: 'memory' | 'sqlite';
  sql: SqlExecutor | null;
};

async function migratedSql(): Promise<SqlExecutor> {
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, 1_000);
  return sql;
}

async function makeCtx(
  kind: 'memory' | 'sqlite',
  options: { chunk?: number; wrapSql?: (sql: SqlExecutor) => SqlExecutor } = {},
): Promise<Ctx> {
  if (kind === 'memory') {
    return { ...createMemoryWorkspace({ recalcChunkSize: options.chunk }), kind, sql: null };
  }
  const raw = await migratedSql();
  const sql = options.wrapSql ? options.wrapSql(raw) : raw;
  return {
    ...(createSqliteWorkspace(sql, { recalcChunkSize: options.chunk }) as unknown as ReturnType<
      typeof createMemoryWorkspace
    >),
    kind,
    sql: raw,
  };
}

const KINDS = ['memory', 'sqlite'] as const;

const HOME: Place = makePlace({ id: 'home', name: 'Home', center: HOME_CENTER, createdAtMs: 1 });
const WORK: Place = makePlace({ id: 'work', name: 'Work', center: WORK_CENTER, createdAtMs: 2 });
const PARK: Place = makePlace({ id: 'park', name: 'Park', center: PARK_CENTER, createdAtMs: 3 });

async function seedPlaces(
  ctx: Ctx,
  radii: { homeDep: number; homeArr: number; workDep: number; workArr: number } = {
    homeDep: 100,
    homeArr: 30,
    workDep: 45,
    workArr: 70,
  },
): Promise<{ home: Place; work: Place; park: Place }> {
  const home = { ...HOME, departureRadiusMeters: radii.homeDep, arrivalRadiusMeters: radii.homeArr };
  const work = { ...WORK, departureRadiusMeters: radii.workDep, arrivalRadiusMeters: radii.workArr };
  for (const place of [home, work, PARK]) {
    await ctx.places.createPlace(place);
  }
  return { home, work, park: PARK };
}

async function seedSession(ctx: Ctx, sessionId: string, samples: LocationSample[]): Promise<void> {
  const start = samples[0]?.recordedAtMs ?? T0;
  await ctx.sessions.createSession(sessionId, start, 'attempt');
  if (samples.length > 0) {
    await ctx.sessions.appendSamples(samples);
  }
  await ctx.sessions.completeSession(sessionId, {
    stoppedAtMs: (samples[samples.length - 1]?.recordedAtMs ?? start) + 1,
    captureOutcome: 'finished',
    reviewDisposition: 'saved',
  });
}

/** A stored completed attempt with deliberately wrong (pre-recalculation) times. */
async function seedAttempt(
  ctx: Ctx,
  input: {
    id: string;
    samples: LocationSample[];
    origin: string | null;
    destination: string | null;
    started?: number | null;
    finished?: number | null;
    lifecycle?: Attempt['lifecycle'];
    routeId?: string | null;
  },
): Promise<Attempt> {
  const sessionId = `session-${input.id}`;
  await seedSession(ctx, sessionId, input.samples.map((s) => ({ ...s, sessionId, id: `${sessionId}-${s.id}` })));
  const first = input.samples[0]?.recordedAtMs ?? T0;
  const attempt = baseAttempt({
    id: input.id,
    sessionId,
    originPlaceId: input.origin,
    destinationPlaceId: input.destination,
    armedAtMs: first,
    lifecycle: input.lifecycle ?? 'completed',
    startedAtMs: input.started === undefined ? first + 1_111 : input.started,
    finishedAtMs: input.finished === undefined ? first + 99_999 : input.finished,
    routeId: input.routeId ?? null,
  });
  await ctx.attempts.saveAttempt(attempt);
  return attempt;
}

function trace(origin: Place, destination: Place, options: { startMs?: number; speedMps?: number } = {}): LocationSample[] {
  return completeJourneySamples({
    origin,
    destination,
    sessionId: 'x',
    startMs: options.startMs ?? T0,
    speedMps: options.speedMps ?? 4,
  });
}

/** Independent interpolation of the first crossing of a radius, straight from the samples. */
function expectedCrossing(
  samples: LocationSample[],
  center: LatLng,
  radius: number,
  direction: 'out' | 'in',
): number {
  for (let index = 1; index < samples.length; index += 1) {
    const before = haversineMeters(samples[index - 1]!, center);
    const after = haversineMeters(samples[index]!, center);
    const crosses = direction === 'out' ? before <= radius && after > radius : before > radius && after <= radius;
    if (crosses) {
      const t = (radius - before) / (after - before);
      const t0 = samples[index - 1]!.recordedAtMs;
      return t0 + t * (samples[index]!.recordedAtMs - t0);
    }
  }
  throw new Error('no crossing');
}

async function openLiveAttempt(ctx: Ctx, id = 'live'): Promise<void> {
  await ctx.sessions.createSession(`${id}-session`, T0 + 9_000_000_000, 'attempt');
  await ctx.attempts.createAttempt(
    baseAttempt({
      id,
      sessionId: `${id}-session`,
      lifecycle: 'armed',
      validity: 'pending',
      armedAtMs: T0 + 9_000_000_000,
    }),
  );
}

async function closeLiveAttempt(ctx: Ctx): Promise<void> {
  const live = (await ctx.attempts.getAttempt('live'))!;
  await ctx.attempts.finalizeAttempt(
    { ...live, lifecycle: 'cancelled', validity: 'unranked', resultAcknowledged: true },
    { stoppedAtMs: T0 + 9_000_000_100, captureOutcome: 'cancelled', reviewDisposition: 'discarded' },
  );
}

async function seedMany(ctx: Ctx, count: number, home: Place, work: Place): Promise<void> {
  const base = trace(home, work);
  for (let index = 0; index < count; index += 1) {
    const shifted = base.map((s) => ({ ...s, recordedAtMs: s.recordedAtMs + index * 10_000_000 }));
    await seedAttempt(ctx, { id: `a${index}`, samples: shifted, origin: 'home', destination: 'work' });
  }
}

async function runToEnd(ctx: Ctx) {
  const result = await ctx.recalc.run();
  assert.equal(result.status, 'published', JSON.stringify(result));
  return result;
}

for (const kind of KINDS) {
  describe(`history recalculation [${kind}]`, () => {
    it('re-times both directions with unequal radii using exactly interpolated crossings', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx);
      const out = trace(home, work, { startMs: T0 });
      const back = trace(work, home, { startMs: T0 + 3_600_000 });
      await seedAttempt(ctx, { id: 'out', samples: out, origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 'back', samples: back, origin: 'work', destination: 'home' });

      assert.equal((await ctx.recalc.start()).ok, true);
      await runToEnd(ctx);

      const outAttempt = (await ctx.attempts.getAttempt('out'))!;
      const backAttempt = (await ctx.attempts.getAttempt('back'))!;
      // Home -> Work: Home DEPARTURE (100 m) and Work ARRIVAL (70 m).
      assert.equal(outAttempt.startedAtMs, expectedCrossing(out, HOME_CENTER, 100, 'out'));
      assert.equal(outAttempt.finishedAtMs, expectedCrossing(out, WORK_CENTER, 70, 'in'));
      // Work -> Home: Work DEPARTURE (45 m) and Home ARRIVAL (30 m).
      assert.equal(backAttempt.startedAtMs, expectedCrossing(back, WORK_CENTER, 45, 'out'));
      assert.equal(backAttempt.finishedAtMs, expectedCrossing(back, HOME_CENTER, 30, 'in'));
      // Identity and raw data untouched.
      assert.equal(outAttempt.originPlaceId, 'home');
      assert.equal(outAttempt.destinationPlaceId, 'work');
      assert.equal(outAttempt.sessionId, 'session-out');
      assert.equal(outAttempt.transportationMode, 'scooter');
      assert.equal((await ctx.sessions.countSamples('session-out')), out.length);
      const progress = (await ctx.recalc.getProgress())!;
      assert.equal(progress.job.status, 'published');
      assert.equal(progress.counts.updated, 2);
    });

    it('changes nothing before the explicit action, including preview and radius saves', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx, { homeDep: 30, homeArr: 30, workDep: 30, workArr: 30 });
      const samples = trace(home, work);
      const original = await seedAttempt(ctx, { id: 'a', samples, origin: 'home', destination: 'work' });
      const saved = await ctx.workspace.savePlace({ ...home, departureRadiusMeters: 100 });
      assert.equal(saved.ok, true);
      const preview = await ctx.recalc.preview();
      assert.equal(preview.candidateCount, 1);
      assert.equal(await ctx.recalc.getProgress(), null);
      assert.equal(await ctx.recalc.hasBlockingJob(), false);
      assert.deepEqual(await ctx.attempts.getAttempt('a'), original);
    });

    it('reports scope: candidates, missing-Place and no-trace runs, ignoring non-completed attempts', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx);
      const samples = trace(home, work);
      await seedAttempt(ctx, { id: 'ok', samples, origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 'no-place', samples, origin: null, destination: 'work' });
      await seedAttempt(ctx, { id: 'no-trace', samples: [], origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 'ended', samples, origin: 'home', destination: null, lifecycle: 'ended', finished: null });
      const preview = await ctx.recalc.preview();
      assert.deepEqual(
        [preview.candidateCount, preview.preSkippedMissingPlace, preview.preSkippedNoTrace],
        [1, 1, 1],
      );
      await ctx.recalc.start();
      await runToEnd(ctx);
      const progress = (await ctx.recalc.getProgress())!;
      assert.equal(progress.preSkipped, 2);
      assert.equal(progress.totalCompletedRuns, 3);
      assert.equal((await ctx.attempts.getAttempt('no-place'))!.originPlaceId, null);
      const ended = (await ctx.attempts.getAttempt('ended'))!;
      assert.equal(ended.lifecycle, 'ended');
    });

    it('skips (keeping the original record) for insufficient GPS, crossing outside the trace, changed endpoint and return_to_origin', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx);
      const full = trace(home, work);
      // Insufficient GPS: the trace stops right after the arrival crossing, before confirmation.
      const arrivalCross = expectedCrossing(full, WORK_CENTER, 70, 'in');
      const truncated = full.filter((s) => s.recordedAtMs <= arrivalCross + 500);
      // Crossing outside the trace: the recording starts after the departure crossing.
      const late = full.filter((s) => haversineMeters(s, HOME_CENTER) > 110 && haversineMeters(s, WORK_CENTER) > 120);
      // Crossing after the last fix: the recording stops 100 m short of the arrival zone.
      const endsEarly = full.filter((s) => haversineMeters(s, WORK_CENTER) > 100);
      // Starts after departure but ends inside Work: the engine would pick Work as the origin.
      const lateFull = full.filter((s) => haversineMeters(s, HOME_CENTER) > 110);
      // Return to origin: out 200 m and back to Home, dwell long enough.
      const out = linearSamples(HOME_CENTER, offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 250, 0), {
        sessionId: 'x',
        startMs: T0 + 3_000,
        speedMps: 4,
      });
      const back = linearSamples(out[out.length - 1]!, HOME_CENTER, {
        sessionId: 'x',
        startMs: out[out.length - 1]!.recordedAtMs + 1_000,
        speedMps: 4,
        startIndex: out.length,
      });
      const lastBack = back[back.length - 1]!.recordedAtMs;
      const rto = [
        ...dwellSamples(HOME_CENTER, { sessionId: 'x', startMs: T0, count: 2 }),
        ...out,
        ...back,
        ...dwellSamples(HOME_CENTER, { sessionId: 'x', startMs: lastBack + 1_000, count: 40, startIndex: 500 }),
      ];
      await seedAttempt(ctx, { id: 'insufficient', samples: truncated, origin: 'home', destination: 'work' });
      assert.ok(late.length > 8 && endsEarly.length > 8 && lateFull.length > 8);
      await seedAttempt(ctx, { id: 'outside', samples: late, origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 'ends-early', samples: endsEarly, origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 'late-full', samples: lateFull, origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 'endpoint', samples: full, origin: 'home', destination: 'park' });
      await seedAttempt(ctx, { id: 'other-origin', samples: full, origin: 'park', destination: 'work' });
      await seedAttempt(ctx, { id: 'rto', samples: rto, origin: 'home', destination: 'work' });
      const before = await ctx.attempts.listAttempts();

      await ctx.recalc.start();
      await runToEnd(ctx);

      const progress = (await ctx.recalc.getProgress())!;
      assert.equal(progress.counts.updated, 0);
      assert.equal(progress.counts.skipped, 7);
      assert.equal(progress.counts.skippedInsufficientGps, 3);
      assert.equal(progress.counts.skippedEndpointChanged, 4);
      assert.deepEqual(await ctx.attempts.listAttempts(), before, 'every original record is unchanged');
    });

    it('reports an identical result as unchanged and is idempotent on re-run', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx);
      await seedAttempt(ctx, { id: 'a', samples: trace(home, work), origin: 'home', destination: 'work' });
      await ctx.recalc.start();
      await runToEnd(ctx);
      const afterFirst = await ctx.attempts.listAttempts();
      assert.equal((await ctx.recalc.getProgress())!.counts.updated, 1);

      const second = await ctx.recalc.start();
      assert.equal(second.ok && second.alreadyExists, false);
      await runToEnd(ctx);
      const progress = (await ctx.recalc.getProgress())!;
      assert.equal(progress.counts.updated, 0);
      assert.equal(progress.counts.unchanged, 1);
      assert.deepEqual(await ctx.attempts.listAttempts(), afterFirst);
    });

    it('processes a large history in bounded chunks with monotonic progress', async () => {
      const ctx = await makeCtx(kind, { chunk: 7 });
      const places = await seedPlaces(ctx, { homeDep: 60, homeArr: 30, workDep: 30, workArr: 50 });
      const base = trace(places.home, places.work);
      for (let index = 0; index < 40; index += 1) {
        const shifted = base.map((s) => ({ ...s, recordedAtMs: s.recordedAtMs + index * 10_000_000 }));
        await seedAttempt(ctx, { id: `a${String(index).padStart(2, '0')}`, samples: shifted, origin: 'home', destination: 'work' });
      }
      await ctx.recalc.start();
      const seen: number[] = [];
      const result = await ctx.recalc.run({ onProgress: (p) => seen.push(p.counts.processed) });
      assert.equal(result.status, 'published');
      assert.equal(seen.length >= 40 / 7, true);
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
      assert.equal(seen[0], 7);
      const progress = (await ctx.recalc.getProgress())!;
      assert.equal(progress.counts.candidates, 40);
      assert.equal(progress.counts.updated, 40);
      assert.equal(progress.job.checkpointProcessed, 40);
    });

    it('resumes after interruption without redoing completed work', async () => {
      const ctx = await makeCtx(kind, { chunk: 3 });
      const { home, work } = await seedPlaces(ctx);
      const base = trace(home, work);
      for (let index = 0; index < 10; index += 1) {
        const shifted = base.map((s) => ({ ...s, recordedAtMs: s.recordedAtMs + index * 10_000_000 }));
        await seedAttempt(ctx, { id: `a${index}`, samples: shifted, origin: 'home', destination: 'work' });
      }
      const reads: string[] = [];
      const countingSessions = Object.create(ctx.sessions) as typeof ctx.sessions;
      countingSessions.listSamples = async (sessionId: string) => {
        reads.push(sessionId);
        return ctx.sessions.listSamples(sessionId);
      };
      const make = () =>
        new HistoryRecalculationService({
          jobs: ctx.jobs,
          attempts: ctx.attempts,
          sessions: countingSessions,
          places: ctx.places,
          reassignPathVariant: (attempt, samples) => ctx.attemptRuntime.reassignPathVariant(attempt, samples),
          yieldToIdle: async () => {},
          chunkSize: 3,
          createJobId: () => 'resume-job',
          now: () => T0,
        });
      const first = make();
      await first.start();
      let chunks = 0;
      const interrupted = await first.run({
        onProgress: () => {
          chunks += 1;
        },
        shouldStop: () => chunks >= 2,
      });
      assert.equal(interrupted.status, 'stopped');
      assert.equal(reads.length, 6);
      const mid = (await first.getProgress())!;
      assert.equal(mid.counts.processed, 6);
      assert.equal((await ctx.attempts.getAttempt('a0'))!.startedAtMs! % 1_000_000 === 0, false);

      // "Relaunch": a brand-new service over the same persisted state.
      const second = make();
      const resumed = await second.run();
      assert.equal(resumed.status, 'published');
      assert.equal(reads.length, 10, 'each trace is read exactly once across the interruption');
      assert.equal(new Set(reads).size, 10);
      assert.equal((await second.getProgress())!.counts.updated, 10);
    });

    it('discards staged results and cancels the job when a Place fingerprint no longer matches', async () => {
      const ctx = await makeCtx(kind, { chunk: 1 });
      const { home, work } = await seedPlaces(ctx);
      const base = trace(home, work);
      for (let index = 0; index < 3; index += 1) {
        const shifted = base.map((s) => ({ ...s, recordedAtMs: s.recordedAtMs + index * 10_000_000 }));
        await seedAttempt(ctx, { id: `a${index}`, samples: shifted, origin: 'home', destination: 'work' });
      }
      const before = await ctx.attempts.listAttempts();
      await ctx.recalc.start();
      let once = false;
      const result = await ctx.recalc.run({
        onProgress: async () => {
          if (!once) {
            once = true;
            // Bypass the workspace guard to simulate a store-level change (e.g. another path).
            await ctx.places.savePlace({ ...work, arrivalRadiusMeters: 90 });
          }
        },
      });
      assert.equal(result.status, 'cancelled');
      const progress = (await ctx.recalc.getProgress())!;
      assert.equal(progress.job.status, 'cancelled');
      assert.equal(progress.job.message, RECALCULATION_PLACES_CHANGED_MESSAGE);
      assert.deepEqual(await ctx.attempts.listAttempts(), before);
      assert.equal(await ctx.recalc.hasBlockingJob(), false);
    });

    it('re-checks the fingerprint and live attempts atomically inside publication', async () => {
      const ctx = await makeCtx(kind, { chunk: 50 });
      const { home, work } = await seedPlaces(ctx);
      await seedAttempt(ctx, { id: 'a', samples: trace(home, work), origin: 'home', destination: 'work' });
      const before = await ctx.attempts.getAttempt('a');
      await ctx.recalc.start();
      // Process everything (one chunk) but stop before the ready/publish step.
      let chunks = 0;
      const stopped = await ctx.recalc.run({ onProgress: () => void (chunks += 1), shouldStop: () => chunks >= 1 });
      assert.equal(stopped.status, 'stopped');
      const job = (await ctx.jobs.getJob())!;
      assert.equal(job.status, 'running');
      assert.equal(await ctx.jobs.markReady(job.id, T0), true);

      await openLiveAttempt(ctx);
      assert.deepEqual(await ctx.jobs.publishJob(job.id, T0), { ok: false, reason: 'open_attempt' });
      await closeLiveAttempt(ctx);

      await ctx.places.savePlace({ ...home, departureRadiusMeters: 99 });
      assert.deepEqual(await ctx.jobs.publishJob(job.id, T0), { ok: false, reason: 'places_changed' });
      assert.deepEqual(await ctx.attempts.getAttempt('a'), before);
    });

    it('pauses while a run is open, resumes once none is, and refuses to start with one open', async () => {
      const ctx = await makeCtx(kind, { chunk: 1 });
      const { home, work } = await seedPlaces(ctx);
      await seedMany(ctx, 4, home, work);
      const before = await ctx.attempts.listAttempts();
      assert.equal((await ctx.recalc.start()).ok, true);

      const paused = await ctx.recalc.run({
        onProgress: async (progress) => {
          if (progress.counts.processed === 1) {
            await openLiveAttempt(ctx);
          }
        },
      });
      assert.equal(paused.status, 'paused');
      const midway = (await ctx.recalc.getProgress())!;
      assert.equal(midway.displayStatus, 'paused');
      assert.equal(midway.counts.processed, 1, 'no processing while a run is open');
      assert.deepEqual(await ctx.attempts.listAttempts(), [...before, (await ctx.attempts.getAttempt('live'))!].sort((a, b) => b.armedAtMs - a.armedAtMs));

      // Still paused on another attempt to run; nothing is published.
      assert.equal((await ctx.recalc.run()).status, 'paused');
      await closeLiveAttempt(ctx);
      assert.equal((await ctx.recalc.run()).status, 'published');
      assert.equal((await ctx.recalc.getProgress())!.counts.updated, 4);

      await openLiveAttempt(ctx, 'live-again');
      const blocked = await ctx.recalc.start();
      assert.deepEqual(blocked, { ok: false, reason: RECALCULATION_LIVE_ATTEMPT_REASON });
    });

    it('shows the existing job for a duplicate trigger and never creates a second one', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx);
      await seedMany(ctx, 2, home, work);
      const first = await ctx.recalc.start();
      const second = await ctx.recalc.start();
      assert.ok(first.ok && second.ok);
      if (first.ok && second.ok) {
        assert.equal(first.alreadyExists, false);
        assert.equal(second.alreadyExists, true);
        assert.equal(second.progress.job.id, first.progress.job.id);
      }
      const direct = await ctx.jobs.createJob({ ...(await ctx.jobs.getJob())!, id: 'another' }, ['a0']);
      assert.equal(direct.created, false);
      assert.equal(direct.job.id, 'job-1'.replace('job-1', (await ctx.jobs.getJob())!.id));
    });

    it('cancels before publication, discards staged results and unblocks Place edits', async () => {
      const ctx = await makeCtx(kind, { chunk: 1 });
      const { home, work } = await seedPlaces(ctx);
      await seedMany(ctx, 3, home, work);
      const before = await ctx.attempts.listAttempts();
      await ctx.recalc.start();
      let chunks = 0;
      await ctx.recalc.run({ onProgress: () => void (chunks += 1), shouldStop: () => chunks >= 2 });
      assert.equal((await ctx.recalc.getProgress())!.counts.processed, 2);
      const cancelled = await ctx.recalc.cancel();
      assert.equal(cancelled.ok, true);
      const progress = (await ctx.recalc.getProgress())!;
      assert.equal(progress.job.status, 'cancelled');
      assert.match(progress.job.message ?? '', /cancelled/);
      assert.deepEqual(await ctx.attempts.listAttempts(), before);
      assert.equal((await ctx.recalc.run()).status, 'cancelled');
      assert.deepEqual(await ctx.attempts.listAttempts(), before);
      const edit = await ctx.workspace.savePlace({ ...home, departureRadiusMeters: 120 });
      assert.equal(edit.ok, true);
    });

    it('blocks centre/radius saves while a job exists, in the workspace layer, but allows other saves', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx);
      await seedMany(ctx, 1, home, work);
      await ctx.recalc.start();
      const radius = await ctx.workspace.savePlace({ ...home, arrivalRadiusMeters: 31 });
      assert.deepEqual(radius, { ok: false, reason: PLACE_RECALCULATION_JOB_REASON });
      const centre = await ctx.workspace.savePlace({
        ...home,
        center: offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 5, 0),
      });
      assert.deepEqual(centre, { ok: false, reason: PLACE_RECALCULATION_JOB_REASON });
      assert.deepEqual(await ctx.workspace.getPlace(home.id), home);
      const rename = await ctx.workspace.savePlace({ ...home, name: 'Home sweet home' });
      assert.equal(rename.ok, true);
      const created = await ctx.workspace.createPlace({
        name: 'Gym',
        center: PARK_CENTER,
        departureRadiusMeters: 30,
        arrivalRadiusMeters: 30,
      });
      assert.deepEqual(created, { ok: false, reason: PLACE_RECALCULATION_JOB_REASON });
      assert.deepEqual(await ctx.workspace.deletePlacePermanently(work.id), {
        ok: false,
        reason: PLACE_RECALCULATION_JOB_REASON,
      });
      await ctx.recalc.cancel();
      assert.equal((await ctx.workspace.savePlace({ ...home, arrivalRadiusMeters: 31 })).ok, true);
    });

    it('records a per-attempt error, keeps that original, and retries only the failed run', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx);
      await seedMany(ctx, 3, home, work);
      const original = (await ctx.attempts.getAttempt('a1'))!;
      let failing = true;
      const flaky = Object.create(ctx.sessions) as typeof ctx.sessions;
      flaky.listSamples = async (sessionId: string) => {
        if (failing && sessionId === 'session-a1') {
          throw new Error('disk read failed');
        }
        return ctx.sessions.listSamples(sessionId);
      };
      const service = new HistoryRecalculationService({
        jobs: ctx.jobs,
        attempts: ctx.attempts,
        sessions: flaky,
        places: ctx.places,
        reassignPathVariant: (attempt, samples) => ctx.attemptRuntime.reassignPathVariant(attempt, samples),
        yieldToIdle: async () => {},
        now: () => T0,
      });
      await service.start();
      assert.equal((await service.run()).status, 'published');
      const progress = (await service.getProgress())!;
      assert.equal(progress.counts.errors, 1);
      assert.equal(progress.counts.updated, 2);
      assert.equal(progress.canRetryFailed, true);
      assert.deepEqual(await ctx.attempts.getAttempt('a1'), original);

      failing = false;
      const retry = await service.retryFailed();
      assert.ok(retry.ok);
      assert.equal((await service.run()).status, 'published');
      const done = (await service.getProgress())!;
      assert.equal(done.counts.updated, 1);
      assert.equal(done.counts.candidates, 1);
      assert.notDeepEqual(await ctx.attempts.getAttempt('a1'), original);
    });

    it('recomputes PB and ranking from the full result set and reassigns the split/variant', async () => {
      const ctx = await makeCtx(kind);
      const { home, work } = await seedPlaces(ctx, { homeDep: 30, homeArr: 30, workDep: 30, workArr: 30 });
      const fast = trace(home, work, { startMs: T0, speedMps: 6 });
      const slow = trace(home, work, { startMs: T0 + 100_000_000, speedMps: 3 });
      // Stored (stale) times claim the slow run is the PB.
      await seedAttempt(ctx, { id: 'fast', samples: fast, origin: 'home', destination: 'work', started: T0 + 2_000, finished: T0 + 200_000 });
      await seedAttempt(ctx, { id: 'slow', samples: slow, origin: 'home', destination: 'work', started: T0 + 100_000_000 + 2_000, finished: T0 + 100_000_000 + 60_000 });
      // A route (path variant) through both Places with a mid checkpoint.
      await ctx.sessions.createSession('route-source', T0 - 1_000_000, 'route_creation');
      await ctx.sessions.completeSession('route-source', { stoppedAtMs: T0 - 999_000, captureOutcome: 'finished', reviewDisposition: 'saved' });
      const path = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, i * 40, 0));
      const route = makeRoute({
        id: 'variant-1',
        sourceRecordingId: 'route-source',
        referencePath: path,
        checkpoints: [{ id: 'cp-mid', name: 'Mid', progressMeters: 200 }],
        kind: 'discovered',
      });
      await ctx.routes.createRoute(route);
      const pool = { originPlaceId: 'home', destinationPlaceId: 'work', transportationMode: 'scooter' as const };
      const stale = (await ctx.workspace.loadJourney(pool))!;
      assert.equal(stale.summary.pbAttemptId, 'slow');

      await ctx.recalc.start();
      await runToEnd(ctx);

      const fresh = (await ctx.workspace.loadJourney(pool))!;
      assert.equal(fresh.summary.pbAttemptId, 'fast', 'PB recomputed, cache not stale');
      const fastAttempt = (await ctx.attempts.getAttempt('fast'))!;
      const slowAttempt = (await ctx.attempts.getAttempt('slow'))!;
      assert.equal(fresh.summary.pbTimeMs, fastAttempt.finishedAtMs! - fastAttempt.startedAtMs!);
      assert.equal(fastAttempt.startedAtMs, expectedCrossing(fast, HOME_CENTER, 30, 'out'));
      assert.equal(fastAttempt.finishedAtMs, expectedCrossing(fast, WORK_CENTER, 30, 'in'));
      assert.ok(slowAttempt.finishedAtMs! - slowAttempt.startedAtMs! > fastAttempt.finishedAtMs! - fastAttempt.startedAtMs!);
      for (const attempt of [fastAttempt, slowAttempt]) {
        assert.equal(attempt.routeId, 'variant-1');
        assert.equal(attempt.crossings.length, 1);
        const crossing = attempt.crossings[0]!;
        assert.ok(crossing.crossedAtMs > attempt.startedAtMs! && crossing.crossedAtMs < attempt.finishedAtMs!);
      }
    });
  });
}

describe('history recalculation memory/SQLite parity', () => {
  it('produces identical attempts, counts and per-item outcomes on both stores', async () => {
    const outcomes: unknown[] = [];
    for (const kind of KINDS) {
      const ctx = await makeCtx(kind, { chunk: 2 });
      const { home, work } = await seedPlaces(ctx);
      const full = trace(home, work);
      await seedAttempt(ctx, { id: 'u1', samples: full, origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 'u2', samples: trace(work, home, { startMs: T0 + 5_000_000 }), origin: 'work', destination: 'home' });
      await seedAttempt(ctx, { id: 's1', samples: full.slice(0, 6), origin: 'home', destination: 'work' });
      await seedAttempt(ctx, { id: 's2', samples: full, origin: 'home', destination: 'park' });
      await seedAttempt(ctx, { id: 'np', samples: full, origin: null, destination: 'work' });
      await ctx.recalc.start();
      await runToEnd(ctx);
      const progress = (await ctx.recalc.getProgress())!;
      const items = await ctx.jobs.listItems(progress.job.id);
      outcomes.push({
        attempts: await ctx.attempts.listAttempts(),
        counts: progress.counts,
        preSkipped: progress.preSkipped,
        items: items.map((item) => [item.attemptId, item.state, item.detail]),
      });
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  });
});

describe('history recalculation SQLite atomic publication', () => {
  it('a failing statement inside the publish transaction leaves the exact old state, then publishes on retry', async () => {
    let failOn: number | null = null;
    let insertCount = 0;
    const ctx = await makeCtx('sqlite', {
      chunk: 50,
      wrapSql: (sql) => ({
        ...sql,
        exec: (text: string) => sql.exec(text),
        getFirst: (text, params) => sql.getFirst(text, params),
        getAll: (text, params) => sql.getAll(text, params),
        withTransaction: (fn) => sql.withTransaction(fn),
        async run(text: string, params?: SqlValue[]) {
          if (failOn != null && text.includes('INSERT INTO attempt (')) {
            insertCount += 1;
            if (insertCount === failOn) {
              throw new Error('simulated crash mid-publish');
            }
          }
          return sql.run(text, params);
        },
      }),
    });
    const { home, work } = await seedPlaces(ctx);
    await seedMany(ctx, 3, home, work);
    const snapshot = async () => {
      const dump = await dumpDatabase(ctx.sql!);
      return { attempt: dump.attempt, crossings: dump.attempt_checkpoint_crossing };
    };
    const before = await snapshot();
    await ctx.recalc.start();

    failOn = 2; // the 2nd attempt write inside the publication transaction throws
    const crashed = await ctx.recalc.run();
    assert.equal(crashed.status, 'publish_failed');
    assert.deepEqual(await snapshot(), before, 'old state: not even the first attempt was rewritten');
    assert.equal((await ctx.jobs.getJob())!.status, 'ready', 'job stays publishable');
    assert.equal(await ctx.recalc.hasBlockingJob(), true);

    failOn = null;
    const retried = await ctx.recalc.run();
    assert.equal(retried.status, 'published');
    assert.equal((await ctx.recalc.getProgress())!.counts.updated, 3);
    assert.notDeepEqual(await snapshot(), before);
  });
});

describe('history recalculation restore, migration and engine rules', () => {
  it('restore discards an in-progress job and cannot resurrect staged results', async () => {
    const ctx = await makeCtx('sqlite', { chunk: 1 });
    const { home, work } = await seedPlaces(ctx);
    await seedMany(ctx, 3, home, work);
    const backup = parseBackup((await exportBackup(ctx.sql!, { nowMs: T0, appVersion: '0.1.0' })).text);
    await ctx.recalc.start();
    let chunks = 0;
    await ctx.recalc.run({ onProgress: () => void (chunks += 1), shouldStop: () => chunks >= 1 });
    assert.equal(await ctx.recalc.hasBlockingJob(), true);

    await restoreBackupPayload(ctx.sql!, backup.payload);

    assert.equal(await ctx.jobs.getJob(), null);
    assert.equal((await ctx.sql!.getFirst<{ c: number }>('SELECT COUNT(*) AS c FROM recalc_job_item'))!.c, 0);
    assert.equal(await ctx.recalc.hasBlockingJob(), false);
    assert.equal((await ctx.recalc.run()).status, 'none');
    const exported = JSON.stringify(JSON.parse((await exportBackup(ctx.sql!, { nowMs: T0, appVersion: '0.1.0' })).text).payload);
    assert.equal(exported.includes('recalc'), false, 'operational tables are never in the portable backup');
  });

  it('migration 13 adds the job tables without touching existing data and enforces a single open job', async () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 13);
    assert.equal(MIGRATIONS[MIGRATIONS.length - 1]!.version, 13);
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 12)) {
      await migration.up(sql, 1_000);
    }
    await sql.exec('PRAGMA user_version = 12');
    await sql.run(
      `INSERT INTO place (id, name, latitude, longitude, radius_meters, departure_radius_meters, arrival_radius_meters, status, created_at_ms)
       VALUES ('home', 'Home', 32.08, 34.78, 30, 100, 30, 'active', 1), ('work', 'Work', 32.09, 34.78, 30, 45, 70, 'active', 2)`,
    );
    await sql.run(
      `INSERT INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition)
       VALUES ('sess', 10, 20, 0, 'attempt', 'finished', 'saved')`,
    );
    await sql.run(
      `INSERT INTO location_sample (id, session_id, recorded_at_ms, latitude, longitude, horizontal_accuracy_meters, speed_meters_per_second, heading_degrees)
       VALUES ('p1', 'sess', 12, 32.08, 34.78, 5, 1, 0)`,
    );
    await sql.run(
      `INSERT INTO attempt (id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
                            lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged,
                            reconciliation_status, reconciliation_version)
       VALUES ('a1', NULL, 'home', 'work', 'scooter', 'sess', 'completed', 'valid', 9, 11.5, 19.25, 1, 'reconciled', 1)`,
    );
    const before = await dumpDatabase(sql);

    await applyMigrations(sql, 5_000);

    assert.equal((await sql.getFirst<{ user_version: number }>('PRAGMA user_version'))!.user_version, 13);
    const after = await dumpDatabase(sql);
    for (const table of Object.keys(before)) {
      assert.deepEqual(after[table], before[table], `${table} untouched`);
    }
    assert.deepEqual(after.recalc_job, []);
    assert.deepEqual(after.recalc_job_item, []);
    const insertJob = (id: string, status: string) =>
      sql.run(
        `INSERT INTO recalc_job (id, status, places_fingerprint, created_at_ms, updated_at_ms, candidate_count)
         VALUES (?, ?, 'f', 1, 1, 1)`,
        [id, status],
      );
    await insertJob('j1', 'running');
    await assert.rejects(() => insertJob('j2', 'ready'), /UNIQUE/);
    await insertJob('j0', 'published');
    await sql.run(`INSERT INTO recalc_job_item (job_id, attempt_id, seq) VALUES ('j1', 'a1', 0)`);
    await sql.run(`DELETE FROM recalc_job WHERE id = 'j1'`);
    assert.equal((await sql.getFirst<{ c: number }>('SELECT COUNT(*) AS c FROM recalc_job_item'))!.c, 0);
    assert.equal((await sql.getAll('SELECT id FROM attempt')).length, 1);
  });

  it('never extrapolates, never fabricates, and treats archived endpoints with their saved radii', () => {
    const home = { ...HOME, departureRadiusMeters: 60, arrivalRadiusMeters: 30 };
    const work: Place = { ...WORK, status: 'archived', arrivalRadiusMeters: 50 };
    const samples = trace(home, work);
    const attempt = baseAttempt({
      id: 'x',
      sessionId: 's',
      originPlaceId: 'home',
      destinationPlaceId: 'work',
      armedAtMs: T0,
      startedAtMs: T0 + 1,
      finishedAtMs: T0 + 2,
    });
    const archived = evaluateAttemptRecalculation({ attempt, samples, places: [home, work] });
    assert.equal(archived.kind, 'updated');
    if (archived.kind === 'updated') {
      assert.equal(archived.finishedAtMs, expectedCrossing(samples, WORK_CENTER, 50, 'in'));
    }
    const same = evaluateAttemptRecalculation({
      attempt: { ...attempt, startedAtMs: archived.kind === 'updated' ? archived.startedAtMs : 0, finishedAtMs: archived.kind === 'updated' ? archived.finishedAtMs : 0 },
      samples,
      places: [home, work],
    });
    assert.equal(same.kind, 'unchanged');
    assert.deepEqual(evaluateAttemptRecalculation({ attempt, samples: [], places: [home, work] }), {
      kind: 'skipped',
      reason: 'insufficient_gps',
    });
  });
});
