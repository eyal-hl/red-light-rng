import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, officialTimeMs, type Attempt } from '../src/domain/attempt';
import {
  computeJourneyPoolStatistics,
  computeJourneyStatistics,
  isInRollingElapsedWindow,
  MILLISECONDS_PER_DAY,
  RECENT_TREND_LIMIT,
} from '../src/domain/journey-statistics';
import { summarizeJourneyPool, type JourneyAttemptTrace } from '../src/domain/journey-analysis';
import { makePlace } from './helpers/places';
import { attemptIdentity } from './helpers/attempts';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 240, 0),
  createdAtMs: 2,
});
const GYM = makePlace({
  id: 'place-gym',
  name: 'Gym',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 0, 240),
  createdAtMs: 3,
});

const POOL = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter' as const,
};

const DAY = MILLISECONDS_PER_DAY;
const AS_OF = Date.UTC(2026, 8, 13, 18, 0, 0);

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
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

function timedAttempt(
  id: string,
  officialMs: number,
  finishedAtMs: number,
  extra: Partial<Attempt> = {},
): Attempt {
  return completedAttempt(id, {
    startedAtMs: finishedAtMs - officialMs,
    finishedAtMs,
    armedAtMs: finishedAtMs - officialMs - 1_000,
    ...extra,
  });
}

function tracesFor(attempts: Attempt[]): JourneyAttemptTrace[] {
  return attempts.map((attempt) => ({ attempt, samples: [] }));
}

