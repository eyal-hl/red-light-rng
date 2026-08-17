import { Pressable, ScrollView, Text, View } from 'react-native';

import { describeUnavailability, type HistoryRow, type RouteAttemptAnalysis } from '../domain/attempt-analysis';
import { formatAttemptStamp, formatElapsed, formatOrdinal } from '../domain/duration';
import type { Route } from '../domain/route';
import { styles } from './styles';

type HistoryMode = 'chronological' | 'ranked';

type HistoryScreenProps = {
  route: Route;
  analysis: RouteAttemptAnalysis;
  mode: HistoryMode;
  busy: boolean;
  error: string | null;
  onChangeMode: (mode: HistoryMode) => void;
  onBack: () => void;
  onOpenAttempt: (attemptId: string) => void;
};

export function HistoryScreen({
  route,
  analysis,
  mode,
  busy,
  error,
  onChangeMode,
  onBack,
  onOpenAttempt,
}: HistoryScreenProps) {
  const rows = mode === 'ranked' ? analysis.rankedHistory : analysis.chronologicalHistory;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← ROUTE</Text>
        </Pressable>
        <Text style={styles.title}>{route.name}</Text>
        <Text style={styles.subtitle}>Attempt history</Text>
        <View style={styles.toggleRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => onChangeMode('chronological')}
            style={[styles.toggleChip, mode === 'chronological' ? styles.toggleChipSelected : null]}
          >
            <Text style={styles.toggleChipText}>Chronological</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => onChangeMode('ranked')}
            style={[styles.toggleChip, mode === 'ranked' ? styles.toggleChipSelected : null]}
          >
            <Text style={styles.toggleChipText}>Ranked</Text>
          </Pressable>
        </View>
        {rows.length === 0 ? (
          <Text style={styles.emptyText}>No attempts to show for this layout.</Text>
        ) : (
          rows.map((row) => (
            <Pressable
              key={row.attemptId}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onOpenAttempt(row.attemptId)}
              style={styles.card}
            >
              <Text style={styles.cardTitle}>{formatAttemptStamp(row.finishedAtMs ?? row.armedAtMs)}</Text>
              <Text style={styles.cardMeta}>{historyMeta(row)}</Text>
              {!row.eligible && row.unavailabilityReason ? (
                <Text style={styles.warningText}>{describeUnavailability(row.unavailabilityReason)}</Text>
              ) : null}
            </Pressable>
          ))
        )}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}

function historyMeta(row: HistoryRow): string {
  if (!row.eligible || row.officialTimeMs == null) {
    return 'Unavailable';
  }
  const time = formatElapsed(row.officialTimeMs);
  if (row.isPb) {
    return `${time} · PB`;
  }
  if (row.rank != null) {
    return `${time} · ${formatOrdinal(row.rank)}`;
  }
  return time;
}
