import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { incompleteAttemptLabel } from '../src/domain/attempt';
import { segmentKey } from '../src/domain/segment-derivation';
import { baseAttempt } from './helpers/backup-fixtures';
import { applyMigrations } from '../src/persistence/migrations';
import { checkpoint, DESTINATION, ORIGIN, POOL, ride, T0, track } from './helpers/segments';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const B = 'b';
const read = (path: string) => readFileSync(path, 'utf8');

type Ctx = ReturnType<typeof createMemoryWorkspace>;

async function makeCtx(kind: 'memory' | 'sqlite'): Promise<Ctx> {
  if (kind === 'memory') {
    const ws = createMemoryWorkspace();
    await ws.places.createPlace(ORIGIN);
    await ws.places.createPlace(DESTINATION);
    return ws;
  }
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, T0);
  const ws = createSqliteWorkspace(sql) as unknown as Ctx;
  await ws.places.createPlace(ORIGIN);
  await ws.places.createPlace(DESTINATION);
  return ws;
}

async function seedRun(ctx: Ctx, id: string, options: { partial?: boolean; speed?: number; shift?: number; lifecycle?: 'completed' | 'ended' } = {}) {
  const speed = options.speed ?? 6;
  const shift = options.shift ?? 0;
  const sessionId = `session-${id}`;
  const fromNorth = options.partial ? 140 : 0;
  const samples = track(ride({ fromNorth, speed, toSeconds: Math.ceil((480 - fromNorth) / speed) + 2 }), sessionId).map((s, i) => ({
    ...s,
    id: `${sessionId}-${i}`,
    recordedAtMs: s.recordedAtMs + shift,
  }));
  await ctx.sessions.createSession(sessionId, T0 + shift, 'attempt');
  await ctx.sessions.appendSamples(samples);
  await ctx.sessions.completeSession(sessionId, { stoppedAtMs: T0 + shift + 100_000, captureOutcome: 'finished', reviewDisposition: 'saved' });
  const ended = options.lifecycle === 'ended';
  const startNorth = options.partial ? 170 : 30;
  const attempt = baseAttempt({
    id,
    sessionId,
    originPlaceId: 'a',
    destinationPlaceId: 'c',
    armedAtMs: T0 + shift - 1000,
    lifecycle: ended ? 'ended' : 'completed',
    validity: ended ? 'unranked' : 'valid',
    startedAtMs: T0 + shift + ((startNorth - fromNorth) / speed) * 1000,
    finishedAtMs: ended ? null : T0 + shift + ((420 - fromNorth) / speed) * 1000,
    startedUtcOffsetMinutes: 0,
    startedTimezoneId: 'UTC',
    startedLocalTimeSource: 'captured',
    ...(options.partial ? { kind: 'partial' as const, startCheckpointId: B, checkpointConfigVersion: 1 } : {}),
  });
  await ctx.attempts.saveAttempt(attempt);
  return attempt;
}

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`segment UI data layer [${kind}] (#81)`, () => {
    it('loads post-run segments without blocking: stale for history, derived on demand only for the just-finished run', async () => {
      const ctx = await makeCtx(kind);
      await seedRun(ctx, 'old');
      assert.equal((await ctx.segments!.loadAttemptSegments('old')).state, 'unconfigured');
      assert.equal((await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150)])).ok, true);

      // A past run is NEVER silently backfilled by viewing it.
      const history = await ctx.segments!.loadAttemptSegments('old');
      assert.equal(history.state, 'stale');
      assert.deepEqual(await ctx.checkpoints.listSegmentResults('old'), []);

      // The just-finished run derives its own rows when the deferred hook has not run yet.
      const fresh = await ctx.segments!.loadAttemptSegments('old', { deriveIfMissing: true });
      assert.equal(fresh.state, 'ready');
      assert.deepEqual(fresh.rows.map((row) => [row.key, row.status, row.pbStatus]), [
        [segmentKey(null, B), 'valid', 'first_result'],
        [segmentKey(B, null), 'valid', 'first_result'],
      ]);
      assert.equal((await ctx.segments!.loadAttemptSegments('old')).state, 'ready');
    });

    it('marks a new segment PB on the post-run view and goes stale after a checkpoint edit', async () => {
      const ctx = await makeCtx(kind);
      await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150)]);
      await seedRun(ctx, 'slow', { speed: 5 });
      await seedRun(ctx, 'fast', { speed: 8, shift: 86_400_000 });
      await ctx.segments!.deriveForAttempt('slow');
      const view = await ctx.segments!.loadAttemptSegments('fast', { deriveIfMissing: true });
      assert.ok(view.rows.every((row) => row.pbStatus === 'new_pb'));
      assert.ok(view.rows.every((row) => row.rank === 1 && row.eligibleCount === 2));
      await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150, 25)]);
      assert.equal((await ctx.segments!.loadAttemptSegments('fast')).state, 'stale');
    });

    it('DNFs show no segments and an unconfigured pool shows nothing', async () => {
      const ctx = await makeCtx(kind);
      await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150)]);
      await seedRun(ctx, 'dnf', { lifecycle: 'ended' });
      const view = await ctx.segments!.loadAttemptSegments('dnf', { deriveIfMissing: true });
      assert.deepEqual([view.state, view.rows.length], ['not_applicable', 0]);
      assert.equal((await ctx.segments!.loadAttemptSegments('missing')).state, 'unconfigured');
    });

    it('lists partial runs in journey history and Home without touching full-route numbers', async () => {
      const ctx = await makeCtx(kind);
      await ctx.segments!.saveCheckpoints(POOL, [checkpoint(B, 150)]);
      await seedRun(ctx, 'full', { speed: 6 });
      await seedRun(ctx, 'partial', { partial: true, speed: 20, shift: 86_400_000 });
      await seedRun(ctx, 'partial-dnf', { partial: true, lifecycle: 'ended', shift: 2 * 86_400_000 });
      const journey = (await ctx.workspace.loadJourney(POOL))!;
      assert.deepEqual(journey.history.map((row) => row.attemptId), ['full']);
      assert.equal(journey.summary.rankedAttemptCount, 1);
      assert.equal(journey.statistics.validAttemptCount, 1);
      assert.deepEqual(
        journey.partialRuns.map((row) => [row.attemptId, row.label, row.startCheckpointName, row.officialTimeMs == null]),
        [
          ['partial-dnf', 'PARTIAL DID NOT FINISH', 'B', true],
          ['partial', 'PARTIAL', 'B', false],
        ],
      );
      const home = await ctx.workspace.loadHome();
      assert.equal(home.journeys.length, 1);
      assert.equal(home.journeys[0]!.rankedAttemptCount, 1);
      assert.deepEqual(
        home.incompleteAttempts.map((attempt) => [attempt.id, incompleteAttemptLabel(attempt)]),
        [['partial-dnf', 'PARTIAL DID NOT FINISH']],
        'a partial DNF is a hideable labeled non-result, not a full DNF',
      );
    });

    it('a journey without partials has an empty partial list (history unchanged)', async () => {
      const ctx = await makeCtx(kind);
      await seedRun(ctx, 'full');
      assert.deepEqual((await ctx.workspace.loadJourney(POOL))!.partialRuns, []);
    });

    it('the workspace exposes the services the screens use', async () => {
      const ctx = await makeCtx(kind);
      assert.ok(ctx.workspace.segments);
      assert.ok(ctx.workspace.segmentRecalculation);
    });
  });
}

