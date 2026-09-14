import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, BackHandler, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
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
import { WAITING_GPS_READINESS, type GpsReadiness } from '../domain/gps-readiness';
import type { PlaceStartZoneStatus } from '../domain/place-timing';
import type { Route, TransportationMode } from '../domain/route';
import type { RouteDerivation } from '../domain/route-derivation';
import type { RouteCompetitiveSummary } from '../domain/attempt-analysis';
import { IDLE_TRACKING_STATE, type TrackingState } from '../domain/tracking-state';
import type { TrackingSessionRecord } from '../persistence/location-sample-store';
import type { CombinedAttemptDebug, RouteWorkspace } from '../product/route-workspace';
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

export function AppRoot({ workspace }: AppRootProps) {
  const [screen, setScreen] = useState<AppScreen>({ kind: 'loading' });
  const [places, setPlaces] = useState<Place[]>([]);
  const [journeys, setJourneys] = useState<JourneyPoolSummary[]>([]);
  const [incomplete, setIncomplete] = useState<Attempt[]>([]);
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
  const [attemptResult, setAttemptResult] = useState<Attempt | null>(null);
  const [journeyFocus, setJourneyFocus] = useState<JourneyFocusAnalysis | null>(null);
  const [attemptDebug, setAttemptDebug] = useState<CombinedAttemptDebug | null>(null);
  const [routeSummary, setRouteSummary] = useState<RouteCompetitiveSummary | null>(null);
  const [historyMode, setHistoryMode] = useState<'chronological' | 'ranked'>('chronological');
  const [historyGroupFilter, setHistoryGroupFilter] = useState<JourneyDepartureGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshHome = useCallback(async () => {
    const snapshot = await workspace.loadHome();
    setPlaces(snapshot.places);
    setJourneys(snapshot.journeys);
    setIncomplete(snapshot.incompleteAttempts);
    setActiveMode(snapshot.activeTransportationMode);
    setPendingRecording(snapshot.pendingRecording);
    setCanStartNewRecording(snapshot.canStartNewRecording);
    setCanStartAttempt(snapshot.canStartAttempt);
    return snapshot;
  }, [workspace]);

  const loadJourney = useCallback(
    async (pool: JourneyPoolId) => {
      const loaded = await workspace.loadJourney(pool);
      if (!loaded) {
        return null;
      }
      setOriginPlace(loaded.origin);
      setDestinationPlace(loaded.destination);
      setJourneySummary(loaded.summary);
      setJourneyStatistics(loaded.statistics);
      setJourneyGrouping(loaded.departureGrouping);
      setJourneyHistory(loaded.history);
      setJourneyPathVariants(loaded.pathVariants);
      return loaded;
    },
    [workspace],
  );

  const openReview = useCallback(
    async (sessionId: string) => {
      const { session, samples, derivation } = await workspace.deriveSession(sessionId);
      setReviewSession(session);
      setReviewDerivation(derivation);
      setReviewPointCount(samples.length);
      setScreen({ kind: 'review', sessionId });
    },
    [workspace],
  );

  const showAttempt = useCallback(
    async (attempt: Attempt) => {
      if (attempt.originPlaceId) {
        const origin = await workspace.getPlace(attempt.originPlaceId);
        setOriginName(origin?.name ?? null);
      } else {
        setOriginName(null);
      }
      setActiveAttempt(attempt);
      setStartZoneStatus(LOCATING_ZONE);
      setGpsReadiness(WAITING_GPS_READINESS);
      setAttemptResult(null);
      setScreen({ kind: 'attempt' });
    },
    [workspace],
  );

  const showAttemptResult = useCallback(
    async (attempt: Attempt) => {
      setSelectedRoute(await resolveAttemptDisplayRoute(attempt, (routeId) => workspace.getRoute(routeId)));
      let focus: JourneyFocusAnalysis | null = null;
      if (attempt.originPlaceId && attempt.destinationPlaceId) {
        const analyzed = await workspace.analyzeJourney(
          {
            originPlaceId: attempt.originPlaceId,
            destinationPlaceId: attempt.destinationPlaceId,
            transportationMode: attempt.transportationMode,
          },
          attempt.id,
        );
        focus = analyzed?.focus ?? null;
      }
      const debug = await workspace.inspectAttempt(attempt.id);
      setActiveAttempt(null);
      setStartZoneStatus(LOCATING_ZONE);
      setGpsReadiness(WAITING_GPS_READINESS);
      setAttemptResult(attempt);
      setJourneyFocus(focus);
      setAttemptDebug(debug);
      setScreen({ kind: 'attempt-result' });
    },
    [workspace],
  );

  const bootstrap = useCallback(async () => {
    const snapshot = await workspace.bootstrap();
    setPlaces(snapshot.places);
    setJourneys(snapshot.journeys);
    setIncomplete(snapshot.incompleteAttempts);
    setActiveMode(snapshot.activeTransportationMode);
    setPendingRecording(snapshot.pendingRecording);
    setCanStartNewRecording(snapshot.canStartNewRecording);
    setCanStartAttempt(snapshot.canStartAttempt);
    if (snapshot.activeAttempt) {
      await showAttempt(snapshot.activeAttempt);
      return;
    }
    if (snapshot.attemptResult) {
      await showAttemptResult(snapshot.attemptResult);
      return;
    }
    if (snapshot.activeRecording) {
      const state = await workspace.getTrackingState();
      setTrackingState(state);
      setScreen({ kind: 'recording' });
      return;
    }
    if (snapshot.pendingRecording) {
      await openReview(snapshot.pendingRecording.id);
      return;
    }
    setScreen({ kind: 'home' });
  }, [openReview, showAttempt, showAttemptResult, workspace]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void bootstrap();
    }, 0);
    return () => clearTimeout(timeout);
  }, [bootstrap]);

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
    const interval = setInterval(() => {
      void (async () => {
        const processed = await workspace.processActiveAttemptWithStartZoneStatus();
        if (!processed.attempt) {
          return;
        }
        setStartZoneStatus(processed.startZoneStatus);
        setGpsReadiness(processed.gpsReadiness);
        if (processed.attempt.originPlaceId) {
          const origin = await workspace.getPlace(processed.attempt.originPlaceId);
          setOriginName(origin?.name ?? processed.startZoneStatus.placeName);
        } else {
          setOriginName(processed.startZoneStatus.placeName);
        }
        if (processed.attempt.lifecycle === 'armed' || processed.attempt.lifecycle === 'active') {
          setActiveAttempt(processed.attempt);
          return;
        }
        await showAttemptResult(processed.attempt);
      })();
    }, 1000);
    return () => clearInterval(interval);
  }, [screen.kind, showAttemptResult, workspace]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      if (status !== 'active') {
        return;
      }
      void (async () => {
        await workspace.recover();
        const snapshot = await refreshHome();
        if (snapshot.activeAttempt) {
          await showAttempt(snapshot.activeAttempt);
          return;
        }
        if (snapshot.attemptResult) {
          await showAttemptResult(snapshot.attemptResult);
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
      })();
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

  const onAcknowledgeAttempt = useCallback(async () => {
    if (!attemptResult) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await workspace.acknowledgeAttemptResult(attemptResult.id);
      const pool =
        attemptResult.originPlaceId && attemptResult.destinationPlaceId
          ? {
              originPlaceId: attemptResult.originPlaceId,
              destinationPlaceId: attemptResult.destinationPlaceId,
              transportationMode: attemptResult.transportationMode,
            }
          : null;
      setAttemptResult(null);
      setJourneyFocus(null);
      setAttemptDebug(null);
      if (pool) {
        const loaded = await loadJourney(pool);
        if (loaded) {
          setScreen({ kind: 'journey', pool });
          return;
        }
      }
      await refreshHome();
      setScreen({ kind: 'home' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not close this result.');
    } finally {
      setBusy(false);
    }
  }, [attemptResult, loadJourney, refreshHome, workspace]);

  const onChangeResultMode = useCallback(
    async (mode: TransportationMode) => {
      if (!attemptResult) {
        return;
      }
      const stayOnDetail = screen.kind === 'attempt-detail';
      setBusy(true);
      setError(null);
      try {
        const updated = await workspace.setAttemptTransportationMode(attemptResult.id, mode);
        if (updated) {
          await showAttemptResult(updated);
          if (stayOnDetail && updated.originPlaceId && updated.destinationPlaceId) {
            setScreen({
              kind: 'attempt-detail',
              pool: {
                originPlaceId: updated.originPlaceId,
                destinationPlaceId: updated.destinationPlaceId,
                transportationMode: updated.transportationMode,
              },
              attemptId: updated.id,
            });
          }
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not change transportation mode.');
      } finally {
        setBusy(false);
      }
    },
    [attemptResult, screen.kind, showAttemptResult, workspace],
  );

  const leaveToHome = useCallback(() => {
    setError(null);
    setScreen({ kind: 'home' });
    void refreshHome();
  }, [refreshHome]);

  const onOpenJourney = useCallback(
    async (originPlaceId: string, destinationPlaceId: string, transportationMode: TransportationMode) => {
      const pool = { originPlaceId, destinationPlaceId, transportationMode };
      const loaded = await loadJourney(pool);
      if (!loaded) {
        setError('This journey is no longer available.');
        return;
      }
      setError(null);
      setHistoryGroupFilter(null);
      setScreen({ kind: 'journey', pool });
    },
    [loadJourney],
  );

  const onOpenHistory = useCallback(async () => {
    if (screen.kind !== 'journey') {
      return;
    }
    setHistoryMode('chronological');
    setHistoryGroupFilter(null);
    setScreen({ kind: 'history', pool: screen.pool });
  }, [screen]);

  const onOpenGroupAttempts = useCallback(
    (group: JourneyDepartureGroup) => {
      if (screen.kind !== 'journey') {
        return;
      }
      setHistoryMode('chronological');
      setHistoryGroupFilter(group);
      setScreen({ kind: 'history', pool: screen.pool });
    },
    [screen],
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
        setSelectedRoute(await resolveAttemptDisplayRoute(attempt, (routeId) => workspace.getRoute(routeId)));
        const analyzed = await workspace.analyzeJourney(screen.pool, attemptId);
        const debug = await workspace.inspectAttempt(attemptId);
        setAttemptResult(attempt);
        setJourneyFocus(analyzed?.focus ?? null);
        setAttemptDebug(debug);
        setScreen({ kind: 'attempt-detail', pool: screen.pool, attemptId });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not open this attempt.');
      } finally {
        setBusy(false);
      }
    },
    [screen, workspace],
  );

  const onBackFromHistoryDetail = useCallback(async () => {
    if (screen.kind !== 'attempt-detail') {
      return;
    }
    setAttemptResult(null);
    setJourneyFocus(null);
    setAttemptDebug(null);
    await loadJourney(screen.pool);
    setScreen({ kind: 'history', pool: screen.pool });
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
      setBusy(true);
      setError(null);
      try {
        const route = await workspace.getRoute(routeId);
        if (!route) {
          setError('This path variant is no longer available.');
          return;
        }
        setSelectedRoute(route);
        const analyzed = await workspace.analyzeRoute(route.id);
        setRouteSummary(analyzed?.analysis.summary ?? null);
        setScreen({ kind: 'detail', routeId: route.id });
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

  const onOpenPlaces = useCallback(async () => {
    setError(null);
    setPlaces(await workspace.listPlaces());
    setScreen({ kind: 'places' });
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

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {screen.kind === 'loading' ? (
        <View style={styles.content}>
          <Text style={styles.mutedText}>Loading…</Text>
        </View>
      ) : null}
      {screen.kind === 'home' ? (
        <HomeScreen
          journeys={journeys}
          places={places}
          incompleteAttempts={incomplete}
          activeTransportationMode={activeMode}
          pendingRecording={pendingRecording != null}
          pendingInterrupted={pendingRecording?.captureOutcome === 'interrupted'}
          canStartAttempt={canStartAttempt}
          canStartNewRecording={canStartNewRecording}
          busy={busy}
          error={error}
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
            })();
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
      {screen.kind === 'journey' && originPlace && destinationPlace && journeySummary ? (
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
          busy={busy}
          error={error}
          onDone={() => {
            void onAcknowledgeAttempt();
          }}
          onChangeMode={(mode) => {
            void onChangeResultMode(mode);
          }}
        />
      ) : null}
      {screen.kind === 'history' && journeySummary ? (
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
      ) : null}
      {screen.kind === 'attempt-detail' && attemptResult ? (
        <AttemptResultScreen
          title={resultTitle}
          route={selectedRoute}
          attempt={attemptResult}
          journey={journeyFocus}
          debug={attemptDebug}
          busy={busy}
          error={error}
          doneLabel="BACK"
          onDone={() => {
            void onBackFromHistoryDetail();
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
