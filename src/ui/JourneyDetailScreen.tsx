import { useMemo, useRef, useState } from 'react';
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
import {
  createJourneyWaitViewState,
  mapHeatFeatures,
  openHotspotFromHeat,
  presentWaitView,
  selectWaitView,
  type JourneyWaitView,
} from '../product/journey-wait-view';
import { transportationModeIcon, transportationModeLabel } from '../domain/route';
import { delayHeatMapFeatures, delayHotspotMapMarkers } from '../map/hotspot-display';
import { RouteMap } from '../map/RouteMap';
import { pathVariantDisplayStyle, pathVariantDisplayStyles, pathVariantsToMapLines } from '../map/path-variant-display';
import { DeferredMapSlot } from './DeferredMapSlot';
import { JourneyDelayHeat } from './JourneyDelayHeat';
import { JourneyDelayHotspots } from './JourneyDelayHotspots';
import { JourneyWaitViewSwitch } from './JourneyWaitViewSwitch';
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
  // One view at a time (recurring list or heat panel); expanded and selection survive switches.
  const [waitView, setWaitView] = useState(createJourneyWaitViewState);
  const presentation = presentWaitView(waitView);
  const scrollRef = useRef<ScrollView>(null);
  // Y of the view switch inside the scroll content, so drill-down can bring the list into view.
  const waitSwitchY = useRef(0);
  const analysis = hotspots.status === 'ready' ? hotspots.analysis : null;
  const rankedHotspots = useMemo(
    () => rankDelayHotspots(analysis?.hotspots ?? [], hotspotOrder),
    [analysis, hotspotOrder],
  );
  const shownHotspots = useMemo(
    () => visibleDelayHotspots(rankedHotspots, waitView.expanded),
    [rankedHotspots, waitView.expanded],
  );
  const [heatMode, setHeatMode] = useState<DelayHeatMode>('frequency');
  // Pure function of (analysis, mode): map gestures and re-renders never recompute it.
  const heatView = useMemo(
    () => delayHeatViewState(hotspots.status, analysis, heatMode),
    [analysis, heatMode, hotspots.status],
  );
  // Heat reaches the map only while the heatmap view is active.
  const heatFeatures = useMemo(() => mapHeatFeatures(waitView.view, heatView), [waitView.view, heatView]);
  const mapHeat = useMemo(() => delayHeatMapFeatures(heatFeatures), [heatFeatures]);
  const selectedHeat =
    heatFeatures.find((item) => item.hotspotId === waitView.selectedHotspotId) ?? null;
  const hotspotMarkers = useMemo(() => delayHotspotMapMarkers(shownHotspots), [shownHotspots]);

  const changeWaitView = (view: JourneyWaitView) => setWaitView((state) => selectWaitView(state, view));
  const selectHotspot = (hotspotId: string | null) =>
    setWaitView((state) => ({ ...state, selectedHotspotId: hotspotId }));

  return (
    <View style={styles.screen}>
      <ScrollView ref={scrollRef} nestedScrollEnabled contentContainerStyle={styles.content}>
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
              selectedMarkerId={waitView.selectedHotspotId}
              heat={mapHeat}
              onHeatPress={(hotspotId) => selectHotspot(hotspotId)}
              onWaitMarkerPress={(hotspotId) =>
                setWaitView((state) => ({
                  ...state,
                  selectedHotspotId: state.selectedHotspotId === hotspotId ? null : hotspotId,
                }))
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
        <View
          onLayout={(event) => {
            waitSwitchY.current = event.nativeEvent.layout.y;
          }}
        >
          <JourneyWaitViewSwitch view={waitView.view} onSelect={changeWaitView} />
        </View>
        {presentation.showHeatPanel ? (
          <JourneyDelayHeat
            view={heatView}
            mode={heatMode}
            selected={selectedHeat}
            onChangeMode={setHeatMode}
            onOpenHotspot={(hotspotId) => {
              setWaitView((state) =>
                openHotspotFromHeat(
                  state,
                  hotspotId,
                  shownHotspots.map((item) => item.id),
                ),
              );
              scrollRef.current?.scrollTo({ y: Math.max(0, waitSwitchY.current - 8), animated: true });
            }}
          />
        ) : null}
        {presentation.showRecurringList ? (
          <JourneyDelayHotspots
            state={hotspots}
            analysis={analysis}
            ranked={rankedHotspots}
            visible={shownHotspots}
            order={hotspotOrder}
            expanded={waitView.expanded}
            selectedId={waitView.selectedHotspotId}
            busy={busy}
            onChangeOrder={setHotspotOrder}
            onToggleExpanded={() => setWaitView((state) => ({ ...state, expanded: !state.expanded }))}
            onSelect={selectHotspot}
            onOpenAttempt={onOpenHotspotAttempt}
          />
        ) : null}
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
