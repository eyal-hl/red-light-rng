import { defaultCourseProgress, validateCourseLayout, type CourseLayout } from '../domain/course-layout';
import { createId } from '../domain/ids';
import type { LocationSample } from '../domain/location-sample';
import type { Place } from '../domain/place';
import { clonePlace, validatePlaceInput } from '../domain/place';
import { ensurePlacesForRoute } from '../domain/place-seeding';
import {
  inspectPlaceAttemptRecord,
  type PlaceAttemptDebugReport,
} from '../domain/place-debug';
import type { Route, TransportationMode } from '../domain/route';
import { deriveRouteGeometry, type RouteDerivation } from '../domain/route-derivation';
import type { TrackingState } from '../domain/tracking-state';
import { isOpenAttempt, type Attempt } from '../domain/attempt';
import {
  analyzeFocusAttempt,
  analyzeRouteAttempts,
  deriveAnchoredLayoutAttempt,
  timingCourseFromRoute,
  type AttemptTrace,
  type FocusAttemptAnalysis,
  type RouteAttemptAnalysis,
} from '../domain/attempt-analysis';
import { inspectAttemptRecord, type AttemptDebugReport } from '../domain/attempt-debug';
import {
  analyzeJourneyFocus,
  incompleteAttempts,
  journeyHistoryRows,
  listJourneyPools,
  summarizeJourneyPool,
  type JourneyAttemptTrace,
  type JourneyFocusAnalysis,
  type JourneyHistoryRow,
  type JourneyPoolSummary,
} from '../domain/journey-analysis';
import { computeJourneyPoolStatistics, type JourneyPoolStatistics } from '../domain/journey-statistics';
import type { JourneyPoolId } from '../domain/journey';
import type { LocationSampleStore, TrackingSessionRecord } from '../persistence/location-sample-store';
import type { PlaceStore } from '../persistence/place-store';
import type { RouteStore } from '../persistence/route-store';
import type { SettingsStore } from '../persistence/settings-store';
import type { LocationPlatform, LocationFix, LocationTracker } from '../tracking/location-tracker';
import {
  AttemptRuntime,
  type ArmAttemptResult,
  type ProcessActiveAttemptResult,
} from './attempt-runtime';

export type HomeSnapshot = {
  routes: Route[];
  places: Place[];
  journeys: JourneyPoolSummary[];
  incompleteAttempts: Attempt[];
  activeTransportationMode: TransportationMode;
  activeRecording: TrackingSessionRecord | null;
  pendingRecording: TrackingSessionRecord | null;
  activeAttempt: Attempt | null;
  attemptResult: Attempt | null;
  canStartNewRecording: boolean;
  canStartAttempt: boolean;
};

export type SaveRouteResult =
  | { ok: true; route: Route }
  | { ok: false; reason: string };

export type SaveCourseLayoutResult =
  | { ok: true; route: Route }
  | { ok: false; reason: string };

export type SavePlaceResult =
  | { ok: true; place: Place }
  | { ok: false; reason: string };

export type RemovePlaceResult =
  | { ok: true; action: 'deleted' | 'archived' }
  | { ok: false; reason: string };

export type CombinedAttemptDebug = {
  place: PlaceAttemptDebugReport;
  variant: AttemptDebugReport | null;
};

export class RouteWorkspace {
  constructor(
    private readonly tracker: LocationTracker,
    private readonly sessions: LocationSampleStore,
    private readonly routes: RouteStore,
    private readonly attempts: AttemptRuntime,
    private readonly places: PlaceStore,
    private readonly settings: SettingsStore,
    private readonly platform: LocationPlatform,
    private readonly now: () => number = () => Date.now(),
    private readonly createRouteId: () => string = createId,
    private readonly createPlaceId: () => string = createId,
  ) {}

  async bootstrap(): Promise<HomeSnapshot> {
    await this.tracker.recover();
    await this.attempts.reconcile();
    return this.loadHome();
  }

