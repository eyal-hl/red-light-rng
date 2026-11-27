import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Attempt } from '../src/domain/attempt';
import { formatElapsed } from '../src/domain/duration';
import { buildSegmentBoards, type SegmentBoard } from '../src/domain/segment-leaderboard';
import { segmentKey, type AttemptSegmentResult } from '../src/domain/segment-derivation';
import {
  addCheckpoint,
  buildAttemptSegmentsView,
  CHECKPOINT_IMPACT_WARNING,
  checkpointEditorView,
  checkpointRing,
  deleteCheckpoint,
  editorItemsFromConfig,
  FULL_ROUTE_SELECTION,
  insertIndexByDistance,
  moveCheckpoint,
  nextCheckpointName,
  partialRunRows,
  pbStatusLabel,
  renameCheckpoint,
  resolveSegmentSelection,
  segmentBoardSummary,
  segmentHighlightPath,
  segmentPreview,
  segmentRecalcSummary,
  segmentSelectorOptions,
  setCheckpointCenter,
  setCheckpointRadius,
  sourceLabel,
  unavailableReasonLabel,
} from '../src/product/competitive-segments-view';
import { checkpoint, config, DESTINATION, fullAttempt, ORIGIN, partialAttempt, pt, T0 } from './helpers/segments';

const B = 'b';
const B2 = 'b2';

function ids() {
  let n = 0;
  return () => `new-${++n}`;
}

describe('checkpoint editor operations (#81)', () => {
  it('inserts a new checkpoint in route order by distance from the origin, with a unique default name', () => {
    const base = [checkpoint(B, 150), checkpoint(B2, 300)];
    assert.equal(insertIndexByDistance(base, pt(100), ORIGIN), 0);
    assert.equal(insertIndexByDistance(base, pt(200), ORIGIN), 1);
    assert.equal(insertIndexByDistance(base, pt(400), ORIGIN), 2);
    const next = addCheckpoint(base, pt(200), ORIGIN, ids());
    assert.deepEqual(next.map((item) => item.id), [B, 'new-1', B2]);
    assert.equal(next[1]!.radiusMeters, 30);
    assert.equal(next[1]!.name, 'Checkpoint 3');
    assert.equal(nextCheckpointName([{ ...checkpoint('x', 1), name: 'Checkpoint 2' }]), 'Checkpoint 3');
    assert.equal(base.length, 2, 'inputs are never mutated');
  });

  it('rename, radius, move, reorder and delete are pure and keep stable ids', () => {
    const base = [checkpoint(B, 150), checkpoint(B2, 300)];
    assert.equal(renameCheckpoint(base, B, 'Junction')[0]!.name, 'Junction');
    assert.equal(setCheckpointRadius(base, B2, 45)[1]!.radiusMeters, 45);
    assert.deepEqual(setCheckpointCenter(base, B, pt(10))[0]!.center, pt(10));
    assert.deepEqual(moveCheckpoint(base, B, 'down').map((item) => item.id), [B2, B]);
    assert.deepEqual(moveCheckpoint(base, B, 'up').map((item) => item.id), [B, B2], 'first cannot move up');
    assert.deepEqual(moveCheckpoint(base, B2, 'down').map((item) => item.id), [B, B2], 'last cannot move down');
    assert.deepEqual(deleteCheckpoint(base, B).map((item) => item.id), [B2]);
    assert.equal(base[0]!.name, 'B');
  });

  it('previews the segments a full ride through the draft qualifies for, excluding the official board', () => {
    assert.deepEqual(segmentPreview([], 'Work', 'Home'), []);
    const preview = segmentPreview([{ ...checkpoint(B, 150), name: 'Junction' }], 'Work', 'Home');
    assert.deepEqual(preview.map((row) => [row.label, row.kind]), [
      ['Work → Junction', 'prefix'],
      ['Junction → Home', 'suffix'],
    ]);
    const two = segmentPreview([checkpoint(B, 150), checkpoint(B2, 300)], 'Work', 'Home').map((row) => row.label);
    assert.deepEqual(two.sort(), ['B → B2', 'B → Home', 'B2 → Home', 'Work → B', 'Work → B2'].sort());
    assert.ok(!two.includes('Work → Home'));
  });

  it('draws a closed ring of the radius for the map', () => {
    const ring = checkpointRing(pt(100), 20, 16);
    assert.equal(ring.length, 17);
    assert.deepEqual(ring[0], ring[16]);
  });
});

