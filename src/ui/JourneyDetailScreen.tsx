import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { formatElapsed } from '../domain/duration';
import type { JourneyDepartureGroup, JourneyDepartureGrouping } from '../domain/journey-departure';
import type { JourneyHistoryRow, JourneyPoolSummary } from '../domain/journey-analysis';
import type { JourneyPoolStatistics } from '../domain/journey-statistics';
import type { JourneyPathVariantSummary } from '../domain/path-variant-discovery';
import { placeZone, type Place } from '../domain/place';
import { transportationModeIcon, transportationModeLabel } from '../domain/route';
import { RouteMap } from '../map/RouteMap';
import { DeferredMapSlot } from './DeferredMapSlot';
import {
  durationOrDash,
  JourneyStatRow,
  JourneyStatisticsDashboard,
  type JourneyStatsView,
} from './JourneyStatisticsDashboard';
import { styles } from './styles';

type JourneyDetailScreenProps = {
  origin: Place;
  destination: Place;
  summary: JourneyPoolSummary;
  statistics: JourneyPoolStatistics;
  grouping: JourneyDepartureGrouping;
  history: JourneyHistoryRow[];
  pathVariants: JourneyPathVariantSummary[];
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onHistory: () => void;
  onOpenGroupAttempts: (group: JourneyDepartureGroup) => void;
  onOpenPathVariant: (routeId: string) => void;
};

export function JourneyDetailScreen({
  origin,
  destination,
  summary,
  statistics,
  grouping,
  history,
  pathVariants,
  busy,
  error,
  onBack,
  onHistory,
  onOpenGroupAttempts,
  onOpenPathVariant,
}: JourneyDetailScreenProps) {
  const [statsView, setStatsView] = useState<JourneyStatsView>('overall');
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
          <DeferredMapSlot style={styles.editorMap}>
            <RouteMap
              path={mapPath}
              startZone={placeZone(origin)}
              finishZone={placeZone(destination)}
              checkpoints={[]}
            />
          </DeferredMapSlot>
        </View>
        <JourneyStatRow label="PB" value={durationOrDash(statistics.pbTimeMs ?? summary.pbTimeMs)} />
        <JourneyStatRow label="Last" value={durationOrDash(statistics.latestTimeMs ?? summary.lastTimeMs)} />
        <JourneyStatRow label="Attempts" value={String(statistics.validAttemptCount)} />
        <JourneyStatisticsDashboard
          statistics={statistics}
          grouping={grouping}
          view={statsView}
          onChangeView={setStatsView}
          onSelectGroup={(group) => {
            if (group) {
              onOpenGroupAttempts(group);
            }
          }}
        />
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
