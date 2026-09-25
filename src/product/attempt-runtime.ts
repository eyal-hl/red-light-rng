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
import { PATH_VARIANT_CLASSIFICATION_VERSION, planPathVariantRecompute } from '../domain/path-variant-discovery';
import type { TransportationMode } from '../domain/route';
import { timingCourseFromRoute } from '../domain/attempt-analysis';
import type { AttemptStore } from '../persistence/attempt-store';
import type { CompleteSessionInput, LocationSampleStore } from '../persistence/location-sample-store';
import type { PlaceStore } from '../persistence/place-store';
import type { RouteStore } from '../persistence/route-store';
import { PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY, type SettingsStore } from '../persistence/settings-store';
import type { LocationPlatform, LocationTracker } from '../tracking/location-tracker';
import { pathVariantRecomputeInputKey } from './derived-view-cache';
import { yieldToEventLoop, type IdleYield } from './idle-yield';
import {
  CURRENT_ATTEMPT_RECONCILIATION_VERSION,
  emptyAttemptReconciliationReport,
  withAttemptReconciliation,
  type AttemptReconciliationReport,
} from '../domain/attempt-reconciliation';
import { findCompatiblePathVariant } from '../domain/path-variant';

export type ArmAttemptResult =
  | { ok: true; attempt: Attempt }
  | { ok: false; reason: string };

export type ProcessActiveAttemptResult = {
  attempt: Attempt | null;
  startZoneStatus: PlaceStartZoneStatus;
  gpsReadiness: GpsReadiness;
};

export type PathVariantRecomputeResult = {
  skipped: boolean;
  poolsProcessed: number;
  listSamplesCalls: number;
};

