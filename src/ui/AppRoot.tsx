import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Pressable, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import { HIDE_INCOMPLETE_MESSAGE, HIDE_INCOMPLETE_TITLE } from '../domain/attempt';
import {
  createCourseEditorDraft,
  toCourseLayout,
  type CourseEditorDraft,
} from '../domain/course-editor';
import type { JourneyPoolId } from '../domain/journey';
import type { JourneyFocusAnalysis, JourneyHistoryRow, JourneyPoolSummary } from '../domain/journey-analysis';
import {
  emptyDepartureGrouping,
  type JourneyDepartureGroup,
  type JourneyDepartureGrouping,
} from '../domain/journey-departure';
import { computeJourneyStatistics, type JourneyPoolStatistics } from '../domain/journey-statistics';
import type { JourneyPathVariantSummary } from '../domain/path-variant-discovery';
import { DEFAULT_PLACE_RADIUS_METERS, placePermanentDeletionMessage, type Place } from '../domain/place';
import {
  sameAttemptLocationSample,
  sameAttemptPlaces,
  sameGpsReadiness,
} from '../domain/attempt-live-map';
import { WAITING_GPS_READINESS, type GpsReadiness } from '../domain/gps-readiness';
import type { LocationSample } from '../domain/location-sample';
import type { PlaceStartZoneStatus } from '../domain/place-timing';
import type { Route, TransportationMode } from '../domain/route';
import type { RouteDerivation } from '../domain/route-derivation';
import type { RouteCompetitiveSummary } from '../domain/attempt-analysis';
import { IDLE_TRACKING_STATE, type TrackingState } from '../domain/tracking-state';
import type { TrackingSessionRecord } from '../persistence/location-sample-store';
import type { ProcessActiveAttemptResult } from '../product/attempt-runtime';
import {
  APP_STARTUP_STAGE_LABELS,
  APP_STARTUP_WATCHDOG_MS,
  formatStartupError,
  startAppStartup,
  type AppStartupStage,
} from '../product/app-startup';
import {
  acknowledgementFailureStillVisible,
  ATTEMPT_ACK_FAILURE_MESSAGE,
  beginAttemptClose,
  beginResultOpen,
  beginResultPresentation,
  captureResultWork,
  captureResumeWatch,
  createAttemptResultShell,
  createResultSession,
  finishAttemptClose,
  forwardAbortSignal,
  hideNavigationAfterDismiss,
  invalidateResultPresentation,
  isCurrentPathAnalyticsLoad,
  isCurrentResultRequest,
  isCurrentSecondaryLoad,
  journeyPoolForAttempt,
  loadAttemptPathAnalytics,
  loadAttemptResultSecondary,
  modeUpdateMayReopen,
  PATH_ANALYTICS_INTERRUPTED_MESSAGE,
  restoreMayTouchAttempt,
  resultExitDestination,
  resultSurfaceKind,
  resumeMayReopenAttempt,
  retryPathAnalyticsSession,
  startResultLoads,
  settledPathAnalyticsView,
  successorResultOpen,
  type ResultSession,
  type ResultWorkCapture,
  type SettledPathAnalyticsView,
  type AttemptResultSecondaryUpdate,
  type ResultOpen,
} from '../product/attempt-result-load';
import { yieldToEventLoop } from '../product/idle-yield';
import {
  beginJourneySnapshotLoad,
  canOpenJourneyHistory,
  canPresentRetainedJourney,
  finishJourneySnapshotLoad,
} from '../product/journey-navigation';
import type { CombinedAttemptDebug, HomeSnapshot, LoadedJourney, RouteWorkspace } from '../product/route-workspace';
import { sameJourneyPool } from '../domain/journey';
import { AttemptResultScreen } from './AttemptResultScreen';
import { AttemptScreen } from './AttemptScreen';
import { CourseEditorScreen } from './CourseEditorScreen';
import { HistoryScreen } from './HistoryScreen';
import { HomeScreen } from './HomeScreen';
import { JourneyDetailScreen } from './JourneyDetailScreen';
import { PlaceEditorScreen, type PlaceEditorDraft } from './PlaceEditorScreen';
import { PlacesScreen } from './PlacesScreen';
import { RecordingScreen } from './RecordingScreen';
import { ReviewScreen } from './ReviewScreen';
import { RouteDetailScreen } from './RouteDetailScreen';
import { SettingsScreen } from './SettingsScreen';
import { styles } from './styles';
import { resolveAttemptDisplayRoute } from './attempt-display-route';
import { handleSystemBack, type AppScreenKind } from './system-back';

function beginPathAnalyticsSignal(
  current: AbortController | null,
  external?: AbortSignal,
): AbortController {
  current?.abort();
  return forwardAbortSignal(external);
}

const LOCATING_ZONE: PlaceStartZoneStatus = {
  status: 'locating',
  placeId: null,
  placeName: null,
  distanceMeters: null,
  overlapTieBreak: null,
};

type AppScreen =
  | { kind: Exclude<AppScreenKind, 'review' | 'detail' | 'editor' | 'history' | 'attempt-detail' | 'journey' | 'place-editor'> }
  | { kind: 'review'; sessionId: string }
  | { kind: 'journey'; pool: JourneyPoolId }
  | { kind: 'detail'; routeId: string }
  | { kind: 'editor'; routeId: string }
  | { kind: 'history'; pool: JourneyPoolId }
  | { kind: 'attempt-detail'; pool: JourneyPoolId; attemptId: string }
  | { kind: 'place-editor'; placeId: string | null };

type AppRootProps = {
  workspace: RouteWorkspace;
};

