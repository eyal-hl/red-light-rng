import {
  rankDelayHotspots,
  type DelayHotspot,
  type DelayHotspotAnalysis,
  type DelayHotspotOrder,
} from './delay-hotspots';
import type { LatLng } from './geo';

/*
 * Journey delay heatmap preparation (pure, deterministic).
 *
 * The heat layer is a presentation of #74's `DelayHotspotAnalysis` and nothing else: no
 * separate grid, no re-clustering, no GPS sample density, no extra reads. One heat feature
 * per recurring hotspot, placed at `hotspot.coordinate`. One-off waits and unlocated waits
 * create no heat. Confirmed waiting is observed stopped time, never time lost versus a PB.
 * The result is a pure function of (analysis, mode), so recompute yields identical output
 * and it invalidates exactly when the cached hotspot analysis object changes.
 */

/** Heat intensity meaning. `frequency` = waitedAttempts; `total` = totalWaitMs. */
export type DelayHeatMode = 'frequency' | 'total';

/** Fewer analyzed attempts than this never render heat (one run is not a pattern). */
export const HEAT_MIN_ANALYZED_ATTEMPTS = 2;

/** Render at most this many heat features (top by the selected mode). */
export const HEAT_MAX_FEATURES = 50;

/**
 * Scaling reference percentile. Intensity = min(1, value / P90 of that mode's raw values
 * over ALL recurring hotspots), so one extreme wait saturates at 1 instead of flattening
 * the rest. Nearest-rank method: sort ascending, take index ceil(0.9 * n) - 1. The
 * reference is computed before the render cap, so capping never changes intensities.
 */
export const HEAT_CLAMP_PERCENTILE = 0.9;

/** Minimum heat footprint radius, meters (hotspot spread is only a few meters). */
export const HEAT_MIN_RADIUS_METERS = 25;

export type DelayHeatFeature = {
  hotspotId: string;
  coordinate: LatLng;
  /** Mode value after the documented clamp, 0..1. */
  intensity: number;
  /** Footprint radius, meters: max(HEAT_MIN_RADIUS_METERS, spreadMeters). */
  radiusMeters: number;
  /** Unscaled mode value (attempts for `frequency`, ms for `total`). */
  rawValue: number;
  /** Raw hotspot values for the tap summary, unchanged by scaling. */
  waitedAttempts: number;
  encounteredAttempts: number;
  medianWaitMs: number;
  totalWaitMs: number;
};

export type DelayHeatPreparation = {
  mode: DelayHeatMode;
  features: DelayHeatFeature[];
  /** Recurring hotspots available before the render cap. */
  recurringCount: number;
  capped: boolean;
  /** The raw value that maps to intensity 1 (the P90 reference). */
  scaleReference: number;
  oneOffWaitMs: number;
  unlocatedWaitMs: number;
};

export type DelayHeatViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'not-enough-history'; analyzedAttemptCount: number }
  | { kind: 'ready'; heat: DelayHeatPreparation };

export function heatRawValue(hotspot: DelayHotspot, mode: DelayHeatMode): number {
  return mode === 'frequency' ? hotspot.waitedAttempts : hotspot.totalWaitMs;
}

/** Nearest-rank percentile over a non-empty list; 0 for an empty list. */
export function nearestRankPercentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

/**
 * Deterministic clamp to 0..1. All-equal and single-value inputs saturate at 1 (the
 * reference equals the value); a non-positive reference gives 1 for positive values and
 * 0 otherwise rather than dividing by zero.
 */
export function clampHeatIntensity(value: number, reference: number): number {
  if (!(value > 0)) {
    return 0;
  }
  if (!(reference > 0)) {
    return 1;
  }
  return Math.min(1, value / reference);
}

export function hasEnoughHeatHistory(analysis: DelayHotspotAnalysis): boolean {
  return (
    analysis.totals.analyzedAttemptCount >= HEAT_MIN_ANALYZED_ATTEMPTS && analysis.hotspots.length > 0
  );
}

/** Returns null when there is not enough history; never produces heat from one attempt. */
export function prepareDelayHeat(
  analysis: DelayHotspotAnalysis,
  mode: DelayHeatMode,
): DelayHeatPreparation | null {
  if (!hasEnoughHeatHistory(analysis)) {
    return null;
  }
  const hotspots = analysis.hotspots;
  const reference = nearestRankPercentile(
    hotspots.map((hotspot) => heatRawValue(hotspot, mode)),
    HEAT_CLAMP_PERCENTILE,
  );
  const order: DelayHotspotOrder = mode === 'frequency' ? 'frequency' : 'total';
  // Stable sort: ties on the raw value keep the existing #74 ranking (id is its last key).
  const ranked = rankDelayHotspots(hotspots, order).sort(
    (a, b) => heatRawValue(b, mode) - heatRawValue(a, mode),
  );
  const features = ranked.slice(0, HEAT_MAX_FEATURES).map((hotspot): DelayHeatFeature => {
    const rawValue = heatRawValue(hotspot, mode);
    return {
      hotspotId: hotspot.id,
      coordinate: hotspot.coordinate,
      intensity: clampHeatIntensity(rawValue, reference),
      radiusMeters: Math.max(HEAT_MIN_RADIUS_METERS, hotspot.spreadMeters),
      rawValue,
      waitedAttempts: hotspot.waitedAttempts,
      encounteredAttempts: hotspot.encounteredAttempts,
      medianWaitMs: hotspot.medianWaitMs,
      totalWaitMs: hotspot.totalWaitMs,
    };
  });
  return {
    mode,
    features,
    recurringCount: hotspots.length,
    capped: hotspots.length > features.length,
    scaleReference: reference,
    oneOffWaitMs: analysis.totals.oneOffWaitMs,
    unlocatedWaitMs: analysis.totals.unlocatedWaitMs,
  };
}

/** Loading is never reported as "not enough history". */
export function delayHeatViewState(
  hotspotsStatus: 'idle' | 'loading' | 'ready' | 'error',
  analysis: DelayHotspotAnalysis | null,
  mode: DelayHeatMode,
): DelayHeatViewState {
  if (hotspotsStatus === 'idle' || hotspotsStatus === 'loading') {
    return { kind: 'loading' };
  }
  if (hotspotsStatus === 'error' || !analysis) {
    return { kind: 'unavailable' };
  }
  const heat = prepareDelayHeat(analysis, mode);
  return heat
    ? { kind: 'ready', heat }
    : { kind: 'not-enough-history', analyzedAttemptCount: analysis.totals.analyzedAttemptCount };
}

export function heatLegendText(mode: DelayHeatMode): string {
  return mode === 'frequency'
    ? 'Frequency: brighter means more attempts had confirmed waiting at this spot.'
    : 'Total waiting: brighter means more confirmed waiting added up across attempts at this spot.';
}
