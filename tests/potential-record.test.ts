import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { Attempt } from '../src/domain/attempt';
import { formatElapsed } from '../src/domain/duration';
import {
  actualFullRoutePbMs,
  computePotentialRecord,
  medianOf,
  POTENTIAL_BEST_MIN_SAMPLES,
  POTENTIAL_TYPICAL_MIN_SAMPLES,
  selectPrefixReferences,
} from '../src/domain/potential-record';
import { segmentKey, SEGMENT_DERIVATION_VERSION, type AttemptSegmentResult } from '../src/domain/segment-derivation';
import { applyMigrations } from '../src/persistence/migrations';
import { describePotentialRecord } from '../src/product/competitive-segments-view';
import { baseAttempt } from './helpers/backup-fixtures';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { checkpoint, DESTINATION, fullAttempt, ORIGIN, partialAttempt, POOL, ride, T0, track } from './helpers/segments';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const S = 1000;
const B = 'b';
const B2 = 'b2';

describe('potential full-route record: pure estimate (#81)', () => {
  it('reproduces the spec example exactly: 25 s best, 40 s median, 5:20 suffix, 6:15 PB -> 5:45 / 6:00', () => {
    const result = computePotentialRecord({
      prefixDurationsMs: [25 * S, 40 * S, 55 * S],
      suffixMs: (5 * 60 + 20) * S,
      fullPbMs: (6 * 60 + 15) * S,
    });
    assert.equal(result.hypothetical, true);
    assert.equal(result.best.status, 'ready');
    assert.equal(result.typical.status, 'ready');
    if (result.best.status === 'ready' && result.typical.status === 'ready') {
      assert.equal(result.best.estimate.totalMs, (5 * 60 + 45) * S);
      assert.equal(formatElapsed(result.best.estimate.totalMs), '5:45');
      assert.deepEqual(result.best.estimate.comparison, { kind: 'potential_record', fasterByMs: 30 * S });
      assert.equal(result.typical.estimate.totalMs, 6 * 60 * S);
      assert.equal(formatElapsed(result.typical.estimate.totalMs), '6:00');
      assert.deepEqual(result.typical.estimate.comparison, { kind: 'potential_record', fasterByMs: 15 * S });
      assert.equal(result.best.estimate.sampleCount, 3);
    }
    // No actual record is awarded: the actual PB is untouched in the result and only compared against.
    assert.equal(result.fullPbMs, (6 * 60 + 15) * S);
  });

  it('shows N and the sample thresholds: best from N>=1, typical from N>=3', () => {
    assert.equal(POTENTIAL_BEST_MIN_SAMPLES, 1);
    assert.equal(POTENTIAL_TYPICAL_MIN_SAMPLES, 3);
    const with_ = (prefixes: number[]) => computePotentialRecord({ prefixDurationsMs: prefixes, suffixMs: 100, fullPbMs: 1000 });
    const none = with_([]);
    assert.deepEqual([none.best, none.typical, none.sampleCount], [
      { status: 'insufficient', sampleCount: 0, required: 1 },
      { status: 'insufficient', sampleCount: 0, required: 3 },
      0,
    ]);
    const one = with_([300]);
    assert.equal(one.best.status, 'ready');
    assert.deepEqual(one.typical, { status: 'insufficient', sampleCount: 1, required: 3 });
    const two = with_([300, 500]);
    assert.equal(two.best.status, 'ready');
    assert.deepEqual(two.typical, { status: 'insufficient', sampleCount: 2, required: 3 });
    const three = with_([300, 900, 500]);
    assert.equal(three.typical.status === 'ready' && three.typical.estimate.prefixMs, 500, 'odd N: the middle value');
    assert.equal(three.typical.status === 'ready' && three.typical.estimate.sampleCount, 3);
  });

  it('an even N averages the two middle values', () => {
    const four = computePotentialRecord({ prefixDurationsMs: [50, 20, 40, 30], suffixMs: 10, fullPbMs: null });
    assert.equal(four.typical.status === 'ready' && four.typical.estimate.prefixMs, 35);
    assert.equal(medianOf([1, 2]), 1.5);
    assert.equal(medianOf([3, 1, 2]), 2);
    assert.equal(medianOf([]), null);
  });

  it('compares each estimate separately and only a strictly faster one is a potential record', () => {
    const total = (pb: number | null) => computePotentialRecord({ prefixDurationsMs: [100, 200, 300], suffixMs: 50, fullPbMs: pb });
    // best = 150, typical = 250
    const strictlyFaster = total(151);
    assert.deepEqual(strictlyFaster.best.status === 'ready' && strictlyFaster.best.estimate.comparison, { kind: 'potential_record', fasterByMs: 1 });
    assert.deepEqual(strictlyFaster.typical.status === 'ready' && strictlyFaster.typical.estimate.comparison, { kind: 'slower', slowerByMs: 99 });
    const tie = total(150);
    assert.deepEqual(tie.best.status === 'ready' && tie.best.estimate.comparison, { kind: 'tie' }, 'ties are labeled as ties, not records');
    const slower = total(100);
    assert.deepEqual(slower.best.status === 'ready' && slower.best.estimate.comparison, { kind: 'slower', slowerByMs: 50 });
    const tieTypical = total(250);
    assert.deepEqual(tieTypical.typical.status === 'ready' && tieTypical.typical.estimate.comparison, { kind: 'tie' });
  });

  it('without a full-route PB the comparison is the explicit no-PB state', () => {
    const result = computePotentialRecord({ prefixDurationsMs: [100, 200, 300], suffixMs: 50, fullPbMs: null });
    assert.deepEqual(result.best.status === 'ready' && result.best.estimate.comparison, { kind: 'no_pb' });
    assert.deepEqual(result.typical.status === 'ready' && result.typical.estimate.comparison, { kind: 'no_pb' });
    const text = describePotentialRecord(result, 'Junction', formatElapsed);
    assert.equal(text.pbLine, 'No full-route PB yet to compare with.');
    assert.match(text.rows[0]!.detail, /No full-route PB to compare with yet/);
  });

  it('ignores non-positive or non-finite prefix values', () => {
    const result = computePotentialRecord({ prefixDurationsMs: [0, -5, Number.NaN, 200], suffixMs: 50, fullPbMs: 1000 });
    assert.equal(result.sampleCount, 1);
  });

  it('describes records, ties, slower and insufficient states with explicit hypothetical wording', () => {
    const record = describePotentialRecord(
      computePotentialRecord({ prefixDurationsMs: [25 * S, 40 * S, 55 * S], suffixMs: 320 * S, fullPbMs: 375 * S }),
      'Junction',
      formatElapsed,
    );
    assert.deepEqual(record.rows.map((r) => [r.title, r.totalMs, r.tone]), [
      ['Best case (optimistic)', 345 * S, 'record'],
      ['Typical (median)', 360 * S, 'record'],
    ]);
    assert.match(record.rows[0]!.detail, /0:30 faster than your PB: a potential record, not awarded/);
    assert.match(record.rows[1]!.detail, /0:15 faster/);
    assert.match(record.sampleLine, /3 full runs with a timed start → Junction/);
    const insufficient = describePotentialRecord(computePotentialRecord({ prefixDurationsMs: [], suffixMs: 1, fullPbMs: 5 }), 'Junction', formatElapsed);
    assert.match(insufficient.rows[0]!.detail, /No estimate: needs at least 1 full run/);
    assert.match(insufficient.rows[1]!.detail, /needs at least 3 full runs.*\(have 0\)/);
    assert.equal(insufficient.rows[0]!.totalMs, null);
    assert.match(insufficient.sampleLine, /No full runs with a timed start/);
  });
});

