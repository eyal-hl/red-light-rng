import { Pressable, Text, View } from 'react-native';

import {
  heatLegendText,
  type DelayHeatFeature,
  type DelayHeatMode,
  type DelayHeatViewState,
} from '../domain/delay-heatmap';
import { formatElapsed } from '../domain/duration';
import { styles } from './styles';

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
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

/** Heat panel for the heatmap view. The caller renders it only while that view is active. */
export function JourneyDelayHeat({
  view,
  mode,
  selected,
  onChangeMode,
  onOpenHotspot,
}: {
  view: DelayHeatViewState;
  mode: DelayHeatMode;
  /** The tapped heat feature, if it is currently rendered. */
  selected: DelayHeatFeature | null;
  onChangeMode: (mode: DelayHeatMode) => void;
  onOpenHotspot: (hotspotId: string) => void;
}) {
  return (
    <View style={styles.statsSection}>
      <Text style={styles.sectionLabel}>DELAY HEATMAP</Text>
      {view.kind === 'loading' ? <Text style={styles.mutedText}>Analyzing recurring waits…</Text> : null}
      {view.kind === 'unavailable' ? (
        <Text style={styles.mutedText}>The heatmap is unavailable right now.</Text>
      ) : null}
      {view.kind === 'not-enough-history' ? (
        <Text style={styles.emptyText}>
          Not enough history for a heatmap. It needs at least two analyzed attempts with confirmed waiting at the
          same spot.
        </Text>
      ) : null}
      {view.kind === 'ready' ? (
        <View>
          <View style={styles.statsViewRow}>
            <Chip label="Frequency" selected={mode === 'frequency'} onPress={() => onChangeMode('frequency')} />
            <Chip label="Total waiting" selected={mode === 'total'} onPress={() => onChangeMode('total')} />
          </View>
          <Text style={styles.mutedText}>{heatLegendText(mode)}</Text>
          <Text style={styles.mutedText}>
            Only recurring spots are shown. Not GPS density, and not time lost versus your PB.
            {view.heat.capped
              ? ` Showing the top ${view.heat.features.length} of ${view.heat.recurringCount} recurring spots.`
              : ''}
            {view.heat.oneOffWaitMs > 0
              ? ` One-off waits (${formatElapsed(view.heat.oneOffWaitMs)}) are not drawn.`
              : ''}
            {view.heat.unlocatedWaitMs > 0
              ? ` Unlocated waits (${formatElapsed(view.heat.unlocatedWaitMs)}) have no map position.`
              : ''}
          </Text>
          {selected ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>
                Waited on {selected.waitedAttempts} of {selected.encounteredAttempts} attempts here
              </Text>
              <Text style={styles.cardMeta}>
                Typical wait {formatElapsed(selected.medianWaitMs)} · {formatElapsed(selected.totalWaitMs)} total
                confirmed waiting
              </Text>
              <Pressable accessibilityRole="button" onPress={() => onOpenHotspot(selected.hotspotId)}>
                <Text style={styles.kicker}>VIEW RECURRING WAIT DETAILS</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.mutedText}>Tap a heat spot on the map for a summary.</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
