import type { Attempt } from './attempt';
import type { CompetitiveCheckpoint, CompetitiveCheckpointConfig } from './competitive-checkpoint';
import { placeFootprintRadiusMeters, zonesOverlap } from './competitive-checkpoint';
import { haversineMeters, type LatLng } from './geo';
import type { LocationSample } from './location-sample';
import type { Place } from './place';
import {
  interpolateRadiusCrossing,
  isAccuracyAccepted,
  PLACE_DEPARTURE_MIN_SAMPLES,
  PLACE_DEPARTURE_SUSTAIN_METERS,
  PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS,
} from './place-timing';

/**
 * Pure derivation of competitive checkpoint segment times (DEC-016, issue #81).
 *
 * Inputs are raw GPS samples, one attempt, one immutable checkpoint configuration version and the
 * origin / destination Place geometry. The output is derived data only: official attempt timing is
 * never read back from or written by this module, and nothing is invented. When the evidence for a
 * boundary is missing or ambiguous the affected segments are `unavailable` with a reason.
 *
 * Boundary rules (all against the raw samples that pass the existing accuracy gate):
 *
 * - Segment START at a checkpoint is the interpolated OUTBOUND crossing of its radius, confirmed
 *   like a Place departure: at least `SEGMENT_DEPARTURE_MIN_SAMPLES` samples after the crossing and
 *   a maximum distance of radius + `SEGMENT_DEPARTURE_SUSTAIN_METERS` (18 m), without re-entering
 *   first. The same edge is used for a through-ride and for a checkpoint start (a partial attempt's
 *   official start is that same outbound crossing), so the two are comparable.
 * - Segment END at a checkpoint is the interpolated INBOUND crossing of its radius. The arrival
 *   margin applies exactly like Place destination eligibility, whose watch covers the whole
 *   journey window: the crossing only counts if, at any time since the attempt's official start and
 *   before the crossing, an accepted sample was seen at radius + 10 m or further from the
 *   checkpoint centre. A rider who started inside (or within 10 m of) the checkpoint circle and
 *   never moved clear of it did not "arrive" at it, so that entry is ignored as a jitter entry and
 *   the end is unavailable. (Unlike a Place finish there is no inside-dwell confirmation because a
 *   rider legitimately passes through a checkpoint without stopping.) The crossing itself must
 *   still happen strictly after the previous valid boundary.
 * - Segment boundaries at the journey start / finish are the attempt's stored official times.
 * - The first valid directional crossing after the previous valid boundary is used; later
 *   re-entries are ignored so repeated crossings can never be cherry-picked.
 * - No crossing is interpolated across a gap larger than `SEGMENT_MAX_INTERPOLATION_GAP_MS`.
 *
 * Inbound and outbound boundaries of one checkpoint differ, so competitive segment times need not
 * sum to the official time.
 */

export const SEGMENT_DERIVATION_VERSION = 1;

/**
 * Maximum gap between the two raw samples a crossing is interpolated across. Location is sampled at
 * 1 s (`timeInterval: 1000`), so 10 s tolerates ordinary background jitter and short dropouts while
 * bounding the interpolation error of any boundary to well under 10 s. A larger gap makes the
 * crossing, and every segment that needs it, unavailable.
 */
export const SEGMENT_MAX_INTERPOLATION_GAP_MS = 10_000;
export const SEGMENT_ARRIVAL_MARGIN_METERS = PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS;
export const SEGMENT_DEPARTURE_SUSTAIN_METERS = PLACE_DEPARTURE_SUSTAIN_METERS;
export const SEGMENT_DEPARTURE_MIN_SAMPLES = PLACE_DEPARTURE_MIN_SAMPLES;
/**
 * A pass counts as the wrong way when the rider ends up more than this much FARTHER from the
 * destination than where they entered, so GPS noise on a perpendicular pass is not rejected.
 */
export const SEGMENT_DIRECTION_TOLERANCE_METERS = 5;

export type SegmentUnavailableReason =
  /** Checkpoint circle never entered after the previous boundary (near miss / bypass / skipped). */
  | 'not_reached'
  /** Only crossed before the previous boundary: the checkpoint was passed out of order. */
  | 'out_of_order'
  /** Entered the circle without having been seen at radius + 10 m beforehand. */
  | 'no_arrival_margin'
  /** The crossing would be interpolated across more than the maximum sample gap. */
  | 'gap_too_large'
  /** The pass moved away from the destination. */
  | 'wrong_direction'
  /** Left the circle but the departure was never confirmed (too few samples, re-entry, trace end). */
  | 'departure_unconfirmed'
  /** No usable GPS fix inside the journey window. */
  | 'missing_telemetry'
  /** Checkpoint geometry collides with an origin / destination Place under the current Places. */
  | 'geometry_invalid'
  /** Boundary times do not give a positive duration. */
  | 'non_positive_duration'
  /** A partial attempt can not time a checkpoint it started at or before. */
  | 'before_start_checkpoint';

