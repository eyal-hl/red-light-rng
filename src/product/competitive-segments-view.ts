import type { Attempt } from '../domain/attempt';
import {
  validateCompetitiveCheckpoints,
  DEFAULT_COMPETITIVE_CHECKPOINT_RADIUS_METERS,
  type CompetitiveCheckpoint,
  type CompetitiveCheckpointConfig,
  type CompetitiveCheckpointIssue,
} from '../domain/competitive-checkpoint';
import { haversineMeters, type LatLng } from '../domain/geo';
import type { LocationSample } from '../domain/location-sample';
import type { Place } from '../domain/place';
import {
  expectedFullSegmentPairs,
  segmentKey,
  type AttemptSegmentResult,
  type SegmentUnavailableReason,
} from '../domain/segment-derivation';
import type { PotentialRecordResult } from '../domain/potential-record';
import type { SegmentBoard, SegmentBoardEntry } from '../domain/segment-leaderboard';

/**
 * Pure view-model builders for the competitive checkpoint UI (#81 stage 3): the checkpoint editor,
 * the segment selector / board rows, the post-run segment section and the map highlight. No React,
 * no storage, no platform code, so every rule here is unit-tested.
 */

/** The segment selector's default: the original full-route board, i.e. the existing screens unchanged. */
export const FULL_ROUTE_SELECTION = 'full';

// ---------------------------------------------------------------------------------------------
// Checkpoint editor (ordered list operations)
// ---------------------------------------------------------------------------------------------

export function editorItemsFromConfig(config: CompetitiveCheckpointConfig | null): CompetitiveCheckpoint[] {
  return (config?.checkpoints ?? []).map((item) => ({ ...item, center: { ...item.center } }));
}

/** Route order is origin -> destination, so a new checkpoint is inserted by distance from the origin. */
export function insertIndexByDistance(
  items: readonly CompetitiveCheckpoint[],
  point: LatLng,
  origin: Pick<Place, 'center'>,
): number {
  const distance = haversineMeters(origin.center, point);
  const index = items.findIndex((item) => haversineMeters(origin.center, item.center) > distance);
  return index < 0 ? items.length : index;
}

export function nextCheckpointName(items: readonly CompetitiveCheckpoint[]): string {
  const used = new Set(items.map((item) => item.name.trim().toLowerCase()));
  for (let n = items.length + 1; n < items.length + 50; n += 1) {
    const name = `Checkpoint ${n}`;
    if (!used.has(name.toLowerCase())) {
      return name;
    }
  }
  return `Checkpoint ${items.length + 1}`;
}

export function addCheckpoint(
  items: readonly CompetitiveCheckpoint[],
  point: LatLng,
  origin: Pick<Place, 'center'>,
  createId: () => string,
  radiusMeters: number = DEFAULT_COMPETITIVE_CHECKPOINT_RADIUS_METERS,
): CompetitiveCheckpoint[] {
  const next = [...items];
  next.splice(insertIndexByDistance(items, point, origin), 0, {
    id: createId(),
    name: nextCheckpointName(items),
    center: { latitude: point.latitude, longitude: point.longitude },
    radiusMeters,
  });
  return next;
}

export function renameCheckpoint(items: readonly CompetitiveCheckpoint[], id: string, name: string) {
  return items.map((item) => (item.id === id ? { ...item, name } : item));
}

export function setCheckpointRadius(items: readonly CompetitiveCheckpoint[], id: string, radiusMeters: number) {
  return items.map((item) => (item.id === id ? { ...item, radiusMeters } : item));
}

export function setCheckpointCenter(items: readonly CompetitiveCheckpoint[], id: string, center: LatLng) {
  return items.map((item) =>
    item.id === id ? { ...item, center: { latitude: center.latitude, longitude: center.longitude } } : item,
  );
}

export function moveCheckpoint(
  items: readonly CompetitiveCheckpoint[],
  id: string,
  direction: 'up' | 'down',
): CompetitiveCheckpoint[] {
  const index = items.findIndex((item) => item.id === id);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= items.length) {
    return [...items];
  }
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function deleteCheckpoint(items: readonly CompetitiveCheckpoint[], id: string) {
  return items.filter((item) => item.id !== id);
}

export function sameCheckpointItems(a: readonly CompetitiveCheckpoint[], b: readonly CompetitiveCheckpoint[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]!;
      return (
        item.id === other.id &&
        item.name === other.name &&
        item.radiusMeters === other.radiusMeters &&
        item.center.latitude === other.center.latitude &&
        item.center.longitude === other.center.longitude
      );
    })
  );
}