describe('checkpoint editor view: validation, lock and impact warning (#81)', () => {
  const places = [ORIGIN, DESTINATION];
  const current = config([checkpoint(B, 150)]);

  it('is clean and saveable only when changed, valid and not locked', () => {
    const unchanged = checkpointEditorView({ current, draft: editorItemsFromConfig(current), places, lockReason: null, runsWithResults: 0 });
    assert.deepEqual([unchanged.changed, unchanged.canSave, unchanged.editable], [false, false, true]);
    const edited = checkpointEditorView({ current, draft: [checkpoint(B, 150, 25)], places, lockReason: null, runsWithResults: 0 });
    assert.deepEqual([edited.changed, edited.canSave, edited.issues.length], [true, true, 0]);
  });

  it('shows validation errors and blocks saving (radius, overlap with places and checkpoints)', () => {
    const view = (draft: ReturnType<typeof checkpoint>[]) =>
      checkpointEditorView({ current, draft, places, lockReason: null, runsWithResults: 0 });
    assert.equal(view([checkpoint(B, 150, 7)]).canSave, false);
    assert.equal(view([checkpoint(B, 150, 7)]).issues[0]!.code, 'radius_out_of_range');
    assert.equal(view([checkpoint(B, 150, Number.NaN)]).issues[0]!.code, 'radius_out_of_range');
    assert.equal(view([checkpoint(B, 435)]).issues[0]!.code, 'overlaps_place');
    assert.equal(view([checkpoint(B, 150), checkpoint(B2, 180)]).issues[0]!.code, 'overlaps_checkpoint');
    assert.equal(view([{ ...checkpoint(B, 150), name: '' }]).issues[0]!.code, 'empty_name');
  });

  it('disables editing and shows the lock reason verbatim while locked', () => {
    const lock = 'Finish or cancel the current run before changing checkpoints.';
    const view = checkpointEditorView({ current, draft: [checkpoint(B, 150, 25)], places, lockReason: lock, runsWithResults: 3 });
    assert.deepEqual([view.editable, view.canSave, view.lockReason], [false, false, lock]);
  });

  it('warns about stale results only when saving would invalidate existing ones', () => {
    const edit = (runsWithResults: number, cur = current) =>
      checkpointEditorView({ current: cur, draft: [checkpoint(B, 150, 25)], places, lockReason: null, runsWithResults });
    assert.equal(edit(2).impactWarning, CHECKPOINT_IMPACT_WARNING);
    assert.match(CHECKPOINT_IMPACT_WARNING, /stale/);
    assert.match(CHECKPOINT_IMPACT_WARNING, /official run times, personal bests and full-route rankings are not changed/);
    assert.equal(edit(0).impactWarning, null);
    assert.equal(edit(2, null as never).impactWarning, null, 'first configuration has nothing to invalidate');
    assert.equal(
      checkpointEditorView({ current, draft: editorItemsFromConfig(current), places, lockReason: null, runsWithResults: 5 }).impactWarning,
      null,
      'no warning without a change',
    );
  });
});

function result(attemptId: string, from: string | null, to: string | null, durationMs: number | null, extra: Partial<AttemptSegmentResult> = {}): AttemptSegmentResult {
  return {
    id: `${attemptId}:${segmentKey(from, to)}`,
    attemptId,
    configVersion: 1,
    derivationVersion: 1,
    fromCheckpointId: from,
    toCheckpointId: to,
    status: durationMs == null ? 'unavailable' : 'valid',
    unavailableReason: durationMs == null ? 'not_reached' : null,
    startedAtMs: durationMs == null ? null : T0,
    endedAtMs: durationMs == null ? null : T0 + durationMs,
    durationMs,
    derivedAtMs: 1,
    ...extra,
  };
}

