import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import { formatTimeOfDay } from '../domain/duration';
import type { PlaceStartZoneStatus } from '../domain/place-timing';
import { styles } from './styles';

type AttemptScreenProps = {
  originName: string | null;
  attempt: Attempt;
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

export function AttemptScreen({
  originName,
  attempt,
  startZoneStatus,
  busy,
  error,
  onEndAndInspect,
  onCancel,
}: AttemptScreenProps) {
  const armed = attempt.lifecycle === 'armed';
  const activeTitle = originName ? `${originName} → ?` : 'Journey';

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
          <View
            accessibilityLabel={`Start zone: ${startZoneLabel(startZoneStatus)}`}
            style={attemptStyles.startZoneStatusRow}
          >
            <View
              style={[
                attemptStyles.startZoneStatusDot,
                startZoneStatus.status === 'inside'
                  ? attemptStyles.startZoneStatusDotInside
                  : startZoneStatus.status === 'outside'
                    ? attemptStyles.startZoneStatusDotOutside
                    : attemptStyles.startZoneStatusDotLocating,
              ]}
            />
            <Text
              style={[
                attemptStyles.startZoneStatusText,
                startZoneStatus.status === 'inside'
                  ? attemptStyles.startZoneStatusTextInside
                  : startZoneStatus.status === 'outside'
                    ? attemptStyles.startZoneStatusTextOutside
                    : attemptStyles.startZoneStatusTextLocating,
              ]}
            >
              {startZoneLabel(startZoneStatus)}
            </Text>
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
  startZoneStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: -4,
    marginBottom: 20,
  },
  startZoneStatusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  startZoneStatusDotInside: {
    backgroundColor: '#7dcea0',
  },
  startZoneStatusDotOutside: {
    backgroundColor: '#f07178',
  },
  startZoneStatusDotLocating: {
    backgroundColor: '#9aa0a6',
  },
  startZoneStatusText: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  startZoneStatusTextInside: {
    color: '#7dcea0',
  },
  startZoneStatusTextOutside: {
    color: '#f07178',
  },
  startZoneStatusTextLocating: {
    color: '#9aa0a6',
  },
});