export type PathVariantRecomputeOptions = {
  skipIfUnchanged?: boolean;
  yieldToIdle?: IdleYield;
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
      reconciliationStatus: 'pending',
      reconciliationVersion: 0,
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
      reconciliationStatus: 'reconciled',
      reconciliationVersion: CURRENT_ATTEMPT_RECONCILIATION_VERSION,
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
      const pending = withAttemptReconciliation(next, 'pending', 0);
      await this.attempts.finalizeAttempt(pending, terminalSessionInput(pending, this.now()));
      try {
        return await this.reconcileDerivedAttempt(pending, samples);
      } catch {
        const failed = withAttemptReconciliation(pending, 'failed', 0);
        await this.attempts.saveAttempt(failed);
        return failed;
      }
    }
    const ended: Attempt = {
      ...next,
      lifecycle: 'ended',
      validity: 'unranked',
      resultAcknowledged: false,
      reconciliationStatus: 'reconciled',
      reconciliationVersion: CURRENT_ATTEMPT_RECONCILIATION_VERSION,
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
      const pending = withAttemptReconciliation(next, 'pending', 0);
      await this.attempts.finalizeAttempt(pending, terminalSessionInput(pending, this.now()));
      try {
        const derived = await this.reconcileDerivedAttempt(pending, samples);
        return { attempt: derived, startZoneStatus: armedStatus, gpsReadiness };
      } catch {
        const failed = withAttemptReconciliation(pending, 'failed', 0);
        await this.attempts.saveAttempt(failed);
        return { attempt: failed, startZoneStatus: armedStatus, gpsReadiness };
      }
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

  async peekFailedReconciliationAttemptId(): Promise<string | null> {
    return this.attempts.peekFailedReconciliationAttemptId();
  }

  async listAttemptsNeedingReconciliation(
    currentVersion: number = CURRENT_ATTEMPT_RECONCILIATION_VERSION,
  ): Promise<Attempt[]> {
    return this.attempts.listAttemptsNeedingReconciliation(currentVersion);
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

  async countAttemptsReferencingPlace(placeId: string): Promise<number> {
    return this.attempts.countAttemptsReferencingPlace(placeId);
  }

  async deleteAttempt(attemptId: string): Promise<void> {
    await this.attempts.deleteAttempt(attemptId);
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
    await this.attempts.saveAttempt(withAttemptReconciliation(next, 'pending', 0));
    const report = await this.reconcileSelectedAttempts(
      [(await this.attempts.getAttempt(attemptId)) ?? withAttemptReconciliation(next, 'pending', 0)],
    );
    if (report.perAttempt[0]?.status === 'failed') {
      return this.attempts.getAttempt(attemptId);
    }
    return this.attempts.getAttempt(attemptId);
  }

  async reconcilePendingAttempts(options: PathVariantRecomputeOptions = {}): Promise<AttemptReconciliationReport> {
    const selected = await this.attempts.listAttemptsNeedingReconciliation(CURRENT_ATTEMPT_RECONCILIATION_VERSION);
    return this.reconcileSelectedAttempts(selected, options);
  }

  async retryAttemptReconciliation(
    attemptId: string,
    options: PathVariantRecomputeOptions = {},
  ): Promise<AttemptReconciliationReport> {
    const attempt = await this.attempts.getAttempt(attemptId);
    if (!attempt || isOpenAttempt(attempt)) {
      return emptyAttemptReconciliationReport();
    }
    const pending = withAttemptReconciliation(attempt, 'pending', 0);
    await this.attempts.saveAttempt(pending);
    return this.reconcileSelectedAttempts([pending], options);
  }

  private async reconcileSelectedAttempts(
    selected: Attempt[],
    options: PathVariantRecomputeOptions = {},
  ): Promise<AttemptReconciliationReport> {
    const yieldToIdle = options.yieldToIdle ?? yieldToEventLoop;
    const startedAt = performance.now();
    const report: AttemptReconciliationReport = {
      selectedAttemptIds: selected.map((attempt) => attempt.id),
      selectedCount: selected.length,
      listSamplesCalls: 0,
      perAttempt: [],
      totalDurationMs: 0,
    };
    if (selected.length === 0) {
      report.totalDurationMs = performance.now() - startedAt;
      return report;
    }
    await yieldToIdle();
    for (const attempt of selected) {
      await yieldToIdle();
      const attemptStartedAt = performance.now();
      let listSamplesCalls = 0;
      try {
        const derived = await this.reconcileDerivedAttempt(attempt, undefined, {
          yieldToIdle,
          onListSamples: () => {
            listSamplesCalls += 1;
            report.listSamplesCalls += 1;
          },
        });
        report.perAttempt.push({
          attemptId: attempt.id,
          durationMs: performance.now() - attemptStartedAt,
          listSamplesCalls,
          status: derived.reconciliationStatus ?? 'reconciled',
          error: null,
        });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Attempt reconciliation failed.';
        await this.attempts.saveAttempt(withAttemptReconciliation(attempt, 'failed', attempt.reconciliationVersion ?? 0));
        report.perAttempt.push({
          attemptId: attempt.id,
          durationMs: performance.now() - attemptStartedAt,
          listSamplesCalls,
          status: 'failed',
          error: message,
        });
      }
    }
    report.totalDurationMs = performance.now() - startedAt;
    return report;
  }

  async recomputeAllPathVariants(options: PathVariantRecomputeOptions = {}): Promise<PathVariantRecomputeResult> {
    const yieldToIdle = options.yieldToIdle ?? yieldToEventLoop;
    await yieldToIdle();
    const currentKey = await this.pathVariantRecomputeFingerprint();
    if (options.skipIfUnchanged) {
      const stored = await this.settings.getValue(PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY);
      if (stored === currentKey) {
        return { skipped: true, poolsProcessed: 0, listSamplesCalls: 0 };
      }
    }

    const attempts = await this.attempts.listAttempts();
    const keys = new Map<string, JourneyPoolId>();
    for (const attempt of attempts) {
      const pool = attemptJourneyPool(attempt);
      if (!pool) {
        continue;
      }
      keys.set(`${pool.originPlaceId}|${pool.destinationPlaceId}|${pool.transportationMode}`, pool);
    }
    let listSamplesCalls = 0;
    let poolsProcessed = 0;
    for (const pool of keys.values()) {
      await yieldToIdle();
      await this.recomputePathVariantsForPool(pool, undefined, {
        yieldToIdle,
        onListSamples: () => {
          listSamplesCalls += 1;
        },
      });
      poolsProcessed += 1;
    }
    const afterKey = await this.pathVariantRecomputeFingerprint();
    await this.settings.setValue(PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY, afterKey);
    const leftovers = await this.attempts.listAttemptsNeedingReconciliation(CURRENT_ATTEMPT_RECONCILIATION_VERSION);
    for (const leftover of leftovers) {
      await this.attempts.saveAttempt(withAttemptReconciliation(leftover, 'reconciled'));
    }
    return { skipped: false, poolsProcessed, listSamplesCalls };
  }

  async recomputePathVariantsForPool(
    pool: JourneyPoolId,
    extra?: { attempt: Attempt; samples: LocationSample[] },
    options: { yieldToIdle?: IdleYield; onListSamples?: () => void } = {},
  ): Promise<Attempt | null> {
    const yieldToIdle = options.yieldToIdle ?? yieldToEventLoop;
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
      await yieldToIdle();
      options.onListSamples?.();
      traces.push({
        attempt,
        samples: await this.sessions.listSamples(attempt.sessionId),
      });
    }
    if (extra) {
      traces.push(extra);
    }
    const routes = await this.routes.listRoutes();
    await yieldToIdle();
    const plan = await planPathVariantRecompute({
      pool,
      origin,
      destination,
      traces,
      routes,
      nowMs: this.now(),
      createRouteId: this.createRouteId,
      yieldToIdle,
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
      await yieldToIdle();
      const routeId = resolveRouteId(assignment.routeId);
      const trace = traces.find((item) => item.attempt.id === assignment.attemptId);
      if (!trace) {
        continue;
      }
      const assigned = await this.applyAssignment(trace.attempt, trace.samples, routeId);
      const marked = withAttemptReconciliation(assigned, 'reconciled');
      if (extra && assignment.attemptId === extra.attempt.id) {
        extraResult = marked;
        continue;
      }
      await this.attempts.saveAttempt(marked);
    }
    return extraResult;
  }

  private async pathVariantRecomputeFingerprint(): Promise<string> {
    const [attempts, places, routes] = await Promise.all([
      this.attempts.listAttempts(),
      this.places.listPlaces(),
      this.routes.listRoutes(),
    ]);
    const sampleIdentities = [];
    const seenSessions = new Set<string>();
    for (const attempt of attempts) {
      if (seenSessions.has(attempt.sessionId)) {
        continue;
      }
      seenSessions.add(attempt.sessionId);
      const session = await this.sessions.getSession(attempt.sessionId);
      sampleIdentities.push({
        sessionId: attempt.sessionId,
        lastSampleAtMs: session?.lastSampleAtMs ?? null,
      });
    }
    return pathVariantRecomputeInputKey({
      classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
      attempts,
      places,
      routes,
      sampleIdentities,
    });
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
    return next;
  }

  private async reconcileDerivedAttempt(
    attempt: Attempt,
    samples?: LocationSample[],
    options: { yieldToIdle?: IdleYield; onListSamples?: () => void } = {},
  ): Promise<Attempt> {
    if (isOpenAttempt(attempt)) {
      return attempt;
    }
    let working = attempt;
    let loaded = samples;
    const needsPathAssignment =
      working.lifecycle === 'completed' &&
      working.originPlaceId != null &&
      working.destinationPlaceId != null &&
      working.startedAtMs != null &&
      working.finishedAtMs != null;
    if (needsPathAssignment) {
      if (!loaded) {
        options.onListSamples?.();
        loaded = await this.sessions.listSamples(working.sessionId);
      }
      if (options.yieldToIdle) {
        await options.yieldToIdle();
      }
      working = await this.assignExistingVariant(working, loaded);
    }
    const reconciled = withAttemptReconciliation(working, 'reconciled');
    await this.attempts.saveAttempt(reconciled);
    return reconciled;
  }

  private async assignExistingVariant(attempt: Attempt, samples: LocationSample[]): Promise<Attempt> {
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
    const match = findCompatiblePathVariant(
      routes,
      origin,
      destination,
      attempt.transportationMode,
      samples,
      { startedAtMs: attempt.startedAtMs, finishedAtMs: attempt.finishedAtMs },
      { includeArchived: false },
    );
    return this.applyAssignment(attempt, samples, match?.id ?? null);
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
      reconciliationStatus: 'reconciled',
      reconciliationVersion: CURRENT_ATTEMPT_RECONCILIATION_VERSION,
    };
    await this.tracker.stopLocationUpdates();
    await this.attempts.finalizeAttempt(abandoned, terminalSessionInput(abandoned, this.now()));
    return abandoned;
  }
}
