import type { LatLng } from './geo';
import {
  describeGhostUnavailable,
  type GhostComparison,
  type GhostComparisonKnot,
  type GhostUnavailableReason,
} from './ghost-comparison';

/**
 * Chart/scrub join for ghost comparison.
 *
 * The rendered path is the time-ordered trustworthy `GhostComparison.knots`
 * polyline in (progress, delta) space. Pixel-width reduction may drop points
 * for performance, but it must not choose unique-first / one-y-per-x
 * comparison semantics. Scrub uses 2-D chart proximity on that same path.
 */

export const GHOST_CHART_SNAP_PX = 36;

export const GHOST_CHART_PLOT_INSETS = {
  leftPx: 44,
  rightPx: 12,
  topPx: 12,
  bottomPx: 24,
};

export type GhostChartVertex = {
  progressMeters: number;
  deltaMs: number;
  currentElapsedMs: number;
  referenceElapsedMs: number;
  coordinate: LatLng | null;
  knotKind: GhostComparisonKnot['knotKind'];
  source: GhostComparisonKnot['source'];
};

export type GhostChartPolyline = {
  vertices: GhostChartVertex[];
};

export type GhostChartPrepared = {
  available: boolean;
  polylines: GhostChartPolyline[];
  startProgressMeters: number;
  finishProgressMeters: number;
  minDeltaMs: number;
  maxDeltaMs: number;
  startDeltaMs: number | null;
  finishTriggerDeltaMs: number | null;
};

export type GhostChartLayout = {
  widthPx: number;
  heightPx: number;
  plotLeftPx: number;
  plotRightPx: number;
  plotTopPx: number;
  plotBottomPx: number;
};

export type GhostChartSelection = {
  progressMeters: number;
  deltaMs: number;
  currentElapsedMs: number;
  referenceElapsedMs: number;
  coordinate: LatLng | null;
};

export type GhostChartCopy = {
  sectionLabel: string;
  deltaLabel: string;
  unavailableMessage: string;
};

function knotToVertex(knot: GhostComparisonKnot): GhostChartVertex | null {
  if (
    knot.coverage !== 'trustworthy' ||
    knot.deltaMs == null ||
    knot.currentElapsedMs == null ||
    knot.referenceElapsedMs == null
  ) {
    return null;
  }
  return {
    progressMeters: knot.progressMeters,
    deltaMs: knot.deltaMs,
    currentElapsedMs: knot.currentElapsedMs,
    referenceElapsedMs: knot.referenceElapsedMs,
    coordinate: knot.coordinate,
    knotKind: knot.knotKind,
    source: knot.source,
  };
}

export function ghostComparisonPolylines(comparison: GhostComparison): GhostChartPolyline[] {
  if (!comparison.available) {
    return [];
  }
  const polylines: GhostChartPolyline[] = [];
  let current: GhostChartVertex[] = [];
  const flush = () => {
    if (current.length > 0) {
      polylines.push({ vertices: current });
      current = [];
    }
  };
  for (const knot of comparison.knots) {
    const vertex = knotToVertex(knot);
    if (!vertex) {
      flush();
      continue;
    }
    current.push(vertex);
  }
  flush();
  return polylines;
}

export function flattenGhostChartVertices(prepared: GhostChartPrepared): GhostChartVertex[] {
  return prepared.polylines.flatMap((polyline) => polyline.vertices);
}

/**
 * Pixel-column reduction that keeps time order and vertical wait extrema.
 *
 * Keeping only the first knot in each x column is forbidden: that recreates
 * unique-first semantics and flattens a 90 s vs 40 s stall to arrival.
 */
export function reduceGhostChartPolyline(
  vertices: GhostChartVertex[],
  startProgressMeters: number,
  finishProgressMeters: number,
  widthPx: number,
): GhostChartVertex[] {
  if (vertices.length <= 4) {
    return vertices;
  }
  const innerWidth = Math.max(1, Math.floor(widthPx));
  const span = Math.max(finishProgressMeters - startProgressMeters, 1e-6);
  const bucketOf = (progressMeters: number): number => {
    const t = (progressMeters - startProgressMeters) / span;
    const clamped = Math.min(1, Math.max(0, t));
    return Math.round(clamped * Math.max(innerWidth - 1, 0));
  };

  const kept: GhostChartVertex[] = [];
  const flush = (group: GhostChartVertex[]) => {
    if (group.length === 0) {
      return;
    }
    if (group.length <= 4) {
      kept.push(...group);
      return;
    }
    let minVertex = group[0]!;
    let maxVertex = group[0]!;
    for (const vertex of group) {
      if (vertex.deltaMs < minVertex.deltaMs) {
        minVertex = vertex;
      }
      if (vertex.deltaMs > maxVertex.deltaMs) {
        maxVertex = vertex;
      }
    }
    const selected = new Set<GhostChartVertex>([
      group[0]!,
      group[group.length - 1]!,
      minVertex,
      maxVertex,
    ]);
    for (const vertex of group) {
      if (vertex.knotKind === 'start' || vertex.knotKind === 'finish-trigger') {
        selected.add(vertex);
      }
    }
    for (const vertex of group) {
      if (selected.has(vertex)) {
        kept.push(vertex);
      }
    }
  };

  let bucket = bucketOf(vertices[0]!.progressMeters);
  let group: GhostChartVertex[] = [];
  for (const vertex of vertices) {
    const next = bucketOf(vertex.progressMeters);
    if (next !== bucket) {
      flush(group);
      group = [];
      bucket = next;
    }
    group.push(vertex);
  }
  flush(group);
  return kept;
}

