import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import type { HistoryRow } from '../src/domain/attempt-analysis';
import {
  journeyHistoryRows,
  journeyRankedHistoryRows,
  type JourneyAttemptTrace,
  type JourneyHistoryRow,
} from '../src/domain/journey-analysis';
import { attemptIdentity } from './helpers/attempts';

const POOL = {
  originPlaceId: 'place-home',
  destinationPlaceId: 'place-work',
  transportationMode: 'scooter' as const,
};

// Minutes after midnight as epoch ms, to keep the fixtures readable.
function at(hh: number, mm: number): number {
  return (hh * 60 + mm) * 60_000;
}

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `${id}-session`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: at(9, 0),
    startedAtMs: at(9, 5),
    finishedAtMs: at(9, 15),
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    ...attemptIdentity(),
    ...overrides,
  };
}

function endedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return completedAttempt(id, {
    lifecycle: 'ended',
    validity: 'invalid',
    finishedAtMs: null,
    ...overrides,
  });
}

function traces(attempts: Attempt[]): JourneyAttemptTrace[] {
  return attempts.map((attempt) => ({ attempt, samples: [] }));
}

function row(attemptId: string, overrides: Partial<HistoryRow> = {}): HistoryRow {
  return {
    attemptId,
    armedAtMs: 0,
    finishedAtMs: 0,
    officialTimeMs: 0,
    rank: null,
    isPb: false,
    eligible: false,
    unavailabilityReason: 'not_valid',
    lifecycle: 'ended',
    incompleteLabel: null,
    ...overrides,
  };
}

function ranked(attemptId: string, rank: number, extra: Partial<HistoryRow> = {}): HistoryRow {
  return row(attemptId, { rank, eligible: true, unavailabilityReason: null, lifecycle: 'completed', ...extra });
}

