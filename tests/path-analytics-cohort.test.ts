import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, officialTimeMs, type Attempt } from '../src/domain/attempt';
import { MATCH_BACKWARD_WINDOW_METERS, MATCH_FORWARD_WINDOW_METERS } from '../src/domain/course-matching';
import { pointAtProgress, progressWindowSegmentCount, referencePathSegmentCount } from '../src/domain/path-projection';
import { PATH_ANALYTICS_BUDGET_MESSAGE, loadAttemptPathAnalytics } from '../src/product/attempt-result-load';
import { yieldToEventLoop } from '../src/product/idle-yield';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

/**
 * Root cause of the stuck "Loading path analytics…" field result:
 * after the async sample reads, journey focus runs course matching on the JS
 * thread. The old near-progress projection built a candidate for every
 * segment and then threw away those outside the window, so a cohort on the
 * order of 19 attempts × 400 samples held the thread until it returned.
 * Presses are not delivered during that stretch, and a timer cannot cancel
 * it. Windowed projection plus a yield between attempts lets the event loop
 * run; the stall budget resets on each yield so a slow valid cohort is not
 * discarded and retried from zero.
 */

const ATTEMPT_COUNT = 19;
const SAMPLE_COUNT = 400;
const OFFICIAL_MS = 439_000;
const STARTED_AT_MS = 1_700_000_000_000;

function samplesAlong(
  path: ReturnType<typeof northPath>,
  distanceMeters: number,
  sessionId: string,
  eastMeters: number,
): ReturnType<typeof sample>[] {
  const samples = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const t = SAMPLE_COUNT === 1 ? 0 : index / (SAMPLE_COUNT - 1);
    const point = pointAtProgress(path, t * distanceMeters);
    const located = eastMeters === 0 ? point : offsetLatLng(point.latitude, point.longitude, 0, eastMeters);
    samples.push(
      sample({
        id: `${sessionId}-${index}`,
        sessionId,
        recordedAtMs: STARTED_AT_MS + Math.round(t * OFFICIAL_MS),
        latitude: located.latitude,
        longitude: located.longitude,
        horizontalAccuracyMeters: 5,
        speedMetersPerSecond: 4,
      }),
    );
  }
  return samples;
}

