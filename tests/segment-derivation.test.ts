import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { officialTimeMs } from '../src/domain/attempt';
import {
  competitiveCheckpointEditBlockReason,
  isValidCompetitiveCheckpointRadius,
  validateCompetitiveCheckpoints,
  MAX_COMPETITIVE_CHECKPOINTS_PER_POOL,
} from '../src/domain/competitive-checkpoint';
import { replayPlaceTrace } from '../src/domain/place-timing';
import {
  deriveSegments,
  expectedFullSegmentPairs,
  expectedPartialSegmentPairs,
  findOutboundCrossingMs,
  isSegmentResultStale,
  segmentKey,
  segmentResultsFromDerivation,
  SEGMENT_DERIVATION_VERSION,
  SEGMENT_MAX_INTERPOLATION_GAP_MS,
  type DerivedSegment,
  type SegmentDerivation,
} from '../src/domain/segment-derivation';
import { makePlace } from './helpers/places';
import {
  checkpoint,
  config,
  DESTINATION,
  fullAttempt,
  ORIGIN,
  partialAttempt,
  pt,
  ride,
  T0,
  track,
} from './helpers/segments';

const B = 'b';
const B2 = 'b2';

function derive(
  samples: ReturnType<typeof track>,
  checkpoints = [checkpoint(B, 150)],
  attempt = fullAttempt(),
): SegmentDerivation {
  return deriveSegments({
    attempt,
    samples,
    config: config(checkpoints),
    origin: ORIGIN,
    destination: DESTINATION,
  });
}

function seg(derivation: SegmentDerivation, from: string | null, to: string | null): DerivedSegment {
  const found = derivation.segments.find((item) => item.key === segmentKey(from, to));
  assert.ok(found, `segment ${segmentKey(from, to)} expected`);
  return found;
}

function near(actual: number | null, expected: number, toleranceMs = 250): void {
  assert.ok(actual != null && Math.abs(actual - expected) <= toleranceMs, `${actual} !~ ${expected}`);
}

const STRAIGHT = ride({});

