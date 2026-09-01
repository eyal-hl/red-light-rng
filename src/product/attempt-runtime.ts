import {
  isOpenAttempt,
  type Attempt,
  type AttemptCheckpointCrossing,
} from '../domain/attempt';
import { checkpointCrossingsForWindow, replayAttemptTrace } from '../domain/attempt-timing';
import { createId } from '../domain/ids';
import type { LocationSample } from '../domain/location-sample';
import type { Place } from '../domain/place';
import {
  derivePlaceStartZoneStatus,
  replayPlaceTrace,
  type PlaceStartZoneStatus,
} from '../domain/place-timing';
import { findCompatiblePathVariant } from '../domain/path-variant';
import type { TransportationMode } from '../domain/route';
import { timingCourseFromRoute } from '../domain/attempt-analysis';
import type { AttemptStore } from '../persistence/attempt-store';
import type { CompleteSessionInput, LocationSampleStore } from '../persistence/location-sample-store';
import type { PlaceStore } from '../persistence/place-store';
import type { RouteStore } from '../persistence/route-store';
import type { SettingsStore } from '../persistence/settings-store';
import type { LocationPlatform, LocationTracker } from '../tracking/location-tracker';

export type ArmAttemptResult =
  | { ok: true; attempt: Attempt }
  | { ok: false; reason: string };

export type ProcessActiveAttemptResult = {
  attempt: Attempt | null;
  startZoneStatus: PlaceStartZoneStatus;
};

const LOCATING_START_ZONE: PlaceStartZoneStatus = {
  status: 'locating',
  placeId: null,
  placeName: null,
  distanceMeters: null,
  overlapTieBreak: null,
};

function crossingId(attemptId: string, checkpointId: string): string {
  return `${attemptId}:${checkpointId}`;
}

function terminalSessionInput(attempt: Attempt, stoppedAtMs: number): CompleteSessionInput {
  if (attempt.lifecycle === 'completed') {
    return { stoppedAtMs, captureOutcome: 'finished', reviewDisposition: 'saved' };
  }
  if (attempt.lifecycle === 'cancelled') {
    return { stoppedAtMs, captureOutcome: 'cancelled', reviewDisposition: 'discarded' };
  }
  if (attempt.lifecycle === 'ended') {
    return { stoppedAtMs, captureOutcome: 'interrupted', reviewDisposition: 'saved' };
  }
  return { stoppedAtMs, captureOutcome: 'interrupted', reviewDisposition: 'discarded' };
}

export class AttemptRuntime {
  constructor(
    private readonly tracker: LocationTracker,
    private readonly platform: LocationPlatform,
    private readonly sessions: LocationSampleStore,
    private readonly routes: RouteStore,
    private readonly attempts: AttemptStore,
    private readonly places: PlaceStore,
    private readonly settings: SettingsStore,
    private readonly now: () => number = () => Date.now(),
    private readonly createAttemptId: () => string = createId,
  ) {}

  async start(): Promise<ArmAttemptResult> {
    const active = await this.sessions.getActiveSession();
    if (active) {
      return { ok: false, reason: 'Finish or cancel the current recording before starting a run.' };
    }
    const pending = await this.sessions.findPendingRouteCreation();
    if (pending) {
      return { ok: false, reason: 'Save or discard the unsaved route recording first.' };
    }
    const open = await this.attempts.getOpenAttempt();
    if (open) {
      return { ok: false, reason: 'An attempt is already armed or active.' };
    }

    await this.tracker.startTracking('attempt');
    const session = await this.sessions.getActiveSession();
    if (!session || session.purpose !== 'attempt') {
      return { ok: false, reason: 'Could not start attempt tracking.' };
    }

    const transportationMode = await this.settings.getActiveTransportationMode();
    const attempt: Attempt = {
      id: this.createAttemptId(),
      routeId: null,
      originPlaceId: null,
      destinationPlaceId: null,
      transportationMode,
      sessionId: session.id,
      lifecycle: 'armed',
      validity: 'pending',
      armedAtMs: this.now(),
      startedAtMs: null,
      finishedAtMs: null,
      resultAcknowledged: false,
      crossings: [],
    };
    try {
      await this.attempts.createAttempt(attempt);
    } catch (error) {
      await this.tracker.cancelTracking();
      throw error;
    }
    return { ok: true, attempt };
  }

