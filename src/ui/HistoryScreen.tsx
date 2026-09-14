import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { describeUnavailability, type HistoryRow } from '../domain/attempt-analysis';
import { formatAttemptStamp, formatElapsed, formatOrdinal } from '../domain/duration';
import type { JourneyDepartureGroup, JourneyDepartureGrouping } from '../domain/journey-departure';
import type { JourneyPoolStatistics } from '../domain/journey-statistics';
import {
  JourneyStatisticsDashboard,
  type JourneyStatsView,
} from './JourneyStatisticsDashboard';
import { styles } from './styles';

type HistoryMode = 'chronological' | 'ranked';

type HistoryScreenProps = {
  title: string;
  statistics: JourneyPoolStatistics;
  grouping: JourneyDepartureGrouping;
  rows: HistoryRow[];
  rankedRows: HistoryRow[];
  mode: HistoryMode;
  groupFilter: JourneyDepartureGroup | null;
  busy: boolean;
  error: string | null;
  onChangeMode: (mode: HistoryMode) => void;
  onSelectGroup: (group: JourneyDepartureGroup | null) => void;
  onBack: () => void;
  onOpenAttempt: (attemptId: string) => void;
};

export function HistoryScreen({
  title,
  statistics,
  grouping,
  rows,
  rankedRows,
  mode,
  groupFilter,
  busy,
  error,
  onChangeMode,
  onSelectGroup,
  onBack,
  onOpenAttempt,
}: HistoryScreenProps) {
  const [statsView, setStatsView] = useState<JourneyStatsView>(
    groupFilter?.weekday != null ? 'weekday' : groupFilter?.hourBucket != null ? 'time-of-day' : 'overall',
  );
  const visibleBase = mode === 'ranked' ? rankedRows : rows;
  const visible =
    groupFilter == null
      ? visibleBase
      : visibleBase.filter((row) => groupFilter.attemptIds.includes(row.attemptId));

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← JOURNEY</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>Attempt history</Text>
        <JourneyStatisticsDashboard
          statistics={statistics}
          grouping={grouping}
          view={statsView}
          onChangeView={(next) => {
            setStatsView(next);
            if (next === 'overall') {
              onSelectGroup(null);
            }
          }}
          selectedGroupKey={groupFilter?.key ?? null}
          onSelectGroup={onSelectGroup}
        />
        {groupFilter ? (
          <Pressable accessibilityRole="button" onPress={() => onSelectGroup(null)}>
            <Text style={styles.mutedText}>Showing {groupFilter.label} · Clear group</Text>
          </Pressable>
        ) : null}
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
        {visible.length === 0 ? (
          <Text style={styles.emptyText}>No attempts to show for this journey.</Text>
        ) : (
          visible.map((row) => (
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
  if (row.incompleteLabel) {
    return row.incompleteLabel;
  }
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
