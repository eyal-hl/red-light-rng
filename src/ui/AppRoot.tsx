import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { AppState, BackHandler, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import {
  createCourseEditorDraft,
  toCourseLayout,
  type CourseEditorDraft,
} from '../domain/course-editor';
import type { Route, TransportationMode } from '../domain/route';
import type { RouteDerivation } from '../domain/route-derivation';
import type { StartZoneStatus } from '../domain/start-zone-status';
import type {
  FocusAttemptAnalysis,
  RouteAttemptAnalysis,
  RouteCompetitiveSummary,
} from '../domain/attempt-analysis';
import { IDLE_TRACKING_STATE, type TrackingState } from '../domain/tracking-state';
import type { TrackingSessionRecord } from '../persistence/location-sample-store';
import type { RouteWorkspace } from '../product/route-workspace';
import { AttemptResultScreen } from './AttemptResultScreen';
import { AttemptScreen } from './AttemptScreen';
import { CourseEditorScreen } from './CourseEditorScreen';
import { HistoryScreen } from './HistoryScreen';
import { HomeScreen } from './HomeScreen';
import { RecordingScreen } from './RecordingScreen';
import { ReviewScreen } from './ReviewScreen';
import { RouteDetailScreen } from './RouteDetailScreen';
import { styles } from './styles';
import { handleSystemBack, type AppScreenKind } from './system-back';

type AppScreen =
  | { kind: Exclude<AppScreenKind, 'review' | 'detail' | 'editor' | 'history' | 'attempt-detail'> }
  | { kind: 'review'; sessionId: string }
  | { kind: 'detail'; routeId: string }
  | { kind: 'editor'; routeId: string }
  | { kind: 'history'; routeId: string }
  | { kind: 'attempt-detail'; routeId: string; attemptId: string };

type AppRootProps = {
  workspace: RouteWorkspace;
};

export function AppRoot({ workspace }: AppRootProps) {
  const [screen, setScreen] = useState<AppScreen>({ kind: 'loading' });
  const [routes, setRoutes] = useState<Route[]>([]);
  const [pendingRecording, setPendingRecording] = useState<TrackingSessionRecord | null>(null);
  const [canStartNewRecording, setCanStartNewRecording] = useState(true);
  const [trackingState, setTrackingState] = useState<TrackingState>(IDLE_TRACKING_STATE);
  const [reviewSession, setReviewSession] = useState<TrackingSessionRecord | null>(null);
  const [reviewDerivation, setReviewDerivation] = useState<RouteDerivation | null>(null);
  const [reviewPointCount, setReviewPointCount] = useState(0);
  const [routeName, setRouteName] = useState('');
  const [routeMode, setRouteMode] = useState<TransportationMode>('scooter');
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [courseDraft, setCourseDraft] = useState<CourseEditorDraft | null>(null);
  const [activeAttempt, setActiveAttempt] = useState<Attempt | null>(null);
  const [startZoneStatus, setStartZoneStatus] = useState<StartZoneStatus>('locating');
  const [attemptResult, setAttemptResult] = useState<Attempt | null>(null);
  const [attemptAnalysis, setAttemptAnalysis] = useState<FocusAttemptAnalysis | null>(null);
  const [routeSummary, setRouteSummary] = useState<RouteCompetitiveSummary | null>(null);
  const [routeAnalysis, setRouteAnalysis] = useState<RouteAttemptAnalysis | null>(null);
  const [historyMode, setHistoryMode] = useState<'chronological' | 'ranked'>('chronological');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRouteStats = useCallback(
    async (routeId: string) => {
      const analyzed = await workspace.analyzeRoute(routeId);
      setRouteSummary(analyzed?.analysis.summary ?? null);
      setRouteAnalysis(analyzed?.analysis ?? null);
      return analyzed;
    },
    [workspace],
  );

  const refreshHome = useCallback(async () => {
    const snapshot = await workspace.loadHome();
    setRoutes(snapshot.routes);
    setPendingRecording(snapshot.pendingRecording);
    setCanStartNewRecording(snapshot.canStartNewRecording);
    return snapshot;
  }, [workspace]);

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
      const route = await workspace.getRoute(attempt.routeId);
      if (route) {
        setSelectedRoute(route);
      }
      setActiveAttempt(attempt);
      setStartZoneStatus('locating');
      setAttemptResult(null);
      setScreen({ kind: 'attempt' });
    },
    [workspace],
  );

  const showAttemptResult = useCallback(
    async (attempt: Attempt) => {
      const route = await workspace.getRoute(attempt.routeId);
      if (route) {
        setSelectedRoute(route);
      }
      const analysis = await workspace.analyzeAttempt(attempt.routeId, attempt.id);
      setActiveAttempt(null);
      setStartZoneStatus('locating');
      setAttemptResult(attempt);
      setAttemptAnalysis(analysis);
      setScreen({ kind: 'attempt-result' });
    },
    [workspace],
  );

  const bootstrap = useCallback(async () => {
    const snapshot = await workspace.bootstrap();
    setRoutes(snapshot.routes);
    setPendingRecording(snapshot.pendingRecording);
    setCanStartNewRecording(snapshot.canStartNewRecording);
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
        if (
          processed.attempt.lifecycle === 'armed' ||
          processed.attempt.lifecycle === 'active'
        ) {
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
      setSelectedRoute(result.route);
      await loadRouteStats(result.route.id);
      await refreshHome();
      setScreen({ kind: 'detail', routeId: result.route.id });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save route.');
    } finally {
      setBusy(false);
    }
  }, [loadRouteStats, refreshHome, routeMode, routeName, screen, workspace]);

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

  const onOpenRoute = useCallback(
    async (routeId: string) => {
      const route = await workspace.getRoute(routeId);
      if (!route) {
        return;
      }
      setSelectedRoute(route);
      await loadRouteStats(routeId);
      setScreen({ kind: 'detail', routeId });
    },
    [loadRouteStats, workspace],
  );

  const onArmRun = useCallback(async () => {
    if (screen.kind !== 'detail') {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await workspace.armRun(screen.routeId);
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      await showAttempt(result.attempt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not arm this run.');
    } finally {
      setBusy(false);
    }
  }, [screen, showAttempt, workspace]);

  const onCancelAttempt = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await workspace.cancelAttempt();
      setActiveAttempt(null);
      setStartZoneStatus('locating');
      await refreshHome();
      if (selectedRoute) {
        await loadRouteStats(selectedRoute.id);
        setScreen({ kind: 'detail', routeId: selectedRoute.id });
      } else {
        setScreen({ kind: 'home' });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel this attempt.');
    } finally {
      setBusy(false);
    }
  }, [loadRouteStats, refreshHome, selectedRoute, workspace]);

  const onAcknowledgeAttempt = useCallback(async () => {
    if (!attemptResult) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await workspace.acknowledgeAttemptResult(attemptResult.id);
      const routeId = attemptResult.routeId;
      setAttemptResult(null);
      setAttemptAnalysis(null);
      const route = await workspace.getRoute(routeId);
      if (route) {
        setSelectedRoute(route);
        await loadRouteStats(routeId);
        setScreen({ kind: 'detail', routeId });
      } else {
        await refreshHome();
        setScreen({ kind: 'home' });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not close this result.');
    } finally {
      setBusy(false);
    }
  }, [attemptResult, loadRouteStats, refreshHome, workspace]);

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
      setScreen({ kind: 'home' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete route.');
    } finally {
      setBusy(false);
    }
  }, [refreshHome, screen, workspace]);

  const onEditCourse = useCallback(async () => {
    if (screen.kind !== 'detail') {
      return;
    }
    const route = await workspace.getRoute(screen.routeId);
    if (!route) {
      setError('This route is no longer available.');
      return;
    }
    setSelectedRoute(route);
    setCourseDraft(createCourseEditorDraft(route));
    setError(null);
    setScreen({ kind: 'editor', routeId: route.id });
  }, [screen, workspace]);

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
      await loadRouteStats(result.route.id);
      await refreshHome();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save course.');
    } finally {
      setBusy(false);
    }
  }, [courseDraft, loadRouteStats, refreshHome, screen, workspace]);

  const onCancelEditor = useCallback(async () => {
    if (screen.kind !== 'editor') {
      return;
    }
    setCourseDraft(null);
    setError(null);
    const route = await workspace.getRoute(screen.routeId);
    if (route) {
      setSelectedRoute(route);
    }
    setScreen({ kind: 'detail', routeId: screen.routeId });
    await loadRouteStats(screen.routeId);
  }, [loadRouteStats, screen, workspace]);

  const onOpenHistory = useCallback(async () => {
    if (screen.kind !== 'detail') {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await loadRouteStats(screen.routeId);
      setHistoryMode('chronological');
      setScreen({ kind: 'history', routeId: screen.routeId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load history.');
    } finally {
      setBusy(false);
    }
  }, [loadRouteStats, screen]);

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
        const analysis = await workspace.analyzeAttempt(screen.routeId, attemptId);
        setAttemptResult(attempt);
        setAttemptAnalysis(analysis);
        setScreen({ kind: 'attempt-detail', routeId: screen.routeId, attemptId });
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
    setAttemptAnalysis(null);
    await loadRouteStats(screen.routeId);
    setScreen({ kind: 'history', routeId: screen.routeId });
  }, [loadRouteStats, screen]);

  const leaveToHome = useCallback(() => {
    setError(null);
    setScreen({ kind: 'home' });
    void refreshHome();
  }, [refreshHome]);

  const onBackFromHistory = useCallback(() => {
    if (screen.kind !== 'history') {
      return;
    }
    const routeId = screen.routeId;
    setError(null);
    setScreen({ kind: 'detail', routeId });
    void loadRouteStats(routeId);
  }, [loadRouteStats, screen]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () =>
      handleSystemBack(screen.kind, {
        leaveToHome,
        cancelRecording: () => {
          void onCancel();
        },
        cancelEditor: () => {
          void onCancelEditor();
        },
        leaveHistoryToDetail: onBackFromHistory,
        cancelAttempt: () => {
          void onCancelAttempt();
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
    leaveToHome,
    onAcknowledgeAttempt,
    onBackFromHistory,
    onBackFromHistoryDetail,
    onCancel,
    onCancelAttempt,
    onCancelEditor,
    screen.kind,
  ]);

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
          routes={routes}
          pendingRecording={pendingRecording}
          canStartNewRecording={canStartNewRecording}
          busy={busy}
          error={error}
          onRecordNewRoute={() => {
            void onRecordNewRoute();
          }}
          onOpenPending={() => {
            if (pendingRecording) {
              setError(null);
              void openReview(pendingRecording.id);
            }
          }}
          onOpenRoute={(routeId) => {
            setError(null);
            void onOpenRoute(routeId);
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
      {screen.kind === 'detail' && selectedRoute ? (
        <RouteDetailScreen
          route={selectedRoute}
          summary={routeSummary}
          canArm={canStartNewRecording}
          busy={busy}
          error={error}
          onBack={leaveToHome}
          onArmRun={() => {
            void onArmRun();
          }}
          onHistory={() => {
            void onOpenHistory();
          }}
          onEditCourse={() => {
            void onEditCourse();
          }}
          onDelete={() => {
            void onDeleteRoute();
          }}
        />
      ) : null}
      {screen.kind === 'attempt' && activeAttempt ? (
        <AttemptScreen
          route={selectedRoute}
          attempt={activeAttempt}
          startZoneStatus={startZoneStatus}
          busy={busy}
          error={error}
          onCancel={() => {
            void onCancelAttempt();
          }}
        />
      ) : null}
      {screen.kind === 'attempt-result' && attemptResult ? (
        <AttemptResultScreen
          route={selectedRoute}
          attempt={attemptResult}
          analysis={attemptAnalysis}
          busy={busy}
          error={error}
          onDone={() => {
            void onAcknowledgeAttempt();
          }}
        />
      ) : null}
      {screen.kind === 'history' && selectedRoute && routeAnalysis ? (
        <HistoryScreen
          route={selectedRoute}
          analysis={routeAnalysis}
          mode={historyMode}
          busy={busy}
          error={error}
          onChangeMode={setHistoryMode}
          onBack={onBackFromHistory}
          onOpenAttempt={(attemptId) => {
            void onOpenHistoryAttempt(attemptId);
          }}
        />
      ) : null}
      {screen.kind === 'attempt-detail' && attemptResult ? (
        <AttemptResultScreen
          route={selectedRoute}
          attempt={attemptResult}
          analysis={attemptAnalysis}
          busy={busy}
          error={error}
          doneLabel="BACK"
          onDone={() => {
            void onBackFromHistoryDetail();
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
