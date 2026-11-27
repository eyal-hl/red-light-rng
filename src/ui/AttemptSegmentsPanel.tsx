import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import { formatElapsed, formatOrdinal } from '../domain/duration';
import type { CompetitiveSegmentsService } from '../product/competitive-segments';
import {
  pbStatusLabel,
  SEGMENTS_PENDING_MESSAGE,
  sourceLabel,
  type AttemptSegmentsView,
} from '../product/competitive-segments-view';
import { styles } from './styles';

type Props = {
  service: CompetitiveSegmentsService;
  attempt: Attempt;
  /** Just-finished result screen only: derive this single run if the live hook has not yet. */
  deriveIfMissing: boolean;
  highlightKey: string | null;
  onSelectSegment: (key: string | null) => void;
  /** Reports the loaded view so the screen can draw the highlighted section. */
  onLoaded: (attemptId: string, view: AttemptSegmentsView) => void;
};

/**
 * Segment times of one run (#81). Loaded asynchronously after the result is shown; the screen,
 * back and done never wait for it. Renders nothing for journeys without competitive checkpoints.
 */
export function AttemptSegmentsPanel({ service, attempt, deriveIfMissing, highlightKey, onSelectSegment, onLoaded }: Props) {
  // The screen mounts this panel with `key={attempt.id}`, so state never leaks between attempts.
  const [view, setView] = useState<AttemptSegmentsView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void service
      .loadAttemptSegments(attempt.id, { deriveIfMissing })
      .then((next) => {
        if (cancelled) return;
        setView(next);
        onLoaded(attempt.id, next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [service, attempt.id, deriveIfMissing, onLoaded]);

  if (failed) {
    return <Text style={styles.mutedText}>Segment times could not be loaded.</Text>;
  }
  if (!view) {
    // Only a configured journey shows anything; until we know, stay silent (no layout shift for the rest).
    return null;
  }
  if (view.state === 'unconfigured') {
    return null;
  }
  return (
    <View accessibilityLabel="Segment times">
      <Text style={styles.sectionLabel}>SEGMENTS</Text>
      {view.attemptKind === 'partial' ? (
        <Text style={styles.sourceBadge}>
          {sourceLabel('partial')}
          {view.startCheckpointName ? ` · started at ${view.startCheckpointName}` : ''}
        </Text>
      ) : null}
      {view.state === 'pending' ? <Text style={styles.mutedText}>{SEGMENTS_PENDING_MESSAGE}</Text> : null}
      {view.message ? <Text style={view.state === 'stale' ? styles.warningText : styles.mutedText}>{view.message}</Text> : null}
      {view.rows.map((row) => {
        const selected = highlightKey === row.key;
        const badge = pbStatusLabel(row.pbStatus);
        return (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            disabled={row.status !== 'valid'}
            onPress={() => onSelectSegment(selected ? null : row.key)}
            style={[styles.splitBlock, selected ? styles.checkpointCardSelected : null]}
          >
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>{row.label}</Text>
              <Text style={styles.statValue}>{row.durationMs == null ? '—' : formatElapsed(row.durationMs)}</Text>
            </View>
            {row.status === 'valid' ? (
              <Text style={styles.cardMeta}>
                {[
                  badge,
                  row.rank != null ? `${formatOrdinal(row.rank)} of ${row.eligibleCount}` : null,
                  row.pbMs != null ? `PB ${formatElapsed(row.pbMs)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            ) : (
              <Text style={styles.mutedText}>{row.reason}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