export function prepareGhostChartSeries(
  comparison: GhostComparison,
  options: { widthPx: number },
): GhostChartPrepared {
  const polylines = ghostComparisonPolylines(comparison);
  const startProgressMeters =
    comparison.currentPolyline?.startProgressMeters ?? comparison.knots[0]?.progressMeters ?? 0;
  const finishProgressMeters =
    comparison.currentPolyline?.finishTriggerProgressMeters ??
    comparison.knots[comparison.knots.length - 1]?.progressMeters ??
    startProgressMeters;
  const widthPx = Math.max(1, Math.floor(options.widthPx));
  const reduced = polylines
    .map((polyline) => ({
      vertices: reduceGhostChartPolyline(
        polyline.vertices,
        startProgressMeters,
        finishProgressMeters,
        widthPx,
      ),
    }))
    .filter((polyline) => polyline.vertices.length > 0);

  let minDeltaMs = 0;
  let maxDeltaMs = 0;
  for (const polyline of reduced) {
    for (const vertex of polyline.vertices) {
      minDeltaMs = Math.min(minDeltaMs, vertex.deltaMs);
      maxDeltaMs = Math.max(maxDeltaMs, vertex.deltaMs);
    }
  }

  return {
    available: comparison.available && reduced.length > 0,
    polylines: reduced,
    startProgressMeters,
    finishProgressMeters,
    minDeltaMs,
    maxDeltaMs,
    startDeltaMs: comparison.startDeltaMs,
    finishTriggerDeltaMs: comparison.finishTriggerDeltaMs,
  };
}

export function ghostChartLayoutForSize(widthPx: number, heightPx: number): GhostChartLayout {
  return {
    widthPx,
    heightPx,
    plotLeftPx: GHOST_CHART_PLOT_INSETS.leftPx,
    plotRightPx: Math.max(GHOST_CHART_PLOT_INSETS.leftPx + 1, widthPx - GHOST_CHART_PLOT_INSETS.rightPx),
    plotTopPx: GHOST_CHART_PLOT_INSETS.topPx,
    plotBottomPx: Math.max(GHOST_CHART_PLOT_INSETS.topPx + 1, heightPx - GHOST_CHART_PLOT_INSETS.bottomPx),
  };
}

export function ghostChartPlotWidthPx(layout: GhostChartLayout): number {
  return Math.max(1, layout.plotRightPx - layout.plotLeftPx);
}

export function ghostChartYRange(prepared: GhostChartPrepared): { minDeltaMs: number; maxDeltaMs: number } {
  const rawMin = Math.min(0, prepared.minDeltaMs);
  const rawMax = Math.max(0, prepared.maxDeltaMs);
  const span = Math.max(rawMax - rawMin, 5_000);
  const pad = span * 0.12;
  return { minDeltaMs: rawMin - pad, maxDeltaMs: rawMax + pad };
}

export function projectGhostChartPoint(
  prepared: GhostChartPrepared,
  layout: GhostChartLayout,
  progressMeters: number,
  deltaMs: number,
): { x: number; y: number } {
  const { minDeltaMs, maxDeltaMs } = ghostChartYRange(prepared);
  const progressSpan = Math.max(prepared.finishProgressMeters - prepared.startProgressMeters, 1e-6);
  const deltaSpan = Math.max(maxDeltaMs - minDeltaMs, 1e-6);
  const plotWidth = Math.max(layout.plotRightPx - layout.plotLeftPx, 1);
  const plotHeight = Math.max(layout.plotBottomPx - layout.plotTopPx, 1);
  const t = (progressMeters - prepared.startProgressMeters) / progressSpan;
  const u = (maxDeltaMs - deltaMs) / deltaSpan;
  return {
    x: layout.plotLeftPx + t * plotWidth,
    y: layout.plotTopPx + u * plotHeight,
  };
}