  async loadHome(): Promise<HomeSnapshot> {
    const [
      routes,
      placeList,
      activeSession,
      pendingRecording,
      activeAttempt,
      attemptResult,
      allAttempts,
      activeTransportationMode,
    ] = await Promise.all([
      this.routes.listRoutes(),
      this.places.listPlaces(),
      this.sessions.getActiveSession(),
      this.sessions.findPendingRouteCreation(),
      this.attempts.getOpenAttempt(),
      this.attempts.getUnacknowledgedResult(),
      this.attempts.listAttempts(),
      this.settings.getActiveTransportationMode(),
    ]);
    const traces = await this.tracesForAttempts(allAttempts);
    const placesById = new Map(placeList.map((place) => [place.id, place]));
    const activeRecording = activeSession?.purpose === 'route_creation' ? activeSession : null;
    const canStart = activeSession == null && pendingRecording == null;
    return {
      routes,
      places: placeList,
      journeys: listJourneyPools(traces, placesById),
      incompleteAttempts: incompleteAttempts(traces),
      activeTransportationMode,
      activeRecording,
      pendingRecording,
      activeAttempt,
      attemptResult: activeAttempt ? null : attemptResult,
      canStartNewRecording: canStart,
      canStartAttempt: canStart,
    };
  }

  async startRouteRecording(): Promise<void> {
    await this.tracker.startTracking('route_creation');
  }

  async finishRecording(): Promise<void> {
    await this.tracker.finishTracking();
  }

  async cancelRecording(): Promise<void> {
    await this.tracker.cancelTracking();
  }

  async interruptRecording(): Promise<void> {
    await this.tracker.interruptTracking();
  }

  async recover(): Promise<void> {
    await this.tracker.recover();
    await this.attempts.reconcile();
  }

  async getTrackingState(): Promise<TrackingState> {
    return this.tracker.getState();
  }

  async getCurrentPosition(): Promise<LocationFix | null> {
    return this.platform.getCurrentPosition();
  }

  async getSession(sessionId: string): Promise<TrackingSessionRecord | null> {
    return this.sessions.getSession(sessionId);
  }

  async countSamples(sessionId: string): Promise<number> {
    return this.sessions.countSamples(sessionId);
  }

  async listSamples(sessionId: string): Promise<LocationSample[]> {
    return this.sessions.listSamples(sessionId);
  }

  async deriveSession(sessionId: string): Promise<{
    session: TrackingSessionRecord | null;
    samples: LocationSample[];
    derivation: RouteDerivation;
  }> {
    const session = await this.sessions.getSession(sessionId);
    const samples = await this.sessions.listSamples(sessionId);
    return {
      session,
      samples,
      derivation: deriveRouteGeometry(samples),
    };
  }

  async discardRecording(sessionId: string): Promise<void> {
    await this.sessions.setReviewDisposition(sessionId, 'discarded');
  }

