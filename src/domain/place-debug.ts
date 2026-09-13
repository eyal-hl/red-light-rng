import { incompleteAttemptLabel, type Attempt, type IncompleteAttemptLabel } from './attempt';
import { haversineMeters, type LatLng } from './geo';
import type { LocationSample } from './location-sample';
import type { Place } from './place';
import {
  isAccuracyAccepted,
  PLACE_ACTIVE_MAX_DURATION_MS,
  PLACE_ARMED_MAX_DURATION_MS,
  PLACE_ARRIVAL_MIN_CONFIRMATION_MS,
  PLACE_ARRIVAL_MIN_INSIDE_SAMPLES,
  PLACE_DEPARTURE_MIN_SAMPLES,
  PLACE_DEPARTURE_SUSTAIN_METERS,
  PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS,
  replayPlaceTrace,
  selectOriginCandidate,
  type DestinationWatchState,
  type PlaceEndReason,
  type PlaceEngineState,
  type PlaceTimingPlace,
} from './place-timing';

export type PlaceDebugSample = {
  sample: LocationSample;
  accepted: boolean;
  poorAccuracy: boolean;
  originCandidatePlaceId: string | null;
  insidePlaceIds: string[];
  nearestPlaceId: string | null;
  nearestDistanceMeters: number | null;
};

export type PlaceDistanceDebug = {
  placeId: string;
  name: string;
  distanceMeters: number | null;
  inside: boolean;
};

export type PlaceDestinationDebug = {
  placeId: string;
  name: string;
  eligible: boolean;
  maxDistanceMeters: number;
  requiredEligibleMeters: number;
  arrivalCrossingAtMs: number | null;
  insideSampleCount: number;
  confirmationSpanMs: number | null;
  lastInside: boolean | null;
};

export type PlaceAttemptDebugReport = {
  rawSampleCount: number;
  acceptedCount: number;
  rejectedPoorAccuracy: number;
  firstRecordedAtMs: number | null;
  lastRecordedAtMs: number | null;
  places: PlaceDistanceDebug[];
  originCandidatePlaceId: string | null;
  originCandidateName: string | null;
  overlapTieBreak: 'nearest' | 'lowest-id' | null;
  departureCrossingAtMs: number | null;
  samplesAfterDeparture: number;
  maxRadialFromOriginMeters: number | null;
  requiredRadialMeters: number | null;
  departureMinSamples: number;
  qualifyingDeparture: boolean;
  reconstructedStartAtMs: number | null;
  pinnedOriginPlaceId: string | null;
  destinations: PlaceDestinationDebug[];
  reconstructedFinishAtMs: number | null;
  pinnedDestinationPlaceId: string | null;
  armedTimeout: boolean;
  activeTimeout: boolean;
  endReason: PlaceEndReason;
  engine: PlaceEngineState;
  samples: PlaceDebugSample[];
  recordedPath: LatLng[];
  officialStartPoint: LatLng | null;
  officialFinishPoint: LatLng | null;
  incompleteLabel: IncompleteAttemptLabel | null;
};

function samplePoint(sample: LocationSample): LatLng {
  return { latitude: sample.latitude, longitude: sample.longitude };
}

function placeById(places: PlaceTimingPlace[], placeId: string | null): PlaceTimingPlace | null {
  if (!placeId) {
    return null;
  }
  return places.find((place) => place.id === placeId) ?? null;
}

function pointNearestTime(samples: PlaceDebugSample[], atMs: number | null): LatLng | null {
  if (atMs == null || samples.length === 0) {
    return null;
  }
  let nearest: PlaceDebugSample | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const entry of samples) {
    const delta = Math.abs(entry.sample.recordedAtMs - atMs);
    if (delta < nearestDelta) {
      nearest = entry;
      nearestDelta = delta;
    }
  }
  return nearest ? samplePoint(nearest.sample) : null;
}

function destinationDebug(
  places: PlaceTimingPlace[],
  watch: DestinationWatchState,
): PlaceDestinationDebug {
  const place = placeById(places, watch.placeId);
  const confirmationSpanMs =
    watch.insideSinceArrivalFirstAtMs != null && watch.insideSinceArrivalLastAtMs != null
      ? watch.insideSinceArrivalLastAtMs - watch.insideSinceArrivalFirstAtMs
      : null;
  return {
    placeId: watch.placeId,
    name: place?.name ?? watch.placeId,
    eligible: watch.seenEligibleOutside,
    maxDistanceMeters: watch.maxDistanceMeters,
    requiredEligibleMeters: (place?.radiusMeters ?? 0) + PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS,
    arrivalCrossingAtMs: watch.arrivalCrossingAtMs,
    insideSampleCount: watch.insideSinceArrivalCount,
    confirmationSpanMs,
    lastInside: watch.lastInside,
  };
}