export type SegmentDerivationStatus = 'derived' | 'not_eligible';

export type SegmentNotEligibleReason =
  | 'not_completed'
  | 'not_valid'
  | 'missing_official_times'
  | 'missing_places'
  | 'start_checkpoint_unknown';

export type DerivedSegment = {
  /** Stable key per endpoint pair, see `segmentKey`. */
  key: string;
  /** Checkpoint the segment starts at; `null` = the journey start (origin place departure). */
  fromCheckpointId: string | null;
  /** Checkpoint the segment ends at; `null` = the journey finish (destination place arrival). */
  toCheckpointId: string | null;
  status: 'valid' | 'unavailable';
  unavailableReason: SegmentUnavailableReason | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
};

export type CheckpointEdge =
  | { atMs: number; reason: null }
  | { atMs: null; reason: SegmentUnavailableReason };

export type CheckpointBoundary = {
  checkpointId: string;
  inbound: CheckpointEdge;
  outbound: CheckpointEdge;
};

export type SegmentDerivation = {
  attemptId: string;
  configVersion: number;
  derivationVersion: number;
  status: SegmentDerivationStatus;
  notEligibleReason: SegmentNotEligibleReason | null;
  boundaries: CheckpointBoundary[];
  /** Deduplicated by endpoint pair; the official full-route pair (start -> finish) is never included. */
  segments: DerivedSegment[];
};

export type SegmentAttemptInput = Pick<
  Attempt,
  'id' | 'lifecycle' | 'validity' | 'startedAtMs' | 'finishedAtMs' | 'originPlaceId' | 'destinationPlaceId'
> &
  Pick<Partial<Attempt>, 'kind' | 'startCheckpointId'>;

export type SegmentPlaceGeometry = Pick<
  Place,
  'id' | 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters'
>;

export type DeriveSegmentsInput = {
  attempt: SegmentAttemptInput;
  samples: readonly LocationSample[];
  config: CompetitiveCheckpointConfig;
  origin: SegmentPlaceGeometry | null;
  destination: SegmentPlaceGeometry | null;
};

export function segmentKey(fromCheckpointId: string | null, toCheckpointId: string | null): string {
  return `${fromCheckpointId == null ? 'S' : `C:${fromCheckpointId}`}>${toCheckpointId == null ? 'F' : `C:${toCheckpointId}`}`;
}

/** A stored result is stale when its configuration or algorithm version is no longer current. */
export function isSegmentResultStale(
  result: { configVersion: number; derivationVersion: number },
  currentConfigVersion: number | null,
): boolean {
  return (
    currentConfigVersion == null ||
    result.configVersion !== currentConfigVersion ||
    result.derivationVersion !== SEGMENT_DERIVATION_VERSION
  );
}

type Point = { t: number; latitude: number; longitude: number };

type EdgeScan = {
  inbound: CheckpointEdge;
  outbound: CheckpointEdge;
};

const REASON_PRIORITY: SegmentUnavailableReason[] = [
  'wrong_direction',
  'gap_too_large',
  'no_arrival_margin',
  'departure_unconfirmed',
  'out_of_order',
  'not_reached',
];

function pickReason(notes: Set<SegmentUnavailableReason>): SegmentUnavailableReason {
  for (const reason of REASON_PRIORITY) {
    if (notes.has(reason)) {
      return reason;
    }
  }
  return 'not_reached';
}

function toPoint(sample: Pick<LocationSample, 'recordedAtMs' | 'latitude' | 'longitude'>): Point {
  return { t: sample.recordedAtMs, latitude: sample.latitude, longitude: sample.longitude };
}

function acceptedPoints(samples: readonly LocationSample[]): Point[] {
  return samples
    .filter(isAccuracyAccepted)
    .map(toPoint)
    .sort((a, b) => a.t - b.t);
}

type DepartureCheck = { confirmed: boolean; reentryAt: number };

