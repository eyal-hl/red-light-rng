import { Pressable, ScrollView, Text, View } from 'react-native';

import { transportationModeIcon, transportationModeLabel, type Route } from '../domain/route';
import type { TrackingSessionRecord } from '../persistence/location-sample-store';
import { styles } from './styles';

type HomeScreenProps = {
  routes: Route[];
  pendingRecording: TrackingSessionRecord | null;
  canStartNewRecording: boolean;
  busy: boolean;
  error: string | null;
  onRecordNewRoute: () => void;
  onOpenPending: () => void;
  onOpenRoute: (routeId: string) => void;
};

export function HomeScreen({
  routes,
  pendingRecording,
  canStartNewRecording,
  busy,
  error,
  onRecordNewRoute,
  onOpenPending,
  onOpenRoute,
}: HomeScreenProps) {
  const recordDisabled = busy || !canStartNewRecording;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>RED LIGHT RNG</Text>
        <Text style={styles.title}>Your routes</Text>

        {pendingRecording ? (
          <Pressable
            accessibilityRole="button"
            onPress={onOpenPending}
            style={styles.card}
          >
            <Text style={styles.cardTitle}>
              {pendingRecording.captureOutcome === 'interrupted'
                ? 'Interrupted recording'
                : 'Unsaved recording'}
            </Text>
            <Text style={styles.cardMeta}>
              {pendingRecording.captureOutcome === 'interrupted'
                ? 'Review this partial route, then save or discard it.'
                : 'Finish reviewing this recording before starting another.'}
            </Text>
          </Pressable>
        ) : null}

        {routes.length === 0 ? (
          <View>
            <Text style={styles.emptyText}>No routes yet.</Text>
            <Text style={styles.subtitle}>
              Record your regular commute once. The app uses it as the reference course.
            </Text>
          </View>
        ) : (
          <View>
            {routes.map((route) => (
              <Pressable
                key={route.id}
                accessibilityRole="button"
                onPress={() => onOpenRoute(route.id)}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>{route.name}</Text>
                <Text style={styles.cardMeta}>
                  {transportationModeIcon(route.transportationMode)}{' '}
                  {transportationModeLabel(route.transportationMode)}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={recordDisabled}
            onPress={onRecordNewRoute}
            style={[
              styles.button,
              styles.primaryButton,
              recordDisabled ? styles.disabledButton : null,
            ]}
          >
            <Text style={styles.buttonText}>+ RECORD NEW ROUTE</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
