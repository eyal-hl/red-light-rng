import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, ScrollView, Text, View } from 'react-native';

import { formatSampleLine } from '../domain/format-sample';
import type { LocationSample } from '../domain/location-sample';
import { IDLE_TRACKING_STATE, type TrackingState } from '../domain/tracking-state';
import type { LocationSampleStore } from '../persistence/location-sample-store';
import type { LocationTracker } from '../tracking/location-tracker';
import { spikeStyles as styles } from './spike-styles';

type BackgroundLocationSpikeScreenProps = {
  tracker: LocationTracker;
  store: LocationSampleStore;
};

export function BackgroundLocationSpikeScreen({
  tracker,
  store,
}: BackgroundLocationSpikeScreenProps) {
  const [state, setState] = useState<TrackingState>(IDLE_TRACKING_STATE);
  const [samples, setSamples] = useState<LocationSample[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const nextState = await tracker.getState();
    setState(nextState);
    if (!nextState.sessionId) {
      setSamples([]);
      return;
    }
    const nextSamples = await store.listSamples(nextState.sessionId);
    setSamples(nextSamples.slice().reverse());
  }, [store, tracker]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void refresh();
    }, 0);
    const interval = setInterval(() => {
      void refresh();
    }, 1000);
    const appStateSub = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void refresh();
      }
    });
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
      appStateSub.remove();
    };
  }, [refresh]);

  const onStart = useCallback(async () => {
    setBusy(true);
    try {
      await tracker.startTracking();
    } catch {
      // Error text is exposed through tracker.getState().
    } finally {
      await refresh();
      setBusy(false);
    }
  }, [refresh, tracker]);

  const onStop = useCallback(async () => {
    setBusy(true);
    try {
      await tracker.stopTracking();
    } catch {
      // Error text is exposed through tracker.getState().
    } finally {
      await refresh();
      setBusy(false);
    }
  }, [refresh, tracker]);

  const tracking = state.status === 'tracking';
  const startDisabled = busy || tracking;
  const stopDisabled = busy || !tracking;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.title}>
          <Text style={styles.titleText}>Background Location Spike</Text>
        </View>

        <View style={styles.statusBlock}>
          <Text style={styles.statusText}>Status: {state.status}</Text>
          <Text style={styles.statusText}>Points recorded: {state.pointCount}</Text>
          {state.lastWarning ? <Text style={styles.warningText}>{state.lastWarning}</Text> : null}
          {state.lastError ? <Text style={styles.errorText}>{state.lastError}</Text> : null}
        </View>

        <Text style={styles.noteText}>
          Use an Expo development build, not Expo Go. Android locked-screen recording still needs a
          physical device test. iOS background tracking is unvalidated.
        </Text>

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={startDisabled}
            onPress={() => {
              void onStart();
            }}
            style={[styles.button, styles.startButton, startDisabled ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>START TRACKING</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={stopDisabled}
            onPress={() => {
              void onStop();
            }}
            style={[styles.button, styles.stopButton, stopDisabled ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>STOP TRACKING</Text>
          </Pressable>
        </View>

        <View style={styles.samplesHeading}>
          <Text style={styles.samplesHeadingText}>Latest samples</Text>
        </View>
        {samples.length === 0 ? (
          <Text style={styles.emptyText}>No samples recorded yet.</Text>
        ) : (
          samples.map((sample) => (
            <View key={sample.id} style={styles.sampleRow}>
              <Text style={styles.sampleText}>{formatSampleLine(sample)}</Text>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
