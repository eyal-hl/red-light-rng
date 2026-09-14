import type { Attempt } from '../domain/attempt';
import { isJourneyCompetitive } from '../domain/attempt';
import { journeyPoolKey, type JourneyPoolId } from '../domain/journey';
import { isInRollingElapsedWindow, ROLLING_WINDOW_30_DAYS, ROLLING_WINDOW_7_DAYS } from '../domain/journey-statistics';
import type { Place } from '../domain/place';
import type { Route, TransportationMode } from '../domain/route';
import type { TrackingSessionRecord } from '../persistence/location-sample-store';

export type SampleIdentity = {
  sessionId: string;
  lastSampleAtMs: number | null;
};

export class SingleKeyedCache<T> {
  private key: string | null = null;
  private value: T | null = null;

  get(key: string): T | null {
    return this.key === key ? this.value : null;
  }

  set(key: string, value: T): void {
    this.key = key;
    this.value = value;
  }
}

export class MapKeyedCache<T> {
  private readonly values = new Map<string, T>();

  get(key: string): T | undefined {
    return this.values.get(key);
  }

  set(key: string, value: T): void {
    this.values.set(key, value);
  }
}

function fingerprintPoint(point: { latitude: number; longitude: number }): string {
  return `${point.latitude},${point.longitude}`;
}

export function fingerprintAttempt(attempt: Attempt): string {
  const crossings = attempt.crossings
    .map(
      (crossing) =>
        `${crossing.id}:${crossing.checkpointId}:${crossing.checkpointProgressMeters}:${crossing.crossedAtMs}`,
    )
    .join(',');
  return [
    attempt.id,
    attempt.routeId ?? '',
    attempt.originPlaceId ?? '',
    attempt.destinationPlaceId ?? '',
    attempt.transportationMode,
    attempt.lifecycle,
    attempt.validity,
    String(attempt.armedAtMs),
    attempt.startedAtMs ?? '',
    attempt.finishedAtMs ?? '',
    attempt.startedUtcOffsetMinutes ?? '',
    attempt.startedTimezoneId ?? '',
    attempt.startedLocalTimeSource ?? '',
    attempt.resultAcknowledged ? '1' : '0',
    attempt.sessionId,
    crossings,
  ].join('|');
}

export function fingerprintAttempts(attempts: readonly Attempt[]): string {
  return [...attempts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(fingerprintAttempt)
    .join('\n');
}

export function fingerprintPlace(place: Place): string {
  return [
    place.id,
    place.name,
    fingerprintPoint(place.center),
    String(place.radiusMeters),
    place.status,
    String(place.createdAtMs),
  ].join('|');
}

export function fingerprintPlaces(places: readonly Place[]): string {
  return [...places]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(fingerprintPlace)
    .join('\n');
}

export function fingerprintRoute(route: Route): string {
  const checkpoints = route.checkpoints
    .map((checkpoint) => `${checkpoint.id}:${checkpoint.name}:${checkpoint.progressMeters}`)
    .join(',');
  const path = route.referencePath.map(fingerprintPoint).join(';');
  return [
    route.id,
    route.name,
    route.transportationMode,
    route.status,
    route.kind,
    String(route.classificationVersion),
    String(route.startProgressMeters),
    String(route.finishProgressMeters),
    fingerprintPoint(route.startZone.center),
    String(route.startZone.radiusMeters),
    fingerprintPoint(route.finishZone.center),
    String(route.finishZone.radiusMeters),
    checkpoints,
    path,
  ].join('|');
}

export function fingerprintRoutes(routes: readonly Route[]): string {
  return [...routes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(fingerprintRoute)
    .join('\n');
}

export function fingerprintSession(session: TrackingSessionRecord | null): string {
  if (!session) {
    return '';
  }
  return [
    session.id,
    session.isActive ? '1' : '0',
    session.purpose,
    session.captureOutcome,
    session.reviewDisposition,
    session.lastSampleAtMs ?? '',
  ].join('|');
}

export function fingerprintSampleIdentities(identities: readonly SampleIdentity[]): string {
  return [...identities]
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    .map((item) => `${item.sessionId}:${item.lastSampleAtMs ?? ''}`)
    .join('|');
}

export function rollingWindowMembershipKey(attempts: readonly Attempt[], asOfMs: number): string {
  const in7: string[] = [];
  const in30: string[] = [];
  for (const attempt of attempts) {
    if (!isJourneyCompetitive(attempt) || attempt.finishedAtMs == null) {
      continue;
    }
    if (isInRollingElapsedWindow(attempt.finishedAtMs, asOfMs, ROLLING_WINDOW_7_DAYS)) {
      in7.push(attempt.id);
    }
    if (isInRollingElapsedWindow(attempt.finishedAtMs, asOfMs, ROLLING_WINDOW_30_DAYS)) {
      in30.push(attempt.id);
    }
  }
  in7.sort();
  in30.sort();
  return `7:${in7.join(',')}|30:${in30.join(',')}`;
}

export function homeDerivationKey(input: {
  attempts: readonly Attempt[];
  places: readonly Place[];
  activeTransportationMode: TransportationMode;
  activeRecording: TrackingSessionRecord | null;
  pendingRecording: TrackingSessionRecord | null;
  activeAttemptId: string | null;
  attemptResultId: string | null;
}): string {
  return [
    'home',
    fingerprintAttempts(input.attempts),
    fingerprintPlaces(input.places),
    input.activeTransportationMode,
    fingerprintSession(input.activeRecording),
    fingerprintSession(input.pendingRecording),
    input.activeAttemptId ?? '',
    input.attemptResultId ?? '',
  ].join('::');
}

export function journeyDerivationKey(input: {
  pool: JourneyPoolId;
  attempts: readonly Attempt[];
  origin: Place;
  destination: Place;
  routes: readonly Route[];
  asOfMs: number;
}): string {
  return [
    'journey',
    journeyPoolKey(input.pool),
    fingerprintAttempts(input.attempts),
    fingerprintPlace(input.origin),
    fingerprintPlace(input.destination),
    fingerprintRoutes(input.routes),
    rollingWindowMembershipKey(input.attempts, input.asOfMs),
  ].join('::');
}

export function focusDerivationKey(input: {
  pool: JourneyPoolId;
  attemptId: string;
  attempts: readonly Attempt[];
  origin: Place;
  destination: Place;
  routes: readonly Route[];
  sampleIdentities: readonly SampleIdentity[];
}): string {
  return [
    'focus',
    journeyPoolKey(input.pool),
    input.attemptId,
    fingerprintAttempts(input.attempts),
    fingerprintPlace(input.origin),
    fingerprintPlace(input.destination),
    fingerprintRoutes(input.routes),
    fingerprintSampleIdentities(input.sampleIdentities),
  ].join('::');
}

export function debugDerivationKey(input: {
  attempt: Attempt;
  places: readonly Place[];
  route: Route | null;
  sampleIdentity: SampleIdentity;
}): string {
  return [
    'debug',
    fingerprintAttempt(input.attempt),
    fingerprintPlaces(input.places),
    input.route ? fingerprintRoute(input.route) : '',
    fingerprintSampleIdentities([input.sampleIdentity]),
  ].join('::');
}

export function routeAnalysisDerivationKey(input: {
  route: Route;
  attempts: readonly Attempt[];
  sampleIdentities: readonly SampleIdentity[];
}): string {
  return [
    'route-analysis',
    fingerprintRoute(input.route),
    fingerprintAttempts(input.attempts),
    fingerprintSampleIdentities(input.sampleIdentities),
  ].join('::');
}
