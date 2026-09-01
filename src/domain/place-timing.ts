import type { AttemptLifecycle, AttemptValidity } from './attempt';
import { MAX_SAMPLE_ACCURACY_METERS } from './course-matching';
import { haversineMeters, type LatLng } from './geo';
import type { LocationSample } from './location-sample';
import type { Place } from './place';

export const PLACE_DEPARTURE_MIN_SAMPLES = 4;
export const PLACE_DEPARTURE_SUSTAIN_METERS = 18;
export const PLACE_ARRIVAL_MIN_INSIDE_SAMPLES = 3;
export const PLACE_ARRIVAL_MIN_CONFIRMATION_MS = 2_000;
export const PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS = 10;
export const PLACE_ARMED_MAX_DURATION_MS = 30 * 60 * 1000;
export const PLACE_ACTIVE_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
export const PLACE_RETURN_TO_ORIGIN_DWELL_MS = 30_000;
export const PLACE_RETURN_TO_ORIGIN_MIN_DISTANCE_METERS = 50;

export { MAX_SAMPLE_ACCURACY_METERS };

export type PlaceTimingPlace = Pick<Place, 'id' | 'name' | 'center' | 'radiusMeters' | 'status'>;

export type PlaceStartZoneStatus = {
  status: 'locating' | 'outside' | 'inside';
  placeId: string | null;
  placeName: string | null;
  distanceMeters: number | null;
  overlapTieBreak: 'nearest' | 'lowest-id' | null;
};

export type PlaceEndReason =
  | 'destination'
  | 'armed_timeout'
  | 'active_timeout'
  | 'return_to_origin'
  | null;

export type AcceptedPlaceSample = {
  recordedAtMs: number;
  latitude: number;
  longitude: number;
};

export type DestinationWatchState = {
  placeId: string;
  seenEligibleOutside: boolean;
  maxDistanceMeters: number;
  lastInside: boolean | null;
  arrivalCrossingAtMs: number | null;
  insideSinceArrivalCount: number;
  insideSinceArrivalFirstAtMs: number | null;
  insideSinceArrivalLastAtMs: number | null;
};

export type PlaceEngineState = {
  lifecycle: AttemptLifecycle;
  validity: AttemptValidity;
  accepted: AcceptedPlaceSample[];
  rejectedPoorAccuracy: number;
  originPlaceId: string | null;
  destinationPlaceId: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  lastSampleAtMs: number | null;
  lastAccepted: AcceptedPlaceSample | null;
  startZone: PlaceStartZoneStatus;
  originCandidatePlaceId: string | null;
  lastInsideOrigin: boolean | null;
  departureCrossingAtMs: number | null;
  samplesAfterDeparture: number;
  maxRadialFromOriginMeters: number | null;
  maxDistanceFromOriginMeters: number;
  insideOriginSinceMs: number | null;
  destinations: DestinationWatchState[];
  endReason: PlaceEndReason;
};

export type PlaceTimingContext = {
  armedAtMs: number;
  nowMs: number;
};

function samplePoint(sample: Pick<AcceptedPlaceSample, 'latitude' | 'longitude'>): LatLng {
  return { latitude: sample.latitude, longitude: sample.longitude };
}

function locatingStatus(): PlaceStartZoneStatus {
  return {
    status: 'locating',
    placeId: null,
    placeName: null,
    distanceMeters: null,
    overlapTieBreak: null,
  };
}

function outsideStatus(distanceMeters: number | null): PlaceStartZoneStatus {
  return {
    status: 'outside',
    placeId: null,
    placeName: null,
    distanceMeters,
    overlapTieBreak: null,
  };
}

export function isAccuracyAccepted(sample: LocationSample): boolean {
  if (sample.horizontalAccuracyMeters == null) {
    return true;
  }
  return sample.horizontalAccuracyMeters <= MAX_SAMPLE_ACCURACY_METERS;
}

export function interpolateRadiusCrossing(
  previous: { recordedAtMs: number; distanceMeters: number },
  current: { recordedAtMs: number; distanceMeters: number },
  radiusMeters: number,
): number {
  const span = current.distanceMeters - previous.distanceMeters;
  if (span === 0) {
    return current.recordedAtMs;
  }
  const t = (radiusMeters - previous.distanceMeters) / span;
  const clamped = Math.min(1, Math.max(0, t));
  return previous.recordedAtMs + clamped * (current.recordedAtMs - previous.recordedAtMs);
}

