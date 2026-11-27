import type { CompetitiveCheckpoint, CompetitiveCheckpointPool } from './competitive-checkpoint';
import { haversineMeters, type LatLng } from './geo';
import type { Place } from './place';
import { expectedFullSegmentPairs, expectedPartialSegmentPairs, segmentKey } from './segment-derivation';

/**
 * Start options for a journey with competitive checkpoints (#81). "Full route" is the existing
 * START flow (origin detected automatically); "Start at <checkpoint>" arms a partial attempt for
 * that checkpoint. Pure: suggestion and board preview only; arming lives in the runtime.
 */

/** A suggestion needs the rider to be within this distance of the checkpoint's edge. */
export const START_SUGGESTION_MAX_EDGE_DISTANCE_METERS = 75;

export type StartSelection = { kind: 'full' } | { kind: 'checkpoint'; checkpointId: string };

export const FULL_ROUTE_START: StartSelection = { kind: 'full' };

function edgeDistance(position: LatLng, center: LatLng, radiusMeters: number): number {
  return Math.max(0, haversineMeters(position, center) - radiusMeters);
}

/**
 * Location-aware suggestion. Unknown location, or being nearer the origin Place (or no checkpoint
 * within range) suggests the full route; otherwise the checkpoint whose edge is nearest. The user can
 * always override it. Ties go to the earlier checkpoint in route order.
 */
export function suggestStartSelection(input: {
  position: LatLng | null;
  origin: Pick<Place, 'center' | 'departureRadiusMeters'>;
  checkpoints: readonly CompetitiveCheckpoint[];
}): StartSelection {
  const { position } = input;
  if (!position || input.checkpoints.length === 0) {
    return FULL_ROUTE_START;
  }
  const originEdge = edgeDistance(position, input.origin.center, input.origin.departureRadiusMeters);
  let best: { id: string; edge: number } | null = null;
  for (const item of input.checkpoints) {
    const edge = edgeDistance(position, item.center, item.radiusMeters);
    if (!best || edge < best.edge) {
      best = { id: item.id, edge };
    }
  }
  if (!best || best.edge > START_SUGGESTION_MAX_EDGE_DISTANCE_METERS || originEdge <= best.edge) {
    return FULL_ROUTE_START;
  }
  return { kind: 'checkpoint', checkpointId: best.id };
}

export function sameStartSelection(a: StartSelection, b: StartSelection): boolean {
  return a.kind === b.kind && (a.kind === 'full' || (b.kind === 'checkpoint' && a.checkpointId === b.checkpointId));
}

export type StartBoardPreviewRow = { key: string; label: string };

/** The segment boards a run with this start would qualify for (full: A->B, B->C, ...; partial: from the checkpoint on). */
export function startBoardPreview(input: {
  selection: StartSelection;
  checkpoints: readonly CompetitiveCheckpoint[];
  originName: string;
  destinationName: string;
}): StartBoardPreviewRow[] {
  const ids = input.checkpoints.map((item) => item.id);
  const names = new Map(input.checkpoints.map((item) => [item.id, item.name]));
  const label = (id: string | null, fallback: string) => (id == null ? fallback : (names.get(id) ?? id));
  let pairs: { from: string | null; to: string | null }[];
  if (input.selection.kind === 'full') {
    pairs = expectedFullSegmentPairs(ids);
  } else {
    const index = ids.indexOf(input.selection.checkpointId);
    pairs = index < 0 ? [] : expectedPartialSegmentPairs(ids, index);
  }
  return pairs.map(({ from, to }) => ({
    key: segmentKey(from, to),
    label: `${label(from, input.originName)} → ${label(to, input.destinationName)}`,
  }));
}

export type StartOptionsJourney = {
  pool: CompetitiveCheckpointPool;
  originName: string;
  destinationName: string;
  origin: Pick<Place, 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters'>;
  destination: Pick<Place, 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters'>;
  configVersion: number;
  checkpoints: CompetitiveCheckpoint[];
};

/** The journey whose origin or checkpoint is nearest the position, for the Home start panel default. */
export function nearestStartJourney(
  position: LatLng | null,
  journeys: readonly StartOptionsJourney[],
): StartOptionsJourney | null {
  if (journeys.length === 0) {
    return null;
  }
  if (!position) {
    return journeys[0]!;
  }
  let best = journeys[0]!;
  let bestEdge = Number.POSITIVE_INFINITY;
  for (const journey of journeys) {
    const edges = [
      edgeDistance(position, journey.origin.center, journey.origin.departureRadiusMeters),
      ...journey.checkpoints.map((item) => edgeDistance(position, item.center, item.radiusMeters)),
    ];
    const edge = Math.min(...edges);
    if (edge < bestEdge) {
      best = journey;
      bestEdge = edge;
    }
  }
  return best;
}
