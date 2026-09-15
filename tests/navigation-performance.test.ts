import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import {
  addCheckpointFromPending,
  createCourseEditorDraft,
  previewMapTap,
  toCourseLayout,
} from '../src/domain/course-editor';
import { MILLISECONDS_PER_DAY } from '../src/domain/journey-statistics';
import { pointAtProgress } from '../src/domain/path-projection';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2,
});
const OTHER = makePlace({
  id: 'place-gym',
  name: 'Gym',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 0, 1000),
  createdAtMs: 3,
});
const POOL = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter' as const,
};
const OTHER_POOL = {
  originPlaceId: HOME.id,
  destinationPlaceId: OTHER.id,
  transportationMode: 'scooter' as const,
};
const PATH = northPath({
  startLat: HOME.center.latitude,
  startLng: HOME.center.longitude,
  points: 51,
  stepMeters: 20,
});

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `session-${id}`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_700_000_000_000 - 5_000,
    startedAtMs: 1_700_000_000_000,
    finishedAtMs: 1_700_000_000_000 + 99_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    routeId: 'route-1',
    originPlaceId: HOME.id,
    destinationPlaceId: WORK.id,
    transportationMode: 'scooter',
    ...overrides,
  };
}

async function seedAttempt(
  sessions: ReturnType<typeof createMemoryWorkspace>['sessions'],
  attempts: ReturnType<typeof createMemoryWorkspace>['attempts'],
  attempt: Attempt,
  sampleCount: number,
  path = PATH,
) {
  const samples = traceAlongPath(path, {
    sessionId: attempt.sessionId,
    startMs: attempt.startedAtMs ?? 1_700_000_000_000,
    intervalMs: 1000,
    stepMeters: 10,
    count: sampleCount,
  });
  sessions.seedSession(
    {
      id: attempt.sessionId,
      startedAtMs: samples[0]!.recordedAtMs,
      stoppedAtMs: samples[samples.length - 1]!.recordedAtMs,
      isActive: false,
      purpose: 'attempt',
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
      lastSampleAtMs: samples[samples.length - 1]!.recordedAtMs,
      backgroundPermissionConfirmed: true,
    },
    samples,
  );
  await attempts.createAttempt(attempt);
}

async function legacySampleScan(
  sessions: ReturnType<typeof createMemoryWorkspace>['sessions'],
  attempts: Attempt[],
) {
  const startedAt = performance.now();
  let calls = 0;
  for (const attempt of attempts) {
    await sessions.listSamples(attempt.sessionId);
    calls += 1;
  }
  return { durationMs: performance.now() - startedAt, calls };
}

