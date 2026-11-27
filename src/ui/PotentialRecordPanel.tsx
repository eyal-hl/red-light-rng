import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import { formatElapsed } from '../domain/duration';
import type { CompetitiveSegmentsService, PotentialRecordView } from '../product/competitive-segments';
import {
  describePotentialRecord,
  POTENTIAL_CONFIG_CHANGED_MESSAGE,
  POTENTIAL_RECORD_DISCLAIMER,
} from '../product/competitive-segments-view';
import { styles } from './styles';

type Props = {
  service: CompetitiveSegmentsService;
  attempt: Attempt;
};

/**
 * Hypothetical "potential full-route record" of a completed checkpoint-start run (#81), shown next
 * to the actual full-route PB. Loaded asynchronously and display-only: nothing is saved, ranked or
 * counted. Renders nothing for full runs and for runs without a completed partial result.
 */
export function PotentialRecordPanel({ service, attempt }: Props) {
  // The screen mounts this panel with `key={attempt.id}`, so state never leaks between attempts.
  const [view, setView] = useState<PotentialRecordView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void service
      .loadPotentialRecord(attempt.id)
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [service, attempt.id]);

  if (failed) {
    return <Text style={styles.mutedText}>The potential record could not be calculated.</Text>;
  }
  if (!view || view.state === 'not_applicable') {
    return null;
  }
  if (view.state === 'config_changed') {
    return (
      <View accessibilityLabel="Potential full-route record">
        <Text style={styles.sectionLabel}>POTENTIAL FULL-ROUTE RECORD</Text>
        <Text style={styles.mutedText}>{POTENTIAL_CONFIG_CHANGED_MESSAGE}</Text>
      </View>
    );
  }
  const described = describePotentialRecord(view.result, view.checkpointName, formatElapsed);
  return (
    <View accessibilityLabel="Potential full-route record">
      <Text style={styles.sectionLabel}>POTENTIAL FULL-ROUTE RECORD · HYPOTHETICAL</Text>
      <Text style={styles.statusText}>{described.pbLine}</Text>
      <Text style={styles.mutedText}>{described.sampleLine}</Text>
      {described.rows.map((row) => (
        <View key={row.kind} style={styles.splitBlock}>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>{row.title}</Text>
            <Text style={styles.statValue}>{row.totalMs == null ? '—' : formatElapsed(row.totalMs)}</Text>
          </View>
          <Text style={row.tone === 'record' ? styles.statusText : row.tone === 'unavailable' ? styles.mutedText : styles.cardMeta}>
            {row.detail}
          </Text>
        </View>
      ))}
      <Text style={styles.mutedText}>{POTENTIAL_RECORD_DISCLAIMER}</Text>
    </View>
  );
}
