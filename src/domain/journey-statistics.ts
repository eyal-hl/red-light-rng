import { isJourneyCompetitive, officialTimeMs, type Attempt } from './attempt';
import { filterTracesForJourney, type JourneyAttemptTrace } from './journey-analysis';
import type { JourneyPoolId } from './journey';

export const MILLISECONDS_PER_DAY = 86_400_000;
export const RECENT_TREND_LIMIT = 10;
export const ROLLING_WINDOW_7_DAYS = 7;
export const ROLLING_WINDOW_30_DAYS = 30;

export type JourneyTrendPoint = {
  attemptId: string;
  officialTimeMs: number;
  finishedAtMs: number;
};

export type JourneyPoolStatistics = {
  asOfMs: number;
  validAttemptCount: number;
  pbAttemptId: string | null;
  pbTimeMs: number | null;
  pbFinishedAtMs: number | null;
  latestAttemptId: string | null;
  latestTimeMs: number | null;
  latestFinishedAtMs: number | null;
  meanOfficialTimeMs: number | null;
  medianOfficialTimeMs: number | null;
  sampleStandardDeviationMs: number | null;
  recentTrendPoints: JourneyTrendPoint[] | null;
  recentTrendDeltaMs: number | null;
  bestLast7DaysMs: number | null;
  bestLast7DaysAttemptId: string | null;
  bestLast30DaysMs: number | null;
  bestLast30DaysAttemptId: string | null;
};

function competitiveTime(attempt: Attempt): number {
  return officialTimeMs(attempt) ?? Number.MAX_SAFE_INTEGER;
}

function compareCompetitiveRank(a: Attempt, b: Attempt): number {
  const aTime = competitiveTime(a);
  const bTime = competitiveTime(b);
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  const aStarted = a.startedAtMs ?? a.armedAtMs;
  const bStarted = b.startedAtMs ?? b.armedAtMs;
  if (aStarted !== bStarted) {
    return aStarted - bStarted;
  }
  if (a.armedAtMs !== b.armedAtMs) {
    return a.armedAtMs - b.armedAtMs;
  }
  return a.id.localeCompare(b.id);
}

function compareFinishedAtNewestFirst(a: Attempt, b: Attempt): number {
  const aFinished = a.finishedAtMs ?? 0;
  const bFinished = b.finishedAtMs ?? 0;
  if (aFinished !== bFinished) {
    return bFinished - aFinished;
  }
  if (a.armedAtMs !== b.armedAtMs) {
    return b.armedAtMs - a.armedAtMs;
  }
  return b.id.localeCompare(a.id);
}

export function isInRollingElapsedWindow(
  finishedAtMs: number,
  asOfMs: number,
  dayCount: number,
): boolean {
  const windowStartMs = asOfMs - dayCount * MILLISECONDS_PER_DAY;
  return finishedAtMs >= windowStartMs && finishedAtMs <= asOfMs;
}

function meanOf(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function medianOf(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sampleStandardDeviationOf(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sumSquares = values.reduce((sum, value) => {
    const delta = value - mean;
    return sum + delta * delta;
  }, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

function bestInRollingWindow(
  attempts: Attempt[],
  asOfMs: number,
  dayCount: number,
): { attemptId: string; officialTimeMs: number } | null {
  const members = attempts.filter((attempt) => {
    if (attempt.finishedAtMs == null) {
      return false;
    }
    return isInRollingElapsedWindow(attempt.finishedAtMs, asOfMs, dayCount);
  });
  if (members.length === 0) {
    return null;
  }
  const best = [...members].sort(compareCompetitiveRank)[0]!;
  const time = officialTimeMs(best);
  if (time == null) {
    return null;
  }
  return { attemptId: best.id, officialTimeMs: time };
}

function emptyStatistics(asOfMs: number): JourneyPoolStatistics {
  return {
    asOfMs,
    validAttemptCount: 0,
    pbAttemptId: null,
    pbTimeMs: null,
    pbFinishedAtMs: null,
    latestAttemptId: null,
    latestTimeMs: null,
    latestFinishedAtMs: null,
    meanOfficialTimeMs: null,
    medianOfficialTimeMs: null,
    sampleStandardDeviationMs: null,
    recentTrendPoints: null,
    recentTrendDeltaMs: null,
    bestLast7DaysMs: null,
    bestLast7DaysAttemptId: null,
    bestLast30DaysMs: null,
    bestLast30DaysAttemptId: null,
  };
}

export function computeJourneyStatistics(
  attempts: readonly Attempt[],
  asOfMs: number,
): JourneyPoolStatistics {
  const competitive = attempts.filter(isJourneyCompetitive);
  if (competitive.length === 0) {
    return emptyStatistics(asOfMs);
  }

  const ranked = [...competitive].sort(compareCompetitiveRank);
  const chronological = [...competitive].sort(compareFinishedAtNewestFirst);
  const pb = ranked[0]!;
  const latest = chronological[0]!;
  const officialTimes = competitive.map((attempt) => officialTimeMs(attempt)!);
  const recentNewestFirst = chronological.slice(0, RECENT_TREND_LIMIT);
  const recentOldestFirst = [...recentNewestFirst].reverse();
  const showDistribution = competitive.length >= 2;
  const showTrend = recentOldestFirst.length >= 2;
  const recentTrendPoints = showTrend
    ? recentOldestFirst.map((attempt) => ({
        attemptId: attempt.id,
        officialTimeMs: officialTimeMs(attempt)!,
        finishedAtMs: attempt.finishedAtMs!,
      }))
    : null;
  const oldestRecent = recentTrendPoints?.[0] ?? null;
  const newestRecent = recentTrendPoints?.[recentTrendPoints.length - 1] ?? null;
  const best7 = bestInRollingWindow(competitive, asOfMs, ROLLING_WINDOW_7_DAYS);
  const best30 = bestInRollingWindow(competitive, asOfMs, ROLLING_WINDOW_30_DAYS);

  return {
    asOfMs,
    validAttemptCount: competitive.length,
    pbAttemptId: pb.id,
    pbTimeMs: officialTimeMs(pb),
    pbFinishedAtMs: pb.finishedAtMs,
    latestAttemptId: latest.id,
    latestTimeMs: officialTimeMs(latest),
    latestFinishedAtMs: latest.finishedAtMs,
    meanOfficialTimeMs: showDistribution ? meanOf(officialTimes) : null,
    medianOfficialTimeMs: showDistribution ? medianOf(officialTimes) : null,
    sampleStandardDeviationMs: showDistribution ? sampleStandardDeviationOf(officialTimes) : null,
    recentTrendPoints,
    recentTrendDeltaMs:
      showTrend && oldestRecent && newestRecent
        ? newestRecent.officialTimeMs - oldestRecent.officialTimeMs
        : null,
    bestLast7DaysMs: best7?.officialTimeMs ?? null,
    bestLast7DaysAttemptId: best7?.attemptId ?? null,
    bestLast30DaysMs: best30?.officialTimeMs ?? null,
    bestLast30DaysAttemptId: best30?.attemptId ?? null,
  };
}

export function computeJourneyPoolStatistics(
  pool: JourneyPoolId,
  traces: readonly JourneyAttemptTrace[],
  asOfMs: number,
): JourneyPoolStatistics {
  const competitive = filterTracesForJourney([...traces], pool)
    .map((trace) => trace.attempt)
    .filter(isJourneyCompetitive);
  return computeJourneyStatistics(competitive, asOfMs);
}
