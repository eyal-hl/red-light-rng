import { defaultCourseProgress, validateCourseLayout, type CourseLayout } from '../domain/course-layout';
import { createId } from '../domain/ids';
import type { LocationSample } from '../domain/location-sample';
import {
  attemptReferencesPlace,
  clonePlace,
  openAttemptBlocksPlaceDeletion,
  PLACE_LIVE_ATTEMPT_REASON,
  validatePlaceInput,
  type Place,
} from '../domain/place';
import { ensurePlacesForRoute } from '../domain/place-seeding';
import {
  inspectPlaceAttemptRecord,
  type PlaceAttemptDebugReport,
} from '../domain/place-debug';
import type { Route, TransportationMode } from '../domain/route';
import { validateRouteName } from '../domain/route';
import {
  PATH_VARIANT_CLASSIFICATION_VERSION,
  summarizeJourneyPathVariants,
  type JourneyPathVariantSummary,
} from '../domain/path-variant-discovery';
import { deriveRouteGeometry, type RouteDerivation } from '../domain/route-derivation';
import type { TrackingState } from '../domain/tracking-state';
import { isOpenAttempt, type Attempt } from '../domain/attempt';
import {
  emptyAttemptReconciliationReport,
  type AttemptReconciliationReport,
} from '../domain/attempt-reconciliation';
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
  analyzeJourneyHeadline,
  attemptInPool,
  incompleteAttempts,
  journeyHistoryRows,
  listJourneyPools,
  summarizeJourneyPool,
  tracesFromAttempts,
  type JourneyAttemptTrace,
  type JourneyFocusAnalysis,
  type JourneyHistoryRow,
  type JourneyPoolSummary,
} from '../domain/journey-analysis';
import { computeJourneyPoolDepartureGrouping, type JourneyDepartureGrouping } from '../domain/journey-departure';
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
  type PathVariantRecomputeOptions,
  type PathVariantRecomputeResult,
  type ProcessActiveAttemptResult,
} from './attempt-runtime';
import {
  debugDerivationKey,
  focusDerivationKey,
  homeDerivationKey,
  journeyDerivationKey,
  MapKeyedCache,
  routeAnalysisDerivationKey,
  SingleKeyedCache,
  type SampleIdentity,
} from './derived-view-cache';
import {
  createNavigationLoadState,
  timeNavigationLoad,
  type NavigationLoadState,
} from './navigation-load';

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
  failedReconciliationAttemptId: string | null;
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
  | { ok: true; action: 'deleted'; deletedAttemptCount: number }
  | { ok: true; action: 'archived' }
  | { ok: false; reason: string };

export type CombinedAttemptDebug = {
  place: PlaceAttemptDebugReport;
  variant: AttemptDebugReport | null;
};

export type LoadedJourney = {
  origin: Place;
  destination: Place;
  summary: JourneyPoolSummary;
  statistics: JourneyPoolStatistics;
  departureGrouping: JourneyDepartureGrouping;
  history: JourneyHistoryRow[];
  routes: Route[];
  pathVariants: JourneyPathVariantSummary[];
};

export type AnalyzeJourneyResult = {
  summary: JourneyPoolSummary;
  history: JourneyHistoryRow[];
  focus: JourneyFocusAnalysis | null;
};

export class RouteWorkspace {
  readonly navigationLoad: NavigationLoadState = createNavigationLoadState();
  lastPathVariantRecompute: PathVariantRecomputeResult | null = null;
  lastAttemptReconciliation: AttemptReconciliationReport = emptyAttemptReconciliationReport();
  private readonly homeCache = new SingleKeyedCache<HomeSnapshot>();
  private readonly journeyCache = new MapKeyedCache<LoadedJourney>();
  private readonly focusCache = new MapKeyedCache<AnalyzeJourneyResult>();
  private readonly debugCache = new MapKeyedCache<CombinedAttemptDebug | null>();
  private readonly routeAnalysisCache = new MapKeyedCache<{
    route: Route;
    analysis: RouteAttemptAnalysis;
  }>();

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

  resetNavigationLoad(): void {
    this.navigationLoad.counters = createNavigationLoadState().counters;
    this.navigationLoad.timings = [];
  }

