import { Pressable, Text, View } from 'react-native';

import {
  HOTSPOT_DEFAULT_VISIBLE_COUNT,
  type DelayHotspot,
  type DelayHotspotAnalysis,
  type DelayHotspotOrder,
  type HotspotTrend,
} from '../domain/delay-hotspots';
import { formatAttemptStamp, formatElapsed } from '../domain/duration';
import type { JourneyHotspotsState } from '../product/journey-navigation';
import { styles } from './styles';

const MAX_LISTED_CONTRIBUTIONS = 8;

export function hotspotPercentLabel(hotspot: DelayHotspot): string {
  return `${Math.round(hotspot.waitedRatio * 100)}%`;
}

export function hotspotTrendLabel(trend: HotspotTrend): string {
  const recent = formatElapsed(trend.recentMeanWaitMs);
  const allTime = formatElapsed(trend.allTimeMeanWaitMs);
  const word =
    trend.direction === 'worse' ? 'Waiting more lately' : trend.direction === 'better' ? 'Waiting less lately' : 'Steady lately';
  return `${word}: last 30 days ${recent} per pass vs ${allTime} all-time`;
}

function OrderChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
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

export function JourneyDelayHotspots({
  state,
  analysis,
  ranked,
  visible,
  order,
  expanded,
  selectedId,
  busy,
  onChangeOrder,
  onToggleExpanded,
  onSelect,
  onOpenAttempt,
  onListLayout,
  onCardLayout,
}: {
  state: JourneyHotspotsState;
  analysis: DelayHotspotAnalysis | null;
  ranked: DelayHotspot[];
  visible: DelayHotspot[];
  order: DelayHotspotOrder;
  expanded: boolean;
  selectedId: string | null;
  busy: boolean;
  onChangeOrder: (order: DelayHotspotOrder) => void;
  onToggleExpanded: () => void;
  onSelect: (hotspotId: string | null) => void;
  onOpenAttempt: (attemptId: string) => void;
  /** Cards container y, relative to this component's root. */
  onListLayout?: (y: number) => void;
  /** Card y, relative to the cards container, for scrolling to a drilled-into hotspot. */
  onCardLayout?: (hotspotId: string, y: number) => void;
}) {
  const totals = analysis?.totals ?? null;
  return (
    <View style={styles.statsSection}>
      <Text style={styles.sectionLabel}>RECURRING WAITS</Text>
      <Text style={styles.mutedText}>
        Confirmed waiting is stopped time we observed. It is not time lost versus your PB.
      </Text>
      {state.status === 'idle' || state.status === 'loading' ? (
        <Text style={styles.mutedText}>Analyzing recurring waits…</Text>
      ) : null}
      {state.status === 'error' ? (
        <Text style={styles.mutedText}>Recurring waits are unavailable right now.</Text>
      ) : null}
      {state.status === 'ready' && analysis ? (
        <>
          {ranked.length === 0 ? (
            <Text style={styles.emptyText}>
              No recurring waits yet. A spot needs confirmed waiting on at least two attempts.
            </Text>
          ) : (
            <View onLayout={(event) => onListLayout?.(event.nativeEvent.layout.y)}>
              <View style={styles.statsViewRow}>
                <OrderChip label="Worst total" selected={order === 'total'} onPress={() => onChangeOrder('total')} />
                <OrderChip
                  label="Most frequent"
                  selected={order === 'frequency'}
                  onPress={() => onChangeOrder('frequency')}
                />
              </View>
              {visible.map((hotspot, index) => (
                <HotspotCard
                  key={hotspot.id}
                  rank={index + 1}
                  hotspot={hotspot}
                  selected={hotspot.id === selectedId}
                  busy={busy}
                  onSelect={onSelect}
                  onOpenAttempt={onOpenAttempt}
                  onLayout={onCardLayout}
                />
              ))}
              {ranked.length > HOTSPOT_DEFAULT_VISIBLE_COUNT ? (
                <Pressable accessibilityRole="button" onPress={onToggleExpanded}>
                  <Text style={styles.kicker}>
                    {expanded ? 'SHOW FEWER' : `SHOW ALL ${ranked.length}`}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
          {totals && totals.unlocatedEventCount > 0 ? (
            <Text style={styles.mutedText}>
              Unlocated confirmed waiting (no map pin): {formatElapsed(totals.unlocatedWaitMs)} across{' '}
              {totals.unlocatedEventCount} wait{totals.unlocatedEventCount === 1 ? '' : 's'} in{' '}
              {totals.unlocatedAttemptCount} attempt{totals.unlocatedAttemptCount === 1 ? '' : 's'}.
            </Text>
          ) : null}
          {totals && totals.excludedAttemptCount > 0 ? (
            <Text style={styles.mutedText}>
              {totals.excludedAttemptCount} attempt{totals.excludedAttemptCount === 1 ? '' : 's'} without a
              matching path variant are not included.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function HotspotCard({
  rank,
  hotspot,
  selected,
  busy,
  onSelect,
  onOpenAttempt,
  onLayout,
}: {
  rank: number;
  hotspot: DelayHotspot;
  selected: boolean;
  busy: boolean;
  onSelect: (hotspotId: string | null) => void;
  onOpenAttempt: (attemptId: string) => void;
  onLayout?: (hotspotId: string, y: number) => void;
}) {
  return (
    <View
      style={[styles.card, selected ? styles.selectedCard : null]}
      onLayout={(event) => onLayout?.(hotspot.id, event.nativeEvent.layout.y)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Recurring wait ${rank}`}
        onPress={() => onSelect(selected ? null : hotspot.id)}
      >
        <Text style={styles.cardTitle}>
          #{rank} · {formatElapsed(hotspot.totalWaitMs)} confirmed waiting
        </Text>
        <Text style={styles.cardMeta}>
          Waited {hotspot.waitedAttempts} of {hotspot.encounteredAttempts} attempts that passed (
          {hotspotPercentLabel(hotspot)}) · typical {formatElapsed(hotspot.medianWaitMs)}
        </Text>
      </Pressable>
      {selected ? (
        <View>
          <Text style={styles.cardMeta}>
            Average when waiting {formatElapsed(hotspot.averageWaitMs)} · median {formatElapsed(hotspot.medianWaitMs)} ·
            worst {formatElapsed(hotspot.worstWaitMs)}
          </Text>
          <Text style={styles.cardMeta}>
            Location {hotspot.coordinate.latitude.toFixed(5)}, {hotspot.coordinate.longitude.toFixed(5)} · spread{' '}
            {Math.round(hotspot.spreadMeters)} m · {hotspot.confidence} confidence
          </Text>
          <Text style={styles.cardMeta}>
            {hotspot.trend ? hotspotTrendLabel(hotspot.trend) : 'Trend needs more recent and older passes.'}
          </Text>
          {hotspot.contributions.slice(0, MAX_LISTED_CONTRIBUTIONS).map((item) => (
            <Pressable
              key={item.attemptId}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onOpenAttempt(item.attemptId)}
              style={styles.waitRow}
            >
              <Text style={styles.waitDuration}>{formatElapsed(item.waitMs)}</Text>
              <Text style={styles.waitLocation}>
                {item.finishedAtMs != null ? formatAttemptStamp(item.finishedAtMs) : 'Attempt'}
                {item.eventCount > 1 ? ` · ${item.eventCount} waits` : ''}
              </Text>
            </Pressable>
          ))}
          {hotspot.contributions.length > MAX_LISTED_CONTRIBUTIONS ? (
            <Text style={styles.cardMeta}>
              +{hotspot.contributions.length - MAX_LISTED_CONTRIBUTIONS} older attempts
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
