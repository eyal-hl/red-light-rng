import { attemptDepartureWallClock } from './attempt-local-time';
import type { Attempt } from './attempt';
import type { CompetitiveCheckpointConfig } from './competitive-checkpoint';
import { officialTimesMedianMs } from './journey-statistics';
import {
  expectedFullSegmentPairs,
  isSegmentResultStale,
  segmentKey,
  type AttemptSegmentResult,
} from './segment-derivation';

/**
 * Segment leaderboards (DEC-016): per endpoint pair, the eligible VALID derived results for the
 * CURRENT checkpoint configuration, ranked with the same semantics as the full-route board
 * (fastest first; ties broken by earlier start, earlier arming, then id; ordinal rank; median needs
 * at least two samples). Full-route attempts and partial attempts that started at or before the
 * segment's start rank together on the same board. Pure; the official full-route board is a separate,
 * unchanged code path.
 */

export type SegmentBoardFilter = {
  /** 0 = Sunday .. 6 = Saturday; matches the full-route weekday groups (attempt departure wall clock). */
  weekday?: number | null;
  /** Departure hour 0-23, same buckets as the full-route time-of-day groups. */
  hourBucket?: number | null;
};

export type SegmentBoardSort = 'ranked' | 'chronological';

export type SegmentBoardEntry = {
  attemptId: string;
  resultId: string;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  attemptKind: 'full' | 'partial';
  /** 1-based ordinal rank within the (filtered) board. */
  rank: number;
  isPb: boolean;
  /** Equal duration to the PB (a tie), whatever the tie-break order. */
  tiedWithPb: boolean;
};

export type SegmentBoard = {
  key: string;
  fromCheckpointId: string | null;
  toCheckpointId: string | null;
  fromName: string;
  toName: string;
  /** Eligible valid results after filters. */
  validCount: number;
  pb: SegmentBoardEntry | null;
  medianMs: number | null;
  /** Ordered by `sort`; ranks are always by time. */
  entries: SegmentBoardEntry[];
};

export type BuildSegmentBoardsInput = {
  config: CompetitiveCheckpointConfig;
  originName: string;
  destinationName: string;
  results: readonly AttemptSegmentResult[];
  attempts: readonly Attempt[];
  filter?: SegmentBoardFilter;
  sort?: SegmentBoardSort;
};

function matchesFilter(attempt: Attempt, filter: SegmentBoardFilter | undefined): boolean {
  if (!filter || (filter.weekday == null && filter.hourBucket == null)) {
    return true;
  }
  const clock = attemptDepartureWallClock(attempt);
  if (!clock) {
    return false;
  }
  if (filter.weekday != null && clock.weekday !== filter.weekday) {
    return false;
  }
  if (filter.hourBucket != null && clock.hourBucket !== filter.hourBucket) {
    return false;
  }
  return true;
}

/** Only completed, valid, un-hidden attempts compete; results of stale versions never do. */
function eligibleAttempt(attempt: Attempt | undefined): attempt is Attempt {
  return (
    attempt != null &&
    attempt.lifecycle === 'completed' &&
    attempt.validity === 'valid' &&
    attempt.hiddenIncomplete !== true
  );
}

export function buildSegmentBoards(input: BuildSegmentBoardsInput): SegmentBoard[] {
  const { config } = input;
  const attemptsById = new Map(input.attempts.map((attempt) => [attempt.id, attempt]));
  const checkpointName = (id: string | null, fallback: string): string =>
    id == null ? fallback : (config.checkpoints.find((item) => item.id === id)?.name ?? id);
  const ids = config.checkpoints.map((checkpoint) => checkpoint.id);
  // Fixed selector order: every possible pair of a full ride. Partial-only pairs are a subset.
  const pairs = expectedFullSegmentPairs(ids);

  return pairs.map(({ from, to }) => {
    const key = segmentKey(from, to);
    const candidates = input.results
      .filter(
        (result) =>
          result.status === 'valid' &&
          result.durationMs != null &&
          result.startedAtMs != null &&
          result.endedAtMs != null &&
          segmentKey(result.fromCheckpointId, result.toCheckpointId) === key &&
          !isSegmentResultStale(result, config.version),
      )
      .map((result) => ({ result, attempt: attemptsById.get(result.attemptId) }))
      .filter(
        (item): item is { result: AttemptSegmentResult; attempt: Attempt } =>
          eligibleAttempt(item.attempt) && matchesFilter(item.attempt, input.filter),
      );
    candidates.sort((a, b) => {
      if (a.result.durationMs !== b.result.durationMs) {
        return a.result.durationMs! - b.result.durationMs!;
      }
      const aStarted = a.attempt.startedAtMs ?? a.attempt.armedAtMs;
      const bStarted = b.attempt.startedAtMs ?? b.attempt.armedAtMs;
      if (aStarted !== bStarted) {
        return aStarted - bStarted;
      }
      if (a.attempt.armedAtMs !== b.attempt.armedAtMs) {
        return a.attempt.armedAtMs - b.attempt.armedAtMs;
      }
      return a.attempt.id.localeCompare(b.attempt.id);
    });
    const bestMs = candidates[0]?.result.durationMs ?? null;
    const ranked: SegmentBoardEntry[] = candidates.map(({ result, attempt }, index) => ({
      attemptId: attempt.id,
      resultId: result.id,
      durationMs: result.durationMs!,
      startedAtMs: result.startedAtMs!,
      endedAtMs: result.endedAtMs!,
      attemptKind: attempt.kind === 'partial' ? 'partial' : 'full',
      rank: index + 1,
      isPb: index === 0,
      tiedWithPb: bestMs != null && result.durationMs === bestMs,
    }));
    const entries =
      input.sort === 'chronological'
        ? [...ranked].sort((a, b) => b.endedAtMs - a.endedAtMs || b.attemptId.localeCompare(a.attemptId))
        : ranked;
    return {
      key,
      fromCheckpointId: from,
      toCheckpointId: to,
      fromName: checkpointName(from, input.originName),
      toName: checkpointName(to, input.destinationName),
      validCount: ranked.length,
      pb: ranked[0] ?? null,
      medianMs: officialTimesMedianMs(ranked.map((entry) => entry.durationMs)),
      entries,
    };
  });
}
