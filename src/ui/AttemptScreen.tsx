import { Pressable, ScrollView, Text, View } from 'react-native';

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
            style={styles.startZoneStatusRow}
          >
            <View
              style={[
                styles.startZoneStatusDot,
                startZoneStatus === 'inside'
                  ? styles.startZoneStatusDotInside
                  : startZoneStatus === 'outside'
                    ? styles.startZoneStatusDotOutside
                    : styles.startZoneStatusDotLocating,
              ]}
            />
            <Text
              style={[
                styles.startZoneStatusText,
                startZoneStatus === 'inside'
                  ? styles.startZoneStatusTextInside
                  : startZoneStatus === 'outside'
                    ? styles.startZoneStatusTextOutside
                    : styles.startZoneStatusTextLocating,
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