function interpolateVertex(from: GhostChartVertex, to: GhostChartVertex, t: number): GhostChartSelection {
  const lerp = (start: number, end: number) => start + t * (end - start);
  const coordinate =
    from.coordinate && to.coordinate
      ? {
          latitude: lerp(from.coordinate.latitude, to.coordinate.latitude),
          longitude: lerp(from.coordinate.longitude, to.coordinate.longitude),
        }
      : (from.coordinate ?? to.coordinate);
  return {
    progressMeters: lerp(from.progressMeters, to.progressMeters),
    deltaMs: lerp(from.deltaMs, to.deltaMs),
    currentElapsedMs: lerp(from.currentElapsedMs, to.currentElapsedMs),
    referenceElapsedMs: lerp(from.referenceElapsedMs, to.referenceElapsedMs),
    coordinate,
  };
}

function closestOnSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): { t: number; dist: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const t =
    lengthSq <= 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby) / lengthSq));
  const x = ax + t * abx;
  const y = ay + t * aby;
  return { t, dist: Math.hypot(px - x, py - y) };
}

function selectionFromVertex(vertex: GhostChartVertex): GhostChartSelection {
  return {
    progressMeters: vertex.progressMeters,
    deltaMs: vertex.deltaMs,
    currentElapsedMs: vertex.currentElapsedMs,
    referenceElapsedMs: vertex.referenceElapsedMs,
    coordinate: vertex.coordinate,
  };
}

export function selectGhostChartPoint(
  prepared: GhostChartPrepared,
  layout: GhostChartLayout,
  chartX: number,
  chartY: number,
  options?: { maxDistancePx?: number },
): GhostChartSelection | null {
  if (!prepared.available) {
    return null;
  }
  const maxDistancePx = options?.maxDistancePx ?? GHOST_CHART_SNAP_PX;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestPolylineIndex = Number.MAX_SAFE_INTEGER;
  let bestSegmentIndex = Number.MAX_SAFE_INTEGER;
  let bestSelection: GhostChartSelection | null = null;

  const consider = (
    dist: number,
    polylineIndex: number,
    segmentIndex: number,
    selection: GhostChartSelection,
  ) => {
    const better =
      dist < bestDist - 1e-9 ||
      (Math.abs(dist - bestDist) <= 1e-9 &&
        (polylineIndex < bestPolylineIndex ||
          (polylineIndex === bestPolylineIndex && segmentIndex < bestSegmentIndex)));
    if (!better) {
      return;
    }
    bestDist = dist;
    bestPolylineIndex = polylineIndex;
    bestSegmentIndex = segmentIndex;
    bestSelection = selection;
  };

  for (let polylineIndex = 0; polylineIndex < prepared.polylines.length; polylineIndex += 1) {
    const vertices = prepared.polylines[polylineIndex]?.vertices ?? [];
    if (vertices.length === 1) {
      const vertex = vertices[0]!;
      const projected = projectGhostChartPoint(prepared, layout, vertex.progressMeters, vertex.deltaMs);
      consider(Math.hypot(chartX - projected.x, chartY - projected.y), polylineIndex, 0, selectionFromVertex(vertex));
      continue;
    }
    for (let index = 1; index < vertices.length; index += 1) {
      const from = vertices[index - 1]!;
      const to = vertices[index]!;
      const start = projectGhostChartPoint(prepared, layout, from.progressMeters, from.deltaMs);
      const end = projectGhostChartPoint(prepared, layout, to.progressMeters, to.deltaMs);
      const hit = closestOnSegment(start.x, start.y, end.x, end.y, chartX, chartY);
      consider(hit.dist, polylineIndex, index, interpolateVertex(from, to, hit.t));
    }
  }

  if (!bestSelection || bestDist > maxDistancePx) {
    return null;
  }
  return bestSelection;
}

export function ghostChartCopy(input: {
  available: boolean;
  unavailableReason: GhostUnavailableReason | null;
  isCurrentPb: boolean;
}): GhostChartCopy {
  const vsPrevious = input.isCurrentPb;
  if (input.unavailableReason === 'missing_comparison_target' && vsPrevious) {
    return {
      sectionLabel: 'GHOST VS PREVIOUS PB',
      deltaLabel: 'Delta vs previous PB',
      unavailableMessage: 'No previous PB to compare against.',
    };
  }
  return {
    sectionLabel: vsPrevious ? 'GHOST VS PREVIOUS PB' : 'GHOST VS PB',
    deltaLabel: vsPrevious ? 'Delta vs previous PB' : 'Delta vs PB',
    unavailableMessage: input.unavailableReason
      ? describeGhostUnavailable(input.unavailableReason)
      : 'Ghost comparison is unavailable.',
  };
}