  async cancel(): Promise<Attempt | null> {
    const open = await this.attempts.getOpenAttempt();
    if (!open) {
      return null;
    }
    const cancelled: Attempt = {
      ...open,
      lifecycle: 'cancelled',
      validity: 'unranked',
      resultAcknowledged: true,
    };
    await this.tracker.stopLocationUpdates();
    await this.attempts.finalizeAttempt(cancelled, terminalSessionInput(cancelled, this.now()));
    return cancelled;
  }

  async endAndInspect(): Promise<Attempt | null> {
    const open = await this.attempts.getOpenAttempt();
    if (!open) {
      return null;
    }
    const samples = await this.sessions.listSamples(open.sessionId);
    let next = await this.applyPlaceEngine(open, samples);
    if (!isOpenAttempt(next)) {
      await this.tracker.stopLocationUpdates();
      await this.attempts.finalizeAttempt(next, terminalSessionInput(next, this.now()));
      return next;
    }
    const ended: Attempt = {
      ...next,
      lifecycle: 'ended',
      validity: 'unranked',
      resultAcknowledged: false,
    };
    await this.tracker.stopLocationUpdates();
    await this.attempts.finalizeAttempt(ended, terminalSessionInput(ended, this.now()));
    return ended;
  }

  async processActiveWithStartZoneStatus(): Promise<ProcessActiveAttemptResult> {
    const open = await this.attempts.getOpenAttempt();
    if (!open) {
      return {
        attempt: await this.attempts.getUnacknowledgedResult(),
        startZoneStatus: LOCATING_START_ZONE,
      };
    }
    const samples = await this.sessions.listSamples(open.sessionId);
    const places = await this.placesForAttempt(open);
    const next = await this.applyPlaceEngine(open, samples, places);
    const engine = replayPlaceTrace(places, samples, { armedAtMs: open.armedAtMs, nowMs: this.now() });
    const armedStatus =
      next.lifecycle === 'armed' ? derivePlaceStartZoneStatus(places, samples, engine) : LOCATING_START_ZONE;

    if (!isOpenAttempt(next)) {
      await this.tracker.stopLocationUpdates();
      await this.attempts.finalizeAttempt(next, terminalSessionInput(next, this.now()));
      return { attempt: next, startZoneStatus: armedStatus };
    }
    await this.attempts.saveAttempt(next);
    return { attempt: next, startZoneStatus: armedStatus };
  }

  async processActive(): Promise<Attempt | null> {
    return (await this.processActiveWithStartZoneStatus()).attempt;
  }

  async reconcile(): Promise<Attempt | null> {
    const processed = await this.processActive();
    const open = await this.attempts.getOpenAttempt();
    if (!open) {
      return processed ?? this.attempts.getUnacknowledgedResult();
    }

    const osUpdating = await this.platform.isUpdating();
    const servicesEnabled = await this.platform.hasServicesEnabled();
    const foregroundGranted = await this.platform.hasForegroundPermission();
    if (osUpdating && servicesEnabled && foregroundGranted) {
      return open;
    }
    return this.abandon(open, 'unranked');
  }

  async acknowledgeResult(attemptId: string): Promise<void> {
    await this.attempts.acknowledgeResult(attemptId);
  }

  async getOpenAttempt(): Promise<Attempt | null> {
    return this.attempts.getOpenAttempt();
  }

  async getUnacknowledgedResult(): Promise<Attempt | null> {
    return this.attempts.getUnacknowledgedResult();
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    return this.attempts.getAttempt(attemptId);
  }

  async listAttempts(): Promise<Attempt[]> {
    return this.attempts.listAttempts();
  }

  async listAttemptsForRoute(routeId: string): Promise<Attempt[]> {
    return this.attempts.listAttemptsForRoute(routeId);
  }