function runAt(id: string, offsetMs: number, extra: Partial<Attempt> = {}): Attempt {
  return fullAttempt({
    id,
    sessionId: `s-${id}`,
    armedAtMs: T0 + offsetMs - 1000,
    startedAtMs: T0 + offsetMs,
    finishedAtMs: T0 + offsetMs + 60_000,
    ...extra,
  });
}

describe('segment selector and board summary (#81)', () => {
  const cfg = config([checkpoint(B, 150)]);
  const attempts = [runAt('r1', 0), runAt('r2', 100_000), runAt('r3', 200_000)];
  const results = [
    result('r1', B, null, 40_000, { startedAtMs: T0, endedAtMs: T0 + 40_000 }),
    result('r2', B, null, 30_000, { startedAtMs: T0 + 100_000, endedAtMs: T0 + 130_000 }),
    result('r3', B, null, 50_000, { startedAtMs: T0 + 200_000, endedAtMs: T0 + 250_000 }),
    result('r1', null, B, 10_000, { startedAtMs: T0, endedAtMs: T0 + 10_000 }),
  ];
  const boards = buildSegmentBoards({ config: cfg, originName: 'Work', destinationName: 'Home', results, attempts });

  it('defaults to the full route and lists one option per segment', () => {
    const options = segmentSelectorOptions(boards);
    assert.equal(options[0]!.key, FULL_ROUTE_SELECTION);
    assert.equal(options[0]!.label, 'Full route');
    assert.deepEqual(options.slice(1).map((o) => [o.label, o.count]), [['Work → B', 1], ['B → Home', 3]]);
    assert.deepEqual(segmentSelectorOptions([]).map((o) => o.key), [FULL_ROUTE_SELECTION], 'no boards: only the full route');
  });

  it('falls back to the full route when the selected segment disappears', () => {
    assert.equal(resolveSegmentSelection(segmentKey(B, null), boards), segmentKey(B, null));
    assert.equal(resolveSegmentSelection('C:gone>F', boards), FULL_ROUTE_SELECTION);
    assert.equal(resolveSegmentSelection(FULL_ROUTE_SELECTION, boards), FULL_ROUTE_SELECTION);
    assert.equal(resolveSegmentSelection(segmentKey(B, null), []), FULL_ROUTE_SELECTION);
  });

  it('summarises PB, median, count and the empty state with the full-route formatting', () => {
    const suffix = boards.find((b: SegmentBoard) => b.key === segmentKey(B, null))!;
    const summary = segmentBoardSummary(suffix, formatElapsed);
    assert.deepEqual(
      [summary.title, summary.countLabel, summary.pbLabel, summary.medianLabel, summary.empty],
      ['B → Home', '3 eligible runs', 'PB 0:30', 'Median 0:40', false],
    );
    const prefix = segmentBoardSummary(boards.find((b: SegmentBoard) => b.key === segmentKey(null, B))!, formatElapsed);
    assert.deepEqual([prefix.countLabel, prefix.medianLabel], ['1 eligible run', null]);
    const empty = segmentBoardSummary({ ...suffix, validCount: 0, pb: null, medianMs: null, entries: [] }, formatElapsed);
    assert.deepEqual([empty.empty, empty.pbLabel], [true, null]);
  });

  it('labels the source of an entry', () => {
    assert.equal(sourceLabel('full'), 'FULL RUN');
    assert.equal(sourceLabel('partial'), 'PARTIAL START');
  });
});