function row(attemptId: string, from: string | null, to: string | null, durationMs: number | null, extra: Partial<AttemptSegmentResult> = {}): AttemptSegmentResult {
  return {
    id: `${attemptId}:${segmentKey(from, to)}:${extra.configVersion ?? 1}`,
    attemptId,
    configVersion: 1,
    derivationVersion: SEGMENT_DERIVATION_VERSION,
    fromCheckpointId: from,
    toCheckpointId: to,
    status: durationMs == null ? 'unavailable' : 'valid',
    unavailableReason: durationMs == null ? 'not_reached' : null,
    startedAtMs: durationMs == null ? null : 0,
    endedAtMs: durationMs,
    durationMs,
    derivedAtMs: 1,
    ...extra,
  };
}

describe('prefix reference selection (#81)', () => {
  const full = (id: string, extra: Partial<Attempt> = {}) => fullAttempt({ id, sessionId: `s-${id}`, ...extra });
  const partial = partialAttempt(B, T0, T0 + 30_000, { id: 'the-partial' });

  it('uses only eligible full runs with a valid cumulative start->checkpoint row of the same config version', () => {
    const attempts = [
      full('ok-1'),
      full('ok-2'),
      full('dnf', { lifecycle: 'ended', validity: 'unranked', finishedAtMs: null }),
      full('unranked', { validity: 'unranked' }),
      full('other-version'),
      full('unavailable'),
      full('wrong-checkpoint'),
      full('stale-algorithm'),
      partialAttempt(B, T0, T0 + 1000, { id: 'another-partial' }),
      partial,
    ];
    const results = [
      row('ok-1', null, B, 20_000),
      row('ok-2', null, B, 30_000),
      row('dnf', null, B, 5_000),
      row('unranked', null, B, 5_000),
      row('other-version', null, B, 5_000, { configVersion: 2 }),
      row('unavailable', null, B, null),
      row('wrong-checkpoint', null, B2, 5_000),
      row('wrong-checkpoint', B, B2, 5_000),
      row('stale-algorithm', null, B, 5_000, { derivationVersion: SEGMENT_DERIVATION_VERSION + 1 }),
      row('another-partial', null, B, 5_000),
      row('the-partial', null, B, 5_000),
      row('ok-1', null, B, 999, { id: 'duplicate-row' }),
    ];
    const refs = selectPrefixReferences({ partial, configVersion: 1, attempts, results });
    assert.deepEqual(refs.attemptIds, ['ok-1', 'ok-2']);
    assert.deepEqual(refs.durationsMs, [20_000, 30_000], 'one sample per run');
  });

  it('a later checkpoint uses the cumulative start->checkpoint row, never a sum of segments', () => {
    const later = partialAttempt(B2, T0, T0 + 12_000, { id: 'later-partial' });
    const attempts = [full('r1')];
    const results = [row('r1', null, B, 16_000), row('r1', B, B2, 26_000), row('r1', null, B2, 41_000)];
    const refs = selectPrefixReferences({ partial: later, configVersion: 1, attempts, results });
    assert.deepEqual(refs.durationsMs, [41_000]);
    assert.notEqual(refs.durationsMs[0], 16_000 + 26_000);
  });

  it('actualFullRoutePbMs is the best official time of eligible full runs only', () => {
    const attempts = [
      full('a', { startedAtMs: T0, finishedAtMs: T0 + 80_000 }),
      full('b', { startedAtMs: T0, finishedAtMs: T0 + 70_000 }),
      full('dnf', { lifecycle: 'ended', validity: 'unranked', startedAtMs: T0, finishedAtMs: T0 + 1_000 }),
      partialAttempt(B, T0, T0 + 5_000, { id: 'fast-partial' }),
    ];
    assert.equal(actualFullRoutePbMs(attempts), 70_000);
    assert.equal(actualFullRoutePbMs([]), null);
  });
});