function JourneyLoadingShell({ onBack, error }: { onBack: () => void; error?: string | null }) {
  return (
    <View style={styles.content}>
      <Pressable accessibilityRole="button" onPress={onBack}>
        <Text style={styles.kicker}>← JOURNEYS</Text>
      </Pressable>
      <Text style={styles.title}>Loading journey…</Text>
      <Text style={styles.mutedText}>Official time and PB load from saved attempts first.</Text>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

export function AppRoot({ workspace }: AppRootProps) {
  const [screen, setScreen] = useState<AppScreen>({ kind: 'loading' });
  const [places, setPlaces] = useState<Place[]>([]);
  const [journeys, setJourneys] = useState<JourneyPoolSummary[]>([]);
  const [incomplete, setIncomplete] = useState<Attempt[]>([]);
  const [hiddenIncomplete, setHiddenIncomplete] = useState<Attempt[]>([]);
  const [activeMode, setActiveMode] = useState<TransportationMode>('scooter');
  const [pendingRecording, setPendingRecording] = useState<TrackingSessionRecord | null>(null);
  const [canStartNewRecording, setCanStartNewRecording] = useState(true);
  const [canStartAttempt, setCanStartAttempt] = useState(true);
  const [trackingState, setTrackingState] = useState<TrackingState>(IDLE_TRACKING_STATE);
  const [reviewSession, setReviewSession] = useState<TrackingSessionRecord | null>(null);
  const [reviewDerivation, setReviewDerivation] = useState<RouteDerivation | null>(null);
  const [reviewPointCount, setReviewPointCount] = useState(0);
  const [routeName, setRouteName] = useState('');
  const [routeMode, setRouteMode] = useState<TransportationMode>('scooter');
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [courseDraft, setCourseDraft] = useState<CourseEditorDraft | null>(null);
  const [placeDraft, setPlaceDraft] = useState<PlaceEditorDraft | null>(null);
  const [originPlace, setOriginPlace] = useState<Place | null>(null);
  const [destinationPlace, setDestinationPlace] = useState<Place | null>(null);
  const [journeySummary, setJourneySummary] = useState<JourneyPoolSummary | null>(null);
  const [journeyStatistics, setJourneyStatistics] = useState<JourneyPoolStatistics>(() =>
    computeJourneyStatistics([], 0),
  );
  const [journeyGrouping, setJourneyGrouping] = useState<JourneyDepartureGrouping>(() =>
    emptyDepartureGrouping(),
  );
  const [journeyHistory, setJourneyHistory] = useState<JourneyHistoryRow[]>([]);
  const [journeyPathVariants, setJourneyPathVariants] = useState<JourneyPathVariantSummary[]>([]);
  const [activeAttempt, setActiveAttempt] = useState<Attempt | null>(null);
  const [originName, setOriginName] = useState<string | null>(null);
  const [startZoneStatus, setStartZoneStatus] = useState<PlaceStartZoneStatus>(LOCATING_ZONE);
  const [gpsReadiness, setGpsReadiness] = useState<GpsReadiness>(WAITING_GPS_READINESS);
  const [latestSample, setLatestSample] = useState<LocationSample | null>(null);
  const [effectivePlaces, setEffectivePlaces] = useState<Place[]>([]);
  const [sampleGpsReadiness, setSampleGpsReadiness] = useState<GpsReadiness>(WAITING_GPS_READINESS);
  const [attemptObservedAtMs, setAttemptObservedAtMs] = useState(() => Date.now());
  const [attemptResult, setAttemptResult] = useState<Attempt | null>(null);
  const [journeyFocus, setJourneyFocus] = useState<JourneyFocusAnalysis | null>(null);
  const [attemptDebug, setAttemptDebug] = useState<CombinedAttemptDebug | null>(null);
  const [routeSummary, setRouteSummary] = useState<RouteCompetitiveSummary | null>(null);
  const [historyMode, setHistoryMode] = useState<'chronological' | 'ranked'>('chronological');
  const [historyGroupFilter, setHistoryGroupFilter] = useState<JourneyDepartureGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedReconciliationAttemptId, setFailedReconciliationAttemptId] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState<AppStartupStage>('opening-database');
  const [startupNonce, setStartupNonce] = useState(0);
  const [debugPending, setDebugPending] = useState(false);
  const [pathAnalyticsPending, setPathAnalyticsPending] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [pathAnalyticsError, setPathAnalyticsError] = useState<string | null>(null);
  const [pathAnalyticsUnavailable, setPathAnalyticsUnavailable] = useState(false);
  const [journeySnapshotReady, setJourneySnapshotReady] = useState(false);
  const startupTokenRef = useRef(0);
  const activeJourneyPoolRef = useRef<JourneyPoolId | null>(null);
  const journeyLoadTokenRef = useRef(0);
  const resultSessionRef = useRef<ResultSession>(createResultSession());
  const resultOpenRef = useRef<ResultOpen | null>(null);
  const pathAnalyticsAbortRef = useRef<AbortController | null>(null);
  const routeDetailTokenRef = useRef(0);
  const attemptResultRef = useRef<Attempt | null>(null);
  const headlineFocusRef = useRef<JourneyFocusAnalysis | null>(null);
  const pathViewRef = useRef<SettledPathAnalyticsView | null>(null);
  const screenRef = useRef<AppScreen>({ kind: 'loading' });
  const showAttemptResultRef = useRef<(attempt: Attempt, signal?: AbortSignal) => Promise<void>>(
    async () => undefined,
  );
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const applyLoadedJourney = useCallback((pool: JourneyPoolId, loaded: LoadedJourney) => {
    const active = activeJourneyPoolRef.current;
    if (!active || !sameJourneyPool(active, pool)) {
      return;
    }
    setOriginPlace(loaded.origin);
    setDestinationPlace(loaded.destination);
    setJourneySummary(loaded.summary);
    setJourneyStatistics(loaded.statistics);
    setJourneyGrouping(loaded.departureGrouping);
    setJourneyHistory(loaded.history);
    setJourneyPathVariants(loaded.pathVariants);
  }, []);

  const refreshHome = useCallback(async () => {
    const snapshot = await workspace.loadHome();
    setPlaces(snapshot.places);
    setJourneys(snapshot.journeys);
    setIncomplete(snapshot.incompleteAttempts);
    setHiddenIncomplete(snapshot.hiddenIncompleteAttempts);
    setActiveMode(snapshot.activeTransportationMode);
    setPendingRecording(snapshot.pendingRecording);
    setCanStartNewRecording(snapshot.canStartNewRecording);
    setCanStartAttempt(snapshot.canStartAttempt);
    setFailedReconciliationAttemptId(snapshot.failedReconciliationAttemptId);
    return snapshot;
  }, [workspace]);

  const commitJourneyLoad = useCallback(
    async (pool: JourneyPoolId, token: number) => {
      const loaded = await workspace.loadJourney(pool);
      const outcome = finishJourneySnapshotLoad(
        token,
        journeyLoadTokenRef.current,
        activeJourneyPoolRef.current,
        pool,
        loaded,
      );
      if (outcome.kind !== 'ready') {
        return outcome;
      }
      applyLoadedJourney(pool, outcome.loaded);
      setJourneySnapshotReady(true);
      return outcome;
    },
    [applyLoadedJourney, workspace],
  );

  const loadJourney = useCallback(
    async (pool: JourneyPoolId) => {
      const began = beginJourneySnapshotLoad(journeyLoadTokenRef.current);
      journeyLoadTokenRef.current = began.token;
      activeJourneyPoolRef.current = pool;
      setJourneySnapshotReady(began.snapshotReady);
      return commitJourneyLoad(pool, began.token);
    },
    [commitJourneyLoad],
  );

  const applyPathAnalyticsUpdate = useCallback((pathToken: number, update: Extract<AttemptResultSecondaryUpdate, { kind: 'pathAnalytics' }>) => {
    if (!isCurrentPathAnalyticsLoad(resultSessionRef.current.gate, pathToken)) {
      return;
    }
    const view = settledPathAnalyticsView(update);
    if (view === 'cancelled') {
      setPathAnalyticsPending(false);
      setPathAnalyticsError(PATH_ANALYTICS_INTERRUPTED_MESSAGE);
      return;
    }
    if (view === 'error') {
      setPathAnalyticsPending(false);
      setPathAnalyticsUnavailable(false);
      setPathAnalyticsError(update.pathAnalyticsError);
      return;
    }
    if (view === 'skipped') {
      setPathAnalyticsPending(false);
      setPathAnalyticsUnavailable(false);
      setPathAnalyticsError(null);
      return;
    }
    if (view === 'unavailable') {
      pathViewRef.current = 'unavailable';
      setPathAnalyticsPending(false);
      setPathAnalyticsError(null);
      setPathAnalyticsUnavailable(true);
      if (update.pathAnalytics?.focus) {
        headlineFocusRef.current = update.pathAnalytics.focus;
        setJourneyFocus(update.pathAnalytics.focus);
        return;
      }
      const base = headlineFocusRef.current;
      if (base) {
        const unavailable = { ...base, pathAnalytics: null, pathUnavailable: true as const };
        headlineFocusRef.current = unavailable;
        setJourneyFocus(unavailable);
      }
      return;
    }
    pathViewRef.current = 'ready';
    setPathAnalyticsPending(false);
    setPathAnalyticsError(null);
    setPathAnalyticsUnavailable(false);
    if (update.pathAnalytics?.focus) {
      setJourneyFocus(update.pathAnalytics.focus);
    }
  }, []);

  const openReview = useCallback(
    async (sessionId: string, signal?: AbortSignal) => {
      const { session, samples, derivation } = await workspace.deriveSession(sessionId);
      if (signal?.aborted) {
        return;
      }
      setReviewSession(session);
      setReviewDerivation(derivation);
      setReviewPointCount(samples.length);
      setScreen({ kind: 'review', sessionId });
    },
    [workspace],
  );

  const publishAttemptRuntime = useCallback((processed: ProcessActiveAttemptResult): boolean => {
    setAttemptObservedAtMs(Date.now());
    setLatestSample((current) =>
      sameAttemptLocationSample(current, processed.latestSample) ? current : processed.latestSample,
    );
    setEffectivePlaces((current) =>
      sameAttemptPlaces(current, processed.effectivePlaces) ? current : processed.effectivePlaces,
    );
    setSampleGpsReadiness((current) =>
      sameGpsReadiness(current, processed.sampleGpsReadiness) ? current : processed.sampleGpsReadiness,
    );
    if (!processed.attempt) {
      return false;
    }
    setStartZoneStatus(processed.startZoneStatus);
    setGpsReadiness(processed.gpsReadiness);
    if (processed.attempt.originPlaceId) {
      const origin = processed.effectivePlaces.find((place) => place.id === processed.attempt?.originPlaceId);
      setOriginName(origin?.name ?? processed.startZoneStatus.placeName);
    } else {
      setOriginName(processed.startZoneStatus.placeName);
    }
    if (processed.attempt.lifecycle === 'armed' || processed.attempt.lifecycle === 'active') {
      setActiveAttempt(processed.attempt);
      return true;
    }
    return false;
  }, []);

  const showAttempt = useCallback(
    async (attempt: Attempt, signal?: AbortSignal) => {
      const processed = await workspace.processActiveAttemptWithStartZoneStatus();
      if (signal?.aborted) {
        return;
      }
      const open = publishAttemptRuntime(processed);
      attemptResultRef.current = null;
      setAttemptResult(null);
      if (!open && processed.attempt) {
        await showAttemptResultRef.current(processed.attempt, signal);
        return;
      }
      if (!open) {
        setActiveAttempt(attempt);
      }
      setScreen({ kind: 'attempt' });
    },
    [publishAttemptRuntime, workspace],
  );

  const showAttemptResult = useCallback(
    async (attempt: Attempt, signal?: AbortSignal, nextScreen: AppScreen = { kind: 'attempt-result' }) => {
      const begun = beginResultPresentation(resultSessionRef.current);
      resultSessionRef.current = begun.session;
      const requestId = begun.requestId;
      const open = beginResultOpen(requestId);
      resultOpenRef.current = open;
      const stale = () => signal?.aborted || !isCurrentResultRequest(resultSessionRef.current.gate, requestId);
      const adoptSuccessor = async () => {
        const successor = successorResultOpen(resultOpenRef.current, requestId);
        if (!successor) {
          open.finish();
          return;
        }
        try {
          await successor;
          open.finish();
        } catch (successorFailure) {
          open.finish(successorFailure);
          throw successorFailure;
        }
      };
      if (stale()) {
        await adoptSuccessor();
        return;
      }
      const started = startResultLoads(resultSessionRef.current);
      resultSessionRef.current = started.session;
      const loadToken = started.loadToken;
      const pathToken = started.pathToken;
      const shell = createAttemptResultShell(attempt);
      const loadController = beginPathAnalyticsSignal(pathAnalyticsAbortRef.current, signal);
      pathAnalyticsAbortRef.current = loadController;
      headlineFocusRef.current = null;
      pathViewRef.current = null;
      setActiveAttempt(null);
      setStartZoneStatus(LOCATING_ZONE);
      setGpsReadiness(WAITING_GPS_READINESS);
      setSelectedRoute(null);
      attemptResultRef.current = attempt;
      setAttemptResult(attempt);
      setJourneyFocus(null);
      setAttemptDebug(shell.debug);
      setDebugPending(shell.debugPending);
      setPathAnalyticsPending(shell.pathAnalyticsPending);
      setPathAnalyticsUnavailable(false);
      setDebugError(null);
      setPathAnalyticsError(null);
      screenRef.current = nextScreen;
      setScreen(nextScreen);
      void loadAttemptResultSecondary(
        workspace,
        attempt,
        (update) => {
          if (update.kind === 'debug') {
            if (!isCurrentSecondaryLoad(resultSessionRef.current.gate, loadToken)) {
              return;
            }
            setAttemptDebug(update.debug);
            setDebugError(update.debugError);
            setDebugPending(false);
            return;
          }
          applyPathAnalyticsUpdate(pathToken, update);
        },
        {
          signal: loadController.signal,
          yieldToIdle: yieldToEventLoop,
        },
      );
      open.finish();
      void (async () => {
        try {
          const route = await resolveAttemptDisplayRoute(attempt, (routeId) => workspace.getRoute(routeId));
          if (stale() || !isCurrentSecondaryLoad(resultSessionRef.current.gate, loadToken)) {
            return;
          }
          setSelectedRoute(route);
          const pool = journeyPoolForAttempt(attempt);
          if (!pool) {
            return;
          }
          const headline = await workspace.analyzeJourneyHeadline(pool, attempt.id);
          if (stale() || !isCurrentSecondaryLoad(resultSessionRef.current.gate, loadToken)) {
            return;
          }
          if (pathViewRef.current === 'ready' || !headline?.focus) {
            return;
          }
          if (pathViewRef.current === 'unavailable' && headlineFocusRef.current?.pathUnavailable) {
            return;
          }
          headlineFocusRef.current = headline.focus;
          if (pathViewRef.current === 'unavailable') {
            const unavailable = { ...headline.focus, pathAnalytics: null, pathUnavailable: true as const };
            headlineFocusRef.current = unavailable;
            setJourneyFocus(unavailable);
            return;
          }
          setJourneyFocus(headline.focus);
        } catch (caught) {
          if (stale() || !isCurrentSecondaryLoad(resultSessionRef.current.gate, loadToken)) {
            return;
          }
          setError(caught instanceof Error ? caught.message : 'Could not open this result.');
        }
      })();
    },
    [applyPathAnalyticsUpdate, workspace],
  );

  useEffect(() => {
    showAttemptResultRef.current = (attempt, signal) => showAttemptResult(attempt, signal);
  }, [showAttemptResult]);

  const applyStartupSnapshot = useCallback(
    async (snapshot: HomeSnapshot, signal?: AbortSignal) => {
      if (signal?.aborted) {
        return;
      }
      setError(null);
      setPlaces(snapshot.places);
      setJourneys(snapshot.journeys);
      setIncomplete(snapshot.incompleteAttempts);
      setHiddenIncomplete(snapshot.hiddenIncompleteAttempts);
      setActiveMode(snapshot.activeTransportationMode);
      setPendingRecording(snapshot.pendingRecording);
      setCanStartNewRecording(snapshot.canStartNewRecording);
      setCanStartAttempt(snapshot.canStartAttempt);
      setFailedReconciliationAttemptId(snapshot.failedReconciliationAttemptId);
      if (snapshot.activeAttempt) {
        await showAttempt(snapshot.activeAttempt, signal);
        return;
      }
      if (snapshot.attemptResult) {
        await showAttemptResult(snapshot.attemptResult, signal);
        return;
      }
      if (snapshot.activeRecording) {
        const state = await workspace.getTrackingState();
        if (signal?.aborted) {
          return;
        }
        setTrackingState(state);
        setScreen({ kind: 'recording' });
        return;
      }
      if (snapshot.pendingRecording) {
        await openReview(snapshot.pendingRecording.id, signal);
        return;
      }
      if (signal?.aborted) {
        return;
      }
      setScreen({ kind: 'home' });
    },
    [openReview, showAttempt, showAttemptResult, workspace],
  );

  const applyStartupSnapshotRef = useRef(applyStartupSnapshot);

  useEffect(() => {
    applyStartupSnapshotRef.current = applyStartupSnapshot;
  }, [applyStartupSnapshot]);

  const retryBootstrap = useCallback(() => {
    setError(null);
    setStartupStage('opening-database');
    setScreen({ kind: 'loading' });
    setStartupNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    const token = startupTokenRef.current + 1;
    startupTokenRef.current = token;
    const controller = new AbortController();
    const session = startAppStartup(
      {
        preparePersistence: () => workspace.preparePersistence(),
        recoverTracker: () => workspace.recoverTracker(),
        reconcileAttempts: () => workspace.reconcileAttempts(),
        loadHome: () => workspace.loadHome(),
        reconcilePendingAttempts: async () => {
          const report = await workspace.reconcilePendingAttempts();
          const failed = report.perAttempt.find((item) => item.status === 'failed');
          if (startupTokenRef.current === token) {
            setFailedReconciliationAttemptId(failed?.attemptId ?? null);
          }
        },
      },
      {
        onStage: (stage) => {
          if (startupTokenRef.current !== token) {
            return;
          }
          setStartupStage(stage);
        },
        onHomeReady: (snapshot) => applyStartupSnapshotRef.current(snapshot, controller.signal),
        onFailure: (failure) => {
          controller.abort();
          if (startupTokenRef.current !== token) {
            return;
          }
          startupTokenRef.current += 1;
          setStartupStage(failure.stage);
          setError(formatStartupError(failure));
          setScreen({ kind: 'init-error' });
        },
      },
      { watchdogMs: APP_STARTUP_WATCHDOG_MS },
    );
    return () => {
      controller.abort();
      session.cancel();
    };
  }, [startupNonce, workspace]);

  useEffect(() => {
    if (screen.kind !== 'recording') {
      return undefined;
    }
    const interval = setInterval(() => {
      void workspace.getTrackingState().then(setTrackingState);
    }, 1000);
    return () => clearInterval(interval);
  }, [screen.kind, workspace]);

  useEffect(() => {
    if (screen.kind !== 'attempt') {
      return undefined;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const processed = await workspace.processActiveAttemptWithStartZoneStatus();
        if (cancelled) {
          return;
        }
        const open = publishAttemptRuntime(processed);
        if (!open && processed.attempt) {
          await showAttemptResult(processed.attempt);
        }
      } catch (caught: unknown) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Could not open this result.');
        }
      }
    };
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [publishAttemptRuntime, screen.kind, showAttemptResult, workspace]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      if (status !== 'active') {
        return;
      }
      void (async () => {
        const seenResume = captureResumeWatch(resultSessionRef.current);
        await workspace.recover();
        const snapshot = await refreshHome();
        if (snapshot.activeAttempt) {
          await showAttempt(snapshot.activeAttempt);
          return;
        }
        if (snapshot.attemptResult) {
          if (resumeMayReopenAttempt(resultSessionRef.current, seenResume, snapshot.attemptResult.id)) {
            await showAttemptResult(snapshot.attemptResult);
          }
          return;
        }
        if (snapshot.activeRecording) {
          setTrackingState(await workspace.getTrackingState());
          setScreen({ kind: 'recording' });
          return;
        }
        if (snapshot.pendingRecording) {
          await openReview(snapshot.pendingRecording.id);
        }
      })().catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Could not open this result.');
      });
    });
    return () => sub.remove();
  }, [openReview, refreshHome, showAttempt, showAttemptResult, workspace]);

  const onRecordNewRoute = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await workspace.startRouteRecording();
      setTrackingState(await workspace.getTrackingState());
      setScreen({ kind: 'recording' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start recording.');
      await refreshHome();
    } finally {
      setBusy(false);
    }
  }, [refreshHome, workspace]);

  const onFinish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await workspace.finishRecording();
      const state = await workspace.getTrackingState();
      if (state.sessionId) {
        await openReview(state.sessionId);
      } else {
        setScreen({ kind: 'home' });
        await refreshHome();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not finish recording.');
      setTrackingState(await workspace.getTrackingState());
    } finally {
      setBusy(false);
    }
  }, [openReview, refreshHome, workspace]);

  const onCancel = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await workspace.cancelRecording();
      await refreshHome();
      setScreen({ kind: 'home' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel recording.');
      setTrackingState(await workspace.getTrackingState());
    } finally {
      setBusy(false);
    }
  }, [refreshHome, workspace]);

  const onEndAndReview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await workspace.interruptRecording();
      const state = await workspace.getTrackingState();
      if (state.sessionId) {
        await openReview(state.sessionId);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not end recording.');
      setTrackingState(await workspace.getTrackingState());
    } finally {
      setBusy(false);
    }
  }, [openReview, workspace]);

  const onSave = useCallback(async () => {
    if (screen.kind !== 'review') {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await workspace.saveRoute(screen.sessionId, routeName, routeMode);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setRouteName('');
      await refreshHome();
      setScreen({ kind: 'home' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save route.');
    } finally {
      setBusy(false);
    }
  }, [refreshHome, routeMode, routeName, screen, workspace]);

  const onDiscard = useCallback(async () => {
    if (screen.kind !== 'review') {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await workspace.discardRecording(screen.sessionId);
      setRouteName('');
      await refreshHome();
      setScreen({ kind: 'home' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not discard recording.');
    } finally {
      setBusy(false);
    }
  }, [refreshHome, screen, workspace]);

  const onStartAttempt = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await workspace.startAttempt();
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      await showAttempt(result.attempt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start.');
    } finally {
      setBusy(false);
    }
  }, [showAttempt, workspace]);

  const onCancelAttempt = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await workspace.cancelAttempt();
      setActiveAttempt(null);
      setStartZoneStatus(LOCATING_ZONE);
      setGpsReadiness(WAITING_GPS_READINESS);
      await refreshHome();
      setScreen({ kind: 'home' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel this attempt.');
    } finally {
      setBusy(false);
    }
  }, [refreshHome, workspace]);

  const onEndAndInspectAttempt = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const ended = await workspace.endAndInspectAttempt();
      if (!ended) {
        setActiveAttempt(null);
        setStartZoneStatus(LOCATING_ZONE);
        setGpsReadiness(WAITING_GPS_READINESS);
        await refreshHome();
        setScreen({ kind: 'home' });
        return;
      }
      await showAttemptResult(ended);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not end and inspect this attempt.');
    } finally {
      setBusy(false);
    }
  }, [refreshHome, showAttemptResult, workspace]);

  const onAcknowledgeAttempt = useCallback(() => {
    if (!attemptResult) {
      return;
    }
    const close = beginAttemptClose(resultSessionRef.current, attemptResult.id);
    resultSessionRef.current = close.session;
    if (!close.claimed) {
      return;
    }
    const attempt = attemptResult;
    const closeGeneration = close.generation;
    const destination = resultExitDestination(attempt);
    pathAnalyticsAbortRef.current?.abort();
    setAttemptResult(null);
    setJourneyFocus(null);
    setAttemptDebug(null);
    setDebugPending(false);
    setPathAnalyticsPending(false);
    setPathAnalyticsUnavailable(false);
    setDebugError(null);
    setPathAnalyticsError(null);
    setError(null);
    attemptResultRef.current = null;
    const journeyToken =
      destination.kind === 'journey' ? beginJourneySnapshotLoad(journeyLoadTokenRef.current).token : null;
    if (destination.kind === 'journey' && journeyToken != null) {
      journeyLoadTokenRef.current = journeyToken;
      activeJourneyPoolRef.current = destination.pool;
      setJourneySnapshotReady(false);
      const next = { kind: 'journey' as const, pool: destination.pool };
      screenRef.current = next;
      setScreen(next);
    } else {
      screenRef.current = { kind: 'home' };
      setScreen({ kind: 'home' });
    }
    const visibleScreen = () => {
      const current = screenRef.current;
      if (current.kind === 'journey' || current.kind === 'history' || current.kind === 'attempt-detail') {
        return current;
      }
      return { kind: current.kind };
    };
    void (async () => {
      let ackFailed = false;
      try {
        await workspace.acknowledgeAttemptResult(attempt.id);
      } catch {
        ackFailed = true;
        if (acknowledgementFailureStillVisible(visibleScreen(), destination)) {
          setError(ATTEMPT_ACK_FAILURE_MESSAGE);
        }
      } finally {
        resultSessionRef.current = finishAttemptClose(resultSessionRef.current, attempt.id, closeGeneration);
      }
      try {
        if (destination.kind === 'journey' && journeyToken != null) {
          const loaded = await commitJourneyLoad(destination.pool, journeyToken);
          if (
            loaded.kind === 'missing' &&
            !ackFailed &&
            acknowledgementFailureStillVisible(visibleScreen(), destination)
          ) {
            setError('This journey is no longer available.');
            activeJourneyPoolRef.current = null;
            setJourneySnapshotReady(false);
            await refreshHome();
            screenRef.current = { kind: 'home' };
            setScreen({ kind: 'home' });
          }
          return;
        }
        if (screenRef.current.kind === 'home') {
          await refreshHome();
        }
      } catch (caught) {
        if (acknowledgementFailureStillVisible(visibleScreen(), destination)) {
          setError(caught instanceof Error ? caught.message : 'Could not open this journey.');
        }
      }
    })();
  }, [attemptResult, commitJourneyLoad, refreshHome, workspace]);

  const leaveResultAfterHide = useCallback(
    async (
      attempt: Attempt,
      captured: ResultWorkCapture,
      capturedSurface: ReturnType<typeof resultSurfaceKind>,
      historyPool: JourneyPoolId | null,
    ) => {
      await refreshHome();
      const navigation = hideNavigationAfterDismiss(
        resultSessionRef.current,
        attempt.id,
        captured,
        capturedSurface,
        resultSurfaceKind(screenRef.current.kind),
      );
      if (navigation === 'stay') {
        return;
      }
      if (attemptResultRef.current?.id === attempt.id) {
        attemptResultRef.current = null;
        setAttemptResult(null);
        setJourneyFocus(null);
        setAttemptDebug(null);
        setDebugPending(false);
        setPathAnalyticsPending(false);
        setPathAnalyticsUnavailable(false);
        setDebugError(null);
        setPathAnalyticsError(null);
        resultSessionRef.current = {
          ...resultSessionRef.current,
          gate: invalidateResultPresentation(resultSessionRef.current.gate),
        };
        pathAnalyticsAbortRef.current?.abort();
      }
      if (navigation === 'history' && historyPool) {
        const next = { kind: 'history' as const, pool: historyPool };
        screenRef.current = next;
        setScreen(next);
        await loadJourney(historyPool);
        return;
      }
      if (navigation === 'home') {
        screenRef.current = { kind: 'home' };
        setScreen({ kind: 'home' });
      }
    },
    [loadJourney, refreshHome],
  );

  const performHideIncomplete = useCallback(
    async (attemptId: string) => {
      const captured = captureResultWork(resultSessionRef.current);
      const capturedSurface = resultSurfaceKind(screenRef.current.kind);
      const historyPool = screenRef.current.kind === 'attempt-detail' ? screenRef.current.pool : null;
      setBusy(true);
      setError(null);
      try {
        const result = await workspace.hideIncompleteAttempt(attemptId);
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        await leaveResultAfterHide(result.attempt, captured, capturedSurface, historyPool);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not hide this incomplete attempt.');
      } finally {
        setBusy(false);
      }
    },
    [leaveResultAfterHide, workspace],
  );

  const confirmHideIncomplete = useCallback(
    (attemptId: string) => {
      Alert.alert(HIDE_INCOMPLETE_TITLE, HIDE_INCOMPLETE_MESSAGE, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Hide',
          onPress: () => {
            void performHideIncomplete(attemptId);
          },
        },
      ]);
    },
    [performHideIncomplete],
  );

  const performRestoreIncomplete = useCallback(
    async (attemptId: string) => {
      const captured = captureResultWork(resultSessionRef.current);
      setBusy(true);
      setError(null);
      try {
        const result = await workspace.restoreIncompleteAttempt(attemptId);
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        const surface = resultSurfaceKind(screenRef.current.kind);
        if (
          restoreMayTouchAttempt(resultSessionRef.current, attemptId, captured) &&
          attemptResultRef.current?.id === attemptId &&
          (surface === 'attempt-result' || surface === 'attempt-detail')
        ) {
          attemptResultRef.current = result.attempt;
          setAttemptResult(result.attempt);
        }
        await refreshHome();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not restore this incomplete attempt.');
      } finally {
        setBusy(false);
      }
    },
    [refreshHome, workspace],
  );

  const onChangeResultMode = useCallback(
    async (mode: TransportationMode) => {
      if (!attemptResult) {
        return;
      }
      const attemptId = attemptResult.id;
      const captured = captureResultWork(resultSessionRef.current);
      const stayOnDetail = screenRef.current.kind === 'attempt-detail';
      setBusy(true);
      setError(null);
      try {
        const updated = await workspace.setAttemptTransportationMode(attemptId, mode);
        if (!updated || !modeUpdateMayReopen(resultSessionRef.current, captured, attemptId)) {
          return;
        }
        const surface = resultSurfaceKind(screenRef.current.kind);
        if (surface !== 'attempt-result' && surface !== 'attempt-detail') {
          return;
        }
        await showAttemptResult(
          updated,
          undefined,
          stayOnDetail && updated.originPlaceId && updated.destinationPlaceId
            ? {
                kind: 'attempt-detail',
                pool: {
                  originPlaceId: updated.originPlaceId,
                  destinationPlaceId: updated.destinationPlaceId,
                  transportationMode: updated.transportationMode,
                },
                attemptId: updated.id,
              }
            : { kind: 'attempt-result' },
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not change transportation mode.');
      } finally {
        setBusy(false);
      }
    },
    [attemptResult, showAttemptResult, workspace],
  );

  const retryPathAnalytics = useCallback(() => {
    if (!attemptResult || !journeyPoolForAttempt(attemptResult)) {
      setPathAnalyticsPending(false);
      setPathAnalyticsUnavailable(false);
      setPathAnalyticsError(null);
      return;
    }
    const attempt = attemptResult;
    const retainedFocus = journeyFocus;
    const retried = retryPathAnalyticsSession(resultSessionRef.current);
    resultSessionRef.current = retried.session;
    const pathToken = retried.pathToken;
    const loadController = beginPathAnalyticsSignal(pathAnalyticsAbortRef.current);
    pathAnalyticsAbortRef.current = loadController;
    setPathAnalyticsPending(true);
    setPathAnalyticsUnavailable(false);
    setPathAnalyticsError(null);
    headlineFocusRef.current = retainedFocus;
    pathViewRef.current = null;
    void loadAttemptPathAnalytics(
      workspace,
      attempt,
      (update) => {
        applyPathAnalyticsUpdate(pathToken, update);
      },
      {
        signal: loadController.signal,
        yieldToIdle: yieldToEventLoop,
      },
    );
  }, [applyPathAnalyticsUpdate, attemptResult, journeyFocus, workspace]);

  const leaveToHome = useCallback(() => {
    setError(null);
    const abandoned = beginJourneySnapshotLoad(journeyLoadTokenRef.current);
    journeyLoadTokenRef.current = abandoned.token;
    activeJourneyPoolRef.current = null;
    setJourneySnapshotReady(abandoned.snapshotReady);
    resultSessionRef.current = {
      ...resultSessionRef.current,
      gate: invalidateResultPresentation(resultSessionRef.current.gate),
    };
    pathAnalyticsAbortRef.current?.abort();
    setDebugPending(false);
    setPathAnalyticsPending(false);
    setPathAnalyticsUnavailable(false);
    setDebugError(null);
    setPathAnalyticsError(null);
    screenRef.current = { kind: 'home' };
    setScreen({ kind: 'home' });
    void refreshHome();
  }, [refreshHome]);

  const onOpenJourney = useCallback(
    async (originPlaceId: string, destinationPlaceId: string, transportationMode: TransportationMode) => {
      const pool = { originPlaceId, destinationPlaceId, transportationMode };
      setError(null);
      setHistoryGroupFilter(null);
      setScreen({ kind: 'journey', pool });
      const loaded = await loadJourney(pool);
      if (loaded.kind === 'superseded') {
        return;
      }
      if (loaded.kind === 'missing') {
        setError('This journey is no longer available.');
        activeJourneyPoolRef.current = null;
        setJourneySnapshotReady(false);
        await refreshHome();
        setScreen({ kind: 'home' });
      }
    },
    [loadJourney, refreshHome],
  );

  const onOpenHistory = useCallback(async () => {
    if (screen.kind !== 'journey') {
      return;
    }
    if (
      !canOpenJourneyHistory({
        snapshotReady: journeySnapshotReady,
        pool: screen.pool,
        origin: originPlace,
        destination: destinationPlace,
        summary: journeySummary,
      })
    ) {
      return;
    }
    setHistoryMode('chronological');
    setHistoryGroupFilter(null);
    setScreen({ kind: 'history', pool: screen.pool });
  }, [destinationPlace, journeySnapshotReady, journeySummary, originPlace, screen]);

  const onOpenGroupAttempts = useCallback(
    (group: JourneyDepartureGroup) => {
      if (screen.kind !== 'journey') {
        return;
      }
      if (
        !canOpenJourneyHistory({
          snapshotReady: journeySnapshotReady,
          pool: screen.pool,
          origin: originPlace,
          destination: destinationPlace,
          summary: journeySummary,
        })
      ) {
        return;
      }
      setHistoryMode('chronological');
      setHistoryGroupFilter(group);
      setScreen({ kind: 'history', pool: screen.pool });
    },
    [destinationPlace, journeySnapshotReady, journeySummary, originPlace, screen],
  );

  const onOpenHistoryAttempt = useCallback(
    async (attemptId: string) => {
      if (screen.kind !== 'history') {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const attempt = await workspace.getAttempt(attemptId);
        if (!attempt) {
          setError('This attempt is no longer available.');
          return;
        }
        await showAttemptResult(attempt, undefined, {
          kind: 'attempt-detail',
          pool: screen.pool,
          attemptId,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not open this attempt.');
      } finally {
        setBusy(false);
      }
    },
    [screen, showAttemptResult, workspace],
  );

  const onBackFromHistoryDetail = useCallback(() => {
    if (screen.kind !== 'attempt-detail') {
      return;
    }
    resultSessionRef.current = {
      ...resultSessionRef.current,
      gate: invalidateResultPresentation(resultSessionRef.current.gate),
    };
    pathAnalyticsAbortRef.current?.abort();
    attemptResultRef.current = null;
    setAttemptResult(null);
    setJourneyFocus(null);
    setAttemptDebug(null);
    setDebugPending(false);
    setPathAnalyticsPending(false);
    setPathAnalyticsUnavailable(false);
    setDebugError(null);
    setPathAnalyticsError(null);
    const pool = screen.pool;
    const next = { kind: 'history' as const, pool };
    screenRef.current = next;
    setScreen(next);
    void loadJourney(pool);
  }, [loadJourney, screen]);

  const onBackFromHistory = useCallback(() => {
    if (screen.kind !== 'history') {
      return;
    }
    const pool = screen.pool;
    setError(null);
    setHistoryGroupFilter(null);
    setScreen({ kind: 'journey', pool });
    void loadJourney(pool);
  }, [loadJourney, screen]);

  const onEditCourse = useCallback(async () => {
    if (!selectedRoute) {
      return;
    }
    setCourseDraft(createCourseEditorDraft(selectedRoute));
    setError(null);
    setScreen({ kind: 'editor', routeId: selectedRoute.id });
  }, [selectedRoute]);

  const onSaveCourse = useCallback(async () => {
    if (screen.kind !== 'editor' || !courseDraft) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await workspace.saveCourseLayout(screen.routeId, toCourseLayout(courseDraft));
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setSelectedRoute(result.route);
      setCourseDraft(null);
      setScreen({ kind: 'detail', routeId: result.route.id });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save course.');
    } finally {
      setBusy(false);
    }
  }, [courseDraft, screen, workspace]);

  const onCancelEditor = useCallback(async () => {
    if (screen.kind !== 'editor') {
      return;
    }
    setCourseDraft(null);
    setError(null);
    setScreen({ kind: 'detail', routeId: screen.routeId });
  }, [screen]);

  const onDeleteRoute = useCallback(async () => {
    if (screen.kind !== 'detail') {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await workspace.deleteRoute(screen.routeId);
      setSelectedRoute(null);
      await refreshHome();
      if (originPlace && destinationPlace && journeySummary) {
        const pool = {
          originPlaceId: originPlace.id,
          destinationPlaceId: destinationPlace.id,
          transportationMode: journeySummary.transportationMode,
        };
        await loadJourney(pool);
        setScreen({ kind: 'journey', pool });
      } else {
        setScreen({ kind: 'home' });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete path variant.');
    } finally {
      setBusy(false);
    }
  }, [destinationPlace, journeySummary, loadJourney, originPlace, refreshHome, screen, workspace]);

  const onOpenPathVariant = useCallback(
    async (routeId: string) => {
      const token = routeDetailTokenRef.current + 1;
      routeDetailTokenRef.current = token;
      setBusy(true);
      setError(null);
      try {
        const route = await workspace.getRoute(routeId);
        if (!route) {
          setError('This path variant is no longer available.');
          return;
        }
        setSelectedRoute(route);
        setRouteSummary(null);
        setScreen({ kind: 'detail', routeId: route.id });
        setBusy(false);
        const analyzed = await workspace.analyzeRoute(route.id);
        if (token !== routeDetailTokenRef.current) {
          return;
        }
        setRouteSummary(analyzed?.analysis.summary ?? null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not open this path variant.');
      } finally {
        setBusy(false);
      }
    },
    [workspace],
  );

  const onRenamePathVariant = useCallback(
    async (name: string) => {
      if (screen.kind !== 'detail') {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await workspace.renamePathVariant(screen.routeId, name);
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setSelectedRoute(result.route);
        if (originPlace && destinationPlace && journeySummary) {
          await loadJourney({
            originPlaceId: originPlace.id,
            destinationPlaceId: destinationPlace.id,
            transportationMode: journeySummary.transportationMode,
          });
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not rename this path variant.');
      } finally {
        setBusy(false);
      }
    },
    [destinationPlace, journeySummary, loadJourney, originPlace, screen, workspace],
  );

  const onArchivePathVariant = useCallback(async () => {
    if (screen.kind !== 'detail') {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await workspace.archivePathVariant(screen.routeId);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setSelectedRoute(null);
      setRouteSummary(null);
      if (originPlace && destinationPlace && journeySummary) {
        const pool = {
          originPlaceId: originPlace.id,
          destinationPlaceId: destinationPlace.id,
          transportationMode: journeySummary.transportationMode,
        };
        await loadJourney(pool);
        setScreen({ kind: 'journey', pool });
      } else {
        setScreen({ kind: 'home' });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not archive this path variant.');
    } finally {
      setBusy(false);
    }
  }, [destinationPlace, journeySummary, loadJourney, originPlace, screen, workspace]);

  const onOpenPlaces = useCallback(() => {
    setError(null);
    setScreen({ kind: 'places' });
    void workspace.listPlaces().then(setPlaces);
  }, [workspace]);

  const onOpenPlaceEditor = useCallback(
    async (placeId: string | null) => {
      if (placeId) {
        const place = await workspace.getPlace(placeId);
        if (!place) {
          setError('This place is no longer available.');
          return;
        }
        setPlaceDraft({
          id: place.id,
          name: place.name,
          center: place.center,
          radiusMeters: place.radiusMeters,
          status: place.status,
        });
      } else {
        const current = await workspace.getCurrentPosition();
        setPlaceDraft({
          id: null,
          name: '',
          center: current ?? { latitude: 32.08, longitude: 34.78 },
          radiusMeters: DEFAULT_PLACE_RADIUS_METERS,
          status: 'active',
        });
      }
      setError(null);
      setScreen({ kind: 'place-editor', placeId });
    },
    [workspace],
  );

  const onSavePlace = useCallback(async () => {
    if (screen.kind !== 'place-editor' || !placeDraft) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = placeDraft.id
        ? await workspace.savePlace({
            id: placeDraft.id,
            name: placeDraft.name,
            center: placeDraft.center,
            radiusMeters: placeDraft.radiusMeters,
            status: placeDraft.status,
            createdAtMs: 0,
          })
        : await workspace.createPlace({
            name: placeDraft.name,
            center: placeDraft.center,
            radiusMeters: placeDraft.radiusMeters,
          });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setPlaceDraft(null);
      setPlaces(await workspace.listPlaces());
      setScreen({ kind: 'places' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save place.');
    } finally {
      setBusy(false);
    }
  }, [placeDraft, screen, workspace]);

  const onArchivePlace = useCallback(async () => {
    if (screen.kind !== 'place-editor' || !placeDraft?.id) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await workspace.archivePlace(placeDraft.id);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setPlaceDraft(null);
      setPlaces(await workspace.listPlaces());
      setScreen({ kind: 'places' });
      await refreshHome();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not archive place.');
    } finally {
      setBusy(false);
    }
  }, [placeDraft, refreshHome, screen, workspace]);

  const performPermanentPlaceDeletion = useCallback(
    async (placeId: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await workspace.deletePlacePermanently(placeId);
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setPlaceDraft(null);
        setPlaces(await workspace.listPlaces());
        setScreen({ kind: 'places' });
        await refreshHome();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not delete place.');
      } finally {
        setBusy(false);
      }
    },
    [refreshHome, workspace],
  );

  const confirmPermanentPlaceDeletion = useCallback(
    (placeId: string) => {
      void (async () => {
        const place = await workspace.getPlace(placeId);
        if (!place) {
          setError('This place is no longer available.');
          return;
        }
        const attemptCount = await workspace.countAttemptsReferencingPlace(placeId);
        Alert.alert(
          'Delete this place permanently?',
          placePermanentDeletionMessage(place.name, attemptCount),
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete permanently',
              style: 'destructive',
              onPress: () => {
                void performPermanentPlaceDeletion(placeId);
              },
            },
          ],
        );
      })();
    },
    [performPermanentPlaceDeletion, workspace],
  );

  const onUseCurrentLocation = useCallback(async () => {
    if (!placeDraft) {
      return;
    }
    const current = await workspace.getCurrentPosition();
    if (!current) {
      setError('Could not read the current location.');
      return;
    }
    setPlaceDraft({ ...placeDraft, center: current });
  }, [placeDraft, workspace]);

  const leavePlaceEditor = useCallback(() => {
    setPlaceDraft(null);
    setError(null);
    setScreen({ kind: 'places' });
    void workspace.listPlaces().then(setPlaces);
  }, [workspace]);

  const leaveDetailToJourney = useCallback(() => {
    routeDetailTokenRef.current += 1;
    if (screen.kind === 'journey') {
      setScreen({ kind: 'home' });
      return;
    }
    if (originPlace && destinationPlace && journeySummary) {
      const pool = {
        originPlaceId: originPlace.id,
        destinationPlaceId: destinationPlace.id,
        transportationMode: journeySummary.transportationMode,
      };
      setScreen({ kind: 'journey', pool });
      void loadJourney(pool);
      return;
    }
    leaveToHome();
  }, [destinationPlace, journeySummary, leaveToHome, loadJourney, originPlace, screen.kind]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () =>
      handleSystemBack(screen.kind, {
        leaveToHome,
        cancelRecording: () => {
          void onCancel();
        },
        leavePlaceEditor,
        leaveDetailToJourney,
        cancelEditor: () => {
          void onCancelEditor();
        },
        leaveHistoryToDetail: onBackFromHistory,
        inspectAttempt: () => {
          void onEndAndInspectAttempt();
        },
        acknowledgeAttemptResult: () => {
          void onAcknowledgeAttempt();
        },
        leaveAttemptDetailToHistory: () => {
          void onBackFromHistoryDetail();
        },
      }),
    );
    return () => sub.remove();
  }, [
    leaveDetailToJourney,
    leavePlaceEditor,
    leaveToHome,
    onAcknowledgeAttempt,
    onBackFromHistory,
    onBackFromHistoryDetail,
    onCancel,
    onCancelEditor,
    onEndAndInspectAttempt,
    screen.kind,
  ]);

  const resultTitle = journeyFocus?.summary.title ?? originName ?? 'Attempt';
  const journeyPoolForSnapshot =
    screen.kind === 'journey' || screen.kind === 'history' ? screen.pool : null;
  const journeySnapshot = journeyPoolForSnapshot
    ? {
        snapshotReady: journeySnapshotReady,
        pool: journeyPoolForSnapshot,
        origin: originPlace,
        destination: destinationPlace,
        summary: journeySummary,
      }
    : null;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {screen.kind === 'loading' ? (
        <View style={styles.content}>
          <Text style={styles.mutedText}>Loading…</Text>
          <Text style={styles.mutedText}>{APP_STARTUP_STAGE_LABELS[startupStage]}</Text>
        </View>
      ) : null}
      {screen.kind === 'init-error' ? (
        <View style={styles.content}>
          <Text style={styles.kicker}>RED LIGHT RNG</Text>
          <Text style={styles.title}>Could not open your data</Text>
          <Text style={styles.subtitle}>
            Startup did not finish. Home never loaded, so this is not an infinite spinner. Your
            history is still on this device. Try again, or keep this error to report the upgrade.
          </Text>
          <Text style={styles.mutedText}>Stage: {startupStage}</Text>
          <Text style={styles.mutedText}>{APP_STARTUP_STAGE_LABELS[startupStage]}</Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Try starting again"
              onPress={retryBootstrap}
              style={[styles.button, styles.primaryButton]}
            >
              <Text style={styles.buttonText}>TRY AGAIN</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {screen.kind === 'home' ? (
        <HomeScreen
          journeys={journeys}
          places={places}
          incompleteAttempts={incomplete}
          hiddenIncompleteAttempts={hiddenIncomplete}
          activeTransportationMode={activeMode}
          pendingRecording={pendingRecording != null}
          pendingInterrupted={pendingRecording?.captureOutcome === 'interrupted'}
          canStartAttempt={canStartAttempt}
          canStartNewRecording={canStartNewRecording}
          busy={busy}
          error={error}
          failedReconciliationAttemptId={failedReconciliationAttemptId}
          onStart={() => {
            void onStartAttempt();
          }}
          onOpenJourney={(originPlaceId, destinationPlaceId, mode) => {
            void onOpenJourney(originPlaceId, destinationPlaceId, mode);
          }}
          onOpenIncomplete={(attemptId) => {
            void (async () => {
              const attempt = await workspace.getAttempt(attemptId);
              if (attempt) {
                await showAttemptResult(attempt);
              }
            })().catch((caught: unknown) => {
              setError(caught instanceof Error ? caught.message : 'Could not open this result.');
            });
          }}
          onHideIncomplete={(attemptId) => {
            confirmHideIncomplete(attemptId);
          }}
          onRestoreIncomplete={(attemptId) => {
            void performRestoreIncomplete(attemptId);
          }}
          onOpenPlaces={() => {
            void onOpenPlaces();
          }}
          onOpenSettings={() => {
            setError(null);
            setScreen({ kind: 'settings' });
          }}
          onRecordPathVariant={() => {
            void onRecordNewRoute();
          }}
          onOpenPending={() => {
            if (pendingRecording) {
              setError(null);
              void openReview(pendingRecording.id);
            }
          }}
          onRetryReconciliation={() => {
            if (!failedReconciliationAttemptId) {
              return;
            }
            void (async () => {
              setBusy(true);
              try {
                const report = await workspace.retryAttemptReconciliation(failedReconciliationAttemptId);
                const failed = report.perAttempt.find((item) => item.status === 'failed');
                setFailedReconciliationAttemptId(failed?.attemptId ?? null);
                await refreshHome();
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not retry that attempt.');
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
      ) : null}
      {screen.kind === 'places' ? (
        <PlacesScreen
          places={places}
          busy={busy}
          error={error}
          onBack={leaveToHome}
          onCreate={() => {
            void onOpenPlaceEditor(null);
          }}
          onOpenPlace={(placeId) => {
            void onOpenPlaceEditor(placeId);
          }}
          onDeletePermanently={(placeId) => {
            confirmPermanentPlaceDeletion(placeId);
          }}
        />
      ) : null}
      {screen.kind === 'place-editor' && placeDraft ? (
        <PlaceEditorScreen
          draft={placeDraft}
          busy={busy}
          error={error}
          onChangeDraft={setPlaceDraft}
          onUseCurrentLocation={() => {
            void onUseCurrentLocation();
          }}
          onSave={() => {
            void onSavePlace();
          }}
          onCancel={leavePlaceEditor}
          onArchive={() => {
            Alert.alert(
              'Archive this place?',
              'Archived places stop being used for start and finish. Their run history stays until you delete the place permanently.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Archive',
                  onPress: () => {
                    void onArchivePlace();
                  },
                },
              ],
            );
          }}
          onDeletePermanently={() => {
            if (placeDraft.id) {
              confirmPermanentPlaceDeletion(placeDraft.id);
            }
          }}
        />
      ) : null}
      {screen.kind === 'settings' ? (
        <SettingsScreen
          mode={activeMode}
          busy={busy}
          error={error}
          onBack={leaveToHome}
          onChangeMode={(mode) => {
            void (async () => {
              await workspace.setActiveTransportationMode(mode);
              setActiveMode(mode);
            })();
          }}
        />
      ) : null}
      {screen.kind === 'recording' ? (
        <RecordingScreen
          state={trackingState}
          busy={busy}
          error={error}
          onFinish={() => {
            void onFinish();
          }}
          onCancel={() => {
            void onCancel();
          }}
          onEndAndReview={() => {
            void onEndAndReview();
          }}
        />
      ) : null}
      {screen.kind === 'review' && reviewSession && reviewDerivation ? (
        <ReviewScreen
          session={reviewSession}
          rawPointCount={reviewPointCount}
          derivation={reviewDerivation}
          name={routeName}
          mode={routeMode}
          busy={busy}
          error={error}
          onChangeName={setRouteName}
          onChangeMode={setRouteMode}
          onSave={() => {
            void onSave();
          }}
          onDiscard={() => {
            void onDiscard();
          }}
          onBack={leaveToHome}
        />
      ) : null}
      {screen.kind === 'journey' ? (
        journeySnapshot &&
        canPresentRetainedJourney(journeySnapshot) &&
        originPlace &&
        destinationPlace &&
        journeySummary ? (
        <JourneyDetailScreen
          origin={originPlace}
          destination={destinationPlace}
          summary={journeySummary}
          statistics={journeyStatistics}
          grouping={journeyGrouping}
          history={journeyHistory}
          pathVariants={journeyPathVariants}
          busy={busy}
          error={error}
          onBack={leaveToHome}
          onHistory={() => {
            void onOpenHistory();
          }}
          onOpenGroupAttempts={onOpenGroupAttempts}
          onOpenPathVariant={(routeId) => {
            void onOpenPathVariant(routeId);
          }}
        />
        ) : (
          <JourneyLoadingShell onBack={leaveToHome} error={error} />
        )
      ) : null}
      {screen.kind === 'detail' && selectedRoute ? (
        <RouteDetailScreen
          route={selectedRoute}
          summary={routeSummary}
          busy={busy}
          error={error}
          onBack={leaveDetailToJourney}
          onEditCourse={() => {
            void onEditCourse();
          }}
          onRename={(name) => {
            void onRenamePathVariant(name);
          }}
          onArchive={() => {
            void onArchivePathVariant();
          }}
          onDelete={selectedRoute.kind === 'explicit' ? () => void onDeleteRoute() : null}
        />
      ) : null}
      {screen.kind === 'attempt' && activeAttempt ? (
        <AttemptScreen
          originName={originName}
          attempt={activeAttempt}
          gpsReadiness={gpsReadiness}
          startZoneStatus={startZoneStatus}
          latestSample={latestSample}
          effectivePlaces={effectivePlaces}
          sampleGpsReadiness={sampleGpsReadiness}
          observedAtMs={attemptObservedAtMs}
          busy={busy}
          error={error}
          onEndAndInspect={() => {
            void onEndAndInspectAttempt();
          }}
          onCancel={() => {
            void onCancelAttempt();
          }}
        />
      ) : null}
      {screen.kind === 'attempt-result' && attemptResult ? (
        <AttemptResultScreen
          title={resultTitle}
          route={selectedRoute}
          attempt={attemptResult}
          journey={journeyFocus}
          debug={attemptDebug}
          debugPending={debugPending}
          pathAnalyticsPending={pathAnalyticsPending}
          debugError={debugError}
          pathAnalyticsError={pathAnalyticsError}
          pathAnalyticsUnavailable={pathAnalyticsUnavailable}
          busy={busy}
          error={error}
          onRetryPathAnalytics={retryPathAnalytics}
          onDone={() => {
            void onAcknowledgeAttempt();
          }}
          onHideIncomplete={() => {
            if (attemptResult) {
              confirmHideIncomplete(attemptResult.id);
            }
          }}
          onRestoreIncomplete={() => {
            if (attemptResult) {
              void performRestoreIncomplete(attemptResult.id);
            }
          }}
          onChangeMode={(mode) => {
            void onChangeResultMode(mode);
          }}
        />
      ) : null}
      {screen.kind === 'history' ? (
        journeySnapshot && canPresentRetainedJourney(journeySnapshot) && journeySummary ? (
        <HistoryScreen
          title={journeySummary.title}
          statistics={journeyStatistics}
          grouping={journeyGrouping}
          rows={journeyHistory}
          rankedRows={journeyHistory.filter((row) => row.eligible && row.rank != null)}
          mode={historyMode}
          groupFilter={historyGroupFilter}
          busy={busy}
          error={error}
          onChangeMode={setHistoryMode}
          onSelectGroup={setHistoryGroupFilter}
          onBack={onBackFromHistory}
          onOpenAttempt={(attemptId) => {
            void onOpenHistoryAttempt(attemptId);
          }}
        />
        ) : (
          <JourneyLoadingShell onBack={onBackFromHistory} error={error} />
        )
      ) : null}
      {screen.kind === 'attempt-detail' && attemptResult ? (
        <AttemptResultScreen
          title={resultTitle}
          route={selectedRoute}
          attempt={attemptResult}
          journey={journeyFocus}
          debug={attemptDebug}
          debugPending={debugPending}
          pathAnalyticsPending={pathAnalyticsPending}
          debugError={debugError}
          pathAnalyticsError={pathAnalyticsError}
          pathAnalyticsUnavailable={pathAnalyticsUnavailable}
          busy={busy}
          error={error}
          onRetryPathAnalytics={retryPathAnalytics}
          doneLabel="BACK"
          onDone={() => {
            void onBackFromHistoryDetail();
          }}
          onHideIncomplete={() => {
            confirmHideIncomplete(attemptResult.id);
          }}
          onRestoreIncomplete={() => {
            void performRestoreIncomplete(attemptResult.id);
          }}
          onChangeMode={(mode) => {
            void onChangeResultMode(mode);
          }}
        />
      ) : null}
      {screen.kind === 'editor' && courseDraft ? (
        <CourseEditorScreen
          draft={courseDraft}
          busy={busy}
          error={error}
          onChangeDraft={setCourseDraft}
          onSave={() => {
            void onSaveCourse();
          }}
          onCancel={() => {
            void onCancelEditor();
          }}
        />
      ) : null}
    </View>
  );
}