/**
 * Departure confirmation for a pair (`prevIndex` inside, `firstOutside` outside): same sustain rule
 * as a Place departure. Counts samples while they stay outside the radius; a re-entry before the
 * sustain is reached cancels this crossing (jitter) and reports where scanning resumes.
 */
function confirmDeparture(
  distances: number[],
  firstOutside: number,
  radiusMeters: number,
): DepartureCheck {
  let count = 0;
  let maxDistance = 0;
  for (let m = firstOutside; m < distances.length; m += 1) {
    const distance = distances[m]!;
    if (distance <= radiusMeters) {
      return { confirmed: false, reentryAt: m };
    }
    count += 1;
    maxDistance = Math.max(maxDistance, distance);
    if (
      count >= SEGMENT_DEPARTURE_MIN_SAMPLES &&
      maxDistance >= radiusMeters + SEGMENT_DEPARTURE_SUSTAIN_METERS
    ) {
      return { confirmed: true, reentryAt: -1 };
    }
  }
  return { confirmed: false, reentryAt: distances.length };
}

function crossingAt(
  prev: Point,
  prevDistance: number,
  cur: Point,
  curDistance: number,
  radiusMeters: number,
): number {
  return interpolateRadiusCrossing(
    { recordedAtMs: prev.t, distanceMeters: prevDistance },
    { recordedAtMs: cur.t, distanceMeters: curDistance },
    radiusMeters,
  );
}

type OutboundSearch = {
  /** Confirmed outbound crossing, if any. */
  atMs: number | null;
  /** Index of the first outside sample of that crossing. */
  index: number;
  notes: Set<SegmentUnavailableReason>;
};

/**
 * First CONFIRMED outbound crossing (inside -> outside) at or after sample index `fromIndex`, with
 * its crossing time strictly inside `(afterMs, beforeMs)`. Pairs across a gap larger than the
 * maximum interpolation gap are skipped and noted.
 */
function searchOutbound(
  points: Point[],
  distances: number[],
  fromIndex: number,
  radiusMeters: number,
  afterMs: number,
  beforeMs: number,
): OutboundSearch {
  const notes = new Set<SegmentUnavailableReason>();
  for (let j = Math.max(1, fromIndex); j < points.length; j += 1) {
    const prev = points[j - 1]!;
    const cur = points[j]!;
    if (prev.t >= beforeMs) {
      break;
    }
    if (!(distances[j - 1]! <= radiusMeters && distances[j]! > radiusMeters)) {
      continue;
    }
    const tOut = crossingAt(prev, distances[j - 1]!, cur, distances[j]!, radiusMeters);
    if (!(tOut > afterMs && tOut < beforeMs)) {
      continue;
    }
    if (cur.t - prev.t > SEGMENT_MAX_INTERPOLATION_GAP_MS) {
      notes.add('gap_too_large');
      continue;
    }
    const check = confirmDeparture(distances, j, radiusMeters);
    if (check.confirmed) {
      return { atMs: tOut, index: j, notes };
    }
    notes.add('departure_unconfirmed');
  }
  return { atMs: null, index: points.length, notes };
}

/**
 * Scan raw samples for one checkpoint after the previous boundary `afterMs` (exclusive) and before
 * the journey finish `beforeMs`. See the module comment for the rules.
 */
