import { Pressable, ScrollView, Text, View } from 'react-native';

import { officialTimeMs, type Attempt } from '../domain/attempt';
import { formatElapsed, formatTimeOfDay } from '../domain/duration';
import type { Route } from '../domain/route';
import { styles } from './styles';

type AttemptResultScreenProps = {
  route: Route | null;
  attempt: Attempt;
  busy: boolean;
  error: string | null;
  onDone: () => void;
};

export function AttemptResultScreen({
  route,
  attempt,
  busy,
  error,
  onDone,
}: AttemptResultScreenProps) {
  const official = officialTimeMs(attempt);
  const completed = attempt.lifecycle === 'completed';
  const valid = attempt.validity === 'valid';

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>{completed ? 'ATTEMPT COMPLETE' : 'ATTEMPT ENDED'}</Text>
        <Text style={styles.title}>{route?.name ?? 'Attempt'}</Text>
        {completed && official != null ? (
          <Text style={styles.title}>{formatElapsed(official)}</Text>
        ) : (
          <Text style={styles.subtitle}>
            {attempt.lifecycle === 'abandoned'
              ? 'This attempt left the course and was not ranked.'
              : 'This attempt was cancelled and is not an official run.'}
          </Text>
        )}
        {completed && !valid ? (
          <Text style={styles.warningText}>Unranked — the course match was not reliable enough.</Text>
        ) : null}
        {attempt.startedAtMs != null ? (
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Started</Text>
            <Text style={styles.statValue}>{formatTimeOfDay(attempt.startedAtMs)}</Text>
          </View>
        ) : null}
        {attempt.finishedAtMs != null ? (
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Finished</Text>
            <Text style={styles.statValue}>{formatTimeOfDay(attempt.finishedAtMs)}</Text>
          </View>
        ) : null}
        {attempt.crossings.length === 0 ? (
          <Text style={styles.mutedText}>No intermediate checkpoints on this course.</Text>
        ) : (
          <View>
            <Text style={styles.sectionLabel}>CHECKPOINTS</Text>
            {attempt.crossings.map((crossing) => (
              <View key={crossing.id} style={styles.statRow}>
                <Text style={styles.statLabel}>{crossing.checkpointName}</Text>
                <Text style={styles.statValue}>
                  {attempt.startedAtMs != null
                    ? formatElapsed(Math.max(0, crossing.crossedAtMs - attempt.startedAtMs))
                    : formatTimeOfDay(crossing.crossedAtMs)}
                </Text>
              </View>
            ))}
          </View>
        )}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onDone}
            style={[styles.button, styles.primaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>DONE</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