type Ctx = ReturnType<typeof createMemoryWorkspace>;

async function makeCtx(kind: 'memory' | 'sqlite', list = [checkpoint(B, 150)]): Promise<Ctx> {
  let ctx: Ctx;
  if (kind === 'memory') {
    ctx = createMemoryWorkspace();
  } else {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, T0);
    ctx = createSqliteWorkspace(sql) as unknown as Ctx;
  }
  await ctx.places.createPlace(ORIGIN);
  await ctx.places.createPlace(DESTINATION);
  assert.equal((await ctx.segments!.saveCheckpoints(POOL, list)).ok, true);
  return ctx;
}

async function seedRun(ctx: Ctx, id: string, options: { speed?: number; shift?: number; partialAt?: 'b' | 'b2'; lifecycle?: 'ended' } = {}) {
  const speed = options.speed ?? 6;
  const shift = options.shift ?? 0;
  const sessionId = `session-${id}`;
  const startInside = options.partialAt === 'b2' ? 290 : options.partialAt === 'b' ? 140 : 0;
  const outbound = options.partialAt === 'b2' ? 320 : options.partialAt === 'b' ? 170 : 30;
  const samples = track(ride({ fromNorth: startInside, speed, toSeconds: Math.ceil((480 - startInside) / speed) + 2 }), sessionId).map((s, i) => ({
    ...s,
    id: `${sessionId}-${i}`,
    recordedAtMs: s.recordedAtMs + shift,
  }));
  await ctx.sessions.createSession(sessionId, T0 + shift, 'attempt');
  await ctx.sessions.appendSamples(samples);
  await ctx.sessions.completeSession(sessionId, { stoppedAtMs: T0 + shift + 200_000, captureOutcome: 'finished', reviewDisposition: 'saved' });
  const ended = options.lifecycle === 'ended';
  const attempt = baseAttempt({
    id,
    sessionId,
    originPlaceId: 'a',
    destinationPlaceId: 'c',
    armedAtMs: T0 + shift - 1000,
    lifecycle: ended ? 'ended' : 'completed',
    validity: ended ? 'unranked' : 'valid',
    startedAtMs: T0 + shift + ((outbound - startInside) / speed) * 1000,
    finishedAtMs: ended ? null : T0 + shift + ((420 - startInside) / speed) * 1000,
    startedUtcOffsetMinutes: 0,
    startedTimezoneId: 'UTC',
    startedLocalTimeSource: 'captured',
    ...(options.partialAt ? { kind: 'partial' as const, startCheckpointId: options.partialAt, checkpointConfigVersion: 1 } : {}),
  });
  await ctx.attempts.saveAttempt(attempt);
  return attempt;
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`potential record loader [${kind}] (#81)`, () => {
    it('estimates from actual full-run prefixes of the same journey and config version', async () => {
      const ctx = await makeCtx(kind);
      // Full runs at 6, 5 and 4 m/s: A->B (inbound edge 130 m) takes 100/speed s; official PB 65 s.
      for (const [i, speed] of [6, 5, 4].entries()) {
        await seedRun(ctx, `full-${i}`, { speed, shift: i * 3_600_000 });
        await ctx.segments!.deriveForAttempt(`full-${i}`);
      }
      const partial = await seedRun(ctx, 'partial', { partialAt: 'b', speed: 8, shift: 10_000_000 });
      const view = await ctx.segments!.loadPotentialRecord(partial.id);
      assert.equal(view.state, 'ready');
      if (view.state !== 'ready') return;
      const { result } = view;
      assert.equal(view.checkpointName, 'B');
      assert.equal(result.sampleCount, 3);
      // Suffix = (420 - 170) / 8 = 31.25 s; best prefix 100/6 = 16.67 s; median prefix 100/5 = 20 s; PB = 390/6 = 65 s.
      assert.ok(Math.abs(result.suffixMs - 31_250) < 50);
      assert.ok(Math.abs((result.fullPbMs ?? 0) - 65_000) < 300);
      assert.ok(result.best.status === 'ready' && Math.abs(result.best.estimate.totalMs - (16_667 + 31_250)) < 400);
      assert.ok(result.typical.status === 'ready' && Math.abs(result.typical.estimate.totalMs - (20_000 + 31_250)) < 400);
      assert.equal(result.best.status === 'ready' && result.best.estimate.comparison.kind, 'potential_record');
    });

    it('never persists, ranks or counts the estimate, and the actual records are unchanged', async () => {
      const ctx = await makeCtx(kind);
      for (const [i, speed] of [6, 5, 4].entries()) {
        await seedRun(ctx, `full-${i}`, { speed, shift: i * 3_600_000 });
        await ctx.segments!.deriveForAttempt(`full-${i}`);
      }
      const partial = await seedRun(ctx, 'partial', { partialAt: 'b', speed: 8, shift: 10_000_000 });
      await ctx.segments!.deriveForAttempt(partial.id);
      const snapshot = async () => {
        const journey = (await ctx.workspace.loadJourney(POOL))!;
        return {
          summary: journey.summary,
          statistics: journey.statistics,
          history: journey.history,
          attempts: await ctx.attempts.listAttempts({ kind: 'all' }),
          rows: await ctx.checkpoints.listSegmentResultsForPool(POOL, 1),
          boards: (await ctx.segments!.loadSegmentBoards(POOL)).boards,
        };
      };
      const before = await snapshot();
      const first = await ctx.segments!.loadPotentialRecord(partial.id);
      const second = await ctx.segments!.loadPotentialRecord(partial.id);
      assert.deepEqual(second, first, 'deterministic, recalculated on display');
      assert.deepEqual(await snapshot(), before, 'nothing written, ranked, or counted');
      assert.equal(before.summary.rankedAttemptCount, 3, 'the partial is not a ranked full run');
      assert.equal(before.summary.pbAttemptId, 'full-0', 'no actual record is awarded');
    });

    it('a later checkpoint uses the cumulative start -> checkpoint prefix, not a sum of segments', async () => {
      const ctx = await makeCtx(kind, [checkpoint(B, 150), checkpoint(B2, 300)]);
      for (const [i, speed] of [6, 5, 4].entries()) {
        await seedRun(ctx, `full-${i}`, { speed, shift: i * 3_600_000 });
        await ctx.segments!.deriveForAttempt(`full-${i}`);
      }
      const partial = await seedRun(ctx, 'partial-b2', { partialAt: 'b2', speed: 8, shift: 10_000_000 });
      const view = await ctx.segments!.loadPotentialRecord(partial.id);
      assert.equal(view.state, 'ready');
      if (view.state !== 'ready') return;
      // Cumulative A->b2 (inbound at 280 m): 250/6 = 41.67 s best, 250/5 = 50 s median.
      assert.ok(view.result.best.status === 'ready' && Math.abs(view.result.best.estimate.prefixMs - 41_667) < 300);
      assert.ok(view.result.typical.status === 'ready' && Math.abs(view.result.typical.estimate.prefixMs - 50_000) < 300);
      assert.equal(view.checkpointName, 'B2');
    });

    it('partial runs and DNFs are never reference samples, even if rows exist for them', async () => {
      const ctx = await makeCtx(kind);
      await seedRun(ctx, 'full-0', { speed: 6 });
      await ctx.segments!.deriveForAttempt('full-0');
      const dnf = await seedRun(ctx, 'dnf', { speed: 20, shift: 3_600_000, lifecycle: 'ended' });
      const otherPartial = await seedRun(ctx, 'other-partial', { partialAt: 'b', speed: 20, shift: 7_200_000 });
      await ctx.checkpoints.replaceSegmentResults([
        { attemptId: dnf.id, configVersion: 1, results: [row(dnf.id, null, B, 1_000)] },
        { attemptId: otherPartial.id, configVersion: 1, results: [row(otherPartial.id, null, B, 1_000)] },
      ]);
      const partial = await seedRun(ctx, 'partial', { partialAt: 'b', speed: 8, shift: 10_000_000 });
      const view = await ctx.segments!.loadPotentialRecord(partial.id);
      assert.equal(view.state === 'ready' && view.result.sampleCount, 1);
    });

    it('explicit states: no samples, no PB, insufficient, config changed, not applicable', async () => {
      const ctx = await makeCtx(kind);
      const lonely = await seedRun(ctx, 'lonely', { partialAt: 'b', speed: 8 });
      const none = await ctx.segments!.loadPotentialRecord(lonely.id);
      assert.equal(none.state, 'ready');
      if (none.state === 'ready') {
        assert.deepEqual([none.result.sampleCount, none.result.fullPbMs, none.result.best.status], [0, null, 'insufficient']);
        const text = describePotentialRecord(none.result, none.checkpointName, formatElapsed);
        assert.equal(text.pbLine, 'No full-route PB yet to compare with.');
      }
      // One reference sample: best-case only.
      await seedRun(ctx, 'full-0', { speed: 6, shift: 3_600_000 });
      await ctx.segments!.deriveForAttempt('full-0');
      const one = await ctx.segments!.loadPotentialRecord(lonely.id);
      assert.ok(one.state === 'ready' && one.result.best.status === 'ready' && one.result.typical.status === 'insufficient');

      // Not applicable: full runs and partial non-results.
      assert.equal((await ctx.segments!.loadPotentialRecord('full-0')).state, 'not_applicable');
      const dnf = await seedRun(ctx, 'partial-dnf', { partialAt: 'b', lifecycle: 'ended', shift: 5_000_000 });
      assert.equal((await ctx.segments!.loadPotentialRecord(dnf.id)).state, 'not_applicable');
      assert.equal((await ctx.segments!.loadPotentialRecord('missing')).state, 'not_applicable');

      // Incompatible: the checkpoints changed after the run, so earlier results are not comparable.
      assert.equal((await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150, 25)])).ok, true);
      assert.equal((await ctx.segments!.loadPotentialRecord(lonely.id)).state, 'config_changed');
    });
  });
}