describe('journey pool statistics', () => {
  it('does not read Date.now inside the pure statistics module', () => {
    const source = readFileSync('src/domain/journey-statistics.ts', 'utf8');
    assert.doesNotMatch(source, /Date\.now\s*\(/);
  });

  it('returns an empty state for zero valid attempts', () => {
    const stats = computeJourneyStatistics([], AS_OF);
    assert.equal(stats.validAttemptCount, 0);
    assert.equal(stats.pbTimeMs, null);
    assert.equal(stats.latestTimeMs, null);
    assert.equal(stats.meanOfficialTimeMs, null);
    assert.equal(stats.medianOfficialTimeMs, null);
    assert.equal(stats.sampleStandardDeviationMs, null);
    assert.equal(stats.recentTrendPoints, null);
    assert.equal(stats.recentTrendDeltaMs, null);
    assert.equal(stats.bestLast7DaysMs, null);
    assert.equal(stats.bestLast30DaysMs, null);
    assert.equal(stats.asOfMs, AS_OF);
  });

  it('shows PB and latest only for a first attempt, with no fabricated variance or trend', () => {
    const attempt = timedAttempt('first', 12 * 60_000, AS_OF - DAY);
    const stats = computeJourneyStatistics([attempt], AS_OF);
    assert.equal(stats.validAttemptCount, 1);
    assert.equal(stats.pbAttemptId, 'first');
    assert.equal(stats.pbTimeMs, 12 * 60_000);
    assert.equal(stats.pbFinishedAtMs, AS_OF - DAY);
    assert.equal(stats.latestAttemptId, 'first');
    assert.equal(stats.latestTimeMs, 12 * 60_000);
    assert.equal(stats.meanOfficialTimeMs, null);
    assert.equal(stats.medianOfficialTimeMs, null);
    assert.equal(stats.sampleStandardDeviationMs, null);
    assert.equal(stats.recentTrendPoints, null);
    assert.equal(stats.recentTrendDeltaMs, null);
    assert.equal(stats.bestLast7DaysMs, 12 * 60_000);
    assert.equal(stats.bestLast30DaysMs, 12 * 60_000);
  });

  it('exposes a faster second attempt as PB and a negative recent-trend delta', () => {
    const slower = timedAttempt('slower', 13 * 60_000, AS_OF - 2 * DAY);
    const faster = timedAttempt('faster', 12 * 60_000, AS_OF - DAY);
    const stats = computeJourneyStatistics([slower, faster], AS_OF);
    assert.equal(stats.validAttemptCount, 2);
    assert.equal(stats.pbAttemptId, 'faster');
    assert.equal(stats.pbTimeMs, 12 * 60_000);
    assert.equal(stats.latestAttemptId, 'faster');
    assert.equal(stats.meanOfficialTimeMs, (13 * 60_000 + 12 * 60_000) / 2);
    assert.equal(stats.medianOfficialTimeMs, (13 * 60_000 + 12 * 60_000) / 2);
    assert.ok(stats.recentTrendPoints);
    assert.deepEqual(
      stats.recentTrendPoints.map((point) => point.attemptId),
      ['slower', 'faster'],
    );
    assert.equal(stats.recentTrendDeltaMs, -60_000);
  });

  it('exposes a slower second attempt as latest without changing the PB', () => {
    const faster = timedAttempt('faster', 12 * 60_000, AS_OF - 2 * DAY);
    const slower = timedAttempt('slower', 13 * 60_000, AS_OF - DAY);
    const stats = computeJourneyStatistics([faster, slower], AS_OF);
    assert.equal(stats.pbAttemptId, 'faster');
    assert.equal(stats.latestAttemptId, 'slower');
    assert.equal(stats.recentTrendDeltaMs, 60_000);
  });

  it('computes a deterministic mean and odd-population median from official times', () => {
    const attempts = [
      timedAttempt('a', 10_000, AS_OF - 3 * DAY),
      timedAttempt('b', 20_000, AS_OF - 2 * DAY),
      timedAttempt('c', 90_000, AS_OF - DAY),
    ];
    const stats = computeJourneyStatistics(attempts, AS_OF);
    assert.equal(stats.meanOfficialTimeMs, 40_000);
    assert.equal(stats.medianOfficialTimeMs, 20_000);
    assert.equal(stats.sampleStandardDeviationMs, Math.sqrt((30_000 ** 2 + 20_000 ** 2 + 50_000 ** 2) / 2));
  });

  it('uses the average of the two central official times for an even median', () => {
    const attempts = [
      timedAttempt('a', 10_000, AS_OF - 4 * DAY),
      timedAttempt('b', 20_000, AS_OF - 3 * DAY),
      timedAttempt('c', 30_000, AS_OF - 2 * DAY),
      timedAttempt('d', 40_000, AS_OF - DAY),
    ];
    const stats = computeJourneyStatistics(attempts, AS_OF);
    assert.equal(stats.meanOfficialTimeMs, 25_000);
    assert.equal(stats.medianOfficialTimeMs, 25_000);
  });

  it('selects the recent trend window by finishedAtMs and keeps oldest-to-newest order', () => {
    const attempts: Attempt[] = [];
    for (let index = 0; index < 12; index += 1) {
      attempts.push(
        timedAttempt(`run-${index}`, (20 - index) * 1_000, AS_OF - (12 - index) * DAY),
      );
    }
    const stats = computeJourneyStatistics(attempts, AS_OF);
    assert.ok(stats.recentTrendPoints);
    assert.equal(stats.recentTrendPoints.length, RECENT_TREND_LIMIT);
    assert.equal(stats.recentTrendPoints[0]?.attemptId, 'run-2');
    assert.equal(stats.recentTrendPoints[9]?.attemptId, 'run-11');
    assert.equal(stats.recentTrendPoints[0]?.finishedAtMs, AS_OF - 10 * DAY);
    assert.equal(stats.recentTrendPoints[9]?.finishedAtMs, AS_OF - DAY);
    assert.equal(stats.validAttemptCount, 12);
    assert.equal(stats.meanOfficialTimeMs, attempts.reduce((sum, item) => sum + officialTimeMs(item)!, 0) / 12);
  });

  it('includes rolling 7/30-day boundaries at both ends with an explicit asOfMs', () => {
    const windowStart7 = AS_OF - 7 * DAY;
    const windowStart30 = AS_OF - 30 * DAY;
    const attempts = [
      timedAttempt('before-7', 15_000, windowStart7 - 1),
      timedAttempt('on-7-start', 11_000, windowStart7),
      timedAttempt('on-as-of', 12_000, AS_OF),
      timedAttempt('after-as-of', 8_000, AS_OF + 1),
      timedAttempt('before-30', 7_000, windowStart30 - 1),
      timedAttempt('on-30-start', 13_000, windowStart30),
    ];
    const stats = computeJourneyStatistics(attempts, AS_OF);
    assert.equal(isInRollingElapsedWindow(windowStart7, AS_OF, 7), true);
    assert.equal(isInRollingElapsedWindow(windowStart7 - 1, AS_OF, 7), false);
    assert.equal(isInRollingElapsedWindow(AS_OF, AS_OF, 7), true);
    assert.equal(isInRollingElapsedWindow(AS_OF + 1, AS_OF, 7), false);
    assert.equal(isInRollingElapsedWindow(windowStart30, AS_OF, 30), true);
    assert.equal(isInRollingElapsedWindow(windowStart30 - 1, AS_OF, 30), false);
    assert.equal(isInRollingElapsedWindow(AS_OF, AS_OF, 30), true);
    assert.equal(isInRollingElapsedWindow(AS_OF + 1, AS_OF, 30), false);
    assert.equal(stats.bestLast7DaysMs, 11_000);
    assert.equal(stats.bestLast7DaysAttemptId, 'on-7-start');
    assert.equal(stats.bestLast30DaysMs, 11_000);
    assert.equal(stats.bestLast30DaysAttemptId, 'on-7-start');
    assert.equal(stats.pbTimeMs, 7_000);
  });

  it('does not regroup rolling-window membership after DST-length or timezone reinterpretation', () => {
    const asOfMs = Date.UTC(2026, 9, 26, 9, 0, 0);
    const attempt169HoursEarlier = timedAttempt('dst-long', 12 * 60_000, asOfMs - 169 * 60 * 60 * 1000);
    const attempt168HoursEarlier = timedAttempt('dst-edge', 11 * 60_000, asOfMs - 168 * 60 * 60 * 1000);
    const overnightFinish = Date.parse('2026-09-12T00:12:00+03:00');
    const overnight = timedAttempt('overnight', 22 * 60_000, overnightFinish, {
      startedAtMs: Date.parse('2026-09-11T23:50:00+03:00'),
    });
    const overnightAsOf = Date.parse('2026-09-18T00:06:00-04:00');

    const previousTz = process.env.TZ;
    process.env.TZ = 'Asia/Jerusalem';
    const jerusalem = computeJourneyStatistics(
      [attempt169HoursEarlier, attempt168HoursEarlier],
      asOfMs,
    );
    process.env.TZ = 'America/New_York';
    const newYork = computeJourneyStatistics(
      [attempt169HoursEarlier, attempt168HoursEarlier],
      asOfMs,
    );
    process.env.TZ = 'UTC';
    const utc = computeJourneyStatistics([attempt169HoursEarlier, attempt168HoursEarlier], asOfMs);
    const overnightJerusalem = computeJourneyStatistics([overnight], overnightAsOf);
    process.env.TZ = 'America/New_York';
    const overnightNewYork = computeJourneyStatistics([overnight], overnightAsOf);
    if (previousTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTz;
    }

    assert.deepEqual(jerusalem, newYork);
    assert.deepEqual(jerusalem, utc);
    assert.equal(jerusalem.bestLast7DaysAttemptId, 'dst-edge');
    assert.equal(jerusalem.bestLast7DaysMs, 11 * 60_000);
    assert.equal(
      isInRollingElapsedWindow(attempt169HoursEarlier.finishedAtMs!, asOfMs, 7),
      false,
    );
    assert.deepEqual(overnightJerusalem, overnightNewYork);
    assert.equal(overnightJerusalem.bestLast7DaysAttemptId, 'overnight');
  });

  it('keys overnight attempts by finishedAtMs rather than startedAtMs', () => {
    const windowStart = AS_OF - 7 * DAY;
    const overnight = timedAttempt('overnight', 22 * 60_000, windowStart + 12 * 60_000, {
      startedAtMs: windowStart - 10 * 60_000,
    });
    const stats = computeJourneyStatistics([overnight], AS_OF);
    assert.equal(isInRollingElapsedWindow(overnight.startedAtMs!, AS_OF, 7), false);
    assert.equal(isInRollingElapsedWindow(overnight.finishedAtMs!, AS_OF, 7), true);
    assert.equal(stats.latestFinishedAtMs, overnight.finishedAtMs);
    assert.equal(stats.bestLast7DaysAttemptId, 'overnight');
  });

  it('keeps opposite directions as separate competitive populations', () => {
    const outbound = timedAttempt('out', 12 * 60_000, AS_OF - DAY);
    const inbound = timedAttempt('back', 9 * 60_000, AS_OF - DAY, {
      originPlaceId: WORK.id,
      destinationPlaceId: HOME.id,
    });
    const stats = computeJourneyPoolStatistics(POOL, tracesFor([outbound, inbound]), AS_OF);
    assert.equal(stats.validAttemptCount, 1);
    assert.equal(stats.pbAttemptId, 'out');
    assert.equal(stats.pbTimeMs, 12 * 60_000);
  });

  it('keeps transportation modes as separate competitive populations', () => {
    const scooter = timedAttempt('scooter', 12 * 60_000, AS_OF - DAY);
    const walk = timedAttempt('walk', 40 * 60_000, AS_OF - DAY, { transportationMode: 'walk' });
    const stats = computeJourneyPoolStatistics(POOL, tracesFor([scooter, walk]), AS_OF);
    assert.equal(stats.validAttemptCount, 1);
    assert.equal(stats.pbAttemptId, 'scooter');
  });

  it('keeps valid attempts on different path variants in one journey-level population', () => {
    const park = timedAttempt('park', 12 * 60_000, AS_OF - 2 * DAY, { routeId: 'route-park' });
    const main = timedAttempt('main', 13 * 60_000, AS_OF - DAY, { routeId: null });
    const stats = computeJourneyPoolStatistics(POOL, tracesFor([park, main]), AS_OF);
    assert.equal(stats.validAttemptCount, 2);
    assert.equal(stats.pbAttemptId, 'park');
    assert.equal(stats.meanOfficialTimeMs, (12 * 60_000 + 13 * 60_000) / 2);
  });

  it('excludes cancelled, incomplete, unranked, and other-pool attempts from the metrics', () => {
    const valid = timedAttempt('valid', 12 * 60_000, AS_OF - DAY);
    const cancelled = completedAttempt('cancelled', {
      lifecycle: 'cancelled',
      validity: 'unranked',
      startedAtMs: AS_OF - DAY - 12 * 60_000,
      finishedAtMs: AS_OF - DAY,
    });
    const didNotFinish = completedAttempt('dnf', {
      lifecycle: 'ended',
      validity: 'unranked',
      startedAtMs: AS_OF - DAY - 5_000,
      finishedAtMs: null,
    });
    const didNotStart = completedAttempt('dns', {
      lifecycle: 'ended',
      validity: 'unranked',
      startedAtMs: null,
      finishedAtMs: null,
    });
    const unranked = completedAttempt('unranked', {
      lifecycle: 'completed',
      validity: 'unranked',
      startedAtMs: AS_OF - DAY - 8 * 60_000,
      finishedAtMs: AS_OF - DAY,
    });
    const abandoned = completedAttempt('abandoned', {
      lifecycle: 'abandoned',
      validity: 'unranked',
      startedAtMs: AS_OF - DAY - 8 * 60_000,
      finishedAtMs: AS_OF - DAY,
    });
    const otherDestination = timedAttempt('gym', 8 * 60_000, AS_OF - DAY, {
      destinationPlaceId: GYM.id,
    });
    const stats = computeJourneyPoolStatistics(
      POOL,
      tracesFor([valid, cancelled, didNotFinish, didNotStart, unranked, abandoned, otherDestination]),
      AS_OF,
    );
    assert.equal(stats.validAttemptCount, 1);
    assert.equal(stats.pbAttemptId, 'valid');
    assert.equal(stats.meanOfficialTimeMs, null);
    assert.equal(stats.sampleStandardDeviationMs, null);
  });

  it('reproduces identical stats after restart for the same attempts and asOfMs', () => {
    const attempts = [
      timedAttempt('a', 12 * 60_000, AS_OF - 3 * DAY),
      timedAttempt('b', 11 * 60_000, AS_OF - DAY),
    ];
    const first = computeJourneyStatistics(attempts, AS_OF);
    const second = computeJourneyStatistics(attempts.map((attempt) => ({ ...attempt })), AS_OF);
    assert.deepEqual(first, second);
    const later = computeJourneyStatistics(attempts, AS_OF + 8 * DAY);
    assert.equal(later.bestLast7DaysMs, null);
    assert.equal(later.pbTimeMs, first.pbTimeMs);
    assert.notDeepEqual(first, later);
  });

  it('does not change official PB, rank, or history semantics from summarizeJourneyPool', () => {
    const attempts = [
      timedAttempt('older-slow', 14 * 60_000, AS_OF - 4 * DAY, { routeId: 'variant-a' }),
      timedAttempt('pb', 11 * 60_000, AS_OF - 2 * DAY, { routeId: null }),
      timedAttempt('latest', 12 * 60_000, AS_OF - DAY, { routeId: 'variant-b' }),
    ];
    const traces = tracesFor(attempts);
    const summary = summarizeJourneyPool(POOL, HOME, WORK, traces);
    const stats = computeJourneyPoolStatistics(POOL, traces, AS_OF);
    assert.equal(stats.pbAttemptId, summary.pbAttemptId);
    assert.equal(stats.pbTimeMs, summary.pbTimeMs);
    assert.equal(stats.latestAttemptId, summary.lastAttemptId);
    assert.equal(stats.latestTimeMs, summary.lastTimeMs);
    assert.equal(stats.latestFinishedAtMs, summary.lastFinishedAtMs);
    assert.equal(stats.validAttemptCount, summary.rankedAttemptCount);
    assert.equal(officialTimeMs(attempts[1]!), 11 * 60_000);
    assert.equal(attempts[1]?.startedAtMs, AS_OF - 2 * DAY - 11 * 60_000);
    assert.equal(attempts[1]?.finishedAtMs, AS_OF - 2 * DAY);
  });

  it('loadJourney uses injected now() as asOfMs and leaves official attempt times unchanged', async () => {
    const { workspace, attempts, places } = createMemoryWorkspace({ now: () => AS_OF });
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    const attempt = timedAttempt('pb', 12 * 60_000, AS_OF - DAY);
    await attempts.saveAttempt(attempt);
    const loaded = await workspace.loadJourney(POOL);
    assert.ok(loaded);
    assert.equal(loaded.statistics.asOfMs, AS_OF);
    assert.equal(loaded.statistics.validAttemptCount, 1);
    assert.equal(loaded.statistics.pbTimeMs, 12 * 60_000);
    assert.equal(loaded.statistics.bestLast7DaysMs, 12 * 60_000);
    assert.ok(Array.isArray(loaded.pathVariants));
    const stored = await attempts.getAttempt('pb');
    assert.equal(stored?.startedAtMs, attempt.startedAtMs);
    assert.equal(stored?.finishedAtMs, attempt.finishedAtMs);
    assert.equal(officialTimeMs(stored!), 12 * 60_000);
  });

  it('keeps the statistics dashboard on journey detail/history and off the active-run screen', () => {
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    const history = readFileSync('src/ui/HistoryScreen.tsx', 'utf8');
    const active = readFileSync('src/ui/AttemptScreen.tsx', 'utf8');
    assert.match(detail, /JourneyStatisticsDashboard/);
    assert.match(detail, /PATH VARIANTS/);
    assert.match(detail, /pathVariants/);
    assert.match(history, /JourneyStatisticsDashboard/);
    assert.match(history, /groupFilter/);
    assert.doesNotMatch(active, /JourneyStatisticsDashboard|Std\. deviation|Best \(7 days\)/);
  });
});
