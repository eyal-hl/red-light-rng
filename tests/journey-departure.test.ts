import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { officialTimeMs, type Attempt } from '../src/domain/attempt';
import {
  attachAttemptLocalStart,
  attemptDepartureWallClock,
  localWallClockFromOffset,
} from '../src/domain/attempt-local-time';
import {
  computeJourneyDepartureGrouping,
  computeJourneyPoolDepartureGrouping,
  hourBucketLabel,
  MIN_COMPARATIVE_GROUP_ATTEMPTS,
  WEEKDAY_LABELS,
} from '../src/domain/journey-departure';
import { summarizeJourneyPool, type JourneyAttemptTrace } from '../src/domain/journey-analysis';
import {
  bestCompetitiveAttempt,
  computeJourneyStatistics,
  officialTimesMeanMs,
  officialTimesMedianMs,
} from '../src/domain/journey-statistics';
import { makePlace } from './helpers/places';
import { attemptIdentity, capturedLocalStart, EMPTY_ATTEMPT_LOCAL_START } from './helpers/attempts';
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

const OFFSET = 180;
const AS_OF = Date.UTC(2026, 8, 14, 18, 0, 0);

function utcFromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
}

function withTimeZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

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

function departedAttempt(
  id: string,
  officialMs: number,
  localStart: { day: number; hour: number; minute: number; second?: number },
  extra: Partial<Attempt> = {},
): Attempt {
  const startedAtMs = utcFromLocal(
    2026,
    9,
    localStart.day,
    localStart.hour,
    localStart.minute,
    localStart.second ?? 0,
    OFFSET,
  );
  return completedAttempt(id, {
    startedAtMs,
    finishedAtMs: startedAtMs + officialMs,
    armedAtMs: startedAtMs - 60_000,
    ...capturedLocalStart(OFFSET, 'Asia/Jerusalem'),
    ...extra,
  });
}

function tracesFor(attempts: Attempt[]): JourneyAttemptTrace[] {
  return attempts.map((attempt) => ({ attempt, samples: [] }));
}