function scanCheckpoint(
  points: Point[],
  checkpoint: CompetitiveCheckpoint,
  destination: LatLng | null,
  afterMs: number,
  beforeMs: number,
  windowStartMs: number,
): EdgeScan {
  const radius = checkpoint.radiusMeters;
  const distances = points.map((point) => haversineMeters(point, checkpoint.center));
  const destinationDistance = (index: number): number | null =>
    destination ? haversineMeters(points[index]!, destination) : null;
  const movesAway = (beforeIndex: number, afterIndex: number): boolean => {
    const before = destinationDistance(beforeIndex);
    const after = destinationDistance(afterIndex);
    return before != null && after != null && after - before > SEGMENT_DIRECTION_TOLERANCE_METERS;
  };

  const inboundNotes = new Set<SegmentUnavailableReason>();
  const outboundNotes = new Set<SegmentUnavailableReason>();
  let seenEligible = false;
  let wrongDirectionSeen = false;
  let k = 0;
  while (k < points.length) {
    const sample = points[k]!;
    if (sample.t >= windowStartMs && distances[k]! >= radius + SEGMENT_ARRIVAL_MARGIN_METERS) {
      seenEligible = true;
    }
    if (k === 0) {
      k += 1;
      continue;
    }
    const prev = points[k - 1]!;
    if (prev.t >= beforeMs) {
      break;
    }
    if (!(distances[k - 1]! > radius && distances[k]! <= radius)) {
      k += 1;
      continue;
    }
    const tIn = crossingAt(prev, distances[k - 1]!, sample, distances[k]!, radius);
    if (!(tIn > afterMs && tIn < beforeMs)) {
      k += 1;
      continue;
    }
    if (sample.t - prev.t > SEGMENT_MAX_INTERPOLATION_GAP_MS) {
      inboundNotes.add('gap_too_large');
      k += 1;
      continue;
    }
    if (!seenEligible) {
      inboundNotes.add('no_arrival_margin');
      k += 1;
      continue;
    }
    // Candidate inbound crossing at `tIn`. Look for the confirmed outbound crossing of this pass.
    const out = searchOutbound(points, distances, k + 1, radius, tIn, beforeMs);
    if (out.atMs != null) {
      if (movesAway(k - 1, out.index)) {
        wrongDirectionSeen = true;
        inboundNotes.add('wrong_direction');
        outboundNotes.add('wrong_direction');
        k = out.index + 1;
        continue;
      }
      return {
        inbound: { atMs: tIn, reason: null },
        outbound: { atMs: out.atMs, reason: null },
      };
    }
    // Entered but no confirmed exit: the inbound edge stands on its own approach direction.
    if (movesAway(k - 1, k)) {
      wrongDirectionSeen = true;
      inboundNotes.add('wrong_direction');
      k += 1;
      continue;
    }
    for (const note of out.notes) {
      outboundNotes.add(note);
    }
    if (out.notes.size === 0) {
      outboundNotes.add('departure_unconfirmed');
    }
    return {
      inbound: { atMs: tIn, reason: null },
      outbound: { atMs: null, reason: pickReason(outboundNotes) },
    };
  }

  // No usable inbound crossing. The outbound edge stands alone (an entry lost to a gap, or too
  // close to the previous boundary for the arrival margin, does not hide a clean departure), unless
  // a pass was already rejected for direction.
  let outbound: CheckpointEdge | null = null;
  if (!wrongDirectionSeen) {
    const out = searchOutbound(points, distances, 1, radius, afterMs, beforeMs);
    for (const note of out.notes) {
      outboundNotes.add(note);
    }
    if (out.atMs != null) {
      if (movesAway(out.index - 1, out.index)) {
        outboundNotes.add('wrong_direction');
      } else {
        outbound = { atMs: out.atMs, reason: null };
      }
    }
  }

  const insideBeforeBoundary = points.some(
    (point, index) => point.t >= windowStartMs && point.t < afterMs && distances[index]! <= radius,
  );
  const outOfOrder = (notes: Set<SegmentUnavailableReason>) => {
    if (notes.size === 0 && insideBeforeBoundary) {
      notes.add('out_of_order');
    }
  };
  outOfOrder(inboundNotes);
  if (outbound == null) {
    outOfOrder(outboundNotes);
  }
  return {
    inbound: { atMs: null, reason: pickReason(inboundNotes) },
    outbound: outbound ?? { atMs: null, reason: pickReason(outboundNotes) },
  };
}

function unavailableSegment(
  from: string | null,
  to: string | null,
  reason: SegmentUnavailableReason,
): DerivedSegment {
  return {
    key: segmentKey(from, to),
    fromCheckpointId: from,
    toCheckpointId: to,
    status: 'unavailable',
    unavailableReason: reason,
    startedAtMs: null,
    endedAtMs: null,
    durationMs: null,
  };
}

function timedSegment(
  from: string | null,
  to: string | null,
  startedAtMs: number,
  endedAtMs: number,
): DerivedSegment {
  if (!(endedAtMs > startedAtMs)) {
    return unavailableSegment(from, to, 'non_positive_duration');
  }
  return {
    key: segmentKey(from, to),
    fromCheckpointId: from,
    toCheckpointId: to,
    status: 'valid',
    unavailableReason: null,
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
  };
}

function notEligible(
  input: DeriveSegmentsInput,
  reason: SegmentNotEligibleReason,
): SegmentDerivation {
  return {
    attemptId: input.attempt.id,
    configVersion: input.config.version,
    derivationVersion: SEGMENT_DERIVATION_VERSION,
    status: 'not_eligible',
    notEligibleReason: reason,
    boundaries: [],
    segments: [],
  };
}