describe('UI wiring (#81)', () => {
  const app = read('src/ui/AppRoot.tsx');
  const journey = read('src/ui/JourneyDetailScreen.tsx');
  const boards = read('src/ui/JourneySegmentBoards.tsx');
  const result = read('src/ui/AttemptResultScreen.tsx');
  const panel = read('src/ui/AttemptSegmentsPanel.tsx');
  const history = read('src/ui/HistoryScreen.tsx');
  const checkpoints = read('src/ui/CheckpointsScreen.tsx');
  const recalcPanel = read('src/ui/SegmentRecalculationPanel.tsx');
  const context = read('src/app-context.ts');

  it('adds the Checkpoints & segments screen inside the journey flow, not as a new main tab', () => {
    assert.match(app, /kind: 'checkpoints'/);
    assert.match(app, /<CheckpointsScreen/);
    assert.match(app, /onOpenCheckpoints=\{workspace\.segments \? onOpenCheckpoints : undefined\}/);
    assert.match(read('src/ui/system-back.ts'), /case 'checkpoints':\s*return 'leaveCheckpointsToJourney'/);
    assert.match(app, /leaveCheckpointsToJourney,\s*\}\),/s);
    assert.doesNotMatch(read('src/ui/HomeScreen.tsx'), /CheckpointsScreen|CHECKPOINTS & SEGMENTS/);
  });

  it('the checkpoint editor uses the existing map, shows lock reasons and validation, and warns about impact', () => {
    assert.match(checkpoints, /RouteMap/);
    assert.match(checkpoints, /startZone=\{placeZone\(origin, 'departure'\)\}/);
    assert.match(checkpoints, /finishZone=\{placeZone\(destination, 'arrival'\)\}/);
    assert.match(checkpoints, /onMapPress=\{place\}/);
    assert.match(checkpoints, /getCurrentPosition/);
    assert.match(checkpoints, /view\.lockReason/);
    assert.match(checkpoints, /editable=\{view\.editable\}/);
    assert.match(checkpoints, /view\.issues\.map/);
    assert.match(checkpoints, /impactWarning/);
    assert.match(checkpoints, /Alert\.alert/);
    assert.match(checkpoints, /START · \{origin\.name\}/);
    assert.match(checkpoints, /FINISH · \{destination\.name\}/);
    assert.match(checkpoints, /SEGMENTS THIS CREATES/);
    assert.match(checkpoints, /<SegmentRecalculationPanel/);
    assert.doesNotMatch(checkpoints, /saveConfig\(/, 'saves go through the locked product API, never the raw store');
  });

  it('the recalculation panel is explicit: confirm, progress, resume, cancel, retry; never automatic', () => {
    for (const label of ['CONFIRM RECALCULATION', 'RESUME', 'CANCEL RECALCULATION', 'RETRY FAILED', 'RECALCULATE SEGMENTS']) {
      assert.ok(recalcPanel.includes(label), label);
    }
    assert.match(recalcPanel, /SEGMENT_RECALCULATION_CONFIRM_WARNING/);
    assert.match(recalcPanel, /service\.preview\(pool\)/);
    // run() is only reached from a button handler or the paused-retry timer, never from mount.
    const mountEffect = recalcPanel.slice(recalcPanel.indexOf('useEffect(() => {\n    mounted.current = true;'), recalcPanel.indexOf('const run = useCallback'));
    assert.doesNotMatch(mountEffect, /run\(/);
  });

  it('the journey screen keeps the full route as the default and renders nothing extra without checkpoints', () => {
    assert.match(journey, /segments && onOpenCheckpoints && onOpenSegmentAttempt/);
    assert.match(journey, /onOpenCheckpoints \? \(/);
    assert.match(boards, /useState<string>\(FULL_ROUTE_SELECTION\)/);
    assert.match(boards, /if \(!result \|\| !result\.config \|\| result\.config\.checkpoints\.length === 0\) \{\s*return null;/);
    assert.match(boards, /grouping\.weekdayGroups/);
    assert.match(boards, /grouping\.hourGroups/);
    assert.match(boards, /'ranked'/);
    assert.match(boards, /sourceLabel\(entry\.attemptKind\)/);
    assert.match(boards, /onOpenAttempt\(entry\.attemptId, board\.key\)/);
    // The existing HISTORY button and stats are untouched.
    assert.match(journey, /<Text style=\{styles\.buttonText\}>HISTORY<\/Text>/);
    assert.match(journey, /<JourneyStatisticsDashboard/);
  });

  it('segment entries open the original attempt with the segment highlighted', () => {
    assert.match(app, /segmentKey,\s*\}\);/s);
    assert.match(app, /initialSegmentKey=\{screen\.kind === 'attempt-detail'/);
    assert.match(result, /segmentHighlightPath\(/);
    assert.match(result, /pathVariants=\{segmentHighlightLines\}/);
  });

  it('post-run segments load asynchronously inside their own component and never gate back/done', () => {
    assert.match(panel, /useEffect\(/);
    assert.match(panel, /\.loadAttemptSegments\(attempt\.id, \{ deriveIfMissing \}\)/);
    assert.match(result, /<AttemptSegmentsPanel\s+key=\{attempt\.id\}/);
    assert.match(app, /segments=\{workspace\.segments\}\s+deriveSegmentsIfMissing/);
    assert.doesNotMatch(app.slice(app.indexOf('const showAttemptResult')), /loadAttemptSegments/);
    // Only the post-run screen may derive on demand; history/detail show stale instead of backfilling.
    const detail = app.slice(app.indexOf("screen.kind === 'attempt-detail' && attemptResult"));
    assert.doesNotMatch(detail.slice(0, detail.indexOf('onDone')), /deriveSegmentsIfMissing/);
    assert.match(panel, /Segment times could not be loaded\./);
  });

  it('history lists partial runs in a separate labeled section and passes {kind: all} only where partials belong', () => {
    assert.match(history, /partialRows = \[\]/);
    assert.match(history, /PARTIAL RUNS/);
    assert.match(app, /partialRows=\{journeyPartialRuns\}/);
    const workspace = read('src/product/route-workspace.ts');
    assert.match(workspace, /this\.attempts\.listAttempts\(\{ kind: 'all' \}\)/);
    assert.match(workspace, /kind: 'partial'/);
  });

  it('is wired in the app context with deferred derivation', () => {
    assert.match(context, /competitiveSegments,\s*segmentRecalculation,\s*\);/s);
    assert.match(context, /setOnAttemptCompleted/);
  });
});

describe('partial start UI wiring (#81)', () => {
  const app = read('src/ui/AppRoot.tsx');
  const home = read('src/ui/HomeScreen.tsx');
  const panel = read('src/ui/CheckpointStartPanel.tsx');
  const attemptScreen = read('src/ui/AttemptScreen.tsx');

  it('the start panel renders nothing without configured journeys, so plain START is the default', () => {
    assert.match(panel, /if \(!journeys \|\| journeys\.length === 0 \|\| !activeJourney \|\| activeKey == null\) \{\s*return null;/);
    assert.match(home, /\{startPanel\}/);
    assert.match(home, /<Text style=\{styles\.buttonText\}>START<\/Text>/, 'the original START button is untouched');
    assert.match(app, /onStart=\{\(\) => \{\s*void onStartAttempt\(\);/);
    assert.match(app, /workspace\.startAttempt\(\)/, 'plain START takes no options');
  });

  it('offers Full route vs Start at <checkpoint> with a suggestion, an override, the map and the board preview', () => {
    assert.match(panel, /label: 'Full route'/);
    assert.match(panel, /Start at \$\{item\.name\}/);
    assert.match(panel, /suggestStartSelection/);
    assert.match(panel, /setOverride/);
    assert.match(panel, /startBoardPreview/);
    assert.match(panel, /<RouteMap/);
    assert.match(panel, /startZone=\{placeZone\(activeJourney\.origin/);
    assert.match(panel, /finishZone=\{placeZone\(activeJourney\.destination/);
    assert.match(panel, /checkpoints=\{activeJourney\.checkpoints\.map/);
    assert.match(panel, /never counts on the full-route board/);
    assert.match(panel, /passing other checkpoints never ends the run/);
  });

  it('arms through the workspace with the partial request and shows the checkpoint on the attempt screen', () => {
    assert.match(app, /workspace\.startAttempt\(\{ partial: \{ pool, startCheckpointId \} \}\)/);
    assert.match(app, /resolveStartCheckpointName\(attempt\)/);
    assert.match(attemptScreen, /ARMED · CHECKPOINT START/);
    assert.match(attemptScreen, /The walk to it is not timed/);
    // Cancel / end are the unchanged controls.
    assert.match(attemptScreen, /onPress=\{onCancel\}/);
  });

  it('the runtime and app context keep platform code out of the partial timing domain', () => {
    const domain = read('src/domain/partial-timing.ts');
    assert.doesNotMatch(domain, /^import .*(expo|react-native|tracking\/)/m);
    assert.match(read('src/app-context.ts'), /attemptRuntime\.setCompetitiveCheckpoints\(competitiveCheckpointStore\)/);
  });
});