  async saveRoute(
    sessionId: string,
    name: string,
    transportationMode: TransportationMode,
  ): Promise<SaveRouteResult> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return { ok: false, reason: 'Enter a route name before saving.' };
    }

    const { session, derivation } = await this.deriveSession(sessionId);
    if (!session || session.reviewDisposition !== 'pending') {
      return { ok: false, reason: 'This recording is no longer waiting to be saved.' };
    }
    if (!derivation.saveable || !derivation.startZone || !derivation.finishZone) {
      return {
        ok: false,
        reason: derivation.reason ?? 'This recording is too short or low-quality to save as a route.',
      };
    }

    const progress = defaultCourseProgress(derivation.referencePath);
    const route: Route = {
      id: this.createRouteId(),
      name: trimmedName,
      transportationMode,
      createdAtMs: this.now(),
      sourceRecordingId: sessionId,
      referencePath: derivation.referencePath,
      startZone: derivation.startZone,
      finishZone: derivation.finishZone,
      startProgressMeters: progress.startProgressMeters,
      finishProgressMeters: progress.finishProgressMeters,
      checkpoints: [],
    };
    await this.routes.createRoute(route);
    await this.sessions.setReviewDisposition(sessionId, 'saved');
    await this.syncPlacesForRoute(route);
    return { ok: true, route };
  }

  async getRoute(routeId: string): Promise<Route | null> {
    return this.routes.getRoute(routeId);
  }

  async saveCourseLayout(routeId: string, layout: CourseLayout): Promise<SaveCourseLayoutResult> {
    const existing = await this.routes.getRoute(routeId);
    if (!existing) {
      return { ok: false, reason: 'This route is no longer available.' };
    }
    const validation = validateCourseLayout(layout);
    if (!validation.valid) {
      return { ok: false, reason: validation.reason ?? 'This course layout cannot be saved.' };
    }
    await this.routes.replaceCourseLayout(routeId, layout);
    const route = await this.routes.getRoute(routeId);
    if (!route) {
      return { ok: false, reason: 'This route is no longer available.' };
    }
    await this.syncPlacesForRoute(route);
    return { ok: true, route };
  }

  async deleteRoute(routeId: string): Promise<void> {
    await this.routes.deleteRoute(routeId);
  }

  async listPlaces(): Promise<Place[]> {
    return this.places.listPlaces();
  }

  async getPlace(placeId: string): Promise<Place | null> {
    return this.places.getPlace(placeId);
  }

  async createPlace(input: {
    name: string;
    center: Place['center'];
    radiusMeters: number;
  }): Promise<SavePlaceResult> {
    const validation = validatePlaceInput(input);
    if (!validation.valid) {
      return { ok: false, reason: validation.reason ?? 'This place cannot be saved.' };
    }
    const place: Place = {
      id: this.createPlaceId(),
      name: input.name.trim(),
      center: { latitude: input.center.latitude, longitude: input.center.longitude },
      radiusMeters: input.radiusMeters,
      status: 'active',
      createdAtMs: this.now(),
    };
    await this.places.createPlace(place);
    return { ok: true, place };
  }

  async savePlace(place: Place): Promise<SavePlaceResult> {
    const validation = validatePlaceInput(place);
    if (!validation.valid) {
      return { ok: false, reason: validation.reason ?? 'This place cannot be saved.' };
    }
    const existing = await this.places.getPlace(place.id);
    if (!existing) {
      return { ok: false, reason: 'This place is no longer available.' };
    }
    const next = clonePlace({
      ...existing,
      name: place.name.trim(),
      center: place.center,
      radiusMeters: place.radiusMeters,
      status: place.status,
    });
    await this.places.savePlace(next);
    return { ok: true, place: next };
  }

  async removePlace(placeId: string): Promise<RemovePlaceResult> {
    const existing = await this.places.getPlace(placeId);
    if (!existing) {
      return { ok: false, reason: 'This place is no longer available.' };
    }
    const referenced = await this.attemptsIsPlaceReferenced(placeId);
    if (referenced) {
      await this.places.archivePlace(placeId);
      return { ok: true, action: 'archived' };
    }
    await this.places.deletePlace(placeId);
    return { ok: true, action: 'deleted' };
  }

  async getActiveTransportationMode(): Promise<TransportationMode> {
    return this.settings.getActiveTransportationMode();
  }

  async setActiveTransportationMode(mode: TransportationMode): Promise<void> {
    await this.settings.setActiveTransportationMode(mode);
  }

  async startAttempt(): Promise<ArmAttemptResult> {
    return this.attempts.start();
  }

  async armRun(_routeId?: string): Promise<ArmAttemptResult> {
    return this.attempts.start();
  }

  async cancelAttempt(): Promise<Attempt | null> {
    return this.attempts.cancel();
  }

  async endAndInspectAttempt(): Promise<Attempt | null> {
    return this.attempts.endAndInspect();
  }

  async inspectAttempt(attemptId: string): Promise<CombinedAttemptDebug | null> {
    const attempt = await this.attempts.getAttempt(attemptId);
    if (!attempt) {
      return null;
    }
    const samples = await this.sessions.listSamples(attempt.sessionId);
    const places = await this.places.listPlaces();
    const session = await this.sessions.getSession(attempt.sessionId);
    const inspectNow = isOpenAttempt(attempt) ? this.now() : (session?.stoppedAtMs ?? this.now());
    const place = inspectPlaceAttemptRecord(attempt, places, samples, inspectNow);
    let variant: AttemptDebugReport | null = null;
    if (attempt.routeId) {
      const route = await this.routes.getRoute(attempt.routeId);
      if (route) {
        variant = inspectAttemptRecord(attempt, timingCourseFromRoute(route), samples);
      }
    }
    return { place, variant };
  }

  async processActiveAttempt(): Promise<Attempt | null> {
    return this.attempts.processActive();
  }

  async processActiveAttemptWithStartZoneStatus(): Promise<ProcessActiveAttemptResult> {
    return this.attempts.processActiveWithStartZoneStatus();
  }

  async getOpenAttempt(): Promise<Attempt | null> {
    return this.attempts.getOpenAttempt();
  }

  async getAttemptResult(): Promise<Attempt | null> {
    return this.attempts.getUnacknowledgedResult();
  }

  async acknowledgeAttemptResult(attemptId: string): Promise<void> {
    await this.attempts.acknowledgeResult(attemptId);
  }

  async listAttemptsForRoute(routeId: string): Promise<Attempt[]> {
    return this.attempts.listAttemptsForRoute(routeId);
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    return this.attempts.getAttempt(attemptId);
  }

  async setAttemptTransportationMode(
    attemptId: string,
    mode: TransportationMode,
  ): Promise<Attempt | null> {
    return this.attempts.setAttemptTransportationMode(attemptId, mode);
  }

  async loadRouteTraces(routeId: string): Promise<{ route: Route; traces: AttemptTrace[] } | null> {
    const route = await this.routes.getRoute(routeId);
    if (!route) {
      return null;
    }
    const attempts = await this.attempts.listAttemptsForRoute(routeId);
    const traces: AttemptTrace[] = [];
    for (const attempt of attempts) {
      traces.push({
        attempt,
        samples: await this.sessions.listSamples(attempt.sessionId),
      });
    }
    return { route, traces };
  }

  async analyzeRoute(routeId: string): Promise<{ route: Route; analysis: RouteAttemptAnalysis } | null> {
    const loaded = await this.loadRouteTraces(routeId);
    if (!loaded) {
      return null;
    }
    return {
      route: loaded.route,
      analysis: analyzeRouteAttempts(
        timingCourseFromRoute(loaded.route),
        loaded.traces,
        deriveAnchoredLayoutAttempt,
      ),
    };
  }

  async analyzeAttempt(routeId: string, attemptId: string): Promise<FocusAttemptAnalysis | null> {
    const loaded = await this.loadRouteTraces(routeId);
    if (!loaded) {
      return null;
    }
    return analyzeFocusAttempt(
      timingCourseFromRoute(loaded.route),
      loaded.traces,
      attemptId,
      deriveAnchoredLayoutAttempt,
    );
  }

  async analyzeJourney(
    pool: JourneyPoolId,
    attemptId: string,
  ): Promise<{
    summary: JourneyPoolSummary;
    history: JourneyHistoryRow[];
    focus: JourneyFocusAnalysis | null;
  } | null> {
    const origin = await this.places.getPlace(pool.originPlaceId);
    const destination = await this.places.getPlace(pool.destinationPlaceId);
    if (!origin || !destination) {
      return null;
    }
    const traces = await this.tracesForAttempts(await this.attempts.listAttempts());
    const routes = await this.routes.listRoutes();
    return {
      summary: summarizeJourneyPool(pool, origin, destination, traces),
      history: journeyHistoryRows(pool, traces),
      focus: analyzeJourneyFocus(pool, origin, destination, traces, attemptId, routes),
    };
  }

  async loadJourney(
    pool: JourneyPoolId,
  ): Promise<{
    origin: Place;
    destination: Place;
    summary: JourneyPoolSummary;
    statistics: JourneyPoolStatistics;
    history: JourneyHistoryRow[];
    routes: Route[];
  } | null> {
    const origin = await this.places.getPlace(pool.originPlaceId);
    const destination = await this.places.getPlace(pool.destinationPlaceId);
    if (!origin || !destination) {
      return null;
    }
    const traces = await this.tracesForAttempts(await this.attempts.listAttempts());
    const routes = await this.routes.listRoutes();
    return {
      origin,
      destination,
      summary: summarizeJourneyPool(pool, origin, destination, traces),
      statistics: computeJourneyPoolStatistics(pool, traces, this.now()),
      history: journeyHistoryRows(pool, traces),
      routes,
    };
  }

  private async tracesForAttempts(attempts: Attempt[]): Promise<JourneyAttemptTrace[]> {
    const traces: JourneyAttemptTrace[] = [];
    for (const attempt of attempts) {
      traces.push({
        attempt,
        samples: await this.sessions.listSamples(attempt.sessionId),
      });
    }
    return traces;
  }

  private async syncPlacesForRoute(route: Route): Promise<void> {
    const existing = await this.places.listPlaces();
    const result = ensurePlacesForRoute(existing, route, {
      createPlaceId: () => this.createPlaceId(),
      nowMs: this.now(),
    });
    for (const place of result.placesToCreate) {
      await this.places.createPlace(place);
    }
  }

  private async attemptsIsPlaceReferenced(placeId: string): Promise<boolean> {
    const attempts = await this.attempts.listAttempts();
    return attempts.some(
      (attempt) => attempt.originPlaceId === placeId || attempt.destinationPlaceId === placeId,
    );
  }
}