export type SegmentPreviewRow = {
  key: string;
  label: string;
  kind: 'prefix' | 'adjacent' | 'suffix';
};

/** The boards a full ride through the draft checkpoints would qualify for (official start->finish excluded). */
export function segmentPreview(
  items: readonly CompetitiveCheckpoint[],
  originName: string,
  destinationName: string,
): SegmentPreviewRow[] {
  const names = new Map(items.map((item) => [item.id, item.name.trim() || 'Checkpoint']));
  const label = (id: string | null, fallback: string) => (id == null ? fallback : (names.get(id) ?? id));
  return expectedFullSegmentPairs(items.map((item) => item.id)).map(({ from, to }) => ({
    key: segmentKey(from, to),
    label: `${label(from, originName)} → ${label(to, destinationName)}`,
    kind: from == null ? 'prefix' : to == null ? 'suffix' : 'adjacent',
  }));
}

export type CheckpointEditorView = {
  editable: boolean;
  /** Why editing is disabled (open run / recalculation job), shown verbatim. */
  lockReason: string | null;
  issues: CompetitiveCheckpointIssue[];
  changed: boolean;
  canSave: boolean;
  /** Impact warning to confirm before saving, or null when nothing existing is affected. */
  impactWarning: string | null;
};

export const CHECKPOINT_IMPACT_WARNING =
  'Saving changes the checkpoints. Existing segment results for this journey become stale and will not be shown until you run Recalculate segments. Your official run times, personal bests and full-route rankings are not changed.';
export const CHECKPOINT_NO_IMPACT_NOTE =
  'No run has segment results for this journey yet. Saving does not change any official time; use Recalculate segments afterwards to time past runs.';

export function checkpointEditorView(input: {
  current: CompetitiveCheckpointConfig | null;
  draft: readonly CompetitiveCheckpoint[];
  places: readonly Place[];
  lockReason: string | null;
  /** Number of runs that currently have valid segment results (stale once the config changes). */
  runsWithResults: number;
}): CheckpointEditorView {
  const issues = validateCompetitiveCheckpoints(input.draft, input.places);
  const changed = !sameCheckpointItems(editorItemsFromConfig(input.current), input.draft);
  const editable = input.lockReason == null;
  return {
    editable,
    lockReason: input.lockReason,
    issues,
    changed,
    canSave: editable && changed && issues.length === 0,
    impactWarning:
      changed && input.current != null && input.runsWithResults > 0 ? CHECKPOINT_IMPACT_WARNING : null,
  };
}

/** Closed ring polyline for a checkpoint radius, drawn through the map's existing line layer. */
export function checkpointRing(center: LatLng, radiusMeters: number, steps = 32): LatLng[] {
  const latMeters = 111_320;
  const lngMeters = Math.max(1e-6, 111_320 * Math.cos((center.latitude * Math.PI) / 180));
  const ring: LatLng[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    ring.push({
      latitude: center.latitude + (radiusMeters * Math.sin(angle)) / latMeters,
      longitude: center.longitude + (radiusMeters * Math.cos(angle)) / lngMeters,
    });
  }
  return ring;
}

// ---------------------------------------------------------------------------------------------
// Segment selector and board rows
// ---------------------------------------------------------------------------------------------

export type SegmentSelectorOption = { key: string; label: string; count: number | null };

/** Full route first (the default); then one option per segment that has at least one result. */
export function segmentSelectorOptions(boards: readonly SegmentBoard[]): SegmentSelectorOption[] {
  return [
    { key: FULL_ROUTE_SELECTION, label: 'Full route', count: null },
    ...boards.map((board) => ({
      key: board.key,
      label: `${board.fromName} → ${board.toName}`,
      count: board.validCount,
    })),
  ];
}

/** An unknown or vanished selection (e.g. after a config change) falls back to the full route. */
export function resolveSegmentSelection(selection: string, boards: readonly SegmentBoard[]): string {
  return selection !== FULL_ROUTE_SELECTION && boards.some((board) => board.key === selection)
    ? selection
    : FULL_ROUTE_SELECTION;
}

export function sourceLabel(kind: 'full' | 'partial'): string {
  return kind === 'partial' ? 'PARTIAL START' : 'FULL RUN';
}

export type SegmentBoardSummary = {
  title: string;
  countLabel: string;
  pbLabel: string | null;
  medianLabel: string | null;
  empty: boolean;
};

