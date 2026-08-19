import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import { formatTimeOfDay } from '../domain/duration';
import type { Route } from '../domain/route';
import type { StartZoneStatus } from '../domain/start-zone-status';
import { styles } from './styles';

type AttemptScreenProps = {
  route: Route | null;
  attempt: Attempt;
  startZoneStatus: StartZoneStatus;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
};

function startZoneLabel(status: StartZoneStatus): string {
  if (status === 'inside') {
    return 'IN START ZONE';
  }
  if (status === 'outside') {
    return 'OUTSIDE START ZONE';
  }
  return 'LOCATING…';
}

export function AttemptScreen({
  route,
  attempt,
  startZoneStatus,
  busy,
  error,
  onCancel,
}: AttemptScreenProps) {
  const armed = attempt.lifecycle === 'armed';

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>{armed ? 'ARMED' : 'RUN ACTIVE'}</Text>
        <Text style={styles.title}>
          {armed ? 'Waiting for start' : route?.name ?? 'Attempt'}
        </Text>
        {armed ? (
          <Text style={styles.subtitle}>
            {route?.name ?? 'Saved route'}. Put the phone away. Official timing starts after genuine
            departure.
          </Text>
        ) : (
          <View>
            <Text style={styles.subtitle}>{route?.name ?? 'Saved route'}</Text>
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
                startZoneStatus === 'inside'
                  ? attemptStyles.startZoneStatusDotInside
                  : startZoneStatus === 'outside'
                    ? attemptStyles.startZoneStatusDotOutside
                    : attemptStyles.startZoneStatusDotLocating,
              ]}
            />
            <Text
              style={[
                attemptStyles.startZoneStatusText,
                startZoneStatus === 'inside'
                  ? attemptStyles.startZoneStatusTextInside
                  : startZoneStatus === 'outside'
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