/**
 * The segments a configuration generates for a full attempt: prefix (journey start -> each
 * checkpoint), adjacent (checkpoint -> next checkpoint) and suffix (each checkpoint -> finish),
 * deduplicated by endpoint pair. The official full-route pair (start -> finish) is excluded.
 */
export function expectedFullSegmentPairs(
  checkpointIds: readonly string[],
): { from: string | null; to: string | null }[] {
  const pairs = new Map<string, { from: string | null; to: string | null }>();
  const add = (from: string | null, to: string | null) => {
    if (from == null && to == null) {
      return;
    }
    pairs.set(segmentKey(from, to), { from, to });
  };
  checkpointIds.forEach((id, index) => {
    add(null, id);
    const next = checkpointIds[index + 1];
    if (next != null) {
      add(id, next);
    }
    add(id, null);
  });
  return [...pairs.values()];
}

/**
 * The segments for a partial attempt that started at checkpoint index `startIndex`: only segments
 * that start at that checkpoint or later (adjacent + suffix). The prefix family is anchored at the
 * origin Place and therefore exists for full attempts only.
 */
export function expectedPartialSegmentPairs(
  checkpointIds: readonly string[],
  startIndex: number,
): { from: string | null; to: string | null }[] {
  const pairs = new Map<string, { from: string | null; to: string | null }>();
  for (let index = startIndex; index < checkpointIds.length; index += 1) {
    const id = checkpointIds[index]!;
    const next = checkpointIds[index + 1];
    if (next != null) {
      pairs.set(segmentKey(id, next), { from: id, to: next });
    }
    pairs.set(segmentKey(id, null), { from: id, to: null });
  }
  return [...pairs.values()];
}

export function deriveSegments(input: DeriveSegmentsInput): SegmentDerivation {
  const { attempt, config } = input;
  if (attempt.lifecycle !== 'completed') {
    return notEligible(input, 'not_completed');
  }
  if (attempt.validity !== 'valid') {
    return notEligible(input, 'not_valid');
  }
  const startedAtMs = attempt.startedAtMs;
  const finishedAtMs = attempt.finishedAtMs;
  if (startedAtMs == null || finishedAtMs == null || !(finishedAtMs > startedAtMs)) {
    return notEligible(input, 'missing_official_times');
  }
  if (attempt.originPlaceId == null || attempt.destinationPlaceId == null || !input.origin || !input.destination) {
    return notEligible(input, 'missing_places');
  }

  const checkpoints = config.checkpoints;
  const ids = checkpoints.map((checkpoint) => checkpoint.id);
  const isPartial = attempt.kind === 'partial';
  let startIndex = -1;
  if (isPartial) {
    startIndex = ids.indexOf(attempt.startCheckpointId ?? '');
    if (startIndex < 0) {
      return notEligible(input, 'start_checkpoint_unknown');
    }
  }

  const pairs = isPartial
    ? expectedPartialSegmentPairs(ids, startIndex)
    : expectedFullSegmentPairs(ids);

  const geometryInvalid = new Set<string>();
  for (const checkpoint of checkpoints) {
    const zone = { center: checkpoint.center, radiusMeters: checkpoint.radiusMeters };
    for (const place of [input.origin, input.destination]) {
      if (zonesOverlap(zone, { center: place.center, radiusMeters: placeFootprintRadiusMeters(place) })) {
        geometryInvalid.add(checkpoint.id);
      }
    }
  }

  const points = acceptedPoints(input.samples).filter(
    (point) => point.t >= startedAtMs - SEGMENT_MAX_INTERPOLATION_GAP_MS,
  );
  const hasTelemetry = points.some((point) => point.t >= startedAtMs && point.t <= finishedAtMs);

  const boundaries = new Map<string, CheckpointBoundary>();
  const firstScanIndex = isPartial ? startIndex + 1 : 0;
  if (isPartial) {
    // The start checkpoint's outbound crossing IS the attempt's official start (same edge a
    // through-ride uses); it is taken as stored, never re-derived.
    boundaries.set(ids[startIndex]!, {
      checkpointId: ids[startIndex]!,
      inbound: { atMs: null, reason: 'before_start_checkpoint' },
      outbound: { atMs: startedAtMs, reason: null },
    });
  }

  let previousBoundaryMs = startedAtMs;
  for (let index = firstScanIndex; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index]!;
    let boundary: CheckpointBoundary;
    if (geometryInvalid.has(checkpoint.id)) {
      boundary = {
        checkpointId: checkpoint.id,
        inbound: { atMs: null, reason: 'geometry_invalid' },
        outbound: { atMs: null, reason: 'geometry_invalid' },
      };
    } else if (!hasTelemetry) {
      boundary = {
        checkpointId: checkpoint.id,
        inbound: { atMs: null, reason: 'missing_telemetry' },
        outbound: { atMs: null, reason: 'missing_telemetry' },
      };
    } else {
      const scan = scanCheckpoint(
        points,
        checkpoint,
        input.destination.center,
        previousBoundaryMs,
        finishedAtMs,
        startedAtMs,
      );
      boundary = { checkpointId: checkpoint.id, ...scan };
    }
    boundaries.set(checkpoint.id, boundary);
    if (boundary.outbound.atMs != null) {
      previousBoundaryMs = boundary.outbound.atMs;
    } else if (boundary.inbound.atMs != null) {
      previousBoundaryMs = boundary.inbound.atMs;
    }
  }

  const segments: DerivedSegment[] = pairs.map(({ from, to }) => {
    let start: CheckpointEdge | { atMs: number; reason: null };
    if (from == null) {
      start = { atMs: startedAtMs, reason: null };
    } else {
      start = boundaries.get(from)?.outbound ?? { atMs: null, reason: 'not_reached' };
    }
    if (start.atMs == null) {
      return unavailableSegment(from, to, start.reason);
    }
    let end: CheckpointEdge | { atMs: number; reason: null };
    if (to == null) {
      end = { atMs: finishedAtMs, reason: null };
    } else {
      end = boundaries.get(to)?.inbound ?? { atMs: null, reason: 'not_reached' };
    }
    if (end.atMs == null) {
      return unavailableSegment(from, to, end.reason);
    }
    return timedSegment(from, to, start.atMs, end.atMs);
  });

  return {
    attemptId: attempt.id,
    configVersion: config.version,
    derivationVersion: SEGMENT_DERIVATION_VERSION,
    status: 'derived',
    notEligibleReason: null,
    boundaries: checkpoints.map((checkpoint) => boundaries.get(checkpoint.id)!).filter(Boolean),
    segments,
  };
}

