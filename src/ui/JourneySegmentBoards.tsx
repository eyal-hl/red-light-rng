import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { CompetitiveCheckpointPool } from '../domain/competitive-checkpoint';
import { formatAttemptStamp, formatElapsed, formatOrdinal } from '../domain/duration';
import type { JourneyDepartureGrouping, JourneyDepartureGroup } from '../domain/journey-departure';
import type { SegmentBoardSort } from '../domain/segment-leaderboard';
import type { CompetitiveSegmentsService, SegmentBoardsResult } from '../product/competitive-segments';
import {
  FULL_ROUTE_SELECTION,
  resolveSegmentSelection,
  segmentBoardSummary,
  segmentSelectorOptions,
  sourceLabel,
} from '../product/competitive-segments-view';
import { styles } from './styles';

type Props = {
  segments: CompetitiveSegmentsService;
  pool: CompetitiveCheckpointPool;
  /** The journey's existing weekday / time-of-day groups; the segment filters reuse them. */
  grouping: JourneyDepartureGrouping;
  /** Bumped when checkpoints or results changed elsewhere. */
  refreshKey?: number;
  onOpenCheckpoints: () => void;
  /** Opens the original attempt with the segment highlighted on its map. */
  onOpenAttempt: (attemptId: string, segmentKey: string) => void;
};

/**
 * Segment selector under the journey summary (#81). The original full route is the default and is
 * rendered by the existing screen unchanged; this component renders NOTHING for a journey without
 * competitive checkpoints, and only the selector row while the full route is selected.
 */
export function JourneySegmentBoards({ segments, pool, grouping, refreshKey = 0, onOpenCheckpoints, onOpenAttempt }: Props) {
  const [result, setResult] = useState<SegmentBoardsResult | null>(null);
  const [selection, setSelection] = useState<string>(FULL_ROUTE_SELECTION);
  const [group, setGroup] = useState<JourneyDepartureGroup | null>(null);
  const [sort, setSort] = useState<SegmentBoardSort>('ranked');

  useEffect(() => {
    let cancelled = false;
    void segments
      .loadSegmentBoards(pool, {
        filter: group ? { weekday: group.weekday, hourBucket: group.hourBucket } : undefined,
        sort,
      })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [segments, pool, group, sort, refreshKey]);

  const boards = useMemo(() => result?.boards ?? [], [result]);
  const options = useMemo(() => segmentSelectorOptions(boards), [boards]);
  const active = resolveSegmentSelection(selection, boards);
  const board = boards.find((item) => item.key === active) ?? null;

  if (!result || !result.config || result.config.checkpoints.length === 0) {
    return null;
  }
  const summary = board ? segmentBoardSummary(board, formatElapsed) : null;
  const groups = [...grouping.weekdayGroups, ...grouping.hourGroups];

  return (
    <View accessibilityLabel="Segment boards">
      <Text style={styles.sectionLabel}>SEGMENTS</Text>
      <View style={styles.segmentChipRow}>
        {options.map((option) => (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            onPress={() => setSelection(option.key)}
            style={[styles.modeChip, option.key === active ? styles.modeChipSelected : null]}
          >
            <Text style={styles.modeChipText}>
              {option.label}
              {option.count != null ? ` (${option.count})` : ''}
            </Text>
          </Pressable>
        ))}
      </View>
      {result.status.needsRecalculation ? (
        <Pressable accessibilityRole="button" onPress={onOpenCheckpoints}>
          <Text style={styles.warningText}>
            {result.status.staleAttemptCount} run{result.status.staleAttemptCount === 1 ? '' : 's'} have no segment times for
            the current checkpoints yet. Open Checkpoints & segments to recalculate.
          </Text>
        </Pressable>
      ) : null}
      {board && summary ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{summary.title}</Text>
          <Text style={styles.cardMeta}>
            {[summary.countLabel, summary.pbLabel, summary.medianLabel].filter(Boolean).join(' · ')}
          </Text>
          {groups.length > 0 ? (
            <View style={styles.segmentChipRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setGroup(null)}
                style={[styles.modeChip, group == null ? styles.modeChipSelected : null]}
              >
                <Text style={styles.modeChipText}>All</Text>
              </Pressable>
              {groups.map((item) => (
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  onPress={() => setGroup(group?.key === item.key ? null : item)}
                  style={[styles.modeChip, group?.key === item.key ? styles.modeChipSelected : null]}
                >
                  <Text style={styles.modeChipText}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.segmentChipRow}>
            {(['ranked', 'chronological'] as const).map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="button"
                onPress={() => setSort(mode)}
                style={[styles.modeChip, sort === mode ? styles.modeChipSelected : null]}
              >
                <Text style={styles.modeChipText}>{mode === 'ranked' ? 'Ranked' : 'Newest'}</Text>
              </Pressable>
            ))}
          </View>
          {summary.empty ? (
            <Text style={styles.mutedText}>
              No eligible results for this segment{group ? ' with this filter' : ''} yet.
              {result.status.needsRecalculation ? ' Recalculate segments to time past runs.' : ''}
            </Text>
          ) : (
            board.entries.map((entry) => (
              <Pressable
                key={entry.resultId}
                accessibilityRole="button"
                accessibilityLabel={`Open ${sourceLabel(entry.attemptKind)} ${formatElapsed(entry.durationMs)}`}
                onPress={() => onOpenAttempt(entry.attemptId, board.key)}
                style={styles.statRow}
              >
                <View>
                  <Text style={styles.statLabel}>
                    {formatOrdinal(entry.rank)}
                    {entry.isPb ? ' · PB' : entry.tiedWithPb ? ' · ties PB' : ''}
                  </Text>
                  <Text style={styles.sourceBadge}>
                    {sourceLabel(entry.attemptKind)} · {formatAttemptStamp(entry.endedAtMs)}
                  </Text>
                </View>
                <Text style={styles.statValue}>{formatElapsed(entry.durationMs)}</Text>
              </Pressable>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}