  async listAttemptsForJourney(
    originPlaceId: string,
    destinationPlaceId: string,
    transportationMode: TransportationMode,
  ): Promise<Attempt[]> {
    return this.attempts.listAttemptsForJourney(originPlaceId, destinationPlaceId, transportationMode);
  }

  async setAttemptTransportationMode(
    attemptId: string,
    transportationMode: TransportationMode,
  ): Promise<Attempt | null> {
    const attempt = await this.attempts.getAttempt(attemptId);
    if (!attempt) {
      return null;
    }
    const next: Attempt = { ...attempt, transportationMode };
    const withVariant = await this.associateVariant(next, await this.sessions.listSamples(attempt.sessionId));
    await this.attempts.saveAttempt(withVariant);
    return withVariant;
  }

  private async placesForAttempt(attempt: Attempt): Promise<Place[]> {
    const active = await this.places.listActivePlaces();
    const extraIds = [attempt.originPlaceId, attempt.destinationPlaceId].filter(
      (id): id is string => id != null && !active.some((place) => place.id === id),
    );
    const extras: Place[] = [];
    for (const id of extraIds) {
      const place = await this.places.getPlace(id);
      if (place) {
        extras.push(place);
      }
    }
    return [...active, ...extras];
  }

  private async applyPlaceEngine(
    attempt: Attempt,
    samples: LocationSample[],
    places?: Place[],
  ): Promise<Attempt> {
    const resolvedPlaces = places ?? (await this.placesForAttempt(attempt));
    const engine = replayPlaceTrace(resolvedPlaces, samples, {
      armedAtMs: attempt.armedAtMs,
      nowMs: this.now(),
    });
    const next: Attempt = {
      ...attempt,
      lifecycle: engine.lifecycle,
      validity: engine.validity,
      originPlaceId: engine.originPlaceId,
      destinationPlaceId: engine.destinationPlaceId,
      startedAtMs: engine.startedAtMs,
      finishedAtMs: engine.finishedAtMs,
    };
    if (next.lifecycle === 'completed' && next.startedAtMs != null && next.finishedAtMs != null) {
      return this.associateVariant(next, samples);
    }
    return next;
  }

  private async associateVariant(attempt: Attempt, samples: LocationSample[]): Promise<Attempt> {
    if (
      attempt.originPlaceId == null ||
      attempt.destinationPlaceId == null ||
      attempt.startedAtMs == null ||
      attempt.finishedAtMs == null
    ) {
      return { ...attempt, routeId: null, crossings: [] };
    }
    const origin = await this.places.getPlace(attempt.originPlaceId);
    const destination = await this.places.getPlace(attempt.destinationPlaceId);
    if (!origin || !destination) {
      return { ...attempt, routeId: null, crossings: [] };
    }
    const routes = await this.routes.listRoutes();
    const variant = findCompatiblePathVariant(
      routes,
      origin,
      destination,
      attempt.transportationMode,
      samples,
      { startedAtMs: attempt.startedAtMs, finishedAtMs: attempt.finishedAtMs },
    );
    if (!variant) {
      return { ...attempt, routeId: null, crossings: [] };
    }
    const course = timingCourseFromRoute(variant);
    const engine = replayAttemptTrace(course, samples);
    const crossings: AttemptCheckpointCrossing[] = checkpointCrossingsForWindow(
      engine.accepted,
      course,
      attempt.startedAtMs,
      attempt.finishedAtMs,
    ).map((crossing) => ({
      id: crossingId(attempt.id, crossing.checkpointId),
      attemptId: attempt.id,
      checkpointId: crossing.checkpointId,
      checkpointName: crossing.checkpointName,
      checkpointProgressMeters: crossing.checkpointProgressMeters,
      crossedAtMs: crossing.crossedAtMs,
    }));
    return {
      ...attempt,
      routeId: variant.id,
      crossings,
    };
  }

  private async abandon(open: Attempt, validity: 'unranked'): Promise<Attempt> {
    const abandoned: Attempt = {
      ...open,
      lifecycle: 'abandoned',
      validity,
    };
    await this.tracker.stopLocationUpdates();
    await this.attempts.finalizeAttempt(abandoned, terminalSessionInput(abandoned, this.now()));
    return abandoned;
  }
}
