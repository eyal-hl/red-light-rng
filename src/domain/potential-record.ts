import type { Attempt } from './attempt';
import { isJourneyCompetitive, officialTimeMs } from './attempt';
import {
  isSegmentResultStale,
  segmentKey,
  type AttemptSegmentResult,
} from './segment-derivation';

/**
 * Potential full-route record of a PARTIAL attempt (DEC-016, #81). HYPOTHETICAL and display-only:
 * the estimate is computed when shown from existing derived rows, never persisted, never ranked,
 * never a reference sample for anything, and never replaces an actual full-route record.
 *
 * For a completed partial that started at checkpoint k, the prefix reference samples are the actual
 * cumulative `journey start -> checkpoint k` segment results of eligible FULL runs of the same
 * journey and the same checkpoint configuration version (never sums of unrelated per-segment
 * medians). Estimates: best-case = fastest prefix + this run's measured suffix (needs N >= 1),
 * typical = median prefix + suffix (needs N >= 3; an even N averages the two middle values).
 * Each is compared separately with the actual full-route PB; only a strictly faster estimate is a
 * potential record, an equal one is a tie.
 */

export const POTENTIAL_BEST_MIN_SAMPLES = 1;
export const POTENTIAL_TYPICAL_MIN_SAMPLES = 3;

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export type PotentialComparison =
  | { kind: 'no_pb' }
  | { kind: 'potential_record'; fasterByMs: number }
  | { kind: 'tie' }
  | { kind: 'slower'; slowerByMs: number };

export type PotentialEstimate = {
  kind: 'best_case' | 'typical';
  /** Number of reference prefix samples behind the estimate. */
  sampleCount: number;
  prefixMs: number;
  suffixMs: number;
  totalMs: number;
  comparison: PotentialComparison;
};

export type PotentialEstimateSlot =
  | { status: 'ready'; estimate: PotentialEstimate }
  | { status: 'insufficient'; sampleCount: number; required: number };

export type PotentialRecordResult = {
  /** Always true: this is never an official result. */
  hypothetical: true;
  suffixMs: number;
  /** The actual full-route PB the estimates are compared with; null when there is none yet. */
  fullPbMs: number | null;
  sampleCount: number;
  best: PotentialEstimateSlot;
  typical: PotentialEstimateSlot;
};

export function comparePotential(totalMs: number, fullPbMs: number | null): PotentialComparison {
  if (fullPbMs == null) {
    return { kind: 'no_pb' };
  }
  if (totalMs < fullPbMs) {
    return { kind: 'potential_record', fasterByMs: fullPbMs - totalMs };
  }
  return totalMs === fullPbMs ? { kind: 'tie' } : { kind: 'slower', slowerByMs: totalMs - fullPbMs };
}

function slot(
  kind: PotentialEstimate['kind'],
  prefixMs: number | null,
  sampleCount: number,
  required: number,
  suffixMs: number,
  fullPbMs: number | null,
): PotentialEstimateSlot {
  if (prefixMs == null || sampleCount < required) {
    return { status: 'insufficient', sampleCount, required };
  }
  const totalMs = prefixMs + suffixMs;
  return {
    status: 'ready',
    estimate: { kind, sampleCount, prefixMs, suffixMs, totalMs, comparison: comparePotential(totalMs, fullPbMs) },
  };
}

/** Pure estimate from prefix durations (ms) of the reference runs, this run's suffix and the actual PB. */
export function computePotentialRecord(input: {
  prefixDurationsMs: readonly number[];
  suffixMs: number;
  fullPbMs: number | null;
}): PotentialRecordResult {
  const prefixes = input.prefixDurationsMs.filter((value) => Number.isFinite(value) && value > 0);
  const n = prefixes.length;
  return {
    hypothetical: true,
    suffixMs: input.suffixMs,
    fullPbMs: input.fullPbMs,
    sampleCount: n,
    best: slot('best_case', n > 0 ? Math.min(...prefixes) : null, n, POTENTIAL_BEST_MIN_SAMPLES, input.suffixMs, input.fullPbMs),
    typical: slot('typical', medianOf(prefixes), n, POTENTIAL_TYPICAL_MIN_SAMPLES, input.suffixMs, input.fullPbMs),
  };
}

export type PrefixReferences = {
  durationsMs: number[];
  attemptIds: string[];
};

/**
 * Reference prefix samples for a partial that started at `startCheckpointId` under
 * `configVersion`: one cumulative `start -> checkpoint` result per eligible FULL run of the pool.
 * Excluded: partial attempts, DNFs and other ineligible runs, the attempt itself, rows of another
 * configuration or algorithm version, and unavailable rows. One sample per attempt.
 */
export function selectPrefixReferences(input: {
  partial: Pick<Attempt, 'id' | 'startCheckpointId'>;
  configVersion: number;
  attempts: readonly Attempt[];
  results: readonly AttemptSegmentResult[];
}): PrefixReferences {
  const wanted = segmentKey(null, input.partial.startCheckpointId ?? null);
  const eligible = new Set(
    input.attempts.filter((attempt) => attempt.id !== input.partial.id && isJourneyCompetitive(attempt)).map((a) => a.id),
  );
  const byAttempt = new Map<string, number>();
  for (const result of input.results) {
    if (
      result.status !== 'valid' ||
      result.durationMs == null ||
      !(result.durationMs > 0) ||
      segmentKey(result.fromCheckpointId, result.toCheckpointId) !== wanted ||
      isSegmentResultStale(result, input.configVersion) ||
      !eligible.has(result.attemptId) ||
      byAttempt.has(result.attemptId)
    ) {
      continue;
    }
    byAttempt.set(result.attemptId, result.durationMs);
  }
  const attemptIds = [...byAttempt.keys()].sort();
  return { attemptIds, durationsMs: attemptIds.map((id) => byAttempt.get(id)!) };
}

/** The actual full-route PB of the pool's attempts (full, completed, valid), or null. */
export function actualFullRoutePbMs(attempts: readonly Attempt[]): number | null {
  const times = attempts.filter(isJourneyCompetitive).map((attempt) => officialTimeMs(attempt));
  const valid = times.filter((value): value is number => value != null);
  return valid.length === 0 ? null : Math.min(...valid);
}
