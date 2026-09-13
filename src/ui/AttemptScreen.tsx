import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import { formatTimeOfDay } from '../domain/duration';
import { formatGpsReadinessLabel, type GpsReadiness } from '../domain/gps-readiness';
import type { PlaceStartZoneStatus } from '../domain/place-timing';
import { styles } from './styles';

type AttemptScreenProps = {
  originName: string | null;
  attempt: Attempt;
  gpsReadiness: GpsReadiness;
  startZoneStatus: PlaceStartZoneStatus;
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
  busy,
  error,
  onEndAndInspect,
  onCancel,
}: AttemptScreenProps) {
  const armed = attempt.lifecycle === 'armed';
  const activeTitle = originName ? `${originName} → ?` : 'Journey';
  const readinessLabel = formatGpsReadinessLabel(gpsReadiness);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
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
      </ScrollView>
    </View>
  );
}

const attemptStyles = StyleSheet.create({
  statusBlock: {
    gap: 10,
    marginTop: -4,
    marginBottom: 20,
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
