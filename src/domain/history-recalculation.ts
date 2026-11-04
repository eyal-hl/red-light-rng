import { sha256Hex } from './sha256';
import type { Attempt, AttemptCheckpointCrossing } from './attempt';
import type { LocationSample } from './location-sample';
import type { Place } from './place';
import { PLACE_ARRIVAL_MIN_INSIDE_SAMPLES, PLACE_DEPARTURE_MIN_SAMPLES, replayPlaceTrace, type PlaceTimingPlace } from './place-timing';

/**
 * Manual, resumable historical recalculation (#77). Pure decision logic only: replays a stored GPS
 * trace through the SAME place-timing engine used for live timing and decides whether the result may
 * replace the stored official window. Persistence, chunking and publication live elsewhere.
 */

export type RecalculationSkipReason = 'endpoint_changed' | 'insufficient_gps';

export const RECALCULATION_SKIP_LABEL: Record<RecalculationSkipReason, string> = {
  endpoint_changed: 'skipped — endpoint/geometry changed',
  insufficient_gps: 'skipped — insufficient GPS',
};

export type AttemptRecalculationOutcome =
  | { kind: 'updated'; startedAtMs: number; finishedAtMs: number }
  | { kind: 'unchanged' }
  | { kind: 'skipped'; reason: RecalculationSkipReason };

export type RecalculationJobStatus = 'running' | 'ready' | 'published' | 'cancelled';

/** A job in one of these states blocks Place centre/radius edits. */
export function isBlockingRecalculationStatus(status: RecalculationJobStatus): boolean {
  return status === 'running' || status === 'ready';
}

export const RECALCULATION_LIVE_ATTEMPT_REASON =
  'Finish or cancel the current run before recalculating history.';
export const RECALCULATION_PAUSED_LIVE_ATTEMPT_MESSAGE =
  'Paused while a run is armed or active. Recalculation continues when no run is open.';
export const RECALCULATION_NO_CANDIDATES_REASON =
  'There are no completed runs with a stored GPS trace to recalculate.';
export const PLACE_RECALCULATION_JOB_REASON =
  'A history recalculation is running or waiting to be published. Cancel or finish it before changing a place location or radius.';
export const RECALCULATION_PLACES_CHANGED_MESSAGE =
  'Place locations or radii changed while the recalculation was pending, so the staged results were discarded and nothing was changed. Start a new recalculation to use the current radii.';
export const RECALCULATION_CANCELLED_MESSAGE =
  'Recalculation cancelled. Staged results were discarded and no run was changed.';
export const RECALCULATION_CONFIRM_WARNING =
  'Recalculating may change previous official times, personal bests, rankings, segments and statistics. Runs without sufficient GPS cannot be updated and keep their original times. Results use the CURRENT departure and arrival radii of each run\'s start and finish place, because earlier radii were not saved.';

type FingerprintPlace = Pick<Place, 'id' | 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters'>;

/** Fingerprint of every Place's ID, centre and both radii (name and status are irrelevant to timing). */
export function recalculationPlacesFingerprint(places: readonly FingerprintPlace[]): string {
  const canonical = [...places]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(
      (place) =>
        `${place.id}|${place.center.latitude}|${place.center.longitude}|${place.departureRadiusMeters}|${place.arrivalRadiusMeters}`,
    )
    .join('\n');
  return sha256Hex(canonical);
}

export function placeGeometryChanged(
  before: Pick<Place, 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters'>,
  after: Pick<Place, 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters'>,
): boolean {
  return (
    before.center.latitude !== after.center.latitude ||
    before.center.longitude !== after.center.longitude ||
    before.departureRadiusMeters !== after.departureRadiusMeters ||
    before.arrivalRadiusMeters !== after.arrivalRadiusMeters
  );
}

/** Minimum accepted fixes needed to confirm one departure and one arrival at all. */
export const RECALCULATION_MIN_ACCEPTED_SAMPLES =
  PLACE_DEPARTURE_MIN_SAMPLES + PLACE_ARRIVAL_MIN_INSIDE_SAMPLES;

function bracketed(accepted: readonly { recordedAtMs: number }[], atMs: number): boolean {
  let before = false;
  let after = false;
  for (const sample of accepted) {
    if (sample.recordedAtMs <= atMs) {
      before = true;
    }
    if (sample.recordedAtMs >= atMs) {
      after = true;
    }
  }
  return before && after;
}

