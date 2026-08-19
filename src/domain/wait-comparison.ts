import { formatDistance, haversineMeters, type LatLng } from './geo';
import { isMovementDisplayable, type MovementBreakdown } from './movement-analysis';
import { pointAtProgress } from './path-projection';
import {
  displayedWaitDurationSumMs,
  WAIT_MARKER_TAP_MAX_METERS,
  type WaitEvent,
} from './wait-events';

export type WaitComparisonAttempt = {
  attemptId: string;
  eligible: boolean;
  movement: MovementBreakdown | null;
  waitEvents: WaitEvent[];
};

/**
 * Cross-attempt wait identity in route-progress space.
 * Distinct from the 15 m same-attempt fragment-merge radius.
 */
export const WAIT_COMPARISON_LOCATION_RADIUS_METERS = 40;

/** Compact UI omits location rows whose absolute waiting delta is below this. */
export const MIN_DISPLAY_WAIT_COMPARISON_ABS_MS = 3_000;

/** Compact UI keeps at most this many meaningful location rows. */
export const MAX_DISPLAY_WAIT_COMPARISON_LOCATIONS = 5;

export type WaitComparisonMemberSide = 'current' | 'reference';

export type WaitComparisonMatchState = 'matched' | 'current-only' | 'reference-only';

export type WaitComparisonUnavailableReason =
  | 'missing_comparison_target'
  | 'current_not_eligible'
  | 'reference_not_eligible'
  | 'current_movement_not_displayable'
  | 'reference_movement_not_displayable';

export type WaitComparisonLocationEntry = {
  id: string;
  progressMeters: number;
  coordinate: LatLng | null;
  currentWaitingMs: number;
  referenceWaitingMs: number;
  deltaMs: number;
  matchState: WaitComparisonMatchState;
  memberSpanMeters: number;
  currentEventIds: string[];
  referenceEventIds: string[];
};

export type WaitComparisonRemainder = {
  currentLocationAttributedMs: number;
  referenceLocationAttributedMs: number;
  currentUnlocatedWaitEventMs: number;
  referenceUnlocatedWaitEventMs: number;
  currentSubEventWaitingMs: number;
  referenceSubEventWaitingMs: number;
  displayedLocationDeltaSumMs: number;
  hiddenLocationDeltaSumMs: number;
};

export type WaitComparison = {
  available: boolean;
  unavailableReason: WaitComparisonUnavailableReason | null;
  comparisonAttemptId: string | null;
  currentWaitingMs: number;
  referenceWaitingMs: number;
  waitingDeltaMs: number;
  locations: WaitComparisonLocationEntry[];
  displayedLocations: WaitComparisonLocationEntry[];
  remainder: WaitComparisonRemainder;
};

type ClusterMember = {
  side: WaitComparisonMemberSide;
  event: WaitEvent;
  progressMeters: number;
};

type ClusterGroup = {
  members: ClusterMember[];
};

export function emptyWaitComparisonRemainder(): WaitComparisonRemainder {
  return {
    currentLocationAttributedMs: 0,
    referenceLocationAttributedMs: 0,
    currentUnlocatedWaitEventMs: 0,
    referenceUnlocatedWaitEventMs: 0,
    currentSubEventWaitingMs: 0,
    referenceSubEventWaitingMs: 0,
    displayedLocationDeltaSumMs: 0,
    hiddenLocationDeltaSumMs: 0,
  };
}

export function unavailableWaitComparison(
  reason: WaitComparisonUnavailableReason,
  input: {
    comparisonAttemptId?: string | null;
    currentWaitingMs?: number;
    referenceWaitingMs?: number;
  } = {},
): WaitComparison {
  return {
    available: false,
    unavailableReason: reason,
    comparisonAttemptId: input.comparisonAttemptId ?? null,
    currentWaitingMs: input.currentWaitingMs ?? 0,
    referenceWaitingMs: input.referenceWaitingMs ?? 0,
    waitingDeltaMs: 0,
    locations: [],
    displayedLocations: [],
    remainder: emptyWaitComparisonRemainder(),
  };
}

/**
 * Compare confirmed waiting between an attempt and the same PB comparison
 * target already used for split Δ PB (`comparisonPbRun`).
 */
