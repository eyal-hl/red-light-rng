import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { formatAttemptStamp, formatElapsed, formatSignedDelta } from '../domain/duration';
import type { JourneyDepartureGroup, JourneyDepartureGrouping } from '../domain/journey-departure';
import type { JourneyPoolStatistics, JourneyTrendPoint } from '../domain/journey-statistics';
import { styles } from './styles';

export type JourneyStatsView = 'overall' | 'weekday' | 'time-of-day';

export function JourneyStatRow({
  label,
  value,
  valueStyle,
}: {
  label: string;
  value: string;
  valueStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, valueStyle]}>{value}</Text>
    </View>
  );
}

export function durationOrDash(ms: number | null): string {
  return ms == null ? '—' : formatElapsed(ms);
}

function trendBarHeight(timeMs: number, minMs: number, maxMs: number): number {
  if (maxMs <= minMs) {
    return 18;
  }
  const ratio = (timeMs - minMs) / (maxMs - minMs);
  return 8 + ratio * 28;
}

function JourneyTrendSparkline({ points }: { points: JourneyTrendPoint[] }) {
  const times = points.map((point) => point.officialTimeMs);
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={`Recent official times, oldest to newest: ${times.map(formatElapsed).join(', ')}`}
      style={styles.trendSparkline}
    >
      {points.map((point) => (
        <View key={point.attemptId} style={styles.trendBarTrack}>
          <View style={[styles.trendBar, { height: trendBarHeight(point.officialTimeMs, minMs, maxMs) }]} />
        </View>
      ))}
    </View>
  );
}

function StatsViewChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.toggleChip, selected ? styles.toggleChipSelected : null]}
    >
      <Text style={styles.toggleChipText}>{label}</Text>
    </Pressable>
  );
}

function JourneyDepartureGroupCard({
  group,
  selected,
  onPress,
}: {
  group: JourneyDepartureGroup;
  selected: boolean;
  onPress: (() => void) | null;
}) {
  const body = (
    <View>
      <Text style={styles.cardTitle}>{group.label}</Text>
      <Text style={styles.cardMeta}>
        {group.validAttemptCount} attempt{group.validAttemptCount === 1 ? '' : 's'}
        {group.isSparse ? ' · Too few attempts to treat as a trend' : ''}
      </Text>
      <JourneyStatRow label="Median" value={durationOrDash(group.medianOfficialTimeMs)} />
      <JourneyStatRow label="Average" value={durationOrDash(group.meanOfficialTimeMs)} />
      <JourneyStatRow label="Best in this group" value={durationOrDash(group.bestOfficialTimeMs)} />
      {group.reconstructedAttemptCount > 0 ? (
        <Text style={styles.mutedText}>Includes reconstructed local start times.</Text>
      ) : null}
    </View>
  );
  if (!onPress) {
    return <View style={[styles.card, selected ? styles.selectedCard : null]}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.card, selected ? styles.selectedCard : null]}
    >
      {body}
    </Pressable>
  );
}

export function JourneyStatisticsDashboard({
  statistics,
  grouping,
  view,
  onChangeView,
  selectedGroupKey,
  onSelectGroup,
}: {
  statistics: JourneyPoolStatistics;
  grouping: JourneyDepartureGrouping;
  view: JourneyStatsView;
  onChangeView: (view: JourneyStatsView) => void;
  selectedGroupKey?: string | null;
  onSelectGroup?: (group: JourneyDepartureGroup | null) => void;
}) {
  if (statistics.validAttemptCount === 0) {
    return (
      <View style={styles.statsSection}>
        <Text style={styles.emptyText}>No completed attempts yet.</Text>
      </View>
    );
  }

  const trendDeltaStyle =
    statistics.recentTrendDeltaMs == null || statistics.recentTrendDeltaMs === 0
      ? styles.deltaNeutral
      : statistics.recentTrendDeltaMs < 0
        ? styles.deltaFaster
        : styles.deltaSlower;
  const groups = view === 'weekday' ? grouping.weekdayGroups : view === 'time-of-day' ? grouping.hourGroups : [];

  return (
    <View style={styles.statsSection}>
      <Text style={styles.sectionLabel}>STATISTICS</Text>
      <View style={styles.statsViewRow}>
        <StatsViewChip
          label="Overall"
          selected={view === 'overall'}
          onPress={() => onChangeView('overall')}
        />
        <StatsViewChip
          label="Weekday"
          selected={view === 'weekday'}
          onPress={() => onChangeView('weekday')}
        />
        <StatsViewChip
          label="Time of day"
          selected={view === 'time-of-day'}
          onPress={() => onChangeView('time-of-day')}
        />
      </View>
      {view === 'overall' ? (
        <View>
          {statistics.pbFinishedAtMs != null ? (
            <JourneyStatRow label="PB date" value={formatAttemptStamp(statistics.pbFinishedAtMs)} />
          ) : null}
          {statistics.validAttemptCount >= 2 ? (
            <View>
              <JourneyStatRow label="Average" value={durationOrDash(statistics.meanOfficialTimeMs)} />
              <JourneyStatRow label="Median" value={durationOrDash(statistics.medianOfficialTimeMs)} />
              <JourneyStatRow
                label="Std. deviation"
                value={durationOrDash(statistics.sampleStandardDeviationMs)}
              />
            </View>
          ) : null}
          {statistics.recentTrendPoints != null && statistics.recentTrendDeltaMs != null ? (
            <View>
              <Text style={styles.mutedText}>
                Last {statistics.recentTrendPoints.length} official times, oldest to newest.
              </Text>
              <JourneyTrendSparkline points={statistics.recentTrendPoints} />
              <JourneyStatRow
                label="Newest vs oldest"
                value={formatSignedDelta(statistics.recentTrendDeltaMs)}
                valueStyle={trendDeltaStyle}
              />
              <Text style={styles.mutedText}>Trend delta is not a statistical significance test.</Text>
            </View>
          ) : null}
          <JourneyStatRow label="Best (7 days)" value={durationOrDash(statistics.bestLast7DaysMs)} />
          <JourneyStatRow label="Best (30 days)" value={durationOrDash(statistics.bestLast30DaysMs)} />
        </View>
      ) : (
        <View>
          <Text style={styles.mutedText}>
            Grouped by official start local time. Best in a group is not a journey PB.
          </Text>
          {groups.length === 0 ? (
            <Text style={styles.emptyText}>No attempts with a stored local start time yet.</Text>
          ) : (
            groups.map((group) => (
              <JourneyDepartureGroupCard
                key={group.key}
                group={group}
                selected={selectedGroupKey === group.key}
                onPress={
                  onSelectGroup
                    ? () => onSelectGroup(selectedGroupKey === group.key ? null : group)
                    : null
                }
              />
            ))
          )}
          {grouping.reconstructedAttemptCount > 0 ? (
            <Text style={styles.mutedText}>Some older attempts use a reconstructed local start time.</Text>
          ) : null}
        </View>
      )}
    </View>
  );
}