describe('post-run segment view (#81)', () => {
  const cfg = config([checkpoint(B, 150)]);
  const attempts = [runAt('old', 0), runAt('new', 500_000)];
  const view = (attemptId: string, results: AttemptSegmentResult[], all: AttemptSegmentResult[], extra: object = {}) =>
    buildAttemptSegmentsView({
      attempt: attempts.find((a) => a.id === attemptId)!,
      config: cfg,
      results,
      boards: buildSegmentBoards({ config: cfg, originName: 'Work', destinationName: 'Home', results: all, attempts }),
      eligible: true,
      ...extra,
    });

  it('shows nothing for an unconfigured journey (UI unchanged)', () => {
    const v = buildAttemptSegmentsView({ attempt: attempts[0]!, config: null, results: [], boards: [], eligible: true });
    assert.deepEqual([v.state, v.rows.length, v.message], ['unconfigured', 0, null]);
    assert.equal(buildAttemptSegmentsView({ attempt: attempts[0]!, config: config([]), results: [], boards: [], eligible: true }).state, 'unconfigured');
  });

  it('marks first results, new segment PBs and ties, with rank, count and PB', () => {
    const oldRows = [result('old', B, null, 40_000, { startedAtMs: T0, endedAtMs: T0 + 40_000 })];
    const first = view('old', oldRows, oldRows);
    assert.equal(first.rows[0]!.pbStatus, 'first_result');
    assert.equal(pbStatusLabel('first_result'), 'FIRST TIME');

    const fasterRows = [result('new', B, null, 35_000, { startedAtMs: T0 + 500_000, endedAtMs: T0 + 535_000 })];
    const faster = view('new', fasterRows, [...oldRows, ...fasterRows]);
    assert.equal(faster.rows[0]!.pbStatus, 'new_pb');
    assert.equal(pbStatusLabel('new_pb'), 'NEW SEGMENT PB');
    assert.deepEqual([faster.rows[0]!.rank, faster.rows[0]!.eligibleCount, faster.rows[0]!.pbMs], [1, 2, 35_000]);

    const slowerRows = [result('new', B, null, 45_000, { startedAtMs: T0 + 500_000, endedAtMs: T0 + 545_000 })];
    const slower = view('new', slowerRows, [...oldRows, ...slowerRows]);
    assert.equal(slower.rows[0]!.pbStatus, null);
    assert.equal(slower.rows[0]!.rank, 2);
    assert.equal(slower.rows[0]!.pbMs, 40_000);

    const tiedRows = [result('new', B, null, 40_000, { startedAtMs: T0 + 500_000, endedAtMs: T0 + 540_000 })];
    assert.equal(view('new', tiedRows, [...oldRows, ...tiedRows]).rows[0]!.pbStatus, 'ties_pb');
    assert.equal(pbStatusLabel('ties_pb'), 'TIES PB');
  });

  it('shows unavailable segments explicitly with a reason instead of a time', () => {
    const rows = [
      result('old', B, null, 40_000, { startedAtMs: T0, endedAtMs: T0 + 40_000 }),
      result('old', null, B, null, { unavailableReason: 'gap_too_large' }),
    ];
    const v = view('old', rows, rows);
    const unavailable = v.rows.find((row) => row.status === 'unavailable')!;
    assert.deepEqual([unavailable.durationMs, unavailable.reason], [null, 'GPS gap too long to time this crossing.']);
    assert.equal(v.state, 'ready');
    assert.equal(v.message, null);
    const none = view('old', [result('old', null, B, null)], []);
    assert.match(none.message!, /No segment times could be derived/);
  });

  it('reports stale, pending and not-applicable states explicitly (never mixing versions)', () => {
    assert.equal(view('old', [], []).state, 'stale');
    assert.match(view('old', [], []).message!, /Recalculate segments/);
    assert.equal(view('old', [], [], { derivationPending: true }).state, 'pending');
    const dnf = view('old', [], [], { eligible: false });
    assert.deepEqual([dnf.state, dnf.rows.length], ['not_applicable', 0]);
  });

  it('identifies a partial run and its start checkpoint', () => {
    const partial = partialAttempt(B, T0, T0 + 40_000);
    const v = buildAttemptSegmentsView({ attempt: partial, config: cfg, results: [], boards: [], eligible: true });
    assert.deepEqual([v.attemptKind, v.startCheckpointName], ['partial', 'B']);
  });

  it('maps every unavailable reason to a readable sentence', () => {
    for (const reason of ['not_reached', 'out_of_order', 'no_arrival_margin', 'gap_too_large', 'wrong_direction', 'departure_unconfirmed', 'missing_telemetry', 'geometry_invalid', 'non_positive_duration', 'before_start_checkpoint']) {
      assert.match(unavailableReasonLabel(reason), /\w/);
      assert.notEqual(unavailableReasonLabel(reason), 'Unavailable.');
    }
    assert.equal(unavailableReasonLabel(null), 'Unavailable.');
  });
});

