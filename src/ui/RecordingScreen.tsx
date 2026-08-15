import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { formatElapsed, recordingElapsedMs } from '../domain/duration';
import { formatFixAge } from '../domain/session';
import type { TrackingState } from '../domain/tracking-state';
import { styles } from './styles';

type RecordingScreenProps = {
  state: TrackingState;
  busy: boolean;
  onFinish: () => void;
  onCancel: () => void;
  onEndAndReview: () => void;
};

export function RecordingScreen({
  state,
  busy,
  onFinish,
  onCancel,
  onEndAndReview,
}: RecordingScreenProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const startedAtMs = state.startedAtMs ?? nowMs;
  const elapsed = formatElapsed(recordingElapsedMs(startedAtMs, nowMs));
  const finishDisabled = busy;
  const showPartialAction = state.gpsHealth === 'stale' || state.lastError != null;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>RECORDING ROUTE</Text>
        <Text style={styles.recordingDot}>● Recording</Text>
        <Text style={styles.title}>{elapsed}</Text>
        <Text style={styles.statusText}>{state.pointCount} GPS points</Text>
        <Text style={styles.mutedText}>You can lock your phone and put it in your pocket.</Text>

        {state.gpsHealth === 'waiting_for_first_fix' ? (
          <Text style={styles.warningText}>Waiting for first GPS fix.</Text>
        ) : null}
        {state.gpsHealth === 'stale' && state.lastSampleAtMs != null ? (
          <Text style={styles.warningText}>
            No recent GPS fixes ({formatFixAge(state.lastSampleAtMs, nowMs)}). You can still finish
            recording.
          </Text>
        ) : null}
        {state.lastWarning ? <Text style={styles.warningText}>{state.lastWarning}</Text> : null}
        {state.lastError ? <Text style={styles.errorText}>{state.lastError}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={finishDisabled}
            onPress={onFinish}
            style={[
              styles.button,
              styles.primaryButton,
              finishDisabled ? styles.disabledButton : null,
            ]}
          >
            <Text style={styles.buttonText}>FINISH RECORDING</Text>
          </Pressable>
          {showPartialAction ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onEndAndReview}
              style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>END AND REVIEW PARTIAL RECORDING</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onCancel}
            style={[styles.button, styles.dangerButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