export function returnToOriginThresholdMeters(originRadiusMeters: number): number {
  return Math.max(PLACE_RETURN_TO_ORIGIN_MIN_DISTANCE_METERS, 2 * originRadiusMeters);
}

export function selectOriginCandidate(
  places: PlaceTimingPlace[],
  point: LatLng,
): {
  place: PlaceTimingPlace;
  distanceMeters: number;
  overlapTieBreak: 'nearest' | 'lowest-id';
} | null {
  const inside = places
    .filter((place) => place.status === 'active')
    .map((place) => ({
      place,
      distanceMeters: haversineMeters(point, place.center),
    }))
    .filter((item) => item.distanceMeters <= item.place.radiusMeters);
  if (inside.length === 0) {
    return null;
  }
  inside.sort((a, b) => {
    if (a.distanceMeters !== b.distanceMeters) {
      return a.distanceMeters - b.distanceMeters;
    }
    return a.place.id.localeCompare(b.place.id);
  });
  const winner = inside[0];
  if (!winner) {
    return null;
  }
  const sameDistance = inside.filter((item) => item.distanceMeters === winner.distanceMeters);
  return {
    ...winner,
    overlapTieBreak: sameDistance.length > 1 ? 'lowest-id' : 'nearest',
  };
}

export function createPlaceEngineState(): PlaceEngineState {
  return {
    lifecycle: 'armed',
    validity: 'pending',
    accepted: [],
    rejectedPoorAccuracy: 0,
    originPlaceId: null,
    destinationPlaceId: null,
    startedAtMs: null,
    finishedAtMs: null,
    lastSampleAtMs: null,
    lastAccepted: null,
    startZone: locatingStatus(),
    originCandidatePlaceId: null,
    lastInsideOrigin: null,
    departureCrossingAtMs: null,
    samplesAfterDeparture: 0,
    maxRadialFromOriginMeters: null,
    maxDistanceFromOriginMeters: 0,
    insideOriginSinceMs: null,
    destinations: [],
    endReason: null,
  };
}

function cloneEngine(state: PlaceEngineState): PlaceEngineState {
  return {
    ...state,
    accepted: [...state.accepted],
    startZone: { ...state.startZone },
    lastAccepted: state.lastAccepted ? { ...state.lastAccepted } : null,
    destinations: state.destinations.map((item) => ({ ...item })),
  };
}

function findPlace(places: PlaceTimingPlace[], placeId: string | null): PlaceTimingPlace | null {
  if (!placeId) {
    return null;
  }
  return places.find((place) => place.id === placeId) ?? null;
}

function emptyDestinationWatch(placeId: string): DestinationWatchState {
  return {
    placeId,
    seenEligibleOutside: false,
    maxDistanceMeters: 0,
    lastInside: null,
    arrivalCrossingAtMs: null,
    insideSinceArrivalCount: 0,
    insideSinceArrivalFirstAtMs: null,
    insideSinceArrivalLastAtMs: null,
  };
}

function resetDeparture(state: PlaceEngineState): void {
  state.departureCrossingAtMs = null;
  state.samplesAfterDeparture = 0;
  state.maxRadialFromOriginMeters = null;
}

function resetArrival(watch: DestinationWatchState): void {
  watch.arrivalCrossingAtMs = null;
  watch.insideSinceArrivalCount = 0;
  watch.insideSinceArrivalFirstAtMs = null;
  watch.insideSinceArrivalLastAtMs = null;
}

function endAttempt(state: PlaceEngineState, reason: Exclude<PlaceEndReason, null>): PlaceEngineState {
  return {
    ...state,
    lifecycle: 'ended',
    validity: 'unranked',
    endReason: reason,
  };
}

export function applyPlaceTimeouts(state: PlaceEngineState, context: PlaceTimingContext): PlaceEngineState {
  if (state.lifecycle !== 'armed' && state.lifecycle !== 'active') {
    return state;
  }
  if (state.lifecycle === 'armed' && context.nowMs - context.armedAtMs >= PLACE_ARMED_MAX_DURATION_MS) {
    return endAttempt(cloneEngine(state), 'armed_timeout');
  }
  if (
    state.lifecycle === 'active' &&
    state.startedAtMs != null &&
    context.nowMs - state.startedAtMs >= PLACE_ACTIVE_MAX_DURATION_MS
  ) {
    return endAttempt(cloneEngine(state), 'active_timeout');
  }
  return state;
}

