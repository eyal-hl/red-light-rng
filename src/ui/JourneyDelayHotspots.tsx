import { Pressable, Text, View } from 'react-native';

import {
  formatHotspotFrequency,
  formatHotspotListSummary,
  formatHotspotSpread,
  formatRecentWaitSignal,
  MAX_VISIBLE_DELAY_HOTSPOTS,
  rankDelayHotspots,
  type DelayHotspot,
  type DelayHotspotAnalysis,
  type DelayHotspotRank,
} from '../domain/delay-hotspots';
import { formatElapsed } from '../domain/duration';
import { formatWaitEventDuration } from '../domain/wait-events';
import type { RouteMapWaitMarker } from '../map/RouteMap';
import { styles } from './styles';

type JourneyDelayHotspotsProps = {
  analysis: DelayHotspotAnalysis | null;
  pending: boolean;
  error: string | null;
  selectedId: string | null;
  rank: DelayHotspotRank;
  expanded: boolean;
  onChangeRank: (rank: DelayHotspotRank) => void;
  onToggleExpanded: () => void;
  onSelect: (hotspotId: string) => void;
  onOpenAttempt: (attemptId: string) => void;
};

export function JourneyDelayHotspots({
  analysis,
  pending,
  error,
  selectedId,
  rank,
  expanded,
  onChangeRank,
  onToggleExpanded,
  onSelect,
  onOpenAttempt,
}: JourneyDelayHotspotsProps) {
  if (!pending && !error && !analysis) {
    return null;
  }
  const ranked = analysis ? rankDelayHotspots(analysis.hotspots, rank) : [];
  const visible = expanded ? ranked : ranked.slice(0, MAX_VISIBLE_DELAY_HOTSPOTS);
  const selected = analysis?.hotspots.find((hotspot) => hotspot.id === selectedId) ?? null;

  return (
    <View>
      <Text style={styles.sectionLabel}>RECURRING DELAYS</Text>
      {pending ? <Text style={styles.mutedText}>Loading recurring delays.</Text> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {analysis && ranked.length === 0 ? (
        <Text style={styles.mutedText}>No located recurring delays in this journey.</Text>
      ) : null}
      {analysis && ranked.length > 0 ? (
        <View style={styles.toggleRow}>
          <Pressable
            accessibilityRole="button"
            onPress={() => onChangeRank('frequency')}
            style={[styles.toggleChip, rank === 'frequency' ? styles.toggleChipSelected : null]}
          >
            <Text style={styles.toggleChipText}>Most frequent</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => onChangeRank('worst')}
            style={[styles.toggleChip, rank === 'worst' ? styles.toggleChipSelected : null]}
          >
            <Text style={styles.toggleChipText}>Worst waits</Text>
          </Pressable>
        </View>
      ) : null}
      {visible.map((hotspot) => (
        <Pressable
          key={hotspot.id}
          accessibilityRole="button"
          accessibilityLabel={`Delay hotspot, ${formatHotspotListSummary(hotspot)}`}
          onPress={() => onSelect(hotspot.id)}
          style={[styles.card, hotspot.id === selectedId ? styles.selectedCard : null]}
        >
          <Text style={styles.cardTitle}>{formatHotspotFrequency(hotspot.waitedAttempts, hotspot.encounteredAttempts)}</Text>
          <Text style={styles.cardMeta}>
            typical {formatWaitEventDuration(hotspot.medianWaitMs)} · total {formatWaitEventDuration(hotspot.totalConfirmedWaitMs)} · worst {formatWaitEventDuration(hotspot.worstWaitMs)}
          </Text>
        </Pressable>
      ))}
      {ranked.length > MAX_VISIBLE_DELAY_HOTSPOTS ? (
        <Pressable accessibilityRole="button" onPress={onToggleExpanded} style={styles.toggleChip}>
          <Text style={styles.toggleChipText}>{expanded ? 'SHOW FEWER' : 'SHOW ALL DELAYS'}</Text>
        </Pressable>
      ) : null}
      {selected ? <HotspotDetail hotspot={selected} onOpenAttempt={onOpenAttempt} /> : null}
      {analysis && analysis.unlocatedConfirmedWaitMs > 0 ? (
        <Text style={styles.mutedText}>
          Unlocated waiting {formatWaitEventDuration(analysis.unlocatedConfirmedWaitMs)}. These confirmed waits have
          no map coordinate and are not assigned to a hotspot.
        </Text>
      ) : null}
    </View>
  );
}

export function delayHotspotWaitMarkers(
  analysis: DelayHotspotAnalysis | null,
  options: { rank: DelayHotspotRank; expanded: boolean; selectedId: string | null },
): RouteMapWaitMarker[] {
  if (!analysis) {
    return [];
  }
  const ranked = rankDelayHotspots(analysis.hotspots, options.rank);
  const visible = options.expanded ? ranked : ranked.slice(0, MAX_VISIBLE_DELAY_HOTSPOTS);
  const selected = analysis.hotspots.find((hotspot) => hotspot.id === options.selectedId) ?? null;
  const shown =
    selected && !visible.some((hotspot) => hotspot.id === selected.id) ? [...visible, selected] : visible;
  return shown.map((hotspot) => ({
    id: hotspot.id,
    point: hotspot.coordinate,
    label: formatWaitEventDuration(hotspot.medianWaitMs),
    tone: 'wait' as const,
  }));
}

function HotspotDetail({
  hotspot,
  onOpenAttempt,
}: {
  hotspot: DelayHotspot;
  onOpenAttempt: (attemptId: string) => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Delay detail</Text>
      <Text style={styles.cardMeta}>Frequency {formatHotspotFrequency(hotspot.waitedAttempts, hotspot.encounteredAttempts)}</Text>
      <Text style={styles.cardMeta}>Typical {formatWaitEventDuration(hotspot.medianWaitMs)}</Text>
      <Text style={styles.cardMeta}>Average {formatWaitEventDuration(hotspot.averageWaitMs)}</Text>
      <Text style={styles.cardMeta}>Total {formatElapsed(hotspot.totalConfirmedWaitMs)}</Text>
      <Text style={styles.cardMeta}>Worst {formatWaitEventDuration(hotspot.worstWaitMs)}</Text>
      <Text style={styles.cardMeta}>{formatHotspotSpread(hotspot)}</Text>
      {hotspot.recent ? <Text style={styles.cardMeta}>{formatRecentWaitSignal(hotspot.recent)}</Text> : null}
      {hotspot.attempts.map((share) => (
        <Pressable
          key={share.attemptId}
          accessibilityRole="button"
          accessibilityLabel={`Open attempt ${share.attemptId}, ${formatWaitEventDuration(share.confirmedWaitMs)} confirmed waiting`}
          onPress={() => onOpenAttempt(share.attemptId)}
        >
          <Text style={styles.cardMeta}>
            {formatWaitEventDuration(share.confirmedWaitMs)} confirmed waiting
            {share.eventIds.length > 1 ? ` across ${share.eventIds.length} waits` : ''}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