describe('navigation performance and derivation reuse', () => {
  it('does not load GPS samples for Home or journey revisits when derivation inputs are unchanged', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await places.createPlace(OTHER);
    await routes.createRoute(makeRoute({ id: 'route-1', referencePath: PATH, name: 'Main' }));
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 120);
    await seedAttempt(sessions, attempts, completedAttempt('hw-2', { sessionId: 'session-hw-2' }), 120);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('gym-1', {
        id: 'gym-1',
        sessionId: 'session-gym-1',
        destinationPlaceId: OTHER.id,
        routeId: null,
      }),
      120,
      northPath({
        startLat: HOME.center.latitude,
        startLng: HOME.center.longitude,
        points: 40,
        stepMeters: 20,
      }),
    );

    const allAttempts = await attempts.listAttempts();
    const beforePattern = await legacySampleScan(sessions, allAttempts);
    workspace.resetNavigationLoad();

    const home1 = await workspace.loadHome();
    const journey1 = await workspace.loadJourney(POOL);
    const home2 = await workspace.loadHome();
    const journey2 = await workspace.loadJourney(POOL);

    assert.equal(home1.journeys.length, 2);
    assert.equal(journey1?.summary.rankedAttemptCount, 2);
    assert.equal(home2.journeys[0]?.pbAttemptId, home1.journeys[0]?.pbAttemptId);
    assert.equal(journey2?.summary.pbTimeMs, journey1?.summary.pbTimeMs);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);
    assert.equal(workspace.navigationLoad.counters.loadHomeHits, 1);
    assert.equal(workspace.navigationLoad.counters.loadJourneyHits, 1);
    assert.equal(beforePattern.calls, 3);
    assert.ok(beforePattern.durationMs >= 0);
  });

  it('loads samples only for the focused journey pool and reuses that analysis on revisit', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await places.createPlace(OTHER);
    await routes.createRoute(makeRoute({ id: 'route-1', referencePath: PATH }));
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 80);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('gym-1', {
        destinationPlaceId: OTHER.id,
        routeId: null,
        sessionId: 'session-gym-1',
      }),
      80,
    );

    workspace.resetNavigationLoad();
    const headline = await workspace.analyzeJourneyHeadline(POOL, 'hw-1');
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);
    assert.ok(headline?.focus?.officialTimeMs != null);
    assert.equal(headline?.focus?.pathAnalytics, null);

    const first = await workspace.analyzeJourney(POOL, 'hw-1');
    const sampleCallsAfterFirst = workspace.navigationLoad.counters.listSamplesCalls;
    assert.equal(sampleCallsAfterFirst, 1);
    assert.ok(first?.focus?.officialTimeMs === headline?.focus?.officialTimeMs);

    const second = await workspace.analyzeJourney(POOL, 'hw-1');
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, sampleCallsAfterFirst);
    assert.equal(workspace.navigationLoad.counters.analyzeJourneyHits, 1);
    assert.equal(second?.focus?.officialTimeMs, first?.focus?.officialTimeMs);

    const debug1 = await workspace.inspectAttempt('hw-1');
    const debugCalls = workspace.navigationLoad.counters.listSamplesCalls;
    await workspace.inspectAttempt('hw-1');
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, debugCalls);
    assert.equal(workspace.navigationLoad.counters.inspectAttemptHits, 1);
    assert.ok(debug1?.place);
  });

  it('invalidates cached Home/journey presentation after a Place rename with no attempt writes', async () => {
    const { workspace, sessions, attempts, places } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await seedAttempt(sessions, attempts, completedAttempt('hw-1', { routeId: null }), 20);

    const home1 = await workspace.loadHome();
    const journey1 = await workspace.loadJourney(POOL);
    assert.match(home1.journeys[0]?.title ?? '', /Home/);
    assert.equal(journey1?.origin.name, 'Home');

    const renamed = await workspace.savePlace({ ...HOME, name: 'Casa' });
    assert.equal(renamed.ok, true);

    const home2 = await workspace.loadHome();
    const journey2 = await workspace.loadJourney(POOL);
    assert.match(home2.journeys[0]?.title ?? '', /Casa/);
    assert.equal(journey2?.origin.name, 'Casa');
    assert.equal(workspace.navigationLoad.counters.loadHomeMisses, 2);
    assert.equal(workspace.navigationLoad.counters.loadJourneyMisses, 2);
    assert.equal(workspace.navigationLoad.counters.listSamplesCalls, 0);
  });

  it('drops a last-7-days attempt after asOfMs advances 2s with no SQLite writes', async () => {
    let now = 1_800_000_000_000;
    const { workspace, sessions, attempts, places } = createMemoryWorkspace({ now: () => now });
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    const finishedAtMs = now - 7 * MILLISECONDS_PER_DAY + 1_000;
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('edge', {
        routeId: null,
        startedAtMs: finishedAtMs - 10_000,
        finishedAtMs,
      }),
      12,
    );

    const inside = await workspace.loadJourney(POOL);
    assert.equal(inside?.statistics.bestLast7DaysAttemptId, 'edge');

    now += 2_000;
    const outside = await workspace.loadJourney(POOL);
    assert.equal(outside?.statistics.bestLast7DaysAttemptId, null);
    assert.equal(workspace.navigationLoad.counters.loadJourneyHits, 0);
    assert.equal(workspace.navigationLoad.counters.loadJourneyMisses, 2);
  });

  it('does not reuse Gold/split/ghost analysis after a course-layout save with no attempt-row writes', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    const route = makeRoute({ id: 'route-1', referencePath: PATH, name: 'Main' });
    await routes.createRoute(route);
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 80);

    const beforeAttempts = JSON.stringify(await attempts.listAttempts());
    const before = await workspace.analyzeRoute(route.id);
    const beforeFocus = await workspace.analyzeJourney(POOL, 'hw-1');
    assert.ok(before);
    assert.equal(
      before.analysis.summary.layoutIdentity,
      beforeFocus?.focus?.pathAnalytics?.focus.layoutIdentity ?? before.analysis.summary.layoutIdentity,
    );

    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, pointAtProgress(route.referencePath, 80));
    draft = addCheckpointFromPending(draft, () => 'cp-park');
    const saved = await workspace.saveCourseLayout(route.id, toCourseLayout(draft));
    assert.equal(saved.ok, true);
    assert.equal(JSON.stringify(await attempts.listAttempts()), beforeAttempts);

    workspace.resetNavigationLoad();
    const after = await workspace.analyzeRoute(route.id);
    const afterFocus = await workspace.analyzeJourney(POOL, 'hw-1');
    assert.ok(after);
    assert.notEqual(after.analysis.summary.layoutIdentity, before.analysis.summary.layoutIdentity);
    assert.ok((after.analysis.derived[0]?.segments.length ?? 0) > (before.analysis.derived[0]?.segments.length ?? 0));
    assert.equal(workspace.navigationLoad.counters.analyzeRouteHits, 0);
    assert.equal(workspace.navigationLoad.counters.analyzeJourneyHits, 0);
    assert.ok(afterFocus?.focus);
  });

  it('does not reuse a Home/journey snapshot taken before path-variant recompute changes routeIds', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    const route = makeRoute({ id: 'route-1', referencePath: PATH, name: 'Main' });
    await routes.createRoute(route);
    await seedAttempt(sessions, attempts, completedAttempt('hw-1', { routeId: null }), 40);

    const homeBefore = await workspace.loadHome();
    const journeyBefore = await workspace.loadJourney(POOL);
    assert.equal(homeBefore.journeys[0]?.rankedAttemptCount, 1);
    assert.equal(journeyBefore?.pathVariants[0]?.attemptCount, 0);

    const existing = await attempts.getAttempt('hw-1');
    assert.ok(existing);
    await attempts.saveAttempt({ ...existing, routeId: route.id });

    const homeAfter = await workspace.loadHome();
    const journeyAfter = await workspace.loadJourney(POOL);
    assert.equal(homeAfter.journeys[0]?.rankedAttemptCount, 1);
    assert.equal(journeyAfter?.pathVariants[0]?.attemptCount, 1);
    assert.equal(journeyAfter?.pathVariants[0]?.route.id, route.id);
    assert.equal(workspace.navigationLoad.counters.loadHomeMisses, 2);
    assert.equal(workspace.navigationLoad.counters.loadJourneyMisses, 2);
  });

  it('does not mutate attempt rows while navigating Home, journey, and analysis reads', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await routes.createRoute(makeRoute({ id: 'route-1', referencePath: PATH }));
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 30);
    const before = JSON.stringify(await attempts.listAttempts());

    await workspace.loadHome();
    await workspace.loadJourney(POOL);
    await workspace.analyzeJourneyHeadline(POOL, 'hw-1');
    await workspace.analyzeJourney(POOL, 'hw-1');
    await workspace.inspectAttempt('hw-1');
    await workspace.loadHome();
    await workspace.loadJourney(POOL);

    assert.equal(JSON.stringify(await attempts.listAttempts()), before);
  });

  it('records before/after timings for representative Home, journey, and analysis transitions', async () => {
    const { workspace, sessions, attempts, places, routes } = createMemoryWorkspace();
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    await places.createPlace(OTHER);
    await routes.createRoute(makeRoute({ id: 'route-1', referencePath: PATH }));
    await seedAttempt(sessions, attempts, completedAttempt('hw-1'), 150);
    await seedAttempt(sessions, attempts, completedAttempt('hw-2', { sessionId: 'session-hw-2' }), 150);
    await seedAttempt(
      sessions,
      attempts,
      completedAttempt('gym-1', {
        destinationPlaceId: OTHER.id,
        routeId: null,
        sessionId: 'session-gym-1',
      }),
      150,
    );

    const allAttempts = await attempts.listAttempts();
    const legacyHome = await legacySampleScan(sessions, allAttempts);
    workspace.resetNavigationLoad();
    await workspace.loadHome();
    const homeTiming = workspace.navigationLoad.timings.at(-1);
    const afterHome = await workspace.loadHome();
    const homeRevisit = workspace.navigationLoad.timings.at(-1);
    await workspace.loadJourney(POOL);
    const journeyTiming = workspace.navigationLoad.timings.find((item) => item.operation === 'loadJourney');
    await workspace.analyzeJourneyHeadline(POOL, 'hw-1');
    const headlineTiming = workspace.navigationLoad.timings.find(
      (item) => item.operation === 'analyzeJourneyHeadline',
    );
    await workspace.analyzeJourney(POOL, 'hw-1');
    const analysisTiming = workspace.navigationLoad.timings.find((item) => item.operation === 'analyzeJourney');

    assert.equal(afterHome.journeys.length, 2);
    assert.ok(homeTiming);
    assert.ok(homeRevisit?.cacheHit);
    assert.equal(homeTiming.listSamplesDelta, 0);
    assert.equal(journeyTiming?.listSamplesDelta, 0);
    assert.equal(headlineTiming?.listSamplesDelta, 0);
    assert.ok((analysisTiming?.listSamplesDelta ?? 0) <= 2);
    assert.ok(legacyHome.calls === 3);

    const report = {
      environment: 'node-memory-workspace',
      transitions: {
        'legacy Home sample scan (before)': legacyHome,
        'loadHome first paint (after)': homeTiming,
        'loadHome revisit (after)': homeRevisit,
        'loadJourney (after)': journeyTiming,
        'analyzeJourneyHeadline shell (after)': headlineTiming,
        'analyzeJourney secondary (after)': analysisTiming,
      },
    };
    try {
      mkdirSync('/opt/cursor/artifacts', { recursive: true });
      writeFileSync(
        '/opt/cursor/artifacts/navigation-transition-profile.json',
        `${JSON.stringify(report, null, 2)}\n`,
      );
    } catch {
      // Cloud walkthrough dir is optional; CI clones should still pass.
    }
    assert.equal(report.transitions['loadHome first paint (after)']?.listSamplesDelta, 0);
  });

  it('paints journey/result shells before secondary map/debug work and keeps the DB executor a singleton', () => {
    const appRoot = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const resultScreen = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    const journeyScreen = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    const database = readFileSync('src/persistence/database.ts', 'utf8');
    const workspace = readFileSync('src/product/route-workspace.ts', 'utf8');

    assert.match(appRoot, /setScreen\(\{ kind: 'journey', pool \}\);\s*const loaded = await loadJourney\(pool\);/s);
    assert.match(appRoot, /canPresentRetainedJourney/);
    assert.match(appRoot, /beginJourneySnapshotLoad/);
    assert.match(appRoot, /createAttemptResultShell\(attempt\)/);
    assert.match(appRoot, /setScreen\(nextScreen\);\s*void loadAttemptResultSecondary/s);
    assert.match(appRoot, /workspace\.analyzeJourneyHeadline/);
    assert.match(appRoot, /debugPending=\{debugPending\}/);
    assert.match(appRoot, /pathAnalyticsPending=\{pathAnalyticsPending\}/);
    assert.match(resultScreen, /debugPending/);
    assert.match(resultScreen, /pathAnalyticsPending/);
    assert.match(resultScreen, /DeferredMapSlot/);
    assert.match(resultScreen, /Loading path analytics/);
    assert.match(resultScreen, /Loading debug trace/);
    assert.match(journeyScreen, /DeferredMapSlot/);
    assert.match(database, /if \(!executorPromise\)/);
    assert.match(workspace, /tracesFromAttempts/);
    assert.doesNotMatch(workspace, /tracesForAttempts/);
  });
});