function maybeReturnToOrigin(
  state: PlaceEngineState,
  origin: PlaceTimingPlace,
  nowMs: number,
): PlaceEngineState {
  if (state.lifecycle !== 'active' || state.insideOriginSinceMs == null) {
    return state;
  }
  const threshold = returnToOriginThresholdMeters(origin.radiusMeters);
  if (state.maxDistanceFromOriginMeters < threshold) {
    return state;
  }
  if (nowMs - state.insideOriginSinceMs >= PLACE_RETURN_TO_ORIGIN_DWELL_MS) {
    return endAttempt(state, 'return_to_origin');
  }
  return state;
}

function startZoneFromCandidate(
  candidate: ReturnType<typeof selectOriginCandidate>,
): PlaceStartZoneStatus {
  if (!candidate) {
    return outsideStatus(null);
  }
  return {
    status: 'inside',
    placeId: candidate.place.id,
    placeName: candidate.place.name,
    distanceMeters: candidate.distanceMeters,
    overlapTieBreak: candidate.overlapTieBreak,
  };
}

function promoteToActive(
  state: PlaceEngineState,
  origin: PlaceTimingPlace,
  places: PlaceTimingPlace[],
): PlaceEngineState {
  const next = cloneEngine(state);
  next.lifecycle = 'active';
  next.originPlaceId = origin.id;
  next.startedAtMs = state.departureCrossingAtMs;
  next.destinations = places
    .filter((place) => place.status === 'active' && place.id !== origin.id)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((place) => emptyDestinationWatch(place.id));
  return next;
}

function originForDeparture(
  places: PlaceTimingPlace[],
  originPlaceId: string | null,
): PlaceTimingPlace | null {
  return findPlace(places, originPlaceId);
}

function ingestArmed(
  state: PlaceEngineState,
  places: PlaceTimingPlace[],
  accepted: AcceptedPlaceSample,
  sampleTimeMs: number,
  context: PlaceTimingContext,
): PlaceEngineState {
  if (sampleTimeMs - context.armedAtMs >= PLACE_ARMED_MAX_DURATION_MS) {
    return endAttempt(state, 'armed_timeout');
  }

  const candidate = selectOriginCandidate(places, samplePoint(accepted));
  const next = cloneEngine(state);
  next.startZone = startZoneFromCandidate(candidate);
  const candidateId = candidate?.place.id ?? null;
  const previous = next.lastAccepted;

  if (candidate) {
    if (candidateId !== next.originCandidatePlaceId) {
      next.originCandidatePlaceId = candidateId;
      next.lastInsideOrigin = true;
      resetDeparture(next);
      next.lastAccepted = accepted;
      return next;
    }
    resetDeparture(next);
    next.lastInsideOrigin = true;
    next.lastAccepted = accepted;
    return next;
  }

  const origin = originForDeparture(places, next.originCandidatePlaceId);
  if (!origin) {
    next.originCandidatePlaceId = null;
    next.lastInsideOrigin = false;
    resetDeparture(next);
    next.lastAccepted = accepted;
    return next;
  }

  const distanceMeters = haversineMeters(samplePoint(accepted), origin.center);
  const previousDistance =
    previous != null ? haversineMeters(samplePoint(previous), origin.center) : null;

  if (next.lastInsideOrigin === true && previous && previousDistance != null) {
    next.departureCrossingAtMs = interpolateRadiusCrossing(
      { recordedAtMs: previous.recordedAtMs, distanceMeters: previousDistance },
      { recordedAtMs: accepted.recordedAtMs, distanceMeters },
      origin.radiusMeters,
    );
    next.samplesAfterDeparture = 1;
    next.maxRadialFromOriginMeters = distanceMeters;
  } else if (next.departureCrossingAtMs != null) {
    next.samplesAfterDeparture += 1;
    next.maxRadialFromOriginMeters = Math.max(next.maxRadialFromOriginMeters ?? 0, distanceMeters);
    if (
      next.samplesAfterDeparture >= PLACE_DEPARTURE_MIN_SAMPLES &&
      (next.maxRadialFromOriginMeters ?? 0) >= origin.radiusMeters + PLACE_DEPARTURE_SUSTAIN_METERS
    ) {
      next.lastInsideOrigin = false;
      next.lastAccepted = accepted;
      return promoteToActive(next, origin, places);
    }
  }

  next.lastInsideOrigin = false;
  next.lastAccepted = accepted;
  return next;
}