describe('potential record UI wiring (#81)', () => {
  const read = (path: string) => readFileSync(path, 'utf8');
  const panel = read('src/ui/PotentialRecordPanel.tsx');
  const result = read('src/ui/AttemptResultScreen.tsx');
  const service = read('src/product/competitive-segments.ts');

  it('is shown for completed partial runs next to the segments, loaded asynchronously and labeled hypothetical', () => {
    assert.match(result, /segments && attempt\.kind === 'partial' && completed/);
    assert.match(result, /<PotentialRecordPanel key=\{`potential-\$\{attempt\.id\}`\}/);
    assert.match(panel, /useEffect\(/);
    assert.match(panel, /loadPotentialRecord\(attempt\.id\)/);
    assert.match(panel, /HYPOTHETICAL/);
    assert.match(panel, /POTENTIAL_RECORD_DISCLAIMER/);
    assert.match(panel, /describePotentialRecord/);
    assert.match(panel, /if \(!view \|\| view\.state === 'not_applicable'\) \{\s*return null;/);
    // Both opening paths (just finished, and a partial opened from history) render the same screen component.
    assert.match(read('src/ui/AppRoot.tsx'), /segments=\{workspace\.segments\}/);
  });

  it('is display-only: no write, save or rank call exists in the loader or the panel', () => {
    const body = service.slice(service.indexOf('async loadPotentialRecord'), service.indexOf('async resolveStartCheckpointName'));
    assert.doesNotMatch(body, /replaceSegmentResults|saveAttempt|saveConfig|createJob|deriveForAttempt/);
    assert.doesNotMatch(panel, /replaceSegmentResults|saveAttempt|saveCheckpoints/);
    assert.match(read('src/domain/potential-record.ts'), /never persisted/);
  });
});