export function compareAttemptWaiting(input: {
  current: WaitComparisonAttempt;
  reference: WaitComparisonAttempt | null;
  referencePath: LatLng[];
}): WaitComparison {
  const currentWaitingMs = waitingMsOf(input.current.movement);
  const referenceWaitingMs = waitingMsOf(input.reference?.movement ?? null);

  if (!input.current.eligible || input.current.movement == null) {
    return unavailableWaitComparison('current_not_eligible', {
      currentWaitingMs,
      referenceWaitingMs,
      comparisonAttemptId: input.reference?.attemptId ?? null,
    });
  }
  if (input.reference == null) {
    return unavailableWaitComparison('missing_comparison_target', {
      currentWaitingMs,
      comparisonAttemptId: null,
    });
  }
  if (!input.reference.eligible || input.reference.movement == null) {
    return unavailableWaitComparison('reference_not_eligible', {
      currentWaitingMs,
      referenceWaitingMs,
      comparisonAttemptId: input.reference.attemptId,
    });
  }
  if (!isMovementDisplayable(input.current.movement)) {
    return unavailableWaitComparison('current_movement_not_displayable', {
      currentWaitingMs,
      referenceWaitingMs,
      comparisonAttemptId: input.reference.attemptId,
    });
  }
  if (!isMovementDisplayable(input.reference.movement)) {
    return unavailableWaitComparison('reference_movement_not_displayable', {
      currentWaitingMs,
      referenceWaitingMs,
      comparisonAttemptId: input.reference.attemptId,
    });
  }

  return compareWaitingBehavior({
    currentWaitingMs,
    referenceWaitingMs,
    currentEvents: input.current.waitEvents,
    referenceEvents: input.reference.waitEvents,
    comparisonAttemptId: input.reference.attemptId,
    referencePath: input.referencePath,
  });
}

/**
 * Pure waiting comparison. Self-comparison is an identity invariant: the same
 * inputs on both sides must reconcile to a zero total and zero location deltas.
 */
export function compareWaitingBehavior(input: {
  currentWaitingMs: number;
  referenceWaitingMs: number;
  currentEvents: WaitEvent[];
  referenceEvents: WaitEvent[];
  comparisonAttemptId: string | null;
  referencePath: LatLng[];
}): WaitComparison {
  const currentWaitingMs = Math.max(0, input.currentWaitingMs);
  const referenceWaitingMs = Math.max(0, input.referenceWaitingMs);
  const waitingDeltaMs = currentWaitingMs - referenceWaitingMs;
  const locations = clusterWaitComparisonLocations(
    input.currentEvents,
    input.referenceEvents,
    input.referencePath,
  );
  const displayedLocations = selectDisplayedWaitComparisonLocations(locations);
  const remainder = reconcileWaitComparison({
    currentWaitingMs,
    referenceWaitingMs,
    currentEvents: input.currentEvents,
    referenceEvents: input.referenceEvents,
    locations,
    displayedLocations,
  });

  return {
    available: true,
    unavailableReason: null,
    comparisonAttemptId: input.comparisonAttemptId,
    currentWaitingMs,
    referenceWaitingMs,
    waitingDeltaMs,
    locations,
    displayedLocations,
    remainder,
  };
}

export function selectDisplayedWaitComparisonLocations(
  locations: WaitComparisonLocationEntry[],
): WaitComparisonLocationEntry[] {
  const meaningful = locations.filter(
    (entry) => Math.abs(entry.deltaMs) >= MIN_DISPLAY_WAIT_COMPARISON_ABS_MS,
  );
  const ranked = [...meaningful].sort((a, b) => {
    const impact = Math.abs(b.deltaMs) - Math.abs(a.deltaMs);
    if (impact !== 0) {
      return impact;
    }
    return compareLocationOrder(a, b);
  });
  return ranked.slice(0, MAX_DISPLAY_WAIT_COMPARISON_LOCATIONS).sort(compareLocationOrder);
}

/**
 * Nearest-pair complete-linkage in route-progress space.
 * Merge-eligible only while the union member-progress span stays within 40 m.
 */
export function clusterWaitComparisonLocations(
  currentEvents: WaitEvent[],
  referenceEvents: WaitEvent[],
  referencePath: LatLng[],
): WaitComparisonLocationEntry[] {
  const groups: ClusterGroup[] = [
    ...locatedMembers(currentEvents, 'current'),
    ...locatedMembers(referenceEvents, 'reference'),
  ].map((member) => ({ members: [member] }));

  while (true) {
    const merge = chooseNextMerge(groups);
    if (!merge) {
      break;
    }
    const left = groups[merge.leftIndex];
    const right = groups[merge.rightIndex];
    if (!left || !right) {
      break;
    }
    const merged: ClusterGroup = { members: [...left.members, ...right.members] };
    groups.splice(merge.rightIndex, 1);
    groups.splice(merge.leftIndex, 1);
    groups.push(merged);
  }

  return groups
    .map((group) => finalizeLocationEntry(group.members, referencePath))
    .sort(compareLocationOrder);
}

