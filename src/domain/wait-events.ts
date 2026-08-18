import { formatDistance, haversineMeters, type LatLng } from './geo';
import type { ClassifiedMovementInterval, MovementFix } from './movement-analysis';
import { pointAtProgress } from './path-projection';

/** Waiting spans this close in official time may merge when they are the same physical stop. */
export const WAIT_EVENT_MERGE_MAX_GAP_MS = 5_000;

/** Waiting spans may merge only when matched route progress differs by at most this. */
export const WAIT_EVENT_MERGE_MAX_PROGRESS_METERS = 15;

/** User-facing wait events require at least this much confirmed waiting time. */
export const MIN_USER_VISIBLE_WAIT_MS = 3_000;

/** Map taps within this distance of a located wait select that event. */
export const WAIT_MARKER_TAP_MAX_METERS = 40;

export type WaitLocationState = 'located' | 'unavailable';

export type WaitEvent = {
  id: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  progressMeters: number | null;
  coordinate: LatLng | null;
  locationState: WaitLocationState;
};

type OpenWait = {
  startMs: number;
  endMs: number;
  durationMs: number;
  matchedProgresses: number[];
};

/**
 * Derive user-facing wait events from the movement-analysis interval sequence.
 * Does not re-classify telemetry; location comes only from matched flanks that
 * already supported each `waiting` interval.
 */
export function deriveWaitEvents(input: {
  intervals: ClassifiedMovementInterval[];
  startedAtMs: number;
  referencePath: LatLng[];
}): WaitEvent[] {
  const waiting = input.intervals.filter((interval) => interval.label === 'waiting');
  const merged: OpenWait[] = [];

  for (const interval of waiting) {
    const candidate: OpenWait = {
      startMs: interval.startMs,
      endMs: interval.endMs,
      durationMs: interval.durationMs,
      matchedProgresses: matchedFlankProgresses(interval.startFix, interval.endFix),
    };
    const previous = merged[merged.length - 1];
    if (previous && canMerge(previous, candidate)) {
      merged[merged.length - 1] = {
        startMs: previous.startMs,
        endMs: candidate.endMs,
        durationMs: previous.durationMs + candidate.durationMs,
        matchedProgresses: [...previous.matchedProgresses, ...candidate.matchedProgresses],
      };
    } else {
      merged.push(candidate);
    }
  }

  return merged
    .filter((event) => event.durationMs >= MIN_USER_VISIBLE_WAIT_MS)
    .map((event) => finalizeWaitEvent(event, input.startedAtMs, input.referencePath));
}

export function displayedWaitDurationSumMs(events: WaitEvent[]): number {
  return events.reduce((sum, event) => sum + event.durationMs, 0);
}

export function formatWaitEventDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${totalSeconds}s`;
}

export function formatWaitEventLocation(event: WaitEvent): string {
  if (event.locationState !== 'located' || event.progressMeters == null) {
    return 'Location unavailable';
  }
  return `${formatDistance(event.progressMeters)} into route`;
}

export function waitEventIdNearPoint(
  events: WaitEvent[],
  point: LatLng,
  maxDistanceMeters: number = WAIT_MARKER_TAP_MAX_METERS,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.locationState !== 'located' || event.coordinate == null) {
      continue;
    }
    const distance = haversineMeters(event.coordinate, point);
    if (distance <= maxDistanceMeters && distance < bestDistance) {
      bestDistance = distance;
      bestId = event.id;
    }
  }
  return bestId;
}

function canMerge(previous: OpenWait, next: OpenWait): boolean {
  const gapMs = next.startMs - previous.endMs;
  if (gapMs < 0 || gapMs > WAIT_EVENT_MERGE_MAX_GAP_MS) {
    return false;
  }
  const previousProgress = representativeProgress(previous.matchedProgresses);
  const nextProgress = representativeProgress(next.matchedProgresses);
  if (previousProgress == null && nextProgress == null) {
    return true;
  }
  if (previousProgress == null || nextProgress == null) {
    return false;
  }
  return Math.abs(nextProgress - previousProgress) <= WAIT_EVENT_MERGE_MAX_PROGRESS_METERS;
}

function matchedFlankProgresses(...fixes: (MovementFix | null)[]): number[] {
  const progresses: number[] = [];
  for (const fix of fixes) {
    if (fix?.matched && fix.progressMeters != null && Number.isFinite(fix.progressMeters)) {
      progresses.push(fix.progressMeters);
    }
  }
  return progresses;
}

function representativeProgress(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finalizeWaitEvent(event: OpenWait, startedAtMs: number, referencePath: LatLng[]): WaitEvent {
  const startMs = Math.max(0, event.startMs - startedAtMs);
  const endMs = Math.max(startMs, event.endMs - startedAtMs);
  const progressMeters = representativeProgress(event.matchedProgresses);
  const located = progressMeters != null && referencePath.length > 0;
  return {
    id: `wait:${startMs}:${endMs}`,
    startMs,
    endMs,
    durationMs: event.durationMs,
    progressMeters: located ? progressMeters : null,
    coordinate: located && progressMeters != null ? pointAtProgress(referencePath, progressMeters) : null,
    locationState: located ? 'located' : 'unavailable',
  };
}