  async preparePersistence(): Promise<void> {
    await this.settings.getActiveTransportationMode();
  }

  async recoverTracker(): Promise<void> {
    await this.tracker.recover();
  }

  async reconcileAttempts(): Promise<void> {
    await this.attempts.reconcile();
  }

  async reconcilePendingAttempts(options: PathVariantRecomputeOptions = {}): Promise<AttemptReconciliationReport> {
    return timeNavigationLoad(this.navigationLoad, 'reconcilePendingAttempts', async () => {
      const result = await this.attempts.reconcilePendingAttempts(options);
      this.lastAttemptReconciliation = result;
      this.navigationLoad.counters.reconcilePendingSelected += result.selectedCount;
      this.navigationLoad.counters.reconcilePendingListSamples += result.listSamplesCalls;
      this.navigationLoad.counters.listSamplesCalls += result.listSamplesCalls;
      if (result.selectedCount === 0) {
        this.navigationLoad.counters.reconcilePendingSkips += 1;
      } else {
        this.navigationLoad.counters.reconcilePendingRuns += 1;
      }
      return { value: result, cacheHit: result.selectedCount === 0 };
    });
  }

  async retryAttemptReconciliation(attemptId: string): Promise<AttemptReconciliationReport> {
    return timeNavigationLoad(this.navigationLoad, 'reconcilePendingAttempts', async () => {
      const result = await this.attempts.retryAttemptReconciliation(attemptId);
      this.lastAttemptReconciliation = result;
      this.navigationLoad.counters.reconcilePendingSelected += result.selectedCount;
      this.navigationLoad.counters.reconcilePendingListSamples += result.listSamplesCalls;
      this.navigationLoad.counters.listSamplesCalls += result.listSamplesCalls;
      this.navigationLoad.counters.reconcilePendingRuns += 1;
      return { value: result, cacheHit: false };
    });
  }

  async recomputePathVariants(options: PathVariantRecomputeOptions = {}): Promise<PathVariantRecomputeResult> {
    return timeNavigationLoad(this.navigationLoad, 'recomputePathVariants', async () => {
      const result = await this.attempts.recomputeAllPathVariants(options);
      this.lastPathVariantRecompute = result;
      if (result.skipped) {
        this.navigationLoad.counters.pathVariantRecomputeSkips += 1;
      } else {
        this.navigationLoad.counters.pathVariantRecomputeRuns += 1;
      }
      this.navigationLoad.counters.pathVariantRecomputeListSamples += result.listSamplesCalls;
      this.navigationLoad.counters.listSamplesCalls += result.listSamplesCalls;
      return { value: result, cacheHit: result.skipped };
    });
  }

  async bootstrap(): Promise<HomeSnapshot> {
    await this.preparePersistence();
    await this.recoverTracker();
    await this.reconcileAttempts();
    return this.loadHome();
  }

