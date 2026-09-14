import {
  EMPTY_ATTEMPT_LOCAL_START,
  isOpenAttempt,
  type Attempt,
  type AttemptCheckpointCrossing,
} from '../domain/attempt';
import { attachAttemptLocalStart } from '../domain/attempt-local-time';
import { checkpointCrossingsForWindow, replayAttemptTrace } from '../domain/attempt-timing';
import { createId } from '../domain/ids';
import type { LocationSample } from '../domain/location-sample';
import type { Place } from '../domain/place';
import {
  presentArmedAttemptStatus,
  WAITING_GPS_READINESS,
  type AttemptCaptureHealth,
  type GpsReadiness,
} from '../domain/gps-readiness';
import { replayPlaceTrace, type PlaceStartZoneStatus } from '../domain/place-timing';
import type { JourneyPoolId } from '../domain/journey';
import { attemptJourneyPool } from '../domain/journey-analysis';
import { planPathVariantRecompute } from '../domain/path-variant-discovery';
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
  gpsReadiness: GpsReadiness;
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
    private readonly createRouteId: () => string = createId,
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
      ...EMPTY_ATTEMPT_LOCAL_START,
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
        gpsReadiness: WAITING_GPS_READINESS,
      };
    }
    const samples = await this.sessions.listSamples(open.sessionId);
    const places = await this.placesForAttempt(open);
    const next = await this.applyPlaceEngine(open, samples, places);
    const engine = replayPlaceTrace(places, samples, { armedAtMs: open.armedAtMs, nowMs: this.now() });
    const presented = presentArmedAttemptStatus(places, samples, engine, await this.readAttemptCaptureHealth());
    const armedStatus = next.lifecycle === 'armed' ? presented.startZoneStatus : LOCATING_START_ZONE;
    const gpsReadiness = next.lifecycle === 'armed' ? presented.gpsReadiness : WAITING_GPS_READINESS;

    if (!isOpenAttempt(next)) {
      await this.tracker.stopLocationUpdates();
      await this.attempts.finalizeAttempt(next, terminalSessionInput(next, this.now()));
      return { attempt: next, startZoneStatus: armedStatus, gpsReadiness };
    }
    await this.attempts.saveAttempt(next);
    return { attempt: next, startZoneStatus: armedStatus, gpsReadiness };
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
    const next: Attempt = { ...attempt, transportationMode, routeId: null, crossings: [] };
    await this.attempts.saveAttempt(next);
    await this.recomputeAllPathVariants();
    return this.attempts.getAttempt(attemptId);
  }

  async recomputeAllPathVariants(): Promise<void> {
    const attempts = await this.attempts.listAttempts();
    const keys = new Map<string, JourneyPoolId>();
    for (const attempt of attempts) {
      const pool = attemptJourneyPool(attempt);
      if (!pool) {
        continue;
      }
      keys.set(`${pool.originPlaceId}|${pool.destinationPlaceId}|${pool.transportationMode}`, pool);
    }
    for (const pool of keys.values()) {
      await this.recomputePathVariantsForPool(pool);
    }
  }

  async recomputePathVariantsForPool(pool: JourneyPoolId, extra?: { attempt: Attempt; samples: LocationSample[] }): Promise<Attempt | null> {
    const origin = await this.places.getPlace(pool.originPlaceId);
    const destination = await this.places.getPlace(pool.destinationPlaceId);
    if (!origin || !destination) {
      return extra?.attempt ?? null;
    }
    const poolAttempts = await this.attempts.listAttemptsForJourney(
      pool.originPlaceId,
      pool.destinationPlaceId,
      pool.transportationMode,
    );
    const traces = [];
    for (const attempt of poolAttempts) {
      if (extra && attempt.id === extra.attempt.id) {
        continue;
      }
      traces.push({
        attempt,
        samples: await this.sessions.listSamples(attempt.sessionId),
      });
    }
    if (extra) {
      traces.push(extra);
    }
    const routes = await this.routes.listRoutes();
    const plan = planPathVariantRecompute({
      pool,
      origin,
      destination,
      traces,
      routes,
      nowMs: this.now(),
      createRouteId: this.createRouteId,
    });
    const idByPlanned = new Map<string, string>();
    for (const route of plan.newRoutes) {
      await this.routes.createRoute(route);
      const saved =
        (await this.routes.getRoute(route.id)) ??
        (await this.routes.listRoutes()).find((item) => item.sourceRecordingId === route.sourceRecordingId);
      idByPlanned.set(route.id, saved?.id ?? route.id);
    }
    const resolveRouteId = (routeId: string | null) => (routeId == null ? null : (idByPlanned.get(routeId) ?? routeId));
    let extraResult: Attempt | null = extra?.attempt ?? null;
    for (const assignment of plan.assignments) {
      const routeId = resolveRouteId(assignment.routeId);
      const trace = traces.find((item) => item.attempt.id === assignment.attemptId);
      if (!trace) {
        continue;
      }
      const assigned = await this.applyAssignment(trace.attempt, trace.samples, routeId);
      if (extra && assignment.attemptId === extra.attempt.id) {
        extraResult = assigned;
        continue;
      }
      if (assigned.routeId !== trace.attempt.routeId || assigned.crossings.length !== trace.attempt.crossings.length) {
        await this.attempts.saveAttempt(assigned);
      } else {
        const sameCrossings = assigned.crossings.every((crossing, index) => {
          const previous = trace.attempt.crossings[index];
          return previous != null && previous.checkpointId === crossing.checkpointId && previous.crossedAtMs === crossing.crossedAtMs;
        });
        if (!sameCrossings) {
          await this.attempts.saveAttempt(assigned);
        }
      }
    }
    return extraResult;
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
    const next: Attempt = attachAttemptLocalStart(attempt, {
      ...attempt,
      lifecycle: engine.lifecycle,
      validity: engine.validity,
      originPlaceId: engine.originPlaceId,
      destinationPlaceId: engine.destinationPlaceId,
      startedAtMs: engine.startedAtMs,
      finishedAtMs: engine.finishedAtMs,
    });
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
    const classified = await this.recomputePathVariantsForPool(
      {
        originPlaceId: attempt.originPlaceId,
        destinationPlaceId: attempt.destinationPlaceId,
        transportationMode: attempt.transportationMode,
      },
      { attempt, samples },
    );
    return classified ?? { ...attempt, routeId: null, crossings: [] };
  }

  private async applyAssignment(attempt: Attempt, samples: LocationSample[], routeId: string | null): Promise<Attempt> {
    if (routeId == null || attempt.startedAtMs == null || attempt.finishedAtMs == null) {
      return { ...attempt, routeId: null, crossings: [] };
    }
    const variant = await this.routes.getRoute(routeId);
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

  private async readAttemptCaptureHealth(): Promise<AttemptCaptureHealth> {
    const tracking = await this.tracker.getState();
    const [osUpdating, servicesEnabled, foregroundPermissionGranted] = await Promise.all([
      this.platform.isUpdating(),
      this.platform.hasServicesEnabled(),
      this.platform.hasForegroundPermission(),
    ]);
    return {
      sessionActive: tracking.status === 'tracking' && tracking.captureOutcome === 'active',
      osUpdating,
      servicesEnabled,
      foregroundPermissionGranted,
      lastError: tracking.lastError,
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