export function segmentBoardSummary(board: SegmentBoard, formatMs: (ms: number) => string): SegmentBoardSummary {
  return {
    title: `${board.fromName} → ${board.toName}`,
    countLabel: `${board.validCount} eligible run${board.validCount === 1 ? '' : 's'}`,
    pbLabel: board.pb ? `PB ${formatMs(board.pb.durationMs)}` : null,
    medianLabel: board.medianMs != null ? `Median ${formatMs(board.medianMs)}` : null,
    empty: board.validCount === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Post-run (and attempt detail) segment section
// ---------------------------------------------------------------------------------------------

export type AttemptSegmentsState =
  /** The journey has no competitive checkpoints: nothing is shown. */
  | 'unconfigured'
  /** Not a completed official result (DNF, cancelled): no segments, by policy. */
  | 'not_applicable'
  /** Checkpoints exist but this run has no results for the CURRENT version: needs Recalculate segments. */
  | 'stale'
  /** Just finished; results are being derived. */
  | 'pending'
  | 'ready';

export type PbStatus = 'new_pb' | 'ties_pb' | 'first_result' | null;

export type AttemptSegmentRow = {
  key: string;
  label: string;
  status: 'valid' | 'unavailable';
  durationMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  reason: string | null;
  rank: number | null;
  eligibleCount: number;
  pbMs: number | null;
  pbStatus: PbStatus;
};

export type AttemptSegmentsView = {
  state: AttemptSegmentsState;
  message: string | null;
  attemptKind: 'full' | 'partial';
  startCheckpointName: string | null;
  rows: AttemptSegmentRow[];
};

export const SEGMENT_UNAVAILABLE_LABELS: Record<SegmentUnavailableReason, string> = {
  not_reached: 'The checkpoint was not reached on this run.',
  out_of_order: 'Checkpoints were passed out of order.',
  no_arrival_margin: 'The run never moved clear of the checkpoint before reaching it.',
  gap_too_large: 'GPS gap too long to time this crossing.',
  wrong_direction: 'The checkpoint was passed in the wrong direction.',
  departure_unconfirmed: 'Leaving the checkpoint could not be confirmed.',
  missing_telemetry: 'No GPS data for this run.',
  geometry_invalid: 'The checkpoint overlaps a place.',
  non_positive_duration: 'The boundary times are not in order.',
  before_start_checkpoint: 'Starts before this run began.',
};

export function unavailableReasonLabel(reason: string | null): string {
  if (reason == null) {
    return 'Unavailable.';
  }
  return SEGMENT_UNAVAILABLE_LABELS[reason as SegmentUnavailableReason] ?? 'Unavailable.';
}

export const SEGMENTS_STALE_MESSAGE =
  'Segment times for this run are out of date after a checkpoint change. Run Recalculate segments in Checkpoints & segments.';
export const SEGMENTS_PENDING_MESSAGE = 'Calculating segment times…';
export const SEGMENTS_NOT_APPLICABLE_MESSAGE =
  'Only completed official runs have segment times.';
export const SEGMENTS_NONE_MESSAGE = 'No segment times could be derived for this run.';

function pbStatusFor(entry: SegmentBoardEntry, board: SegmentBoard): PbStatus {
  const earlier = board.entries.filter((other) => other.attemptId !== entry.attemptId && other.endedAtMs < entry.endedAtMs);
  if (earlier.length === 0) {
    return 'first_result';
  }
  const best = Math.min(...earlier.map((other) => other.durationMs));
  if (entry.durationMs < best) {
    return 'new_pb';
  }
  return entry.durationMs === best ? 'ties_pb' : null;
}

export function pbStatusLabel(status: PbStatus): string | null {
  switch (status) {
    case 'new_pb':
      return 'NEW SEGMENT PB';
    case 'ties_pb':
      return 'TIES PB';
    case 'first_result':
      return 'FIRST TIME';
    default:
      return null;
  }
}

export function buildAttemptSegmentsView(input: {
  attempt: Attempt;
  config: CompetitiveCheckpointConfig | null;
  /** The attempt's rows for the current configuration version (empty when none). */
  results: readonly AttemptSegmentResult[];
  /** Unfiltered boards of the pool's current configuration. */
  boards: readonly SegmentBoard[];
  /** True while a post-run derivation is still expected. */
  derivationPending?: boolean;
  eligible: boolean;
}): AttemptSegmentsView {
  const { attempt, config } = input;
  const attemptKind = attempt.kind === 'partial' ? 'partial' : 'full';
  const startCheckpointName =
    attemptKind === 'partial'
      ? (config?.checkpoints.find((item) => item.id === attempt.startCheckpointId)?.name ?? null)
      : null;
  const base = { attemptKind, startCheckpointName } as const;
  if (!config || config.checkpoints.length === 0) {
    return { ...base, state: 'unconfigured', message: null, rows: [] };
  }
  if (!input.eligible) {
    return { ...base, state: 'not_applicable', message: SEGMENTS_NOT_APPLICABLE_MESSAGE, rows: [] };
  }
  if (input.results.length === 0) {
    return input.derivationPending
      ? { ...base, state: 'pending', message: SEGMENTS_PENDING_MESSAGE, rows: [] }
      : { ...base, state: 'stale', message: SEGMENTS_STALE_MESSAGE, rows: [] };
  }
  const boardsByKey = new Map(input.boards.map((board) => [board.key, board]));
  const rows: AttemptSegmentRow[] = [...input.results]
    .map((result): AttemptSegmentRow => {
      const key = segmentKey(result.fromCheckpointId, result.toCheckpointId);
      const board = boardsByKey.get(key);
      const entry = board?.entries.find((item) => item.attemptId === attempt.id) ?? null;
      return {
        key,
        label: board ? `${board.fromName} → ${board.toName}` : key,
        status: result.status,
        durationMs: result.durationMs,
        startedAtMs: result.startedAtMs,
        endedAtMs: result.endedAtMs,
        reason: result.status === 'unavailable' ? unavailableReasonLabel(result.unavailableReason) : null,
        rank: entry?.rank ?? null,
        eligibleCount: board?.validCount ?? 0,
        pbMs: board?.pb?.durationMs ?? null,
        pbStatus: entry && board ? pbStatusFor(entry, board) : null,
      };
    })
    .sort((a, b) => boardOrder(input.boards, a.key) - boardOrder(input.boards, b.key));
  const anyValid = rows.some((row) => row.status === 'valid');
  return {
    ...base,
    state: 'ready',
    message: anyValid ? null : SEGMENTS_NONE_MESSAGE,
    rows,
  };
}

function boardOrder(boards: readonly SegmentBoard[], key: string): number {
  const index = boards.findIndex((board) => board.key === key);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/** Trace points of the time window `[startMs, endMs]`, for highlighting one segment on the attempt map. */
export function segmentHighlightPath(
  samples: readonly Pick<LocationSample, 'recordedAtMs' | 'latitude' | 'longitude'>[],
  startMs: number | null,
  endMs: number | null,
): LatLng[] {
  if (startMs == null || endMs == null || !(endMs > startMs)) {
    return [];
  }
  return samples
    .filter((sample) => sample.recordedAtMs >= startMs && sample.recordedAtMs <= endMs)
    .map((sample) => ({ latitude: sample.latitude, longitude: sample.longitude }));
}

// ---------------------------------------------------------------------------------------------
// Partial attempts in history
// ---------------------------------------------------------------------------------------------

export type PartialRunRow = {
  attemptId: string;
  armedAtMs: number;
  finishedAtMs: number | null;
  /** Official time of a completed partial; null for a partial DNF (a labeled non-result). */
  officialTimeMs: number | null;
  label: string;
  startCheckpointName: string | null;
  hidden: boolean;
};

/** Partial attempts for the history list; never ranked, never part of full-route statistics. */
export function partialRunRows(
  attempts: readonly Attempt[],
  checkpointName: (attempt: Attempt) => string | null,
): PartialRunRow[] {
  return attempts
    .filter((attempt) => attempt.kind === 'partial' && !(attempt.lifecycle === 'ended' && attempt.hiddenIncomplete === true))
    .filter((attempt) => attempt.lifecycle === 'completed' || attempt.lifecycle === 'ended')
    .map((attempt) => {
      const done = attempt.lifecycle === 'completed' && attempt.validity === 'valid';
      const started = attempt.startedAtMs != null;
      return {
        attemptId: attempt.id,
        armedAtMs: attempt.armedAtMs,
        finishedAtMs: attempt.finishedAtMs,
        officialTimeMs:
          done && attempt.startedAtMs != null && attempt.finishedAtMs != null
            ? Math.max(0, attempt.finishedAtMs - attempt.startedAtMs)
            : null,
        label: done ? 'PARTIAL' : started ? 'PARTIAL DID NOT FINISH' : 'PARTIAL DID NOT START',
        startCheckpointName: checkpointName(attempt),
        hidden: false,
      };
    })
    .sort((a, b) => (b.finishedAtMs ?? b.armedAtMs) - (a.finishedAtMs ?? a.armedAtMs) || b.attemptId.localeCompare(a.attemptId));
}

// ---------------------------------------------------------------------------------------------
// Segments recalculation panel
// ---------------------------------------------------------------------------------------------

export type SegmentRecalcSummary = {
  headline: string;
  offerRecalculate: boolean;
  staleLabel: string | null;
};

export function segmentRecalcSummary(status: {
  config: CompetitiveCheckpointConfig | null;
  eligibleAttemptCount: number;
  staleAttemptCount: number;
  needsRecalculation: boolean;
}): SegmentRecalcSummary {
  if (!status.config || status.config.checkpoints.length === 0) {
    return { headline: 'Add checkpoints to time segments of past and future runs.', offerRecalculate: false, staleLabel: null };
  }
  if (status.eligibleAttemptCount === 0) {
    return { headline: 'No completed runs on this journey yet.', offerRecalculate: false, staleLabel: null };
  }
  if (!status.needsRecalculation) {
    return {
      headline: `Segment times are up to date for ${status.eligibleAttemptCount} run${status.eligibleAttemptCount === 1 ? '' : 's'}.`,
      offerRecalculate: false,
      staleLabel: null,
    };
  }
  return {
    headline: 'Past runs have no segment times for the current checkpoints yet.',
    offerRecalculate: true,
    staleLabel: `${status.staleAttemptCount} of ${status.eligibleAttemptCount} run${status.eligibleAttemptCount === 1 ? ' needs' : 's need'} recalculation`,
  };
}

// ---------------------------------------------------------------------------------------------
// Potential full-route record (hypothetical, display only)
// ---------------------------------------------------------------------------------------------

export const POTENTIAL_RECORD_DISCLAIMER =
  'Hypothetical estimate, not an official result and not guaranteed. Nothing here is saved or counted in rankings, personal bests or statistics.';
export const POTENTIAL_NOT_APPLICABLE_MESSAGE = 'A potential full-route record is only shown for completed checkpoint-start runs.';
export const POTENTIAL_CONFIG_CHANGED_MESSAGE =
  'The checkpoints changed since this run, so earlier full runs are not comparable and no estimate is shown.';

export type PotentialRowTone = 'record' | 'tie' | 'slower' | 'neutral' | 'unavailable';

export type PotentialRow = {
  kind: 'best_case' | 'typical';
  title: string;
  /** Total hypothetical full-route time, or null without an estimate. */
  totalMs: number | null;
  detail: string;
  tone: PotentialRowTone;
};

export function describePotentialRecord(
  result: PotentialRecordResult,
  checkpointName: string,
  formatMs: (ms: number) => string,
): { rows: PotentialRow[]; pbLine: string; sampleLine: string } {
  const pbLine =
    result.fullPbMs == null ? 'No full-route PB yet to compare with.' : `Actual full-route PB ${formatMs(result.fullPbMs)}`;
  const sampleLine =
    result.sampleCount === 0
      ? `No full runs with a timed start → ${checkpointName} yet.`
      : `${result.sampleCount} full run${result.sampleCount === 1 ? '' : 's'} with a timed start → ${checkpointName}.`;
  const row = (slot: PotentialRecordResult['best'], kind: PotentialRow['kind'], title: string): PotentialRow => {
    if (slot.status === 'insufficient') {
      return {
        kind,
        title,
        totalMs: null,
        tone: 'unavailable',
        detail: `No estimate: needs at least ${slot.required} full run${slot.required === 1 ? '' : 's'} with a timed start → ${checkpointName} (have ${slot.sampleCount}).`,
      };
    }
    const { estimate } = slot;
    const parts = `${formatMs(estimate.prefixMs)} to ${checkpointName} + ${formatMs(estimate.suffixMs)} (this run), ${estimate.sampleCount} sample${estimate.sampleCount === 1 ? '' : 's'}`;
    switch (estimate.comparison.kind) {
      case 'potential_record':
        return { kind, title, totalMs: estimate.totalMs, tone: 'record', detail: `${parts}. ${formatMs(estimate.comparison.fasterByMs)} faster than your PB: a potential record, not awarded.` };
      case 'tie':
        return { kind, title, totalMs: estimate.totalMs, tone: 'tie', detail: `${parts}. Ties your full-route PB.` };
      case 'slower':
        return { kind, title, totalMs: estimate.totalMs, tone: 'slower', detail: `${parts}. ${formatMs(estimate.comparison.slowerByMs)} slower than your PB.` };
      default:
        return { kind, title, totalMs: estimate.totalMs, tone: 'neutral', detail: `${parts}. No full-route PB to compare with yet.` };
    }
  };
  return {
    pbLine,
    sampleLine,
    rows: [row(result.best, 'best_case', 'Best case (optimistic)'), row(result.typical, 'typical', 'Typical (median)')],
  };
}
