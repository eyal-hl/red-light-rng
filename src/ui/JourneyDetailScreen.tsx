import { Pressable, ScrollView, Text, View } from 'react-native';

import { formatElapsed } from '../domain/duration';
import { placeZone } from '../domain/place';
import type { JourneyHistoryRow, JourneyPoolSummary } from '../domain/journey-analysis';
import type { JourneyPathVariantSummary } from '../domain/path-variant-discovery';
import type { Place } from '../domain/place';
import { transportationModeIcon, transportationModeLabel } from '../domain/route';
import { RouteMap } from '../map/RouteMap';
import { styles } from './styles';

type JourneyDetailScreenProps = {
  origin: Place;
  destination: Place;
  summary: JourneyPoolSummary;
  history: JourneyHistoryRow[];
  pathVariants: JourneyPathVariantSummary[];
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onHistory: () => void;
  onOpenPathVariant: (routeId: string) => void;
};

export function JourneyDetailScreen({
  origin,
  destination,
  summary,
  history,
  pathVariants,
  busy,
  error,
  onBack,
  onHistory,
  onOpenPathVariant,
}: JourneyDetailScreenProps) {
  const mapPath = pathVariants.length === 1 ? (pathVariants[0]?.route.referencePath ?? []) : [];

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
            path={mapPath}
            startZone={placeZone(origin)}
            finishZone={placeZone(destination)}
            checkpoints={[]}
          />
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>PB</Text>
          <Text style={styles.statValue}>
            {summary.pbTimeMs == null ? '—' : formatElapsed(summary.pbTimeMs)}
          </Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Last</Text>
          <Text style={styles.statValue}>
            {summary.lastTimeMs == null ? '—' : formatElapsed(summary.lastTimeMs)}
          </Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Attempts</Text>
          <Text style={styles.statValue}>{summary.rankedAttemptCount}</Text>
        </View>
        <Text style={styles.mutedText}>
          Any path between these places counts. Journey PB is the headline. Path variants are optional
          secondary analytics.
        </Text>
        {pathVariants.length > 0 ? (
          <View>
            <Text style={styles.sectionLabel}>PATH VARIANTS</Text>
            {pathVariants.map((item) => (
              <Pressable
                key={item.route.id}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => onOpenPathVariant(item.route.id)}
                style={styles.card}
              >
                <Text style={styles.cardTitle}>{item.route.name}</Text>
                <Text style={styles.cardMeta}>
                  {item.attemptCount} attempt{item.attemptCount === 1 ? '' : 's'}
                  {item.pbTimeMs == null ? '' : ` · variant PB ${formatElapsed(item.pbTimeMs)}`}
                  {item.typicalTimeMs == null ? '' : ` · typical ${formatElapsed(item.typicalTimeMs)}`}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
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
        </View>
      </ScrollView>
    </View>
  );
}