describe('journey departure grouping', { concurrency: 1 }, () => {
  it('does not use live device hours, days, or Date.now as the grouping contract', () => {
    const localTime = readFileSync('src/domain/attempt-local-time.ts', 'utf8');
    const grouping = readFileSync('src/domain/journey-departure.ts', 'utf8');
    const combined = `${localTime}\n${grouping}`;
    assert.doesNotMatch(combined, /Date\.now\s*\(/);
    assert.doesNotMatch(combined, /\.getHours\s*\(/);
    assert.doesNotMatch(combined, /\.getDay\s*\(/);
    assert.match(grouping, /officialTimesMeanMs/);
    assert.match(grouping, /officialTimesMedianMs/);
    assert.match(grouping, /bestCompetitiveAttempt/);
    assert.match(grouping, /isJourneyCompetitive/);
    assert.match(grouping, /attemptDepartureWallClock/);
  });

  it('keys weekday and hour buckets from official startedAtMs local wall-clock', () => {
    const monday = departedAttempt('mon', 12 * 60_000, { day: 14, hour: 8, minute: 5 });
    const clock = attemptDepartureWallClock(monday);
    assert.ok(clock);
    assert.equal(clock.weekday, 1);
    assert.equal(clock.hourBucket, 8);
    assert.equal(WEEKDAY_LABELS[clock.weekday], 'Monday');
    const grouping = computeJourneyDepartureGrouping([monday], AS_OF);
    assert.equal(grouping.weekdayGroups[0]?.label, 'Monday');
    assert.equal(grouping.hourGroups[0]?.label, hourBucketLabel(8));
    assert.equal(grouping.hourGroups[0]?.hourBucket, 8);
  });

  it('places hourly bucket boundaries from official startedAtMs minutes since midnight', () => {
    const before = departedAttempt('before', 10 * 60_000, { day: 14, hour: 7, minute: 59, second: 59 });
    const onHour = departedAttempt('on-hour', 10 * 60_000, { day: 14, hour: 8, minute: 0, second: 0 });
    const grouping = computeJourneyDepartureGrouping([before, onHour], AS_OF);
    const seven = grouping.hourGroups.find((group) => group.hourBucket === 7);
    const eight = grouping.hourGroups.find((group) => group.hourBucket === 8);
    assert.deepEqual(seven?.attemptIds, ['before']);
    assert.deepEqual(eight?.attemptIds, ['on-hour']);
    const beforeClock = localWallClockFromOffset(before.startedAtMs!, OFFSET);
    assert.ok(beforeClock.minutesSinceMidnight < 8 * 60);
    assert.ok(beforeClock.minutesSinceMidnight >= 7 * 60);
  });

  it('groups by start, not arm, when armed in the previous hour', () => {
    const startedAtMs = utcFromLocal(2026, 9, 14, 8, 5, 0, OFFSET);
    const attempt = departedAttempt('late-arm', 25 * 60_000, { day: 14, hour: 8, minute: 5 }, {
      armedAtMs: utcFromLocal(2026, 9, 14, 7, 50, 0, OFFSET),
      finishedAtMs: utcFromLocal(2026, 9, 14, 8, 30, 0, OFFSET),
    });
    const grouping = computeJourneyDepartureGrouping([attempt], AS_OF);
    assert.equal(attempt.armedAtMs, utcFromLocal(2026, 9, 14, 7, 50, 0, OFFSET));
    assert.equal(attempt.startedAtMs, startedAtMs);
    assert.equal(grouping.hourGroups[0]?.hourBucket, 8);
    assert.equal(grouping.weekdayGroups[0]?.label, 'Monday');
    assert.equal(grouping.hourGroups.some((group) => group.hourBucket === 7), false);
  });

  it('groups by start, not finish, when the commute crosses an hour', () => {
    const attempt = departedAttempt('late-start', 25 * 60_000, { day: 14, hour: 8, minute: 50 }, {
      finishedAtMs: utcFromLocal(2026, 9, 14, 9, 15, 0, OFFSET),
    });
    const grouping = computeJourneyDepartureGrouping([attempt], AS_OF);
    assert.equal(grouping.hourGroups[0]?.hourBucket, 8);
    assert.equal(grouping.hourGroups.some((group) => group.hourBucket === 9), false);
  });

  it('follows start weekday and hour for a midnight-crossing attempt', () => {
    const attempt = departedAttempt('overnight', 25 * 60_000, { day: 14, hour: 23, minute: 50 }, {
      finishedAtMs: utcFromLocal(2026, 9, 15, 0, 15, 0, OFFSET),
    });
    const grouping = computeJourneyDepartureGrouping([attempt], AS_OF);
    assert.equal(grouping.weekdayGroups[0]?.label, 'Monday');
    assert.equal(grouping.weekdayGroups.some((group) => group.label === 'Tuesday'), false);
    assert.equal(grouping.hourGroups[0]?.hourBucket, 23);
    assert.equal(grouping.hourGroups.some((group) => group.hourBucket === 0), false);
  });

  it('keeps stored start-time offset grouping after the device timezone changes', () => {
    const attempt = departedAttempt('stable', 12 * 60_000, { day: 14, hour: 8, minute: 5 });
    const jerusalem = withTimeZone('Asia/Jerusalem', () => computeJourneyDepartureGrouping([attempt], AS_OF));
    const newYork = withTimeZone('America/New_York', () => computeJourneyDepartureGrouping([attempt], AS_OF));
    const utc = withTimeZone('UTC', () => computeJourneyDepartureGrouping([attempt], AS_OF));
    assert.deepEqual(jerusalem, newYork);
    assert.deepEqual(jerusalem, utc);
    assert.equal(jerusalem.hourGroups[0]?.hourBucket, 8);
    const liveNewYorkHour = withTimeZone('America/New_York', () => new Date(attempt.startedAtMs!).getHours());
    assert.notEqual(liveNewYorkHour, 8);
  });

  it('does not regroup a DST-offset fixture when later timezone rules would reinterpret the epoch', () => {
    const summerStart = utcFromLocal(2026, 7, 14, 8, 0, 0, 180);
    const attempt = completedAttempt('dst', {
      startedAtMs: summerStart,
      finishedAtMs: summerStart + 12 * 60_000,
      armedAtMs: summerStart - 60_000,
      ...capturedLocalStart(180, 'Asia/Jerusalem'),
    });
    const grouping = withTimeZone('America/New_York', () => computeJourneyDepartureGrouping([attempt], AS_OF));
    const liveNewYorkHour = withTimeZone('America/New_York', () => new Date(summerStart).getHours());
    const liveNewYorkOffset = withTimeZone('America/New_York', () => -new Date(summerStart).getTimezoneOffset());
    assert.equal(attempt.startedUtcOffsetMinutes, 180);
    assert.equal(grouping.hourGroups[0]?.hourBucket, 8);
    assert.notEqual(liveNewYorkOffset, 180);
    assert.notEqual(liveNewYorkHour, 8);
  });

  it('uses reconstructed historical metadata without live-timezone reinterpretation', () => {
    const startedAtMs = utcFromLocal(2026, 9, 14, 8, 5, 0, OFFSET);
    const historical = completedAttempt('old', {
      startedAtMs,
      finishedAtMs: startedAtMs + 12 * 60_000,
      startedUtcOffsetMinutes: OFFSET,
      startedTimezoneId: 'Asia/Jerusalem',
      startedLocalTimeSource: 'reconstructed',
    });
    const first = computeJourneyDepartureGrouping([historical], AS_OF);
    const second = withTimeZone('America/New_York', () => computeJourneyDepartureGrouping([historical], AS_OF));
    assert.deepEqual(first, second);
    assert.equal(first.reconstructedAttemptCount, 1);
    assert.equal(first.hourGroups[0]?.hourBucket, 8);
    assert.equal(first.weekdayGroups[0]?.reconstructedAttemptCount, 1);
  });

  it('skips attempts that still lack persisted start offsets instead of using the current timezone', () => {
    const startedAtMs = utcFromLocal(2026, 9, 14, 8, 5, 0, OFFSET);
    const missing = completedAttempt('missing-offset', {
      startedAtMs,
      finishedAtMs: startedAtMs + 12 * 60_000,
      ...EMPTY_ATTEMPT_LOCAL_START,
    });
    const grouping = withTimeZone('America/New_York', () => computeJourneyDepartureGrouping([missing], AS_OF));
    assert.equal(grouping.groupedAttemptCount, 0);
    assert.equal(grouping.hourGroups.length, 0);
    assert.equal(grouping.overallPbAttemptId, 'missing-offset');
  });

  it('labels sparse groups honestly and never invents a best time to leave', () => {
    const mondayA = departedAttempt('mon-a', 12 * 60_000, { day: 14, hour: 8, minute: 0 });
    const mondayB = departedAttempt('mon-b', 13 * 60_000, { day: 21, hour: 8, minute: 0 });
    const mondayC = departedAttempt('mon-c', 11 * 60_000, { day: 28, hour: 8, minute: 0 });
    const tuesday = departedAttempt('tue', 20 * 60_000, { day: 15, hour: 8, minute: 0 });
    const grouping = computeJourneyDepartureGrouping([mondayA, mondayB, mondayC, tuesday], AS_OF);
    const monday = grouping.weekdayGroups.find((group) => group.label === 'Monday');
    const tue = grouping.weekdayGroups.find((group) => group.label === 'Tuesday');
    assert.equal(monday?.validAttemptCount, 3);
    assert.equal(monday?.isSparse, false);
    assert.equal(tue?.validAttemptCount, 1);
    assert.equal(tue?.isSparse, true);
    assert.equal(tue?.meanOfficialTimeMs, null);
    assert.equal(tue?.medianOfficialTimeMs, null);
    assert.equal(tue?.bestOfficialTimeMs, 20 * 60_000);
    assert.ok(tue.validAttemptCount < MIN_COMPARATIVE_GROUP_ATTEMPTS);
    const ui = `${readFileSync('src/ui/JourneyStatisticsDashboard.tsx', 'utf8')}\n${readFileSync('src/domain/journey-departure.ts', 'utf8')}`;
    assert.doesNotMatch(ui, /best time to leave/i);
    assert.match(ui, /Too few attempts to treat as a trend/);
    assert.match(ui, /Best in this group/);
  });

  it('keeps opposite directions and transportation modes in separate groups', () => {
    const outbound = departedAttempt('out', 12 * 60_000, { day: 14, hour: 8, minute: 0 });
    const inbound = departedAttempt('back', 9 * 60_000, { day: 14, hour: 8, minute: 0 }, {
      originPlaceId: WORK.id,
      destinationPlaceId: HOME.id,
    });
    const walk = departedAttempt('walk', 40 * 60_000, { day: 14, hour: 8, minute: 0 }, {
      transportationMode: 'walk',
    });
    const grouping = computeJourneyPoolDepartureGrouping(POOL, tracesFor([outbound, inbound, walk]), AS_OF);
    assert.equal(grouping.groupedAttemptCount, 1);
    assert.equal(grouping.weekdayGroups[0]?.attemptIds[0], 'out');
    assert.equal(grouping.overallPbAttemptId, 'out');
  });

  it('keeps path variants in the same default journey population', () => {
    const park = departedAttempt('park', 12 * 60_000, { day: 14, hour: 8, minute: 0 }, { routeId: 'route-park' });
    const unmatched = departedAttempt('main', 13 * 60_000, { day: 14, hour: 8, minute: 10 }, { routeId: null });
    const grouping = computeJourneyPoolDepartureGrouping(POOL, tracesFor([park, unmatched]), AS_OF);
    assert.equal(grouping.groupedAttemptCount, 2);
    assert.equal(grouping.hourGroups[0]?.validAttemptCount, 2);
  });

  it('excludes non-competitive attempts from grouped stats', () => {
    const valid = departedAttempt('valid', 12 * 60_000, { day: 14, hour: 8, minute: 0 });
    const cancelled = departedAttempt('cancelled', 8 * 60_000, { day: 14, hour: 8, minute: 0 }, {
      lifecycle: 'cancelled',
      validity: 'unranked',
    });
    const unranked = departedAttempt('unranked', 8 * 60_000, { day: 14, hour: 8, minute: 0 }, {
      validity: 'unranked',
    });
    const gym = departedAttempt('gym', 8 * 60_000, { day: 14, hour: 8, minute: 0 }, {
      destinationPlaceId: GYM.id,
    });
    const grouping = computeJourneyPoolDepartureGrouping(
      POOL,
      tracesFor([valid, cancelled, unranked, gym]),
      AS_OF,
    );
    assert.equal(grouping.groupedAttemptCount, 1);
    assert.equal(grouping.overallPbAttemptId, 'valid');
  });

  it('reuses #33 mean, median, and best math for subgroup metrics', () => {
    const attempts = [
      departedAttempt('a', 10_000, { day: 14, hour: 8, minute: 0 }),
      departedAttempt('b', 20_000, { day: 21, hour: 8, minute: 0 }),
      departedAttempt('c', 90_000, { day: 28, hour: 8, minute: 0 }),
    ];
    const grouping = computeJourneyDepartureGrouping(attempts, AS_OF);
    const monday = grouping.weekdayGroups[0]!;
    const times = attempts.map((attempt) => officialTimeMs(attempt)!);
    assert.equal(monday.meanOfficialTimeMs, officialTimesMeanMs(times));
    assert.equal(monday.medianOfficialTimeMs, officialTimesMedianMs(times));
    assert.equal(monday.bestAttemptId, bestCompetitiveAttempt(attempts)?.id);
    assert.equal(monday.bestOfficialTimeMs, 10_000);
    assert.equal(monday.meanOfficialTimeMs, 40_000);
    assert.equal(monday.medianOfficialTimeMs, 20_000);
  });

  it('does not promote a subgroup best to the journey PB', () => {
    const tuesdayBest = departedAttempt('tue-fast', 9 * 60_000, { day: 15, hour: 8, minute: 0 });
    const mondayPb = departedAttempt('mon-pb', 8 * 60_000, { day: 14, hour: 9, minute: 0 });
    const mondaySlow = departedAttempt('mon-slow', 14 * 60_000, { day: 21, hour: 9, minute: 0 });
    const grouping = computeJourneyDepartureGrouping([tuesdayBest, mondayPb, mondaySlow], AS_OF);
    const overall = computeJourneyStatistics([tuesdayBest, mondayPb, mondaySlow], AS_OF);
    const summary = summarizeJourneyPool(POOL, HOME, WORK, tracesFor([tuesdayBest, mondayPb, mondaySlow]));
    const tuesday = grouping.weekdayGroups.find((group) => group.label === 'Tuesday');
    const monday = grouping.weekdayGroups.find((group) => group.label === 'Monday');
    assert.equal(grouping.overallPbAttemptId, 'mon-pb');
    assert.equal(grouping.overallPbTimeMs, 8 * 60_000);
    assert.equal(overall.pbAttemptId, grouping.overallPbAttemptId);
    assert.equal(summary.pbAttemptId, grouping.overallPbAttemptId);
    assert.equal(tuesday?.bestAttemptId, 'tue-fast');
    assert.equal(monday?.bestAttemptId, 'mon-pb');
    assert.notEqual(tuesday?.bestAttemptId, grouping.overallPbAttemptId);
  });

  it('reproduces identical grouping after reload for the same attempts', () => {
    const attempts = [
      departedAttempt('a', 12 * 60_000, { day: 14, hour: 8, minute: 0 }),
      departedAttempt('b', 11 * 60_000, { day: 15, hour: 9, minute: 0 }),
    ];
    const first = computeJourneyDepartureGrouping(attempts, AS_OF);
    const second = computeJourneyDepartureGrouping(
      attempts.map((attempt) => ({ ...attempt })),
      AS_OF,
    );
    assert.deepEqual(first, second);
  });

  it('captures local start metadata at official start and preserves it through finish', () => {
    withTimeZone('Asia/Jerusalem', () => {
      const previous: Attempt = completedAttempt('live', {
        lifecycle: 'armed',
        validity: 'pending',
        startedAtMs: null,
        finishedAtMs: null,
        ...EMPTY_ATTEMPT_LOCAL_START,
      });
      const startedAtMs = utcFromLocal(2026, 9, 14, 8, 5, 0, OFFSET);
      const started = attachAttemptLocalStart(previous, {
        ...previous,
        lifecycle: 'active',
        startedAtMs,
      });
      assert.equal(started.startedLocalTimeSource, 'captured');
      assert.equal(started.startedUtcOffsetMinutes, OFFSET);
      assert.equal(started.startedTimezoneId, 'Asia/Jerusalem');
      const finished = attachAttemptLocalStart(started, {
        ...started,
        lifecycle: 'completed',
        validity: 'valid',
        finishedAtMs: startedAtMs + 12 * 60_000,
      });
      assert.equal(finished.startedUtcOffsetMinutes, started.startedUtcOffsetMinutes);
      assert.equal(finished.startedLocalTimeSource, 'captured');
      const reset = attachAttemptLocalStart(started, { ...started, startedAtMs: null });
      assert.equal(reset.startedUtcOffsetMinutes, null);
    });
  });

  it('loadJourney returns grouping that survives a stored-offset timezone change', async () => {
    const { workspace, attempts, places } = createMemoryWorkspace({ now: () => AS_OF });
    await places.createPlace(HOME);
    await places.createPlace(WORK);
    const attempt = departedAttempt('pb', 12 * 60_000, { day: 14, hour: 8, minute: 5 });
    await attempts.saveAttempt(attempt);
    const result = await workspace.loadJourney(POOL);
    assert.ok(result);
    assert.equal(result.departureGrouping.hourGroups[0]?.hourBucket, 8);
    assert.equal(result.departureGrouping.weekdayGroups[0]?.label, 'Monday');
    assert.equal(result.statistics.pbTimeMs, 12 * 60_000);
    assert.equal(result.departureGrouping.overallPbTimeMs, result.statistics.pbTimeMs);
    const stored = await attempts.getAttempt('pb');
    assert.equal(stored?.startedUtcOffsetMinutes, OFFSET);
  });

  it('keeps weekday and time-of-day views on journey stats surfaces, not the active-run screen', () => {
    const dashboard = readFileSync('src/ui/JourneyStatisticsDashboard.tsx', 'utf8');
    const detail = readFileSync('src/ui/JourneyDetailScreen.tsx', 'utf8');
    const history = readFileSync('src/ui/HistoryScreen.tsx', 'utf8');
    const active = readFileSync('src/ui/AttemptScreen.tsx', 'utf8');
    assert.match(dashboard, /Weekday/);
    assert.match(dashboard, /Time of day/);
    assert.match(dashboard, /Best in this group/);
    assert.doesNotMatch(dashboard, /\bisPb\b/);
    assert.match(detail, /grouping/);
    assert.match(history, /groupFilter/);
    assert.doesNotMatch(active, /Weekday|Time of day|Best in this group/);
  });
});
