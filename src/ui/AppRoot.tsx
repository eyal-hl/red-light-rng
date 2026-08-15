import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';

import type { Route, TransportationMode } from '../domain/route';
import type { RouteDerivation } from '../domain/route-derivation';
import { IDLE_TRACKING_STATE, type TrackingState } from '../domain/tracking-state';
import type { TrackingSessionRecord } from '../persistence/location-sample-store';
import type { RouteWorkspace } from '../product/route-workspace';
import { HomeScreen } from './HomeScreen';
import { RecordingScreen } from './RecordingScreen';
import { ReviewScreen } from './ReviewScreen';
import { RouteDetailScreen } from './RouteDetailScreen';
import { styles } from './styles';

type AppScreen =
  | { kind: 'loading' }
  | { kind: 'home' }
  | { kind: 'recording' }
  | { kind: 'review'; sessionId: string }
  | { kind: 'detail'; routeId: string };

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const bootstrap = useCallback(async () => {
    const snapshot = await workspace.bootstrap();
    setRoutes(snapshot.routes);
    setPendingRecording(snapshot.pendingRecording);
    setCanStartNewRecording(snapshot.canStartNewRecording);
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
  }, [openReview, workspace]);

  useEffect(() => {
    void bootstrap();
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
    const sub = AppState.addEventListener('change', (status) => {
      if (status !== 'active') {
        return;
      }
      void (async () => {
        await workspace.recover();
        const snapshot = await refreshHome();
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
  }, [openReview, refreshHome, workspace]);

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
    try {
      await workspace.finishRecording();
      const state = await workspace.getTrackingState();
      if (state.sessionId) {
        await openReview(state.sessionId);
      } else {
        setScreen({ kind: 'home' });
        await refreshHome();
      }
    } finally {
      setBusy(false);
    }
  }, [openReview, refreshHome, workspace]);

  const onCancel = useCallback(async () => {
    setBusy(true);
    try {
      await workspace.cancelRecording();
      await refreshHome();
      setScreen({ kind: 'home' });
    } finally {
      setBusy(false);
    }
  }, [refreshHome, workspace]);

  const onEndAndReview = useCallback(async () => {
    setBusy(true);
    try {
      await workspace.interruptRecording();
      const state = await workspace.getTrackingState();
      if (state.sessionId) {
        await openReview(state.sessionId);
      }
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
      await refreshHome();
      setScreen({ kind: 'detail', routeId: result.route.id });
    } finally {
      setBusy(false);
    }
  }, [refreshHome, routeMode, routeName, screen, workspace]);

  const onDiscard = useCallback(async () => {
    if (screen.kind !== 'review') {
      return;
    }
    setBusy(true);
    try {
      await workspace.discardRecording(screen.sessionId);
      setRouteName('');
      await refreshHome();
      setScreen({ kind: 'home' });
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
      setScreen({ kind: 'detail', routeId });
    },
    [workspace],
  );

  const onDeleteRoute = useCallback(async () => {
    if (screen.kind !== 'detail') {
      return;
    }
    setBusy(true);
    try {
      await workspace.deleteRoute(screen.routeId);
      setSelectedRoute(null);
      await refreshHome();
      setScreen({ kind: 'home' });
    } finally {
      setBusy(false);
    }
  }, [refreshHome, screen, workspace]);

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
              void openReview(pendingRecording.id);
            }
          }}
          onOpenRoute={(routeId) => {
            void onOpenRoute(routeId);
          }}
        />
      ) : null}
      {screen.kind === 'recording' ? (
        <RecordingScreen
          state={trackingState}
          busy={busy}
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
        />
      ) : null}
      {screen.kind === 'detail' && selectedRoute ? (
        <RouteDetailScreen
          route={selectedRoute}
          busy={busy}
          onBack={() => {
            setScreen({ kind: 'home' });
            void refreshHome();
          }}
          onDelete={() => {
            void onDeleteRoute();
          }}
        />
      ) : null}
    </View>
  );
}