function watchFor(state: PlaceEngineState, placeId: string): DestinationWatchState {
  const existing = state.destinations.find((item) => item.placeId === placeId);
  if (existing) {
    return existing;
  }
  const created = emptyDestinationWatch(placeId);
  state.destinations.push(created);
  return created;
}

function ingestActive(
  state: PlaceEngineState,
  places: PlaceTimingPlace[],
  accepted: AcceptedPlaceSample,
  sampleTimeMs: number,
  context: PlaceTimingContext,
): PlaceEngineState {
  if (state.startedAtMs != null && sampleTimeMs - state.startedAtMs >= PLACE_ACTIVE_MAX_DURATION_MS) {
    return endAttempt(state, 'active_timeout');
  }

  const origin = findPlace(places, state.originPlaceId);
  if (!origin) {
    return state;
  }

  const next = cloneEngine(state);
  const originDistance = haversineMeters(samplePoint(accepted), origin.center);
  next.maxDistanceFromOriginMeters = Math.max(next.maxDistanceFromOriginMeters, originDistance);
  const insideOrigin = originDistance <= origin.radiusMeters;
  if (insideOrigin) {
    if (next.insideOriginSinceMs == null) {
      next.insideOriginSinceMs = accepted.recordedAtMs;
    }
  } else {
    next.insideOriginSinceMs = null;
  }
  const afterReturn = maybeReturnToOrigin(next, origin, sampleTimeMs);
  if (afterReturn.lifecycle !== 'active') {
    afterReturn.lastAccepted = accepted;
    return afterReturn;
  }

  const destinationPlaces = places.filter(
    (place) => place.status === 'active' && place.id !== origin.id,
  );
  for (const place of destinationPlaces) {
    const watch = watchFor(afterReturn, place.id);
    const distanceMeters = haversineMeters(samplePoint(accepted), place.center);
    watch.maxDistanceMeters = Math.max(watch.maxDistanceMeters, distanceMeters);
    if (distanceMeters >= place.radiusMeters + PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS) {
      watch.seenEligibleOutside = true;
    }
    const inside = distanceMeters <= place.radiusMeters;
    const previous = afterReturn.lastAccepted;
    const previousDistance =
      previous != null ? haversineMeters(samplePoint(previous), place.center) : null;
    if (
      watch.seenEligibleOutside &&
      watch.lastInside === false &&
      inside &&
      previous &&
      previousDistance != null &&
      previousDistance > place.radiusMeters
    ) {
      watch.arrivalCrossingAtMs = interpolateRadiusCrossing(
        { recordedAtMs: previous.recordedAtMs, distanceMeters: previousDistance },
        { recordedAtMs: accepted.recordedAtMs, distanceMeters },
        place.radiusMeters,
      );
      watch.insideSinceArrivalCount = 1;
      watch.insideSinceArrivalFirstAtMs = accepted.recordedAtMs;
      watch.insideSinceArrivalLastAtMs = accepted.recordedAtMs;
    } else if (watch.arrivalCrossingAtMs != null) {
      if (!inside) {
        resetArrival(watch);
      } else {
        watch.insideSinceArrivalCount += 1;
        if (watch.insideSinceArrivalFirstAtMs == null) {
          watch.insideSinceArrivalFirstAtMs = accepted.recordedAtMs;
        }
        watch.insideSinceArrivalLastAtMs = accepted.recordedAtMs;
        const spanMs =
          watch.insideSinceArrivalLastAtMs != null && watch.insideSinceArrivalFirstAtMs != null
            ? watch.insideSinceArrivalLastAtMs - watch.insideSinceArrivalFirstAtMs
            : 0;
        if (
          watch.insideSinceArrivalCount >= PLACE_ARRIVAL_MIN_INSIDE_SAMPLES &&
          spanMs >= PLACE_ARRIVAL_MIN_CONFIRMATION_MS &&
          watch.arrivalCrossingAtMs >= (afterReturn.startedAtMs ?? 0)
        ) {
          afterReturn.lifecycle = 'completed';
          afterReturn.validity = 'valid';
          afterReturn.destinationPlaceId = place.id;
          afterReturn.finishedAtMs = watch.arrivalCrossingAtMs;
          afterReturn.endReason = 'destination';
          afterReturn.lastAccepted = accepted;
          afterReturn.lastInsideOrigin = insideOrigin;
          return afterReturn;
        }
      }
    }
    watch.lastInside = inside;
  }

  afterReturn.lastInsideOrigin = insideOrigin;
  afterReturn.lastAccepted = accepted;
  return afterReturn;
}