describe('path analytics cohort', () => {
  it('settles a 19×400 Home→Work cohort without a cohort-wide deadline', { timeout: 60_000 }, async () => {
    const path = northPath({ points: SAMPLE_COUNT, stepMeters: 8, startLat: 32.08, startLng: 34.78 });
    const route = makeRoute({
      id: 'route-1',
      name: 'Home → Work',
      referencePath: path,
      sourceRecordingId: 'recording-cohort',
    });
    const distance = route.finishProgressMeters;
    const home = makePlace({ id: 'place-home', name: 'Home', center: { ...path[0]! } });
    const work = makePlace({
      id: 'place-work',
      name: 'Work',
      center: { ...path[path.length - 1]! },
      createdAtMs: 2,
    });
    const { workspace, sessions, routes, attempts, places } = createMemoryWorkspace();
    await places.createPlace(home);
    await places.createPlace(work);
    await routes.createRoute(route);

    const fullSegments = referencePathSegmentCount(path);
    const windowSegments = progressWindowSegmentCount(path, {
      centerProgressMeters: distance / 2,
      forwardWindowMeters: MATCH_FORWARD_WINDOW_METERS,
      backwardWindowMeters: MATCH_BACKWARD_WINDOW_METERS,
    });
    assert.ok(fullSegments > 100, `expected a long reference path, saw ${fullSegments} segments`);
    assert.ok(
      windowSegments * 3 < fullSegments,
      `near-progress projection scores ${windowSegments} segments; the full path has ${fullSegments}`,
    );

    const pool = {
      originPlaceId: home.id,
      destinationPlaceId: work.id,
      transportationMode: 'scooter' as const,
    };
    const ids: string[] = [];
    for (let index = 0; index < ATTEMPT_COUNT; index += 1) {
      const id = `hw-${index}`;
      ids.push(id);
      const unmatched = index === ATTEMPT_COUNT - 1;
      const sessionId = `session-${id}`;
      const attempt: Attempt = {
        id,
        sessionId,
        lifecycle: 'completed',
        validity: 'valid',
        armedAtMs: STARTED_AT_MS - 5_000 - index,
        startedAtMs: STARTED_AT_MS,
        finishedAtMs: STARTED_AT_MS + OFFICIAL_MS,
        ...EMPTY_ATTEMPT_LOCAL_START,
        resultAcknowledged: true,
        crossings: [],
        routeId: route.id,
        originPlaceId: home.id,
        destinationPlaceId: work.id,
        transportationMode: 'scooter',
      };
      sessions.seedSession(
        {
          id: sessionId,
          startedAtMs: attempt.startedAtMs!,
          stoppedAtMs: attempt.finishedAtMs,
          isActive: false,
          purpose: 'attempt',
          captureOutcome: 'finished',
          reviewDisposition: 'saved',
          lastSampleAtMs: attempt.finishedAtMs,
          backgroundPermissionConfirmed: true,
        },
        samplesAlong(path, distance, sessionId, unmatched ? 400 : 0),
      );
      await attempts.createAttempt(attempt);
    }

    const measure = () => {
      let yields = 0;
      return {
        get yields() {
          return yields;
        },
        yieldToIdle: async () => {
          yields += 1;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        },
      };
    };

    const unmatchedGate = measure();
    workspace.resetNavigationLoad();
    const unmatched = await workspace.analyzeJourney(pool, ids[ATTEMPT_COUNT - 1]!, {
      yieldToIdle: unmatchedGate.yieldToIdle,
      shouldContinue: () => true,
    });
    assert.ok(unmatched);
    assert.equal(unmatched.focus?.pathUnavailable, true);
    assert.equal(unmatched.focus?.pathAnalytics, null);
    assert.equal(unmatched.focus?.officialTimeMs, OFFICIAL_MS);
    assert.equal(officialTimeMs((await workspace.getAttempt(ids[ATTEMPT_COUNT - 1]!))!), OFFICIAL_MS);
    assert.ok(unmatchedGate.yields >= ATTEMPT_COUNT);

    const matchedGate = measure();
    const matchedId = ids[0]!;
    const matched = await workspace.analyzeJourney(pool, matchedId, {
      yieldToIdle: matchedGate.yieldToIdle,
      shouldContinue: () => true,
    });
    assert.ok(matched?.focus);
    assert.equal(matched.focus.pathUnavailable, false);
    assert.ok(matched.focus.pathAnalytics);
    const splitSum = matched.focus.pathAnalytics.focus.segments
      .filter((segment) => segment.durationMs != null)
      .reduce((sum, segment) => sum + (segment.durationMs ?? 0), 0);
    assert.equal(splitSum, OFFICIAL_MS);
    assert.equal(matched.focus.officialTimeMs, OFFICIAL_MS);
    assert.equal(officialTimeMs((await workspace.getAttempt(matchedId))!), OFFICIAL_MS);
    assert.ok(matchedGate.yields >= ATTEMPT_COUNT);

    const again = await workspace.analyzeJourney(pool, matchedId, {
      yieldToIdle: yieldToEventLoop,
      shouldContinue: () => true,
    });
    assert.equal(again?.focus?.officialTimeMs, OFFICIAL_MS);
    assert.ok(workspace.navigationLoad.counters.analyzeJourneyHits >= 1);

    const loaded = await loadAttemptPathAnalytics(
      workspace,
      (await workspace.getAttempt(matchedId))!,
      undefined,
      { yieldToIdle: yieldToEventLoop },
    );
    assert.equal(loaded.pathAnalyticsError, null);
    assert.notEqual(loaded.pathAnalyticsError, PATH_ANALYTICS_BUDGET_MESSAGE);
    assert.equal(loaded.cancelled, false);
    assert.equal(loaded.pathAnalytics?.focus?.officialTimeMs, OFFICIAL_MS);
    assert.equal(loaded.pathAnalytics?.focus?.pathUnavailable, false);
  });
});