export function inspectPlaceAttempt(
  places: PlaceTimingPlace[],
  samples: LocationSample[],
  context: { armedAtMs: number; nowMs: number },
): PlaceAttemptDebugReport {
  const engine = replayPlaceTrace(places, samples, context);
  const inspected: PlaceDebugSample[] = [];
  const latest = samples[samples.length - 1] ?? null;
  const latestPoint = latest ? samplePoint(latest) : null;
  const latestCandidate =
    latest && isAccuracyAccepted(latest) ? selectOriginCandidate(places, latestPoint!) : null;

  for (const sample of samples) {
    const point = samplePoint(sample);
    const poorAccuracy = !isAccuracyAccepted(sample);
    const insidePlaceIds: string[] = [];
    let nearestPlaceId: string | null = null;
    let nearestDistanceMeters: number | null = null;
    for (const place of places) {
      const distance = haversineMeters(point, place.center);
      if (nearestDistanceMeters == null || distance < nearestDistanceMeters) {
        nearestDistanceMeters = distance;
        nearestPlaceId = place.id;
      }
      if (distance <= place.radiusMeters) {
        insidePlaceIds.push(place.id);
      }
    }
    const originCandidate =
      poorAccuracy ? null : selectOriginCandidate(places, point);
    inspected.push({
      sample,
      accepted: !poorAccuracy,
      poorAccuracy,
      originCandidatePlaceId: originCandidate?.place.id ?? null,
      insidePlaceIds,
      nearestPlaceId,
      nearestDistanceMeters,
    });
  }

  const origin = placeById(places, engine.originPlaceId ?? engine.originCandidatePlaceId);
  const placeDistances: PlaceDistanceDebug[] = places.map((place) => {
    const distanceMeters = latestPoint ? haversineMeters(latestPoint, place.center) : null;
    return {
      placeId: place.id,
      name: place.name,
      distanceMeters,
      inside: distanceMeters != null && distanceMeters <= place.radiusMeters,
    };
  });

  return {
    rawSampleCount: samples.length,
    acceptedCount: engine.accepted.length,
    rejectedPoorAccuracy: engine.rejectedPoorAccuracy,
    firstRecordedAtMs: samples[0]?.recordedAtMs ?? null,
    lastRecordedAtMs: samples[samples.length - 1]?.recordedAtMs ?? null,
    places: placeDistances,
    originCandidatePlaceId: engine.originCandidatePlaceId,
    originCandidateName: latestCandidate?.place.name ?? origin?.name ?? null,
    overlapTieBreak: latestCandidate?.overlapTieBreak ?? engine.startZone.overlapTieBreak,
    departureCrossingAtMs: engine.departureCrossingAtMs,
    samplesAfterDeparture: engine.samplesAfterDeparture,
    maxRadialFromOriginMeters: engine.maxRadialFromOriginMeters,
    requiredRadialMeters: origin
      ? origin.radiusMeters + PLACE_DEPARTURE_SUSTAIN_METERS
      : latestCandidate
        ? latestCandidate.place.radiusMeters + PLACE_DEPARTURE_SUSTAIN_METERS
        : null,
    departureMinSamples: PLACE_DEPARTURE_MIN_SAMPLES,
    qualifyingDeparture: engine.startedAtMs != null,
    reconstructedStartAtMs: engine.startedAtMs,
    pinnedOriginPlaceId: engine.originPlaceId,
    destinations: engine.destinations.map((watch) => destinationDebug(places, watch)),
    reconstructedFinishAtMs: engine.finishedAtMs,
    pinnedDestinationPlaceId: engine.destinationPlaceId,
    armedTimeout: engine.endReason === 'armed_timeout',
    activeTimeout: engine.endReason === 'active_timeout',
    endReason: engine.endReason,
    engine,
    samples: inspected,
    recordedPath: samples.map(samplePoint),
    officialStartPoint: pointNearestTime(inspected, engine.startedAtMs),
    officialFinishPoint: pointNearestTime(inspected, engine.finishedAtMs),
    incompleteLabel: null,
  };
}

export function inspectPlaceAttemptRecord(
  attempt: Pick<Attempt, 'lifecycle' | 'startedAtMs' | 'armedAtMs'>,
  places: Place[] | PlaceTimingPlace[],
  samples: LocationSample[],
  nowMs: number,
): PlaceAttemptDebugReport {
  return {
    ...inspectPlaceAttempt(places, samples, { armedAtMs: attempt.armedAtMs, nowMs }),
    incompleteLabel: incompleteAttemptLabel(attempt),
  };
}

export const PLACE_ARRIVAL_DEBUG_MIN_INSIDE_SAMPLES = PLACE_ARRIVAL_MIN_INSIDE_SAMPLES;
export const PLACE_ARRIVAL_DEBUG_MIN_CONFIRMATION_MS = PLACE_ARRIVAL_MIN_CONFIRMATION_MS;
export const PLACE_ARMED_DEBUG_MAX_DURATION_MS = PLACE_ARMED_MAX_DURATION_MS;
export const PLACE_ACTIVE_DEBUG_MAX_DURATION_MS = PLACE_ACTIVE_MAX_DURATION_MS;