describe('competitive checkpoint segment derivation (#81)', () => {
  describe('segment shape and dedupe', () => {
    it('a full A -> B -> C ride yields A->B and B->C but never duplicates the official A->C', () => {
      const result = derive(track(STRAIGHT));
      assert.equal(result.status, 'derived');
      assert.deepEqual(
        result.segments.map((item) => item.key).sort(),
        [segmentKey(null, B), segmentKey(B, null)].sort(),
      );
      const ab = seg(result, null, B);
      const bc = seg(result, B, null);
      assert.equal(ab.status, 'valid');
      assert.equal(bc.status, 'valid');
      // A starts at T0+5s (30 m), B's inbound edge is 130 m (21.67 s), outbound 170 m (28.33 s).
      near(ab.durationMs, 16_667);
      near(bc.durationMs, 41_667);
      assert.equal(ab.startedAtMs, T0 + 5000, 'A->B starts at the official start');
      assert.equal(bc.endedAtMs, T0 + 70_000, 'B->C ends at the official finish');
    });

    it('segments need not sum to the official time (inbound and outbound edges differ)', () => {
      const result = derive(track(STRAIGHT));
      const sum = seg(result, null, B).durationMs! + seg(result, B, null).durationMs!;
      const official = officialTimeMs(fullAttempt())!;
      assert.ok(sum < official, 'time spent inside the checkpoint circle belongs to neither segment');
      near(official - sum, 6_667);
    });

    it('multiple checkpoints give prefix, adjacent and suffix segments deduplicated by endpoint pair', () => {
      const result = derive(track(STRAIGHT), [checkpoint(B, 150), checkpoint(B2, 300)]);
      assert.deepEqual(
        result.segments.map((item) => item.key).sort(),
        [
          segmentKey(null, B),
          segmentKey(null, B2),
          segmentKey(B, B2),
          segmentKey(B, null),
          segmentKey(B2, null),
        ].sort(),
      );
      assert.equal(result.segments.length, new Set(result.segments.map((item) => item.key)).size);
      assert.ok(result.segments.every((item) => item.status === 'valid'));
      near(seg(result, B, B2).durationMs, 46_667 - 28_333);
      near(seg(result, null, B2).durationMs, 46_667 - 5_000);
    });

    it('the pair generators are deduplicated and never include the official start->finish pair', () => {
      const full = expectedFullSegmentPairs(['x', 'y']);
      assert.equal(full.length, 5);
      assert.ok(full.every((pair) => pair.from != null || pair.to != null));
      assert.deepEqual(expectedFullSegmentPairs([]), []);
      const partial = expectedPartialSegmentPairs(['x', 'y', 'z'], 1);
      assert.deepEqual(
        partial.map((pair) => segmentKey(pair.from, pair.to)).sort(),
        [segmentKey('y', 'z'), segmentKey('y', null), segmentKey('z', null)].sort(),
      );
    });

    it('a configuration without checkpoints derives nothing', () => {
      const result = derive(track(STRAIGHT), []);
      assert.equal(result.status, 'derived');
      assert.deepEqual(result.segments, []);
    });
  });

  describe('partial attempts', () => {
    // Starts inside B and rides to C: official start is B's outbound crossing at 170 m.
    const partialTrack = track(ride({ fromNorth: 140, fromSeconds: 0, toSeconds: 60, maxNorth: 480 }));
    // Position 170 m at 5 s; arrival crossing of C (420 m) at 46.67 s.
    const partialStart = T0 + 5000;
    const partialFinish = T0 + 46_667;

    it('a B -> C partial yields only the segment starting at B, timed from the B outbound edge', () => {
      const result = derive(partialTrack, [checkpoint(B, 150)], partialAttempt(B, partialStart, partialFinish));
      assert.equal(result.status, 'derived');
      assert.deepEqual(result.segments.map((item) => item.key), [segmentKey(B, null)]);
      const bc = seg(result, B, null);
      assert.equal(bc.status, 'valid');
      assert.equal(bc.startedAtMs, partialStart);
      assert.equal(bc.durationMs, partialFinish - partialStart);
    });

    it('with several checkpoints a partial only yields segments that start at its checkpoint or later', () => {
      const attempt = partialAttempt(B, partialStart, partialFinish);
      const result = derive(
        track(ride({ fromNorth: 140, toSeconds: 60 })),
        [checkpoint(B, 150), checkpoint(B2, 300)],
        attempt,
      );
      const keys = result.segments.map((item) => item.key);
      assert.ok(!keys.some((key) => key.startsWith('S>')), 'no origin-anchored prefix for a partial');
      assert.deepEqual(keys.sort(), [segmentKey(B, B2), segmentKey(B, null), segmentKey(B2, null)].sort());
      assert.ok(result.segments.every((item) => item.status === 'valid'));
    });

    it('an unknown start checkpoint is not eligible instead of guessing', () => {
      const result = derive(partialTrack, [checkpoint(B, 150)], partialAttempt('missing', partialStart, partialFinish));
      assert.equal(result.status, 'not_eligible');
      assert.equal(result.notEligibleReason, 'start_checkpoint_unknown');
      assert.deepEqual(result.segments, []);
    });
  });

  describe('through-ride and checkpoint start use the same edge', () => {
    it('the outbound crossing equals the place-engine departure crossing of the same trace', () => {
      const samples = track(ride({ fromNorth: 140, toSeconds: 20 }));
      const outbound = findOutboundCrossingMs(samples, checkpoint(B, 150));
      assert.notEqual(outbound, null);
      const engine = replayPlaceTrace(
        [makePlace({ id: 'cp-as-place', name: 'B', center: pt(150), radiusMeters: 20 })],
        samples,
        { armedAtMs: T0, nowMs: T0 + 30_000 },
      );
      assert.equal(engine.lifecycle, 'active');
      near(outbound, engine.startedAtMs!, 1);
    });

    it('a through-ride and a checkpoint start give the same outbound edge', () => {
      const through = derive(track(STRAIGHT));
      const outboundThrough = seg(through, B, null).startedAtMs!;
      const startedInside = track(ride({ fromNorth: 145, toSeconds: 40 }));
      const outboundStart = findOutboundCrossingMs(startedInside, checkpoint(B, 150))!;
      // Same geometry and speed: the crossing happens at the same position (170 m), so the elapsed
      // time from being at 170 m equals the elapsed time on the through ride.
      const throughAt170 = outboundThrough - T0;
      const startAt170 = outboundStart - T0;
      near(throughAt170, 170 / 6 * 1000);
      near(startAt170, ((170 - 145) / 6) * 1000);
    });
  });

  describe('wrong direction, near miss, jitter and re-entry', () => {
    it('ignores a near miss that never enters the radius', () => {
      const result = derive(track(ride({ east: 40 })));
      assert.equal(seg(result, null, B).status, 'unavailable');
      assert.equal(seg(result, null, B).unavailableReason, 'not_reached');
      assert.equal(seg(result, B, null).unavailableReason, 'not_reached');
    });

    it('a pass that moves away from the destination is not timed', () => {
      // Comes from beyond B (closer to C) and rides south through it.
      const southbound = track([
        [0, 260],
        [1, 230],
        [2, 200],
        [3, 170],
        [4, 140],
        [5, 110],
        [6, 80],
        [7, 50],
        [8, 20],
      ]);
      const result = derive(southbound, [checkpoint(B, 150)], fullAttempt({ startedAtMs: T0, finishedAtMs: T0 + 70_000 }));
      assert.equal(seg(result, null, B).unavailableReason, 'wrong_direction');
      assert.equal(seg(result, B, null).unavailableReason, 'wrong_direction');
    });

    it('a wrong-direction pass followed by a correct pass uses the first VALID directional crossing', () => {
      // Rides north through B, comes back south through it (wrong way), then goes north again.
      const explicit = track([
        ...[0, 1, 2, 3, 4, 5].map((s): [number, number] => [s, s * 6]),
        ...[6, 7, 8, 9, 10].map((s): [number, number] => [s, 30 + (s - 5) * 40]), // fast north: 70..230
        ...[11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((s): [number, number] => [s, 230 - (s - 10) * 25]), // back south to -20
        ...ride({ fromNorth: 5, fromSeconds: 21, toSeconds: 100, maxNorth: 480 }),
      ]);
      const result = derive(explicit, [checkpoint(B, 150)], fullAttempt({ finishedAtMs: T0 + 100_000 }));
      const ab = seg(result, null, B);
      assert.equal(ab.status, 'valid');
      // The very first northbound pass (between 6 s and 9 s) is the first valid directional crossing.
      assert.ok(ab.endedAtMs! < T0 + 10_000, 'first pass is used, later re-entries are ignored');
    });

    it('a wrong-direction pass is skipped and a later correct pass is the first VALID crossing', () => {
      const trace = track([
        // Southbound through B first (away from C)...
        [0, 260],
        [1, 230],
        [2, 200],
        [3, 170],
        [4, 140],
        [5, 110],
        [6, 80],
        [7, 50],
        [8, 20],
        // ...then northbound through it.
        ...ride({ fromNorth: 20, fromSeconds: 9, toSeconds: 80, maxNorth: 480 }),
      ]);
      const result = derive(trace, [checkpoint(B, 150)], fullAttempt({ startedAtMs: T0, finishedAtMs: T0 + 80_000 }));
      const ab = seg(result, null, B);
      assert.equal(ab.status, 'valid');
      assert.ok(ab.endedAtMs! > T0 + 9_000, 'the northbound pass, not the southbound one');
    });

    it('re-entry after the first valid pass never changes the boundary (no cherry-picking)', () => {
      const once = derive(track(STRAIGHT));
      // Same ride but the rider turns back and re-enters B later; finish extends accordingly.
      const reenter = track([
        ...ride({ toSeconds: 40, maxNorth: 480 }),
        ...[41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60].map(
          (s): [number, number] => [s, 240 - (s - 40) * 6],
        ),
        ...ride({ fromNorth: 120, fromSeconds: 61, toSeconds: 160, maxNorth: 480 }),
      ]);
      const again = derive(reenter, [checkpoint(B, 150)], fullAttempt({ finishedAtMs: T0 + 150_000 }));
      assert.equal(seg(again, null, B).endedAtMs, seg(once, null, B).endedAtMs);
      assert.equal(seg(again, B, null).startedAtMs, seg(once, B, null).startedAtMs);
    });

    it('edge jitter before the real pass: the first valid crossing is used, a flicker exit is not a departure', () => {
      // Approach B (r 20 at 150), then hover on the edge: inside, outside, inside, ... then really pass.
      const jitter = track([
        [0, 0],
        [5, 30],
        [10, 100],
        [11, 120],
        [12, 128], // 22 m: outside
        [13, 133], // 17 m: inside  -> first valid inbound crossing between 12 s and 13 s
        [14, 126], // outside, but re-enters before any sustained departure
        [15, 131],
        [16, 140],
        [17, 150],
        [18, 160],
        [19, 168], // 18 m
        [20, 176], // 26 m: the real departure (crosses 20 m at ~19.25 s)
        [21, 184],
        [22, 192],
        [23, 200],
        [24, 260],
      ]);
      const result = derive(jitter, [checkpoint(B, 150)], fullAttempt({ finishedAtMs: T0 + 60_000 }));
      near(seg(result, null, B).endedAtMs! - T0, 12_400, 300);
      near(seg(result, B, null).startedAtMs! - T0, 19_250, 300);
    });

    it('a departure that is never sustained (trace ends right after leaving) is unavailable', () => {
      const trace = track([...ride({ toSeconds: 22 }), [23, 160], [24, 172]]);
      const result = derive(trace, [checkpoint(B, 150)], fullAttempt());
      assert.equal(seg(result, null, B).status, 'valid', 'the inbound edge stands on its own');
      assert.equal(seg(result, B, null).status, 'unavailable');
      assert.equal(seg(result, B, null).unavailableReason, 'departure_unconfirmed');
    });
  });

  describe('arrival margin (+10 m) for segment ends', () => {
    // A checkpoint (r 8) 45 m from A's centre: at the official start (A's 30 m edge) the rider is only
    // 15 m from it and never gets 18 m (radius + 10) clear of it before entering.
    const nearStart = checkpoint('near-start', 45, 8);

    it('an end without a sighting at radius + 10 m since the official start is ignored', () => {
      const result = derive(track(STRAIGHT), [nearStart, checkpoint(B, 150)]);
      assert.equal(seg(result, null, 'near-start').status, 'unavailable');
      assert.equal(seg(result, null, 'near-start').unavailableReason, 'no_arrival_margin');
      // near-start's departure is clean, so the adjacent pair near-start -> B is timed even though the
      // origin-anchored end at near-start is not.
      assert.equal(seg(result, 'near-start', B).status, 'valid');
    });

    it('applies the margin only to ends: a clean departure still starts a segment', () => {
      const result = derive(track(STRAIGHT), [nearStart, checkpoint(B, 150)]);
      assert.equal(seg(result, 'near-start', null).status, 'valid');
      assert.equal(seg(result, B, null).status, 'valid');
    });

    it('closely spaced checkpoints are fine once the rider has been seen clear of them', () => {
      // B2 at 185 (r 8) is 35 m past B (r 20): the rider was far from it earlier in the journey window.
      const result = derive(track(ride({ speed: 5 })), [checkpoint(B, 150), checkpoint('b-close', 185, 8)], fullAttempt({ startedAtMs: T0 + 6000, finishedAtMs: T0 + 84_000 }));
      assert.equal(seg(result, B, 'b-close').status, 'valid');
      assert.equal(seg(result, null, 'b-close').status, 'valid');
    });
  });

  describe('sparse samples and the maximum interpolation gap', () => {
    it('documents a 10 s maximum gap', () => {
      assert.equal(SEGMENT_MAX_INTERPOLATION_GAP_MS, 10_000);
    });

    function gapTrace(gapSeconds: number) {
      // Jump across B's inbound edge: 100 m (outside) -> 150 m (inside) after `gapSeconds`.
      return track([
        ...ride({ toSeconds: 16, maxNorth: 100 }).filter(([s]) => s <= 16),
        [16 + gapSeconds, 150],
        [17 + gapSeconds, 160],
        [18 + gapSeconds, 175],
        [19 + gapSeconds, 190],
        [20 + gapSeconds, 205],
        [21 + gapSeconds, 220],
      ]);
    }

    it('interpolates across a gap of exactly the maximum', () => {
      const result = derive(gapTrace(10), [checkpoint(B, 150)], fullAttempt({ finishedAtMs: T0 + 100_000 }));
      assert.equal(seg(result, null, B).status, 'valid');
    });

    it('refuses to interpolate across a larger gap and reports it', () => {
      const result = derive(gapTrace(10.001), [checkpoint(B, 150)], fullAttempt({ finishedAtMs: T0 + 100_000 }));
      assert.equal(seg(result, null, B).status, 'unavailable');
      assert.equal(seg(result, null, B).unavailableReason, 'gap_too_large');
      // The departure was observed with healthy samples, so the suffix segment is still timed.
      assert.equal(seg(result, B, null).status, 'valid');
    });

    it('a gap across the outbound edge makes only the segments that start there unavailable', () => {
      const trace = track([
        ...ride({ toSeconds: 22 }),
        [23, 160],
        [24, 168], // inside, then a long silence
        [40, 300],
        [41, 306],
        [42, 312],
        [43, 318],
        [44, 324],
      ]);
      const result = derive(trace, [checkpoint(B, 150)], fullAttempt({ finishedAtMs: T0 + 100_000 }));
      assert.equal(seg(result, null, B).status, 'valid');
      assert.equal(seg(result, B, null).unavailableReason, 'gap_too_large');
    });
  });

  describe('skipped, out-of-order, bypassing checkpoints', () => {
    it('a skipped checkpoint only removes the segments that need it', () => {
      const result = derive(track(STRAIGHT), [checkpoint('skip', 150, 20, 60), checkpoint(B2, 300)]);
      assert.equal(seg(result, null, 'skip').unavailableReason, 'not_reached');
      assert.equal(seg(result, 'skip', B2).status, 'unavailable');
      assert.equal(seg(result, 'skip', null).status, 'unavailable');
      assert.equal(seg(result, null, B2).status, 'valid');
      assert.equal(seg(result, B2, null).status, 'valid');
    });

    it('checkpoints passed out of configured order are unavailable, not reordered', () => {
      // Configured far -> near but the ride meets the near one first.
      const result = derive(track(STRAIGHT), [checkpoint('far', 300), checkpoint('near', 150)]);
      assert.equal(seg(result, null, 'far').status, 'valid');
      assert.equal(seg(result, 'far', 'near').status, 'unavailable');
      assert.equal(seg(result, 'far', 'near').unavailableReason, 'out_of_order');
      assert.equal(seg(result, 'near', null).unavailableReason, 'out_of_order');
    });

    it('a route that bypasses a checkpoint leaves the original full run intact', () => {
      const attempt = fullAttempt();
      const before = structuredClone(attempt);
      const result = derive(track(ride({ east: 90 })), [checkpoint(B, 150)], attempt);
      assert.equal(result.status, 'derived');
      assert.ok(result.segments.every((item) => item.status === 'unavailable'));
      assert.deepEqual(attempt, before, 'derivation never edits the attempt');
      assert.equal(officialTimeMs(attempt), 65_000);
    });
  });

  describe('DNF, ineligible attempts and missing evidence', () => {
    it('a DNF attempt yields no segments and no records', () => {
      const dnf = fullAttempt({ lifecycle: 'ended', validity: 'unranked', finishedAtMs: null });
      const result = derive(track(STRAIGHT), [checkpoint(B, 150)], dnf);
      assert.equal(result.status, 'not_eligible');
      assert.equal(result.notEligibleReason, 'not_completed');
      assert.deepEqual(result.segments, []);
      assert.deepEqual(segmentResultsFromDerivation(result, T0), []);
    });

    it('an unranked completed attempt is not eligible', () => {
      const result = derive(track(STRAIGHT), [checkpoint(B, 150)], fullAttempt({ validity: 'unranked' }));
      assert.equal(result.notEligibleReason, 'not_valid');
    });

    it('missing official times are not eligible', () => {
      const result = derive(track(STRAIGHT), [checkpoint(B, 150)], fullAttempt({ finishedAtMs: null }));
      assert.equal(result.notEligibleReason, 'missing_official_times');
    });

    it('no GPS makes every segment unavailable without fabricating a time', () => {
      const result = derive([], [checkpoint(B, 150)]);
      assert.equal(result.status, 'derived');
      assert.ok(result.segments.every((item) => item.status === 'unavailable' && item.durationMs == null));
      assert.ok(result.segments.every((item) => item.unavailableReason === 'missing_telemetry'));
    });

    it('poor-accuracy fixes are ignored (existing accuracy gate)', () => {
      // All samples inside B's circle are junk (100 m accuracy), so the circle is never entered.
      const poor = track(STRAIGHT.map(([s, north]) => [s, north, 0, north >= 130 && north <= 170 ? 100 : 5]));
      const result = derive(poor);
      assert.equal(seg(result, null, B).status, 'unavailable');
    });

    it('a checkpoint overlapping an origin/destination Place under the current Places is unavailable', () => {
      const result = derive(track(STRAIGHT), [checkpoint('near-c', 430, 20)]);
      assert.equal(seg(result, null, 'near-c').unavailableReason, 'geometry_invalid');
    });
  });

  describe('determinism', () => {
    it('is repeatable and independent of input order', () => {
      const samples = track(STRAIGHT);
      const first = derive(samples, [checkpoint(B, 150), checkpoint(B2, 300)]);
      const second = derive([...samples].reverse(), [checkpoint(B, 150), checkpoint(B2, 300)]);
      assert.deepEqual(first, second);
      assert.deepEqual(derive(samples), derive(samples));
    });

    it('persistable rows are keyed by attempt, version and endpoint pair', () => {
      const result = derive(track(STRAIGHT));
      const rows = segmentResultsFromDerivation(result, T0 + 1);
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map((row) => row.id)).size, 2);
      assert.ok(rows.every((row) => row.configVersion === 1 && row.derivationVersion === SEGMENT_DERIVATION_VERSION));
      assert.deepEqual(segmentResultsFromDerivation(result, T0 + 1), rows);
    });

    it('results are stale once the configuration or algorithm version moves on', () => {
      assert.equal(isSegmentResultStale({ configVersion: 1, derivationVersion: SEGMENT_DERIVATION_VERSION }, 1), false);
      assert.equal(isSegmentResultStale({ configVersion: 1, derivationVersion: SEGMENT_DERIVATION_VERSION }, 2), true);
      assert.equal(isSegmentResultStale({ configVersion: 1, derivationVersion: SEGMENT_DERIVATION_VERSION + 1 }, 1), true);
      assert.equal(isSegmentResultStale({ configVersion: 1, derivationVersion: SEGMENT_DERIVATION_VERSION }, null), true);
    });
  });
});

