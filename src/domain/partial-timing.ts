import type { CompetitiveCheckpoint } from './competitive-checkpoint';
import { haversineMeters, type LatLng } from './geo';
import type { Place } from './place';
import {
  createPlaceEngineState,
  finalizePlaceEngine,
  ingestPlaceSample,
  type PlaceEngineState,
  type PlaceTimingContext,
  type PlaceTimingPlace,
} from './place-timing';
import type { LocationSample } from './location-sample';
import { SEGMENT_DIRECTION_TOLERANCE_METERS } from './segment-derivation';

/**
 * Live timing of a PARTIAL attempt (DEC-016, #81): a run that starts at a competitive checkpoint.
 *
 * It reuses the place-timing engine unchanged. The checkpoint is presented to the engine as the
 * ONLY origin (its radius is both departure and arrival radius) and the journey's destination as the
 * ONLY destination, so:
 * - approaching or entering the checkpoint never starts timing; the official start is the
 *   interpolated OUTBOUND crossing of its radius confirmed by the same sustained departure
 *   (>= 4 samples, radius + 18 m) as a Place departure and as segment starts on a through-ride
 *   (`deriveSegments`), so both use the same edge;
 * - armed outside or inside the checkpoint behaves the same: wait for a valid departure;
 * - other checkpoints are not places, so crossing them can never finish the run; and no other Place
 *   can finish it either. The finish is the normal destination arrival.
 *
 * One rule is added: a departure must head toward the destination. If the sustained departure ends
 * more than `SEGMENT_DIRECTION_TOLERANCE_METERS` FARTHER from the destination than the last fix
 * before the crossing, it is rejected and the run keeps waiting (the rider must re-enter the
 * checkpoint and leave toward the destination).
 */

export function checkpointAsTimingPlace(checkpoint: CompetitiveCheckpoint): PlaceTimingPlace {
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    center: checkpoint.center,
    departureRadiusMeters: checkpoint.radiusMeters,
    arrivalRadiusMeters: checkpoint.radiusMeters,
    status: 'active',
  };
}

/** The place set a partial attempt is timed against: [checkpoint (origin), destination]. */
export function partialTimingPlaces(
  checkpoint: CompetitiveCheckpoint,
  destination: Pick<Place, 'id' | 'name' | 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters'>,
): Place[] {
  return [
    { ...checkpointAsTimingPlace(checkpoint), createdAtMs: 0 },
    {
      id: destination.id,
      name: destination.name,
      center: destination.center,
      departureRadiusMeters: destination.departureRadiusMeters,
      arrivalRadiusMeters: destination.arrivalRadiusMeters,
      status: 'active',
      createdAtMs: 0,
    },
  ];
}

function rejectWrongDirectionStart(state: PlaceEngineState, destination: LatLng): PlaceEngineState {
  const startedAtMs = state.startedAtMs;
  const last = state.lastAccepted;
  if (startedAtMs == null || !last) {
    return state;
  }
  let before: (typeof state.accepted)[number] | null = null;
  for (const sample of state.accepted) {
    if (sample.recordedAtMs < startedAtMs) {
      before = sample;
    }
  }
  if (!before) {
    return state;
  }
  const movedAway =
    haversineMeters(last, destination) - haversineMeters(before, destination) > SEGMENT_DIRECTION_TOLERANCE_METERS;
  if (!movedAway) {
    return state;
  }
  // Back to waiting for a departure: keep the raw evidence, forget the rejected one.
  return {
    ...createPlaceEngineState(),
    accepted: state.accepted,
    rejectedPoorAccuracy: state.rejectedPoorAccuracy,
    lastSampleAtMs: state.lastSampleAtMs,
    lastAccepted: state.lastAccepted,
    startZone: { ...state.startZone },
  };
}

/** Ingests one raw sample for a partial attempt (same contract as `ingestPlaceSample`). */
export function ingestPartialSample(
  state: PlaceEngineState,
  places: PlaceTimingPlace[],
  destination: LatLng,
  sample: LocationSample,
  context: PlaceTimingContext,
): PlaceEngineState {
  const wasArmed = state.lifecycle === 'armed';
  const next = ingestPlaceSample(state, places, sample, context);
  return wasArmed && next.lifecycle !== 'armed' && next.startedAtMs != null
    ? rejectWrongDirectionStart(next, destination)
    : next;
}

/** Replays a stored trace for a partial attempt; deterministic, clock = the trace and `context.nowMs`. */
export function replayPartialTrace(
  places: PlaceTimingPlace[],
  destination: LatLng,
  samples: LocationSample[],
  context: PlaceTimingContext,
): PlaceEngineState {
  const replayed = samples.reduce(
    (state, sample) => ingestPartialSample(state, places, destination, sample, context),
    createPlaceEngineState(),
  );
  return finalizePlaceEngine(replayed, places, context);
}
