import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, isJourneyCompetitive, officialTimeMs, type Attempt } from '../src/domain/attempt';
import {
  PATH_ANALYTICS_UNAVAILABLE_MESSAGE,
  analyzeJourneyFocus,
  listJourneyPools,
  type JourneyAttemptTrace,
} from '../src/domain/journey-analysis';
import { deriveAnchoredLayoutAttempt } from '../src/domain/attempt-analysis';
import { timingCourseFromRoute } from '../src/domain/attempt-analysis';
import { makePlace, completeJourneySamples } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';
import { attemptIdentity } from './helpers/attempts';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 240, 0),
  createdAtMs: 2,
});

function completedAttempt(
  id: string,
  overrides: Partial<Attempt> = {},
): Attempt {
  return {
    id,
    sessionId: `${id}-session`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 2_000,
    finishedAtMs: 12_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    ...attemptIdentity(),
    ...overrides,
  };
}

describe('journey identity and analysis', () => {
  it('treats opposite directions and transportation modes as separate pools', () => {
    const traces: JourneyAttemptTrace[] = [
      { attempt: completedAttempt('hw-scooter', { finishedAtMs: 12_000 }), samples: [] },
      {
        attempt: completedAttempt('wh-scooter', {
          originPlaceId: WORK.id,
          destinationPlaceId: HOME.id,
          startedAtMs: 3_000,
          finishedAtMs: 14_000,
        }),
        samples: [],
      },
      {
        attempt: completedAttempt('hw-walk', {
          transportationMode: 'walk',
          routeId: null,
          startedAtMs: 4_000,
          finishedAtMs: 40_000,
        }),
        samples: [],
      },
    ];
    const pools = listJourneyPools(traces, new Map([
      [HOME.id, HOME],
      [WORK.id, WORK],
    ]));
    assert.equal(pools.length, 3);
    const scooterHw = pools.find(
      (pool) =>
        pool.originPlaceId === HOME.id &&
        pool.destinationPlaceId === WORK.id &&
        pool.transportationMode === 'scooter',
    );
    const walkHw = pools.find((pool) => pool.transportationMode === 'walk');
    const reverse = pools.find((pool) => pool.originPlaceId === WORK.id);
    assert.equal(scooterHw?.rankedAttemptCount, 1);
    assert.equal(walkHw?.rankedAttemptCount, 1);
    assert.equal(reverse?.rankedAttemptCount, 1);
    assert.notEqual(scooterHw?.pbTimeMs, walkHw?.pbTimeMs);
  });

  it('keeps different physical paths in the same endpoint+mode pool', () => {
    const traces: JourneyAttemptTrace[] = [
      {
        attempt: completedAttempt('path-a', { startedAtMs: 1_000, finishedAtMs: 11_000, routeId: 'route-a' }),
        samples: completeJourneySamples({ origin: HOME, destination: WORK, sessionId: 'path-a' }),
      },
      {
        attempt: completedAttempt('path-b', {
          startedAtMs: 2_000,
          finishedAtMs: 13_000,
          routeId: null,
        }),
        samples: completeJourneySamples({
          origin: HOME,
          destination: WORK,
          sessionId: 'path-b',
          eastJitterMeters: 80,
        }),
      },
    ];
    const pools = listJourneyPools(traces, new Map([
      [HOME.id, HOME],
      [WORK.id, WORK],
    ]));
    assert.equal(pools.length, 1);
    assert.equal(pools[0]?.rankedAttemptCount, 2);
    assert.equal(pools[0]?.pbAttemptId, 'path-a');
    assert.equal(isJourneyCompetitive(traces[1]!.attempt), true);
  });

  it('re-anchors compatible path analytics to journey start/finish and marks unmatched paths unavailable', () => {
    const path = northPath({
      startLat: HOME.center.latitude,
      startLng: HOME.center.longitude,
      points: 13,
      stepMeters: 20,
    });
    const route = makeRoute({
      id: 'route-1',
      referencePath: path,
      startZone: { center: HOME.center, radiusMeters: 30 },
      finishZone: { center: WORK.center, radiusMeters: 30 },
    });
    const compatibleSamples = completeJourneySamples({
      origin: HOME,
      destination: WORK,
      sessionId: 'compat',
      speedMps: 4,
    });
    const unmatchedSamples = completeJourneySamples({
      origin: HOME,
      destination: WORK,
      sessionId: 'unmatched',
      eastJitterMeters: 80,
    });
    const compatible = completedAttempt('compat', {
      startedAtMs: 1_700_000_002_000,
      finishedAtMs: 1_700_000_002_000 + 60_000,
      routeId: route.id,
    });
    const unmatched = completedAttempt('unmatched', {
      startedAtMs: 1_700_000_002_000,
      finishedAtMs: 1_700_000_002_000 + 70_000,
      routeId: null,
      armedAtMs: 1_700_000_003_000,
    });
    const engineCompat = compatibleSamples;
    const started = engineCompat[0]!.recordedAtMs + 2_000;
    const finished = engineCompat[engineCompat.length - 1]!.recordedAtMs;
    compatible.startedAtMs = started;
    compatible.finishedAtMs = finished;
    unmatched.startedAtMs = unmatchedSamples[0]!.recordedAtMs + 2_000;
    unmatched.finishedAtMs = unmatchedSamples[unmatchedSamples.length - 1]!.recordedAtMs;

    const traces: JourneyAttemptTrace[] = [
      { attempt: compatible, samples: compatibleSamples },
      { attempt: unmatched, samples: unmatchedSamples },
    ];
    const focusCompat = analyzeJourneyFocus(
      { originPlaceId: HOME.id, destinationPlaceId: WORK.id, transportationMode: 'scooter' },
      HOME,
      WORK,
      traces,
      compatible.id,
      [route],
    );
    assert.ok(focusCompat);
    assert.equal(focusCompat.officialTimeMs, officialTimeMs(compatible));
    assert.equal(focusCompat.pathUnavailable, false);
    assert.ok(focusCompat.pathAnalytics);
    const segments = focusCompat.pathAnalytics.focus.segments.filter((item) => item.durationMs != null);
    const splitSum = segments.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
    assert.equal(splitSum, focusCompat.officialTimeMs);
    assert.equal(focusCompat.pathAnalytics.focus.startedAtMs, compatible.startedAtMs);
    assert.equal(focusCompat.pathAnalytics.focus.finishedAtMs, compatible.finishedAtMs);
    const first = focusCompat.pathAnalytics.focus.segments[0];
    const last = focusCompat.pathAnalytics.focus.segments[focusCompat.pathAnalytics.focus.segments.length - 1];
    assert.equal(first?.startedAtMs, compatible.startedAtMs);
    assert.equal(last?.endedAtMs, compatible.finishedAtMs);

    const anchored = deriveAnchoredLayoutAttempt(timingCourseFromRoute(route), compatible, compatibleSamples);
    assert.equal(anchored.officialTimeMs, officialTimeMs(compatible));
    assert.equal(anchored.startedAtMs, compatible.startedAtMs);

    const focusUnmatched = analyzeJourneyFocus(
      { originPlaceId: HOME.id, destinationPlaceId: WORK.id, transportationMode: 'scooter' },
      HOME,
      WORK,
      traces,
      unmatched.id,
      [route],
    );
    assert.ok(focusUnmatched);
    assert.equal(focusUnmatched.pathUnavailable, true);
    assert.equal(focusUnmatched.pathAnalytics, null);
    assert.equal(focusUnmatched.officialTimeMs, officialTimeMs(unmatched));
    assert.equal(focusUnmatched.rank, 2);
    assert.equal(focusUnmatched.comparisonAttemptId, compatible.id);
    assert.equal(focusUnmatched.resultExplanation.availability, 'headline_only');
    assert.equal(focusUnmatched.resultExplanation.rows.length, 0);
    assert.equal(focusCompat.comparisonAttemptId, null);
    assert.equal(focusCompat.resultExplanation.availability, 'no_comparison_target');
    assert.equal(PATH_ANALYTICS_UNAVAILABLE_MESSAGE.includes('unavailable'), true);
  });
});