describe('journeyRankedHistoryRows', () => {
  it('orders the issue example PB-first while chronological history stays newest-first', () => {
    // Chronological input (newest first) as journeyHistoryRows returns it.
    const chronological: HistoryRow[] = [
      ranked('0938', 16, { finishedAtMs: at(9, 38) }),
      ranked('0907', 11, { finishedAtMs: at(9, 7) }),
      ranked('1927', 17, { finishedAtMs: at(19, 27) }),
      ranked('0745', 1, { finishedAtMs: at(7, 45), isPb: true }),
    ];
    const snapshot = structuredClone(chronological);

    const rankedOut = journeyRankedHistoryRows(chronological);

    assert.deepEqual(
      rankedOut.map((item) => item.attemptId),
      ['0745', '0907', '0938', '1927'],
    );
    assert.deepEqual(
      rankedOut.map((item) => item.rank),
      [1, 11, 16, 17],
    );
    assert.deepEqual(
      chronological.map((item) => item.attemptId),
      ['0938', '0907', '1927', '0745'],
      'chronological input order is untouched',
    );
    assert.deepEqual(chronological, snapshot);
  });

  it('follows the canonical comparator tie-breaks for equal official times', () => {
    // All four have an official time of 10 minutes. The canonical order is:
    // earlier start, then earlier armed time, then id.
    const attempts = [
      completedAttempt('late-start', { armedAtMs: at(9, 0), startedAtMs: at(9, 20), finishedAtMs: at(9, 30) }),
      completedAttempt('early-start-late-arm', {
        armedAtMs: at(9, 4),
        startedAtMs: at(9, 5),
        finishedAtMs: at(9, 15),
      }),
      completedAttempt('early-start-early-arm-b', {
        armedAtMs: at(9, 1),
        startedAtMs: at(9, 5),
        finishedAtMs: at(9, 15),
      }),
      completedAttempt('early-start-early-arm-a', {
        armedAtMs: at(9, 1),
        startedAtMs: at(9, 5),
        finishedAtMs: at(9, 15),
      }),
    ];
    const history = journeyHistoryRows(POOL, traces(attempts));
    const rankedOut = journeyRankedHistoryRows(history);

    const expectedOrder = ['early-start-early-arm-a', 'early-start-early-arm-b', 'early-start-late-arm', 'late-start'];
    assert.deepEqual(
      rankedOut.map((item) => item.attemptId),
      expectedOrder,
    );
    // The ranked output must equal rank order exactly, with ranks taken unchanged from the source.
    const byRank = [...history].filter((item) => item.rank != null).sort((a, b) => a.rank! - b.rank!);
    assert.deepEqual(
      rankedOut.map((item) => item.rank),
      byRank.map((item) => item.rank),
    );
    assert.deepEqual(
      rankedOut.map((item) => item.rank),
      [1, 2, 3, 4],
    );
  });

  it('excludes ineligible, incomplete and unranked rows from ranked output only', () => {
    const attempts = [
      completedAttempt('official', { startedAtMs: at(9, 5), finishedAtMs: at(9, 15) }),
      completedAttempt('invalid', {
        validity: 'invalid',
        startedAtMs: at(8, 0),
        finishedAtMs: at(8, 10),
        armedAtMs: at(7, 59),
      }),
      endedAttempt('dnf', { startedAtMs: at(9, 30), armedAtMs: at(9, 29) }),
    ];
    const history = journeyHistoryRows(POOL, traces(attempts));
    const chronological = history.map((item) => item.attemptId);
    // Completed-but-invalid attempts are not history rows at all; the ended DNF is shown chronologically.
    assert.equal(chronological.includes('invalid'), false);
    assert.equal(chronological.includes('dnf'), true);
    assert.equal(chronological.includes('official'), true);

    const rankedOut = journeyRankedHistoryRows(history);
    assert.deepEqual(
      rankedOut.map((item) => item.attemptId),
      ['official'],
    );
    assert.equal(rankedOut[0]?.rank, 1);

    const unrankedEligible: JourneyHistoryRow = {
      ...rankedOut[0]!,
      attemptId: 'eligible-no-rank',
      rank: null,
    };
    const unrankedIneligible: JourneyHistoryRow = {
      ...rankedOut[0]!,
      attemptId: 'rank-but-ineligible',
      eligible: false,
    };
    assert.deepEqual(
      journeyRankedHistoryRows([unrankedEligible, unrankedIneligible, rankedOut[0]!]).map((item) => item.attemptId),
      ['official'],
    );
  });

  it('handles empty and single-row input', () => {
    assert.deepEqual(journeyRankedHistoryRows([]), []);
    const only = ranked('only', 1);
    const out = journeyRankedHistoryRows([only]);
    assert.deepEqual(out, [only]);
    assert.notEqual(out, [only]);
    assert.equal(out[0], only);

    const none = [row('a'), row('b')];
    assert.deepEqual(journeyRankedHistoryRows(none), []);
  });

  it('does not mutate the input array or its rows', () => {
    const input: HistoryRow[] = [
      ranked('c', 3),
      row('x'),
      ranked('a', 1),
      ranked('b', 2),
    ];
    const snapshot = structuredClone(input);
    const originalRefs = [...input];

    const out = journeyRankedHistoryRows(input);

    assert.notEqual(out, input);
    assert.deepEqual(input, snapshot);
    assert.deepEqual(
      input.map((item, index) => item === originalRefs[index]),
      [true, true, true, true],
    );
    assert.deepEqual(
      out.map((item) => item.attemptId),
      ['a', 'b', 'c'],
    );
  });

  it('keeps ascending rank order and original ranks when a group filter is applied', () => {
    const history = [
      ranked('0938', 16, { finishedAtMs: at(9, 38) }),
      ranked('0907', 11, { finishedAtMs: at(9, 7) }),
      ranked('1927', 17, { finishedAtMs: at(19, 27) }),
      ranked('0745', 1, { finishedAtMs: at(7, 45), isPb: true }),
    ];
    const groupAttemptIds = ['1927', '0907', '0745'];

    const filtered = journeyRankedHistoryRows(history).filter((item) => groupAttemptIds.includes(item.attemptId));

    assert.deepEqual(
      filtered.map((item) => item.attemptId),
      ['0745', '0907', '1927'],
    );
    assert.deepEqual(
      filtered.map((item) => item.rank),
      [1, 11, 17],
    );
  });
});

describe('AppRoot ranked history wiring', () => {
  const root = readFileSync(new URL('../src/ui/AppRoot.tsx', import.meta.url), 'utf8');

  it('passes the ranked selector output to HistoryScreen instead of a bare filter', () => {
    assert.match(root, /rankedRows=\{journeyRankedHistory\}/);
    assert.match(root, /useMemo\(\(\) => journeyRankedHistoryRows\(journeyHistory\), \[journeyHistory\]\)/);
    assert.equal(root.includes('.filter((row) => row.eligible && row.rank != null)'), false);
  });
});