export function ingestPlaceSample(
  state: PlaceEngineState,
  places: PlaceTimingPlace[],
  sample: LocationSample,
  context: PlaceTimingContext,
): PlaceEngineState {
  if (state.lifecycle !== 'armed' && state.lifecycle !== 'active') {
    return state;
  }

  const next = cloneEngine(state);
  next.lastSampleAtMs = sample.recordedAtMs;

  if (!isAccuracyAccepted(sample)) {
    next.rejectedPoorAccuracy += 1;
    if (next.lifecycle === 'armed') {
      next.startZone = locatingStatus();
    }
    return applyPlaceTimeouts(next, { ...context, nowMs: sample.recordedAtMs });
  }

  const accepted: AcceptedPlaceSample = {
    recordedAtMs: sample.recordedAtMs,
    latitude: sample.latitude,
    longitude: sample.longitude,
  };
  next.accepted.push(accepted);

  const ingested =
    next.lifecycle === 'armed'
      ? ingestArmed(next, places, accepted, sample.recordedAtMs, context)
      : ingestActive(next, places, accepted, sample.recordedAtMs, context);
  ingested.accepted = next.accepted;
  ingested.rejectedPoorAccuracy = next.rejectedPoorAccuracy;
  ingested.lastSampleAtMs = sample.recordedAtMs;
  return applyPlaceTimeouts(ingested, { ...context, nowMs: sample.recordedAtMs });
}

export function finalizePlaceEngine(
  state: PlaceEngineState,
  places: PlaceTimingPlace[],
  context: PlaceTimingContext,
): PlaceEngineState {
  const timed = applyPlaceTimeouts(state, context);
  if (timed.lifecycle !== 'active') {
    return timed;
  }
  const origin = findPlace(places, timed.originPlaceId);
  if (!origin) {
    return timed;
  }
  return maybeReturnToOrigin(cloneEngine(timed), origin, context.nowMs);
}

export function replayPlaceTrace(
  places: PlaceTimingPlace[],
  samples: LocationSample[],
  context: PlaceTimingContext,
): PlaceEngineState {
  const replayed = samples.reduce(
    (state, sample) => ingestPlaceSample(state, places, sample, context),
    createPlaceEngineState(),
  );
  return finalizePlaceEngine(replayed, places, context);
}

export function derivePlaceStartZoneStatus(
  places: PlaceTimingPlace[],
  samples: LocationSample[],
  engine: PlaceEngineState,
): PlaceStartZoneStatus {
  if (engine.lifecycle !== 'armed') {
    return locatingStatus();
  }
  const latest = samples[samples.length - 1];
  if (!latest) {
    return locatingStatus();
  }
  if (!isAccuracyAccepted(latest)) {
    return locatingStatus();
  }
  const candidate = selectOriginCandidate(places, samplePoint(latest));
  if (!candidate) {
    return {
      ...outsideStatus(null),
      distanceMeters: nearestActiveDistance(places, samplePoint(latest)),
    };
  }
  return startZoneFromCandidate(candidate);
}

function nearestActiveDistance(places: PlaceTimingPlace[], point: LatLng): number | null {
  let nearest: number | null = null;
  for (const place of places) {
    if (place.status !== 'active') {
      continue;
    }
    const distance = haversineMeters(point, place.center);
    if (nearest == null || distance < nearest) {
      nearest = distance;
    }
  }
  return nearest;
}