describe('segment map highlight (#81)', () => {
  const samples = [0, 1, 2, 3, 4, 5].map((s) => ({ recordedAtMs: T0 + s * 1000, latitude: 32 + s / 1000, longitude: 34 }));
  it('returns the trace points of the segment window only', () => {
    assert.deepEqual(segmentHighlightPath(samples, T0 + 1000, T0 + 3000).length, 3);
    assert.deepEqual(segmentHighlightPath(samples, T0 + 1500, T0 + 3500).map((p) => p.latitude), [32.002, 32.003]);
  });
  it('is empty without a valid window', () => {
    assert.deepEqual(segmentHighlightPath(samples, null, T0), []);
    assert.deepEqual(segmentHighlightPath(samples, T0 + 3000, T0 + 1000), []);
    assert.deepEqual(segmentHighlightPath([], T0, T0 + 1000), []);
  });
});

describe('partial runs in history (#81)', () => {
  it('lists completed partials and partial non-results with explicit labels, newest first, never as full DNF', () => {
    const done = partialAttempt(B, T0, T0 + 40_000, { id: 'p-done', sessionId: 's1' });
    const dnf = partialAttempt(B, T0 + 100_000, null as never, { id: 'p-dnf', sessionId: 's2', lifecycle: 'ended', validity: 'unranked', finishedAtMs: null, armedAtMs: T0 + 90_000 });
    const dns = partialAttempt(B, null as never, null as never, { id: 'p-dns', sessionId: 's3', lifecycle: 'ended', validity: 'unranked', startedAtMs: null, finishedAtMs: null, armedAtMs: T0 + 200_000 });
    const hidden = partialAttempt(B, T0, null as never, { id: 'p-hidden', sessionId: 's4', lifecycle: 'ended', validity: 'unranked', finishedAtMs: null, hiddenIncomplete: true });
    const full = runAt('full', 0);
    const cancelled = partialAttempt(B, T0, null as never, { id: 'p-cancelled', sessionId: 's5', lifecycle: 'cancelled', validity: 'unranked', finishedAtMs: null });
    const rows = partialRunRows([done, dnf, dns, hidden, full, cancelled], () => 'B');
    assert.deepEqual(rows.map((row) => [row.attemptId, row.label, row.officialTimeMs]), [
      ['p-dns', 'PARTIAL DID NOT START', null],
      ['p-dnf', 'PARTIAL DID NOT FINISH', null],
      ['p-done', 'PARTIAL', 40_000],
    ]);
    assert.ok(rows.every((row) => row.startCheckpointName === 'B'));
  });
});

describe('segment recalculation summary (#81)', () => {
  const cfg = config([checkpoint(B, 150)]);
  it('reports stale counts and only offers recalculation when needed', () => {
    const base = { config: cfg, eligibleAttemptCount: 4, staleAttemptCount: 3, needsRecalculation: true };
    const stale = segmentRecalcSummary(base);
    assert.deepEqual([stale.offerRecalculate, stale.staleLabel], [true, '3 of 4 runs need recalculation']);
    assert.equal(segmentRecalcSummary({ ...base, staleAttemptCount: 0, needsRecalculation: false }).offerRecalculate, false);
    assert.match(segmentRecalcSummary({ ...base, staleAttemptCount: 0, needsRecalculation: false }).headline, /up to date/);
    assert.match(segmentRecalcSummary({ ...base, eligibleAttemptCount: 0, staleAttemptCount: 0, needsRecalculation: false }).headline, /No completed runs/);
    assert.match(segmentRecalcSummary({ ...base, config: null }).headline, /Add checkpoints/);
    assert.equal(segmentRecalcSummary({ ...base, config: null }).offerRecalculate, false);
    assert.equal(segmentRecalcSummary({ ...base, eligibleAttemptCount: 1, staleAttemptCount: 1 }).staleLabel, '1 of 1 run needs recalculation');
  });
});
