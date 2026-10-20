import { useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import {
  presentAttemptLiveMap,
  shouldRenderAttemptMap,
  type AttemptLiveMapLifecycle,
} from '../domain/attempt-live-map';
import { formatTimeOfDay } from '../domain/duration';
import { formatGpsReadinessLabel, type GpsReadiness } from '../domain/gps-readiness';
import type { LocationSample } from '../domain/location-sample';
import type { Place } from '../domain/place';
import type { PlaceStartZoneStatus } from '../domain/place-timing';
import { AttemptLiveMap } from './AttemptLiveMap';
import { styles } from './styles';

type AttemptScreenProps = {
  originName: string | null;
  attempt: Attempt;
  gpsReadiness: GpsReadiness;
  startZoneStatus: PlaceStartZoneStatus;
  latestSample: LocationSample | null;
  effectivePlaces: Place[];
  sampleGpsReadiness: GpsReadiness;
  observedAtMs: number;
  busy: boolean;
  error: string | null;
  onEndAndInspect: () => void;
  onCancel: () => void;
};

function startZoneLabel(status: PlaceStartZoneStatus): string {
  if (status.status === 'inside' && status.placeName) {
    return `IN START ZONE — ${status.placeName.toUpperCase()}`;
  }
  if (status.status === 'inside') {
    return 'IN START ZONE';
  }
  if (status.status === 'outside') {
    return 'OUTSIDE START ZONE';
  }
  return 'LOCATING…';
}

function StatusRow({
  accessibilityLabel,
  tone,
  label,
}: {
  accessibilityLabel: string;
  tone: 'waiting' | 'poor' | 'good' | 'inside' | 'outside' | 'locating';
  label: string;
}) {
  return (
    <View accessibilityLabel={accessibilityLabel} style={attemptStyles.statusRow}>
      <View
        style={[
          attemptStyles.statusDot,
          tone === 'good' || tone === 'inside'
            ? attemptStyles.statusDotGood
            : tone === 'poor'
              ? attemptStyles.statusDotPoor
              : tone === 'outside'
                ? attemptStyles.statusDotOutside
                : attemptStyles.statusDotWaiting,
        ]}
      />
      <Text
        style={[
          attemptStyles.statusText,
          tone === 'good' || tone === 'inside'
            ? attemptStyles.statusTextGood
            : tone === 'poor'
              ? attemptStyles.statusTextPoor
              : tone === 'outside'
                ? attemptStyles.statusTextOutside
                : attemptStyles.statusTextWaiting,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export function AttemptScreen({
  originName,
  attempt,
  gpsReadiness,
  startZoneStatus,
  latestSample,
  effectivePlaces,
  sampleGpsReadiness,
  observedAtMs,
  busy,
  error,
  onEndAndInspect,
  onCancel,
}: AttemptScreenProps) {
  const armed = attempt.lifecycle === 'armed';
  const lifecycle: AttemptLiveMapLifecycle = attempt.lifecycle === 'active' ? 'active' : 'armed';
  const activeTitle = originName ? `${originName} → ?` : 'Journey';
  const readinessLabel = formatGpsReadinessLabel(gpsReadiness);
  const [appState, setAppState] = useState(AppState.currentState);
  const model = useMemo(
    () =>
      presentAttemptLiveMap({
        lifecycle,
        latestSample,
        sampleGpsReadiness,
        places: effectivePlaces,
        startZoneStatus,
        nowMs: observedAtMs,
      }),
    [effectivePlaces, latestSample, lifecycle, observedAtMs, sampleGpsReadiness, startZoneStatus],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  return (
    <View style={styles.screen}>
      <View style={attemptStyles.header}>
        <Text style={styles.kicker}>{armed ? 'ARMED' : 'RUN ACTIVE'}</Text>
        <Text style={styles.title}>{armed ? 'Waiting for start' : activeTitle}</Text>
        {armed ? (
          <Text style={styles.subtitle}>
            Put the phone away. Official timing starts after genuine departure from a saved place.
          </Text>
        ) : (
          <View>
            <Text style={styles.subtitle}>{activeTitle}</Text>
            {attempt.startedAtMs != null ? (
              <Text style={styles.statusText}>
                Started automatically at {formatTimeOfDay(attempt.startedAtMs)}
              </Text>
            ) : null}
          </View>
        )}
        {armed ? (
          <View style={attemptStyles.statusBlock}>
            <StatusRow
              accessibilityLabel={`GPS readiness: ${readinessLabel}`}
              tone={gpsReadiness.state}
              label={readinessLabel}
            />
            <StatusRow
              accessibilityLabel={`Start zone: ${startZoneLabel(startZoneStatus)}`}
              tone={startZoneStatus.status}
              label={startZoneLabel(startZoneStatus)}
            />
          </View>
        ) : null}
      </View>
      <View style={attemptStyles.mapPane}>
        {shouldRenderAttemptMap(appState) ? (
          <AttemptLiveMap model={model} />
        ) : (
          <View accessibilityLabel="Attempt map paused" style={attemptStyles.paused}>
            <Text style={styles.mutedText}>Map paused. Recording continues.</Text>
          </View>
        )}
      </View>
      <View style={attemptStyles.footer}>
        {model.statusNote ? (
          <Text accessibilityLabel={model.statusNote} style={styles.mutedText}>
            {model.statusNote}
          </Text>
        ) : null}
        {model.emptyPlacesNote ? (
          <Text accessibilityLabel="No saved places" style={styles.mutedText}>
            {model.emptyPlacesNote}
          </Text>
        ) : null}
        {model.distantPlacesNote ? (
          <Text style={styles.mutedText}>{model.distantPlacesNote}</Text>
        ) : null}
        <Text style={styles.mutedText}>You can lock your phone and put it in your pocket.</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onEndAndInspect}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>END & INSPECT</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onCancel}
            style={[styles.button, styles.dangerButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const attemptStyles = StyleSheet.create({
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  mapPane: {
    flex: 1,
    minHeight: 180,
    marginHorizontal: 20,
    marginBottom: 8,
  },
  paused: {
    flex: 1,
    minHeight: 180,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1c2430',
    paddingHorizontal: 16,
  },
  statusBlock: {
    gap: 10,
    marginTop: -4,
    marginBottom: 12,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  statusDotGood: {
    backgroundColor: '#7dcea0',
  },
  statusDotPoor: {
    backgroundColor: '#e0a458',
  },
  statusDotOutside: {
    backgroundColor: '#f07178',
  },
  statusDotWaiting: {
    backgroundColor: '#9aa0a6',
  },
  statusText: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  statusTextGood: {
    color: '#7dcea0',
  },
  statusTextPoor: {
    color: '#e0a458',
  },
  statusTextOutside: {
    color: '#f07178',
  },
  statusTextWaiting: {
    color: '#9aa0a6',
  },
});
