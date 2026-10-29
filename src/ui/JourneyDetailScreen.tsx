import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { delayHeatViewState, type DelayHeatMode } from '../domain/delay-heatmap';
import { rankDelayHotspots, visibleDelayHotspots, type DelayHotspotOrder } from '../domain/delay-hotspots';
import { formatElapsed } from '../domain/duration';
import type { JourneyDepartureGroup, JourneyDepartureGrouping } from '../domain/journey-departure';
import type { JourneyHistoryRow, JourneyPoolSummary } from '../domain/journey-analysis';
import type { JourneyPoolStatistics } from '../domain/journey-statistics';
import type { JourneyPathVariantSummary } from '../domain/path-variant-discovery';
import { placeZone, type Place } from '../domain/place';
import type { JourneyHotspotsState } from '../product/journey-navigation';
import { transportationModeIcon, transportationModeLabel } from '../domain/route';
import { delayHeatMapFeatures, delayHotspotMapMarkers } from '../map/hotspot-display';
import { RouteMap } from '../map/RouteMap';
import { pathVariantDisplayStyle, pathVariantDisplayStyles, pathVariantsToMapLines } from '../map/path-variant-display';
import { DeferredMapSlot } from './DeferredMapSlot';
import { JourneyDelayHeat } from './JourneyDelayHeat';
import { JourneyDelayHotspots } from './JourneyDelayHotspots';
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
  hotspots: JourneyHotspotsState;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onHistory: () => void;
  onOpenGroupAttempts: (group: JourneyDepartureGroup) => void;
  onOpenPathVariant: (routeId: string) => void;
  onOpenHotspotAttempt: (attemptId: string) => void;
};

export function JourneyDetailScreen({
  origin,
  destination,
  summary,
  statistics,
  grouping,
  history,
  pathVariants,
  hotspots,
  busy,
  error,
  onBack,
  onHistory,
  onOpenGroupAttempts,
  onOpenPathVariant,
  onOpenHotspotAttempt,
}: JourneyDetailScreenProps) {
  const [statsView, setStatsView] = useState<JourneyStatsView>('overall');
  const variantStyles = pathVariantDisplayStyles(pathVariants.map((item) => item.route.id));
  const variantMapLines = pathVariantsToMapLines(pathVariants);
  const [hotspotOrder, setHotspotOrder] = useState<DelayHotspotOrder>('total');
  const [hotspotsExpanded, setHotspotsExpanded] = useState(false);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const analysis = hotspots.status === 'ready' ? hotspots.analysis : null;
  const rankedHotspots = useMemo(
    () => rankDelayHotspots(analysis?.hotspots ?? [], hotspotOrder),
    [analysis, hotspotOrder],
  );
  const shownHotspots = useMemo(
    () => visibleDelayHotspots(rankedHotspots, hotspotsExpanded),
    [rankedHotspots, hotspotsExpanded],
  );
  const [heatEnabled, setHeatEnabled] = useState(false);
  const [heatMode, setHeatMode] = useState<DelayHeatMode>('frequency');
  // Pure function of (analysis, mode): map gestures and re-renders never recompute it.
  const heatView = useMemo(
    () => delayHeatViewState(hotspots.status, analysis, heatMode),
    [analysis, heatMode, hotspots.status],
  );
  const heatFeatures = useMemo(
    () => (heatEnabled && heatView.kind === 'ready' ? heatView.heat.features : []),
    [heatEnabled, heatView],
  );
  const mapHeat = useMemo(() => delayHeatMapFeatures(heatFeatures), [heatFeatures]);
  const selectedHeat = heatFeatures.find((item) => item.hotspotId === selectedHotspotId) ?? null;
  const hotspotMarkers = useMemo(() => delayHotspotMapMarkers(shownHotspots), [shownHotspots]);

  return (
    <View style={styles.screen}>
      <ScrollView nestedScrollEnabled contentContainerStyle={styles.content}>
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
              path={[]}
              pathVariants={variantMapLines}
              startZone={placeZone(origin)}
              finishZone={placeZone(destination)}
              checkpoints={[]}
              waitMarkers={hotspotMarkers}
              selectedMarkerId={selectedHotspotId}
              heat={mapHeat}
              onHeatPress={(hotspotId) => setSelectedHotspotId(hotspotId)}
              onWaitMarkerPress={(hotspotId) =>
                setSelectedHotspotId((current) => (current === hotspotId ? null : hotspotId))
              }
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
        <JourneyDelayHeat
          view={heatView}
          enabled={heatEnabled}
          mode={heatMode}
          selected={selectedHeat}
          onToggle={() => setHeatEnabled((value) => !value)}
          onChangeMode={setHeatMode}
          onOpenHotspot={(hotspotId) => {
            setSelectedHotspotId(hotspotId);
            if (!shownHotspots.some((item) => item.id === hotspotId)) {
              setHotspotsExpanded(true);
            }
          }}
        />
        <JourneyDelayHotspots
          state={hotspots}
          analysis={analysis}
          ranked={rankedHotspots}
          visible={shownHotspots}
          order={hotspotOrder}
          expanded={hotspotsExpanded}
          selectedId={selectedHotspotId}
          busy={busy}
          onChangeOrder={setHotspotOrder}
          onToggleExpanded={() => setHotspotsExpanded((value) => !value)}
          onSelect={setSelectedHotspotId}
          onOpenAttempt={onOpenHotspotAttempt}
        />
        <Text style={styles.mutedText}>
          Any path between these places counts. Journey PB is the headline. Path variants are optional
          secondary analytics.
        </Text>
        {pathVariants.length > 0 ? (
          <View>
            <Text style={styles.sectionLabel}>PATH VARIANTS</Text>
            {pathVariants.map((item) => {
              const variantStyle = variantStyles.get(item.route.id) ?? pathVariantDisplayStyle(item.route.id);
              return (
                <Pressable
                  key={item.route.id}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => onOpenPathVariant(item.route.id)}
                  style={styles.card}
                >
                  <View style={styles.cardTitleRow}>
                    <View
                      accessibilityLabel={`${item.route.name} path color`}
                      style={[
                        styles.variantSwatch,
                        { backgroundColor: variantStyle.color },
                      ]}
                    />
                    <Text style={[styles.cardTitle, styles.variantCardTitle]}>{item.route.name}</Text>
                  </View>
                  <Text style={styles.cardMeta}>
                    {item.attemptCount} attempt{item.attemptCount === 1 ? '' : 's'}
                    {item.pbTimeMs == null ? '' : ` · variant PB ${formatElapsed(item.pbTimeMs)}`}
                    {item.typicalTimeMs == null ? '' : ` · typical ${formatElapsed(item.typicalTimeMs)}`}
                  </Text>
                </Pressable>
              );
            })}
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
