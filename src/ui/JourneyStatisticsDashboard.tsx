import { Text, View, type StyleProp, type TextStyle } from 'react-native';

import { formatAttemptStamp, formatElapsed, formatSignedDelta } from '../domain/duration';
import type { JourneyPoolStatistics, JourneyTrendPoint } from '../domain/journey-statistics';
import { styles } from './styles';

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

export function JourneyStatisticsDashboard({ statistics }: { statistics: JourneyPoolStatistics }) {
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

  return (
    <View style={styles.statsSection}>
      <Text style={styles.sectionLabel}>STATISTICS</Text>
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
  );
}
