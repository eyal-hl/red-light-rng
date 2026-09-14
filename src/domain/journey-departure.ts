import { isJourneyCompetitive, officialTimeMs, type Attempt } from './attempt';
import { attemptDepartureWallClock } from './attempt-local-time';
import { filterTracesForJourney, type JourneyAttemptTrace } from './journey-analysis';
import type { JourneyPoolId } from './journey';
import {
  bestCompetitiveAttempt,
  computeJourneyStatistics,
  officialTimesMeanMs,
  officialTimesMedianMs,
} from './journey-statistics';

export const MIN_COMPARATIVE_GROUP_ATTEMPTS = 3;

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type JourneyDepartureGroup = {
  key: string;
  label: string;
  weekday: number | null;
  hourBucket: number | null;
  attemptIds: string[];
  validAttemptCount: number;
  meanOfficialTimeMs: number | null;
  medianOfficialTimeMs: number | null;
  bestOfficialTimeMs: number | null;
  bestAttemptId: string | null;
  isSparse: boolean;
  reconstructedAttemptCount: number;
};

export type JourneyDepartureGrouping = {
  weekdayGroups: JourneyDepartureGroup[];
  hourGroups: JourneyDepartureGroup[];
  overallPbAttemptId: string | null;
  overallPbTimeMs: number | null;
  groupedAttemptCount: number;
  reconstructedAttemptCount: number;
};

export function emptyDepartureGrouping(): JourneyDepartureGrouping {
  return {
    weekdayGroups: [],
    hourGroups: [],
    overallPbAttemptId: null,
    overallPbTimeMs: null,
    groupedAttemptCount: 0,
    reconstructedAttemptCount: 0,
  };
}

export function hourBucketLabel(hourBucket: number): string {
  const start = `${String(hourBucket).padStart(2, '0')}:00`;
  const endHour = hourBucket;
  const end = `${String(endHour).padStart(2, '0')}:59`;
  return `${start}–${end}`;
}

function groupFromMembers(
  key: string,
  label: string,
  members: Attempt[],
  weekday: number | null,
  hourBucket: number | null,
): JourneyDepartureGroup {
  const times = members.map((attempt) => officialTimeMs(attempt)!);
  const best = bestCompetitiveAttempt(members);
  return {
    key,
    label,
    weekday,
    hourBucket,
    attemptIds: members.map((attempt) => attempt.id),
    validAttemptCount: members.length,
    meanOfficialTimeMs: officialTimesMeanMs(times),
    medianOfficialTimeMs: officialTimesMedianMs(times),
    bestOfficialTimeMs: best ? officialTimeMs(best) : null,
    bestAttemptId: best?.id ?? null,
    isSparse: members.length < MIN_COMPARATIVE_GROUP_ATTEMPTS,
    reconstructedAttemptCount: members.filter((attempt) => attempt.startedLocalTimeSource === 'reconstructed').length,
  };
}

function membersByWeekday(attempts: Attempt[]): Map<number, Attempt[]> {
  const buckets = new Map<number, Attempt[]>();
  for (const attempt of attempts) {
    const clock = attemptDepartureWallClock(attempt);
    if (!clock) {
      continue;
    }
    const existing = buckets.get(clock.weekday) ?? [];
    existing.push(attempt);
    buckets.set(clock.weekday, existing);
  }
  return buckets;
}

function membersByHour(attempts: Attempt[]): Map<number, Attempt[]> {
  const buckets = new Map<number, Attempt[]>();
  for (const attempt of attempts) {
    const clock = attemptDepartureWallClock(attempt);
    if (!clock) {
      continue;
    }
    const existing = buckets.get(clock.hourBucket) ?? [];
    existing.push(attempt);
    buckets.set(clock.hourBucket, existing);
  }
  return buckets;
}

export function computeJourneyDepartureGrouping(
  attempts: readonly Attempt[],
  asOfMs: number,
): JourneyDepartureGrouping {
  const competitive = attempts.filter(isJourneyCompetitive);
  const overall = computeJourneyStatistics(competitive, asOfMs);
  const grouped = competitive.filter((attempt) => attemptDepartureWallClock(attempt) != null);
  const weekdayBuckets = membersByWeekday(grouped);
  const hourBuckets = membersByHour(grouped);
  return {
    weekdayGroups: WEEKDAY_ORDER.filter((weekday) => weekdayBuckets.has(weekday)).map((weekday) =>
      groupFromMembers(
        `weekday-${weekday}`,
        WEEKDAY_LABELS[weekday]!,
        weekdayBuckets.get(weekday)!,
        weekday,
        null,
      ),
    ),
    hourGroups: [...hourBuckets.keys()]
      .sort((left, right) => left - right)
      .map((hour) =>
        groupFromMembers(`hour-${hour}`, hourBucketLabel(hour), hourBuckets.get(hour)!, null, hour),
      ),
    overallPbAttemptId: overall.pbAttemptId,
    overallPbTimeMs: overall.pbTimeMs,
    groupedAttemptCount: grouped.length,
    reconstructedAttemptCount: grouped.filter((attempt) => attempt.startedLocalTimeSource === 'reconstructed').length,
  };
}

export function computeJourneyPoolDepartureGrouping(
  pool: JourneyPoolId,
  traces: readonly JourneyAttemptTrace[],
  asOfMs: number,
): JourneyDepartureGrouping {
  const competitive = filterTracesForJourney([...traces], pool).map((trace) => trace.attempt);
  return computeJourneyDepartureGrouping(competitive, asOfMs);
}