export function waitComparisonLocationIdNearPoint(
  locations: WaitComparisonLocationEntry[],
  point: LatLng,
  maxDistanceMeters: number = WAIT_MARKER_TAP_MAX_METERS,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const location of locations) {
    if (location.coordinate == null) {
      continue;
    }
    const distance = haversineMeters(location.coordinate, point);
    if (distance <= maxDistanceMeters && distance < bestDistance) {
      bestDistance = distance;
      bestId = location.id;
    }
  }
  return bestId;
}

export function formatWaitComparisonDelta(deltaMs: number): string {
  if (deltaMs === 0) {
    return '0s';
  }
  const seconds = Math.max(0, Math.round(Math.abs(deltaMs) / 1000));
  if (seconds === 0) {
    return '0s';
  }
  return `${deltaMs < 0 ? '-' : '+'}${seconds}s`;
}

export function formatWaitComparisonLocation(entry: WaitComparisonLocationEntry): string {
  return `${formatDistance(entry.progressMeters)} into route`;
}

export function describeWaitComparisonUnavailable(reason: WaitComparisonUnavailableReason): string {
  switch (reason) {
    case 'missing_comparison_target':
      return 'No PB comparison run is available.';
    case 'current_not_eligible':
    case 'reference_not_eligible':
      return 'Waiting comparison is unavailable for this course layout.';
    case 'current_movement_not_displayable':
    case 'reference_movement_not_displayable':
      return 'Waiting comparison needs trustworthy movement data on both runs.';
  }
}

function waitingMsOf(breakdown: MovementBreakdown | null | undefined): number {
  return breakdown?.waitingMs ?? 0;
}

function locatedMembers(events: WaitEvent[], side: WaitComparisonMemberSide): ClusterMember[] {
  const members: ClusterMember[] = [];
  for (const event of events) {
    if (event.locationState !== 'located' || event.progressMeters == null || !Number.isFinite(event.progressMeters)) {
      continue;
    }
    members.push({ side, event, progressMeters: event.progressMeters });
  }
  return members;
}

function chooseNextMerge(groups: ClusterGroup[]): { leftIndex: number; rightIndex: number } | null {
  let best: {
    leftIndex: number;
    rightIndex: number;
    distance: number;
    unionMin: number;
    unionMax: number;
    unionKey: string;
  } | null = null;

  for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
    const left = groups[leftIndex];
    if (!left) {
      continue;
    }
    const leftStats = groupStats(left.members);
    for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
      const right = groups[rightIndex];
      if (!right) {
        continue;
      }
      const rightStats = groupStats(right.members);
      const unionMin = Math.min(leftStats.minProgress, rightStats.minProgress);
      const unionMax = Math.max(leftStats.maxProgress, rightStats.maxProgress);
      if (unionMax - unionMin > WAIT_COMPARISON_LOCATION_RADIUS_METERS) {
        continue;
      }
      const distance = Math.abs(leftStats.representativeProgress - rightStats.representativeProgress);
      const unionKey = groupStableKey([...left.members, ...right.members]);
      const candidate = { leftIndex, rightIndex, distance, unionMin, unionMax, unionKey };
      if (isBetterMerge(candidate, best)) {
        best = candidate;
      }
    }
  }

  return best ? { leftIndex: best.leftIndex, rightIndex: best.rightIndex } : null;
}

function isBetterMerge(
  candidate: { distance: number; unionMin: number; unionMax: number; unionKey: string },
  current: { distance: number; unionMin: number; unionMax: number; unionKey: string } | null,
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.distance !== current.distance) {
    return candidate.distance < current.distance;
  }
  if (candidate.unionMin !== current.unionMin) {
    return candidate.unionMin < current.unionMin;
  }
  if (candidate.unionMax !== current.unionMax) {
    return candidate.unionMax < current.unionMax;
  }
  return candidate.unionKey < current.unionKey;
}

function groupStats(members: ClusterMember[]): {
  minProgress: number;
  maxProgress: number;
  representativeProgress: number;
} {
  const first = members[0];
  if (!first) {
    return { minProgress: 0, maxProgress: 0, representativeProgress: 0 };
  }
  let minProgress = first.progressMeters;
  let maxProgress = first.progressMeters;
  let sum = 0;
  for (const member of members) {
    minProgress = Math.min(minProgress, member.progressMeters);
    maxProgress = Math.max(maxProgress, member.progressMeters);
    sum += member.progressMeters;
  }
  return {
    minProgress,
    maxProgress,
    representativeProgress: sum / members.length,
  };
}

