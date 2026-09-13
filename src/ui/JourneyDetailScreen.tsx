import { Pressable, ScrollView, Text, View } from 'react-native';

import { formatElapsed } from '../domain/duration';
import { placeZone } from '../domain/place';
import type { JourneyHistoryRow, JourneyPoolSummary } from '../domain/journey-analysis';
import type { JourneyPoolStatistics } from '../domain/journey-statistics';
import type { Place } from '../domain/place';
import {
  transportationModeIcon,
  transportationModeLabel,
  type Route,
} from '../domain/route';
import { RouteMap } from '../map/RouteMap';
import { durationOrDash, JourneyStatRow, JourneyStatisticsDashboard } from './JourneyStatisticsDashboard';
import { styles } from './styles';

type JourneyDetailScreenProps = {
  origin: Place;
  destination: Place;
  summary: JourneyPoolSummary;
  statistics: JourneyPoolStatistics;
  history: JourneyHistoryRow[];
  pathVariant: Route | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onHistory: () => void;
  onEditPathVariant: (() => void) | null;
};

export function JourneyDetailScreen({
  origin,
  destination,
  summary,
  statistics,
  history,
  pathVariant,
  busy,
  error,
  onBack,
  onHistory,
  onEditPathVariant,
}: JourneyDetailScreenProps) {
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← JOURNEYS</Text>
        </Pressable>
        <Text style={styles.title}>{summary.title}</Text>
        <Text style={styles.subtitle}>
          {transportationModeIcon(summary.transportationMode)}{' '}
          {transportationModeLabel(summary.transportationMode)}
        </Text>
        <View style={styles.mapSlot}>
          <RouteMap
            path={pathVariant?.referencePath ?? []}
            startZone={placeZone(origin)}
            finishZone={placeZone(destination)}
            checkpoints={[]}
          />
        </View>
        <JourneyStatRow label="PB" value={durationOrDash(statistics.pbTimeMs ?? summary.pbTimeMs)} />
        <JourneyStatRow label="Last" value={durationOrDash(statistics.latestTimeMs ?? summary.lastTimeMs)} />
        <JourneyStatRow label="Attempts" value={String(statistics.validAttemptCount)} />
        <JourneyStatisticsDashboard statistics={statistics} />
        <Text style={styles.mutedText}>
          Any path between these places counts. This screen is history only — START from Home.
        </Text>
        {history.slice(0, 3).map((row) => (
          <View key={row.attemptId} style={styles.card}>
            <Text style={styles.cardTitle}>
              {row.officialTimeMs == null ? row.incompleteLabel ?? 'Attempt' : formatElapsed(row.officialTimeMs)}
            </Text>
            <Text style={styles.cardMeta}>{row.isPb ? 'PB' : row.rank != null ? `#${row.rank}` : 'Unranked'}</Text>
          </View>
        ))}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onHistory}
            style={[styles.button, styles.primaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>HISTORY</Text>
          </Pressable>
          {onEditPathVariant ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onEditPathVariant}
              style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>EDIT PATH VARIANT</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