export function evaluateAttemptRecalculation(input: {
  attempt: Attempt;
  samples: LocationSample[];
  places: readonly Place[];
}): AttemptRecalculationOutcome {
  const { attempt, samples, places } = input;
  const origin = places.find((place) => place.id === attempt.originPlaceId);
  const destination = places.find((place) => place.id === attempt.destinationPlaceId);
  if (!origin || !destination || origin.id === destination.id) {
    return { kind: 'skipped', reason: 'endpoint_changed' };
  }
  // Same candidate set live timing sees (active Places), plus the attempt's own endpoints even when
  // archived: archived endpoints still count and use their saved radii.
  const timingPlaces: PlaceTimingPlace[] = places
    .filter((place) => place.status === 'active' || place.id === origin.id || place.id === destination.id)
    .map((place) => ({
      id: place.id,
      name: place.name,
      center: place.center,
      departureRadiusMeters: place.departureRadiusMeters,
      arrivalRadiusMeters: place.arrivalRadiusMeters,
      status: 'active' as const,
    }));
  const lastSampleAtMs = samples.reduce((max, sample) => Math.max(max, sample.recordedAtMs), attempt.armedAtMs);
  // Deterministic: the replay clock is the trace itself, never the wall clock (idempotence).
  const engine = replayPlaceTrace(timingPlaces, samples, {
    armedAtMs: attempt.armedAtMs,
    nowMs: lastSampleAtMs,
  });

  if (engine.accepted.length < RECALCULATION_MIN_ACCEPTED_SAMPLES) {
    return { kind: 'skipped', reason: 'insufficient_gps' };
  }

  if (engine.lifecycle === 'completed') {
    if (
      engine.validity !== 'valid' ||
      engine.originPlaceId !== origin.id ||
      engine.destinationPlaceId !== destination.id ||
      engine.startedAtMs == null ||
      engine.finishedAtMs == null
    ) {
      return { kind: 'skipped', reason: 'endpoint_changed' };
    }
    // Never extrapolate: both crossings must lie between observed accepted fixes, in order.
    if (
      engine.finishedAtMs < engine.startedAtMs ||
      !bracketed(engine.accepted, engine.startedAtMs) ||
      !bracketed(engine.accepted, engine.finishedAtMs)
    ) {
      return { kind: 'skipped', reason: 'insufficient_gps' };
    }
    if (engine.startedAtMs === attempt.startedAtMs && engine.finishedAtMs === attempt.finishedAtMs) {
      return { kind: 'unchanged' };
    }
    return { kind: 'updated', startedAtMs: engine.startedAtMs, finishedAtMs: engine.finishedAtMs };
  }

  // No completed finish at the stored destination. A trace that simply stops being usable before a
  // confirmed departure/arrival (crossing before the first fix or after the last, too few fixes) is
  // "insufficient GPS"; a run that ended differently (return_to_origin, timeout) or that departed
  // from a different Place is "endpoint/geometry changed".
  if (engine.lifecycle === 'ended') {
    return { kind: 'skipped', reason: 'endpoint_changed' };
  }
  if (engine.lifecycle === 'active' && engine.originPlaceId !== origin.id) {
    return { kind: 'skipped', reason: 'endpoint_changed' };
  }
  if (
    engine.lifecycle === 'armed' &&
    engine.originCandidatePlaceId != null &&
    engine.originCandidatePlaceId !== origin.id
  ) {
    return { kind: 'skipped', reason: 'endpoint_changed' };
  }
  return { kind: 'skipped', reason: 'insufficient_gps' };
}

export type StagedAttemptUpdate = {
  startedAtMs: number;
  finishedAtMs: number;
  startedUtcOffsetMinutes: number | null;
  startedTimezoneId: string | null;
  startedLocalTimeSource: Attempt['startedLocalTimeSource'];
  routeId: string | null;
  crossings: AttemptCheckpointCrossing[];
};

/** The stored attempt with a staged recalculation applied. Raw identity fields are never touched. */
export function applyStagedUpdate(attempt: Attempt, staged: StagedAttemptUpdate): Attempt {
  return {
    ...attempt,
    startedAtMs: staged.startedAtMs,
    finishedAtMs: staged.finishedAtMs,
    startedUtcOffsetMinutes: staged.startedUtcOffsetMinutes,
    startedTimezoneId: staged.startedTimezoneId,
    startedLocalTimeSource: staged.startedLocalTimeSource,
    routeId: staged.routeId,
    crossings: staged.crossings.map((crossing) => ({ ...crossing })),
  };
}