function groupStableKey(members: ClusterMember[]): string {
  return [...members].sort(compareMemberIdentity).map(memberIdentity).join(';');
}

function compareMemberIdentity(left: ClusterMember, right: ClusterMember): number {
  if (left.side !== right.side) {
    return left.side === 'current' ? -1 : 1;
  }
  if (left.event.startMs !== right.event.startMs) {
    return left.event.startMs - right.event.startMs;
  }
  return left.event.id.localeCompare(right.event.id);
}

function memberIdentity(member: ClusterMember): string {
  return `${member.side === 'current' ? '0' : '1'}|${member.event.startMs}|${member.event.id}`;
}

function finalizeLocationEntry(members: ClusterMember[], referencePath: LatLng[]): WaitComparisonLocationEntry {
  const stats = groupStats(members);
  const currentMembers = members.filter((member) => member.side === 'current');
  const referenceMembers = members.filter((member) => member.side === 'reference');
  const currentWaitingMs = sumDuration(currentMembers);
  const referenceWaitingMs = sumDuration(referenceMembers);
  const located = referencePath.length > 0;
  return {
    id: `wait-cmp:${groupStableKey(members)}`,
    progressMeters: stats.representativeProgress,
    coordinate: located ? pointAtProgress(referencePath, stats.representativeProgress) : null,
    currentWaitingMs,
    referenceWaitingMs,
    deltaMs: currentWaitingMs - referenceWaitingMs,
    matchState: matchStateFor(currentWaitingMs, referenceWaitingMs),
    memberSpanMeters: stats.maxProgress - stats.minProgress,
    currentEventIds: currentMembers.map((member) => member.event.id),
    referenceEventIds: referenceMembers.map((member) => member.event.id),
  };
}

function matchStateFor(currentWaitingMs: number, referenceWaitingMs: number): WaitComparisonMatchState {
  if (currentWaitingMs > 0 && referenceWaitingMs > 0) {
    return 'matched';
  }
  if (currentWaitingMs > 0) {
    return 'current-only';
  }
  return 'reference-only';
}

function sumDuration(members: ClusterMember[]): number {
  return members.reduce((sum, member) => sum + member.event.durationMs, 0);
}

function compareLocationOrder(a: WaitComparisonLocationEntry, b: WaitComparisonLocationEntry): number {
  if (a.progressMeters !== b.progressMeters) {
    return a.progressMeters - b.progressMeters;
  }
  return a.id.localeCompare(b.id);
}

function reconcileWaitComparison(input: {
  currentWaitingMs: number;
  referenceWaitingMs: number;
  currentEvents: WaitEvent[];
  referenceEvents: WaitEvent[];
  locations: WaitComparisonLocationEntry[];
  displayedLocations: WaitComparisonLocationEntry[];
}): WaitComparisonRemainder {
  const currentLocationAttributedMs = input.locations.reduce((sum, entry) => sum + entry.currentWaitingMs, 0);
  const referenceLocationAttributedMs = input.locations.reduce((sum, entry) => sum + entry.referenceWaitingMs, 0);
  const currentUnlocatedWaitEventMs = unlocatedDuration(input.currentEvents);
  const referenceUnlocatedWaitEventMs = unlocatedDuration(input.referenceEvents);
  const currentSubEventWaitingMs = Math.max(0, input.currentWaitingMs - displayedWaitDurationSumMs(input.currentEvents));
  const referenceSubEventWaitingMs = Math.max(
    0,
    input.referenceWaitingMs - displayedWaitDurationSumMs(input.referenceEvents),
  );
  const displayedIds = new Set(input.displayedLocations.map((entry) => entry.id));
  const displayedLocationDeltaSumMs = input.displayedLocations.reduce((sum, entry) => sum + entry.deltaMs, 0);
  const hiddenLocationDeltaSumMs = input.locations
    .filter((entry) => !displayedIds.has(entry.id))
    .reduce((sum, entry) => sum + entry.deltaMs, 0);
  return {
    currentLocationAttributedMs,
    referenceLocationAttributedMs,
    currentUnlocatedWaitEventMs,
    referenceUnlocatedWaitEventMs,
    currentSubEventWaitingMs,
    referenceSubEventWaitingMs,
    displayedLocationDeltaSumMs,
    hiddenLocationDeltaSumMs,
  };
}

function unlocatedDuration(events: WaitEvent[]): number {
  return events
    .filter((event) => event.locationState !== 'located' || event.progressMeters == null)
    .reduce((sum, event) => sum + event.durationMs, 0);
}