/**
 * The outbound crossing of one checkpoint radius, found with the exact rule `deriveSegments` uses
 * for segment starts. Exposed for the live partial-start logic (a later stage) and for tests that
 * prove a through-ride and a checkpoint start use the same edge. Returns null when no confirmed
 * outbound crossing exists in `(afterMs, beforeMs)`.
 */
export function findOutboundCrossingMs(
  samples: readonly LocationSample[],
  checkpoint: Pick<CompetitiveCheckpoint, 'center' | 'radiusMeters'>,
  afterMs: number = Number.NEGATIVE_INFINITY,
  beforeMs: number = Number.POSITIVE_INFINITY,
): number | null {
  const points = acceptedPoints(samples);
  const distances = points.map((point) => haversineMeters(point, checkpoint.center));
  return searchOutbound(points, distances, 1, checkpoint.radiusMeters, afterMs, beforeMs).atMs;
}

export type AttemptSegmentResult = {
  id: string;
  attemptId: string;
  configVersion: number;
  derivationVersion: number;
  fromCheckpointId: string | null;
  toCheckpointId: string | null;
  status: 'valid' | 'unavailable';
  unavailableReason: SegmentUnavailableReason | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  derivedAtMs: number;
};

export function segmentResultId(
  attemptId: string,
  configVersion: number,
  fromCheckpointId: string | null,
  toCheckpointId: string | null,
): string {
  return `${attemptId}:v${configVersion}:${segmentKey(fromCheckpointId, toCheckpointId)}`;
}

/** Persistable rows for one derivation. A not-eligible derivation yields no rows. */
export function segmentResultsFromDerivation(
  derivation: SegmentDerivation,
  derivedAtMs: number,
): AttemptSegmentResult[] {
  return derivation.segments.map((segment) => ({
    id: segmentResultId(
      derivation.attemptId,
      derivation.configVersion,
      segment.fromCheckpointId,
      segment.toCheckpointId,
    ),
    attemptId: derivation.attemptId,
    configVersion: derivation.configVersion,
    derivationVersion: derivation.derivationVersion,
    fromCheckpointId: segment.fromCheckpointId,
    toCheckpointId: segment.toCheckpointId,
    status: segment.status,
    unavailableReason: segment.unavailableReason,
    startedAtMs: segment.startedAtMs,
    endedAtMs: segment.endedAtMs,
    durationMs: segment.durationMs,
    derivedAtMs,
  }));
}