  async loadHome(): Promise<HomeSnapshot> {
    return timeNavigationLoad(this.navigationLoad, 'loadHome', async () => {
      this.navigationLoad.counters.loadHomeReads += 1;
      const [
        routes,
        placeList,
        activeSession,
        pendingRecording,
        activeAttempt,
        attemptResult,
        allAttempts,
        activeTransportationMode,
        failedReconciliationAttemptId,
      ] = await Promise.all([
        this.routes.listRoutes(),
        this.places.listPlaces(),
        this.sessions.getActiveSession(),
        this.sessions.findPendingRouteCreation(),
        this.attempts.getOpenAttempt(),
        this.attempts.getUnacknowledgedResult(),
        this.attempts.listAttempts(),
        this.settings.getActiveTransportationMode(),
        this.attempts.peekFailedReconciliationAttemptId(),
      ]);
      const activeRecording = activeSession?.purpose === 'route_creation' ? activeSession : null;
      const key = homeDerivationKey({
        attempts: allAttempts,
        places: placeList,
        activeTransportationMode,
        activeRecording,
        pendingRecording,
        activeAttemptId: activeAttempt?.id ?? null,
        attemptResultId: activeAttempt ? null : (attemptResult?.id ?? null),
      });
      const cached = this.homeCache.get(key);
      if (cached) {
        this.navigationLoad.counters.loadHomeHits += 1;
        return { value: cached, cacheHit: true };
      }
      this.navigationLoad.counters.loadHomeMisses += 1;
      const traces = tracesFromAttempts(allAttempts);
      const placesById = new Map(placeList.map((place) => [place.id, place]));
      const canStart = activeSession == null && pendingRecording == null;
      const snapshot: HomeSnapshot = {
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
        failedReconciliationAttemptId,
      };
      this.homeCache.set(key, snapshot);
      return { value: snapshot, cacheHit: false };
    });
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
    await this.recoverTracker();
    await this.reconcileAttempts();
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
    const samples = await this.listAttemptSamples(sessionId);
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
      status: 'active',
      kind: 'explicit',
      clusterSignature: null,
      classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
    };
    await this.routes.createRoute(route);
    await this.sessions.setReviewDisposition(sessionId, 'saved');
    await this.syncPlacesForRoute(route);
    await this.attempts.recomputeAllPathVariants();
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
    await this.attempts.recomputeAllPathVariants();
  }

  async renamePathVariant(routeId: string, name: string): Promise<SaveRouteResult> {
    const validation = validateRouteName(name);
    if (!validation.valid) {
      return { ok: false, reason: validation.reason ?? 'Every path variant needs a name.' };
    }
    const existing = await this.routes.getRoute(routeId);
    if (!existing) {
      return { ok: false, reason: 'This path variant is no longer available.' };
    }
    await this.routes.renameRoute(routeId, name.trim());
    const route = await this.routes.getRoute(routeId);
    if (!route) {
      return { ok: false, reason: 'This path variant is no longer available.' };
    }
    return { ok: true, route };
  }

  async archivePathVariant(routeId: string): Promise<SaveRouteResult> {
    const existing = await this.routes.getRoute(routeId);
    if (!existing) {
      return { ok: false, reason: 'This path variant is no longer available.' };
    }
    await this.routes.setRouteStatus(routeId, 'archived');
    await this.attempts.recomputeAllPathVariants();
    const route = await this.routes.getRoute(routeId);
    if (!route) {
      return { ok: false, reason: 'This path variant is no longer available.' };
    }
    return { ok: true, route };
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

  async archivePlace(placeId: string): Promise<RemovePlaceResult> {
    const existing = await this.places.getPlace(placeId);
    if (!existing) {
      return { ok: false, reason: 'This place is no longer available.' };
    }
    await this.places.archivePlace(placeId);
    return { ok: true, action: 'archived' };
  }

  async countAttemptsReferencingPlace(placeId: string): Promise<number> {
    return this.attempts.countAttemptsReferencingPlace(placeId);
  }

  async deletePlacePermanently(placeId: string): Promise<RemovePlaceResult> {
    const existing = await this.places.getPlace(placeId);
    if (!existing) {
      return { ok: false, reason: 'This place is no longer available.' };
    }
    const open = await this.attempts.getOpenAttempt();
    if (openAttemptBlocksPlaceDeletion(open, existing)) {
      return { ok: false, reason: PLACE_LIVE_ATTEMPT_REASON };
    }

    const referencing = (await this.attempts.listAttempts()).filter((attempt) =>
      attemptReferencesPlace(attempt, placeId),
    );
    const protectedSessionIds = new Set(
      (await this.routes.listRoutes()).map((route) => route.sourceRecordingId),
    );
    for (const attempt of referencing) {
      await this.attempts.deleteAttempt(attempt.id);
      if (!protectedSessionIds.has(attempt.sessionId)) {
        await this.sessions.deleteSession(attempt.sessionId);
      }
    }
    await this.places.deletePlace(placeId);
    return { ok: true, action: 'deleted', deletedAttemptCount: referencing.length };
  }

  async removePlace(placeId: string): Promise<RemovePlaceResult> {
    return this.deletePlacePermanently(placeId);
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
    return timeNavigationLoad(this.navigationLoad, 'inspectAttempt', async () => {
      this.navigationLoad.counters.inspectAttemptReads += 1;
      const attempt = await this.attempts.getAttempt(attemptId);
      if (!attempt) {
        this.navigationLoad.counters.inspectAttemptMisses += 1;
        return { value: null, cacheHit: false };
      }
      const [places, session, route] = await Promise.all([
        this.places.listPlaces(),
        this.sessions.getSession(attempt.sessionId),
        attempt.routeId ? this.routes.getRoute(attempt.routeId) : Promise.resolve(null),
      ]);
      const sampleIdentity: SampleIdentity = {
        sessionId: attempt.sessionId,
        lastSampleAtMs: session?.lastSampleAtMs ?? null,
      };
      const key = debugDerivationKey({
        attempt,
        places,
        route,
        sampleIdentity,
      });
      const cached = this.debugCache.get(key);
      if (cached !== undefined) {
        this.navigationLoad.counters.inspectAttemptHits += 1;
        return { value: cached, cacheHit: true };
      }
      this.navigationLoad.counters.inspectAttemptMisses += 1;
      const samples = await this.listAttemptSamples(attempt.sessionId);
      const inspectNow = isOpenAttempt(attempt) ? this.now() : (session?.stoppedAtMs ?? this.now());
      const place = inspectPlaceAttemptRecord(attempt, places, samples, inspectNow);
      let variant: AttemptDebugReport | null = null;
      if (route) {
        variant = inspectAttemptRecord(attempt, timingCourseFromRoute(route), samples);
      }
      const debug: CombinedAttemptDebug = { place, variant };
      this.debugCache.set(key, debug);
      return { value: debug, cacheHit: false };
    });
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
        samples: await this.listAttemptSamples(attempt.sessionId),
      });
    }
    return { route, traces };
  }

  async analyzeRoute(routeId: string): Promise<{ route: Route; analysis: RouteAttemptAnalysis } | null> {
    return timeNavigationLoad(this.navigationLoad, 'analyzeRoute', async () => {
      this.navigationLoad.counters.analyzeRouteReads += 1;
      const route = await this.routes.getRoute(routeId);
      if (!route) {
        this.navigationLoad.counters.analyzeRouteMisses += 1;
        return { value: null, cacheHit: false };
      }
      const attempts = await this.attempts.listAttemptsForRoute(routeId);
      const sampleIdentities = await this.sampleIdentitiesFor(attempts);
      const key = routeAnalysisDerivationKey({ route, attempts, sampleIdentities });
      const cached = this.routeAnalysisCache.get(key);
      if (cached) {
        this.navigationLoad.counters.analyzeRouteHits += 1;
        return { value: cached, cacheHit: true };
      }
      this.navigationLoad.counters.analyzeRouteMisses += 1;
      const traces: AttemptTrace[] = [];
      for (const attempt of attempts) {
        traces.push({
          attempt,
          samples: await this.listAttemptSamples(attempt.sessionId),
        });
      }
      const result = {
        route,
        analysis: analyzeRouteAttempts(
          timingCourseFromRoute(route),
          traces,
          deriveAnchoredLayoutAttempt,
        ),
      };
      this.routeAnalysisCache.set(key, result);
      return { value: result, cacheHit: false };
    });
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

  async analyzeJourneyHeadline(
    pool: JourneyPoolId,
    attemptId: string,
  ): Promise<AnalyzeJourneyResult | null> {
    return timeNavigationLoad(this.navigationLoad, 'analyzeJourneyHeadline', async () => {
      this.navigationLoad.counters.analyzeJourneyHeadlineReads += 1;
      const origin = await this.places.getPlace(pool.originPlaceId);
      const destination = await this.places.getPlace(pool.destinationPlaceId);
      if (!origin || !destination) {
        return { value: null, cacheHit: false };
      }
      const attempts = await this.attempts.listAttempts();
      const traces = tracesFromAttempts(attempts);
      return {
        value: {
          summary: summarizeJourneyPool(pool, origin, destination, traces),
          history: journeyHistoryRows(pool, traces),
          focus: analyzeJourneyHeadline(pool, origin, destination, traces, attemptId),
        },
        cacheHit: false,
      };
    });
  }

  async analyzeJourney(pool: JourneyPoolId, attemptId: string): Promise<AnalyzeJourneyResult | null> {
    return timeNavigationLoad(this.navigationLoad, 'analyzeJourney', async () => {
      this.navigationLoad.counters.analyzeJourneyReads += 1;
      const origin = await this.places.getPlace(pool.originPlaceId);
      const destination = await this.places.getPlace(pool.destinationPlaceId);
      if (!origin || !destination) {
        this.navigationLoad.counters.analyzeJourneyMisses += 1;
        return { value: null, cacheHit: false };
      }
      const [allAttempts, routes] = await Promise.all([
        this.attempts.listAttempts(),
        this.routes.listRoutes(),
      ]);
      const poolAttempts = allAttempts.filter((attempt) => attemptInPool(attempt, pool));
      const sampleIdentities = await this.sampleIdentitiesFor(poolAttempts);
      const key = focusDerivationKey({
        pool,
        attemptId,
        attempts: poolAttempts,
        origin,
        destination,
        routes,
        sampleIdentities,
      });
      const cached = this.focusCache.get(key);
      if (cached) {
        this.navigationLoad.counters.analyzeJourneyHits += 1;
        return { value: cached, cacheHit: true };
      }
      this.navigationLoad.counters.analyzeJourneyMisses += 1;
      const traces = await this.tracesWithSamples(poolAttempts);
      const result: AnalyzeJourneyResult = {
        summary: summarizeJourneyPool(pool, origin, destination, traces),
        history: journeyHistoryRows(pool, traces),
        focus: analyzeJourneyFocus(pool, origin, destination, traces, attemptId, routes),
      };
      this.focusCache.set(key, result);
      return { value: result, cacheHit: false };
    });
  }

  async loadJourney(pool: JourneyPoolId): Promise<LoadedJourney | null> {
    return timeNavigationLoad(this.navigationLoad, 'loadJourney', async () => {
      this.navigationLoad.counters.loadJourneyReads += 1;
      const origin = await this.places.getPlace(pool.originPlaceId);
      const destination = await this.places.getPlace(pool.destinationPlaceId);
      if (!origin || !destination) {
        this.navigationLoad.counters.loadJourneyMisses += 1;
        return { value: null, cacheHit: false };
      }
      const [allAttempts, routes] = await Promise.all([
        this.attempts.listAttempts(),
        this.routes.listRoutes(),
      ]);
      const asOfMs = this.now();
      const poolAttempts = allAttempts.filter((attempt) => attemptInPool(attempt, pool));
      const key = journeyDerivationKey({
        pool,
        attempts: poolAttempts,
        origin,
        destination,
        routes,
        asOfMs,
      });
      const cached = this.journeyCache.get(key);
      if (cached) {
        this.navigationLoad.counters.loadJourneyHits += 1;
        return {
          value: {
            ...cached,
            statistics: { ...cached.statistics, asOfMs },
          },
          cacheHit: true,
        };
      }
      this.navigationLoad.counters.loadJourneyMisses += 1;
      const traces = tracesFromAttempts(poolAttempts);
      const loaded: LoadedJourney = {
        origin,
        destination,
        summary: summarizeJourneyPool(pool, origin, destination, traces),
        statistics: computeJourneyPoolStatistics(pool, traces, asOfMs),
        departureGrouping: computeJourneyPoolDepartureGrouping(pool, traces, asOfMs),
        history: journeyHistoryRows(pool, traces),
        routes,
        pathVariants: summarizeJourneyPathVariants(
          origin,
          destination,
          pool.transportationMode,
          traces,
          routes,
        ),
      };
      this.journeyCache.set(key, loaded);
      return { value: loaded, cacheHit: false };
    });
  }

  private async listAttemptSamples(sessionId: string): Promise<LocationSample[]> {
    this.navigationLoad.counters.listSamplesCalls += 1;
    return this.sessions.listSamples(sessionId);
  }

  private async sampleIdentitiesFor(attempts: Attempt[]): Promise<SampleIdentity[]> {
    const identities: SampleIdentity[] = [];
    for (const attempt of attempts) {
      const session = await this.sessions.getSession(attempt.sessionId);
      identities.push({
        sessionId: attempt.sessionId,
        lastSampleAtMs: session?.lastSampleAtMs ?? null,
      });
    }
    return identities;
  }

  private async tracesWithSamples(attempts: Attempt[]): Promise<JourneyAttemptTrace[]> {
    const traces: JourneyAttemptTrace[] = [];
    for (const attempt of attempts) {
      traces.push({
        attempt,
        samples: await this.listAttemptSamples(attempt.sessionId),
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
}