describe('competitive checkpoint validation (#81)', () => {
  const places = [ORIGIN, DESTINATION];

  it('accepts radii 8-250 m and rejects outside it', () => {
    assert.equal(isValidCompetitiveCheckpointRadius(8), true);
    assert.equal(isValidCompetitiveCheckpointRadius(250), true);
    assert.equal(isValidCompetitiveCheckpointRadius(7.99), false);
    assert.equal(isValidCompetitiveCheckpointRadius(250.01), false);
    assert.equal(isValidCompetitiveCheckpointRadius(Number.NaN), false);
    for (const radius of [7, 251]) {
      const issues = validateCompetitiveCheckpoints([checkpoint('x', 150, radius)], places);
      assert.deepEqual(issues.map((issue) => issue.code), ['radius_out_of_range']);
    }
    assert.deepEqual(
      validateCompetitiveCheckpoints([checkpoint('x', 150, 8), checkpoint('y', 300, 250, 2000)], places).map((i) => i.code),
      [],
    );
  });

  it('rejects overlap with Places (any active place) and with other checkpoints, ignoring archived places', () => {
    // 450 - 30 (destination footprint) = 420: a 20 m checkpoint at 435 overlaps.
    assert.deepEqual(
      validateCompetitiveCheckpoints([checkpoint('x', 435)], places).map((issue) => [issue.code, issue.otherId]),
      [['overlaps_place', 'c']],
    );
    const other = makePlace({ id: 'cafe', name: 'Cafe', center: pt(150, 10), radiusMeters: 20 });
    assert.equal(validateCompetitiveCheckpoints([checkpoint('x', 150)], [...places, other])[0]?.code, 'overlaps_place');
    assert.deepEqual(
      validateCompetitiveCheckpoints([checkpoint('x', 150)], [...places, { ...other, status: 'archived' }]),
      [],
    );
    const departureWins = makePlace({ id: 'wide', name: 'Wide', center: pt(150, 100) });
    departureWins.departureRadiusMeters = 100;
    departureWins.arrivalRadiusMeters = 10;
    assert.equal(validateCompetitiveCheckpoints([checkpoint('x', 150)], [...places, departureWins])[0]?.code, 'overlaps_place');
    assert.deepEqual(
      validateCompetitiveCheckpoints([checkpoint('x', 150, 20), checkpoint('y', 185, 20)], places).map((issue) => issue.code),
      ['overlaps_checkpoint'],
    );
    assert.deepEqual(validateCompetitiveCheckpoints([checkpoint('x', 150, 20), checkpoint('y', 191, 20)], places), []);
  });

  it('rejects empty names, duplicate ids, bad coordinates and too many checkpoints', () => {
    assert.ok(validateCompetitiveCheckpoints([{ ...checkpoint('x', 150), name: '  ' }], places).some((i) => i.code === 'empty_name'));
    assert.ok(validateCompetitiveCheckpoints([checkpoint('x', 150), checkpoint('x', 300)], places).some((i) => i.code === 'duplicate_id'));
    assert.ok(
      validateCompetitiveCheckpoints([{ ...checkpoint('x', 150), center: { latitude: 99, longitude: 0 } }], places).some(
        (i) => i.code === 'invalid_center',
      ),
    );
    const many = Array.from({ length: MAX_COMPETITIVE_CHECKPOINTS_PER_POOL + 1 }, (_, index) => checkpoint(`c${index}`, 40 + index * 40, 8));
    assert.ok(validateCompetitiveCheckpoints(many, places).some((i) => i.code === 'too_many'));
  });

  it('locks edits while a run is armed/active or any recalculation job exists', () => {
    assert.equal(competitiveCheckpointEditBlockReason({ openAttempt: false, recalculationJobExists: false }), null);
    assert.match(competitiveCheckpointEditBlockReason({ openAttempt: true, recalculationJobExists: false })!, /current run/);
    assert.match(competitiveCheckpointEditBlockReason({ openAttempt: false, recalculationJobExists: true })!, /recalculation job/);
  });
});
