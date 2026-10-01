import { formatAttemptStamp } from './duration';
import { formatDistance, haversineMeters, type LatLng } from './geo';
import { journeyPoolKey, type JourneyPoolId } from './journey';
import { isInRollingElapsedWindow, ROLLING_WINDOW_30_DAYS } from './journey-statistics';
import { projectOntoReferencePath } from './path-projection';
import type { TransportationMode } from './route';
import { formatWaitEventDuration, type WaitEvent } from './wait-events';

/**
 * Geographic complete-linkage diameter for journey-wide delay hotspots.
 * A pair of clusters may merge only while every member of the union stays
 * within this distance of every other member. The same distance is the
 * encounter radius: a compatible path variant is encountered when its saved
 * reference path comes within this many meters of the hotspot's representative
 * coordinate.
 *
 * 35 m matches the course-matching corridor. It is intentionally tighter than
 * the 40 m cross-attempt wait-comparison radius, because projected waits on
 * the shipped 40–60 m parallel-path discovery pair sit about 40 m apart and
 * must remain separate hotspots. Same-intersection repeats inside 35 m still
 * cluster. Complete-linkage, not single-linkage, stops a chain of nearby
 * points from collapsing into one unbounded hotspot.
 */
export const DELAY_HOTSPOT_DIAMETER_METERS = 35;

/** Spread at or below this is reported as a tight representative coordinate. */
export const DELAY_HOTSPOT_TIGHT_SPREAD_METERS = 15;

/** Journey detail shows this many ranked hotspots until the list is expanded. */
export const MAX_VISIBLE_DELAY_HOTSPOTS = 3;

/** Recent-vs-all-time is omitted until at least this many attempts encountered the hotspot in the window. */
export const MIN_RECENT_ENCOUNTERED_ATTEMPTS = 2;

/** Absolute frequency delta treated as "similar" to the all-time rate. */
export const RECENT_FREQUENCY_SIMILAR_EPSILON = 0.05;

export type DelayHotspotRank = 'frequency' | 'worst';

export type HotspotSpreadConfidence = 'tight' | 'wide';

export type RecentWaitVersusAllTime = 'more-often' | 'less-often' | 'similar';

export type DelayHotspotAttemptInput = {
  attemptId: string;
  finishedAtMs: number;
  originPlaceId: string;
  destinationPlaceId: string;
  transportationMode: TransportationMode;
  /**
   * The attempt's own compatible assigned path variant.
   * Null means unassigned or incompatible and excludes the attempt from
   * located hotspots and from unlocated totals.
   */
  routeId: string | null;
  /**
   * True only when wait events were derived from this attempt's own variant
   * and the movement breakdown is displayable. Untrustworthy attempts are
   * ignored, including any events attached to them.
   */
  analysisTrustworthy: boolean;
  waitEvents: readonly WaitEvent[];
};

export type DelayHotspotRouteInput = {
  routeId: string;
  referencePath: readonly LatLng[];
};

export type DelayHotspotAttemptShare = {
  attemptId: string;
  finishedAtMs: number;
  confirmedWaitMs: number;
  eventIds: string[];
};

export type DelayHotspotRecent = {
  windowDays: number;
  encounteredAttempts: number;
  waitedAttempts: number;
  frequency: number;
  averageWaitMs: number | null;
  totalConfirmedWaitMs: number;
  versusAllTime: RecentWaitVersusAllTime;
};

export type DelayHotspot = {
  id: string;
  coordinate: LatLng;
  spreadMeters: number;
  confidence: HotspotSpreadConfidence;
  encounteredAttempts: number;
  waitedAttempts: number;
  frequency: number;
  totalConfirmedWaitMs: number;
  averageWaitMs: number;
  medianWaitMs: number;
  worstWaitMs: number;
  memberEventIds: string[];
  attempts: DelayHotspotAttemptShare[];
  recent: DelayHotspotRecent | null;
};

export type DelayHotspotAnalysis = {
  poolKey: string;
  diameterMeters: number;
  hotspots: DelayHotspot[];
  unlocatedConfirmedWaitMs: number;
  trustworthyAttemptCount: number;
};

type LocatedMember = {
  attemptId: string;
  eventId: string;
  durationMs: number;
  coordinate: LatLng;
  finishedAtMs: number;
  routeId: string;
};

type Cluster = {
  members: LocatedMember[];
};

type IncludedAttempt = {
  attemptId: string;
  finishedAtMs: number;
  routeId: string;
  referencePath: readonly LatLng[];
};

export function aggregateDelayHotspots(input: {
  pool: JourneyPoolId;
  attempts: readonly DelayHotspotAttemptInput[];
  routes: readonly DelayHotspotRouteInput[];
  asOfMs: number;
}): DelayHotspotAnalysis {
  const routesById = new Map(input.routes.map((route) => [route.routeId, route]));
  const included: IncludedAttempt[] = [];
  const members: LocatedMember[] = [];
  let unlocatedConfirmedWaitMs = 0;
  const seenEvents = new Set<string>();

  const attempts = [...input.attempts].sort(compareAttemptIdentity);
  for (const attempt of attempts) {
    if (!attemptInRequestedPool(attempt, input.pool)) {
      continue;
    }
    if (!attempt.analysisTrustworthy || attempt.routeId == null) {
      continue;
    }
    const route = routesById.get(attempt.routeId);
    if (!route || route.referencePath.length === 0) {
      continue;
    }
    included.push({
      attemptId: attempt.attemptId,
      finishedAtMs: attempt.finishedAtMs,
      routeId: attempt.routeId,
      referencePath: route.referencePath,
    });
    const events = [...attempt.waitEvents].sort(compareEventIdentity);
    for (const event of events) {
      if (!Number.isFinite(event.durationMs) || event.durationMs <= 0) {
        continue;
      }
      const eventKey = `${attempt.attemptId}|${event.id}`;
      if (seenEvents.has(eventKey)) {
        continue;
      }
      seenEvents.add(eventKey);
      if (!isLocatedWait(event)) {
        unlocatedConfirmedWaitMs += event.durationMs;
        continue;
      }
      members.push({
        attemptId: attempt.attemptId,
        eventId: event.id,
        durationMs: event.durationMs,
        coordinate: {
          latitude: event.coordinate.latitude,
          longitude: event.coordinate.longitude,
        },
        finishedAtMs: attempt.finishedAtMs,
        routeId: attempt.routeId,
      });
    }
  }

  const clusters = clusterByCompleteLinkage(members);
  const hotspots = clusters
    .map((cluster) => finalizeHotspot(cluster.members, included, input.asOfMs))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    poolKey: journeyPoolKey(input.pool),
    diameterMeters: DELAY_HOTSPOT_DIAMETER_METERS,
    hotspots,
    unlocatedConfirmedWaitMs,
    trustworthyAttemptCount: included.length,
  };
}

export function rankDelayHotspots(
  hotspots: readonly DelayHotspot[],
  rank: DelayHotspotRank,
): DelayHotspot[] {
  return [...hotspots].sort((left, right) => compareRankedHotspots(left, right, rank));
}

export function formatHotspotFrequency(waitedAttempts: number, encounteredAttempts: number): string {
  if (encounteredAttempts <= 0) {
    return `${waitedAttempts} waited`;
  }
  const percent = Math.round((waitedAttempts / encounteredAttempts) * 100);
  return `${waitedAttempts}/${encounteredAttempts} (${percent}%)`;
}

export function formatRecentWaitSignal(recent: DelayHotspotRecent): string {
  const rate = formatHotspotFrequency(recent.waitedAttempts, recent.encounteredAttempts);
  const tone =
    recent.versusAllTime === 'more-often'
      ? 'more often than all-time'
      : recent.versusAllTime === 'less-often'
        ? 'less often than all-time'
        : 'similar to all-time';
  return `Last ${recent.windowDays} days: ${rate}, ${tone}`;
}

export function formatHotspotSpread(hotspot: DelayHotspot): string {
  return `${formatDistance(hotspot.spreadMeters)} spread · ${hotspot.confidence}`;
}

export function formatHotspotListSummary(hotspot: DelayHotspot): string {
  return `${formatHotspotFrequency(hotspot.waitedAttempts, hotspot.encounteredAttempts)} · typical ${formatWaitEventDuration(hotspot.medianWaitMs)} · total ${formatWaitEventDuration(hotspot.totalConfirmedWaitMs)} · worst ${formatWaitEventDuration(hotspot.worstWaitMs)}`;
}

export function formatHotspotAttemptShare(share: DelayHotspotAttemptShare): string {
  const repeated = share.eventIds.length > 1 ? ` across ${share.eventIds.length} waits` : '';
  return `${formatAttemptStamp(share.finishedAtMs)} · ${formatWaitEventDuration(share.confirmedWaitMs)} confirmed waiting${repeated}`;
}

function attemptInRequestedPool(attempt: DelayHotspotAttemptInput, pool: JourneyPoolId): boolean {
  return (
    attempt.originPlaceId === pool.originPlaceId &&
    attempt.destinationPlaceId === pool.destinationPlaceId &&
    attempt.transportationMode === pool.transportationMode
  );
}

function isLocatedWait(event: WaitEvent): event is WaitEvent & { coordinate: LatLng } {
  return (
    event.locationState === 'located' &&
    event.coordinate != null &&
    Number.isFinite(event.coordinate.latitude) &&
    Number.isFinite(event.coordinate.longitude)
  );
}

type DiameterPair = {
  left: number;
  right: number;
  distance: number;
};

type WorkingCluster = {
  id: number;
  members: LocatedMember[];
  identities: string[];
  active: boolean;
};

/**
 * Agglomerative complete-linkage inside the hotspot diameter.
 * Points farther apart than the diameter can never share a cluster, so each
 * connected component of that threshold graph is clustered on its own. A
 * component whose every pair is already inside the diameter is one cluster.
 * Otherwise each merge joins the closest eligible pair, breaking distance ties
 * with the lexicographic member-identity key, and the updated complete-linkage
 * distance is the max of the two previous links.
 */
function clusterByCompleteLinkage(members: LocatedMember[]): Cluster[] {
  if (members.length <= 1) {
    return members.map((member) => ({ members: [member] }));
  }
  const pairs = pairsWithinDiameter(members);
  const parent = members.map((_, index) => index);
  const rank = members.map(() => 0);
  const find = (index: number): number => {
    const parentIndex = parent[index]!;
    if (parentIndex === index) {
      return index;
    }
    const root = find(parentIndex);
    parent[index] = root;
    return root;
  };
  const union = (left: number, right: number): void => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    const leftRank = rank[leftRoot] ?? 0;
    const rightRank = rank[rightRoot] ?? 0;
    if (leftRank < rightRank) {
      const swap = leftRoot;
      leftRoot = rightRoot;
      rightRoot = swap;
    }
    parent[rightRoot] = leftRoot;
    if (leftRank === rightRank) {
      rank[leftRoot] = leftRank + 1;
    }
  };
  for (const pair of pairs) {
    union(pair.left, pair.right);
  }

  const groups = new Map<number, number[]>();
  const pairsByRoot = new Map<number, DiameterPair[]>();
  for (let index = 0; index < members.length; index += 1) {
    const root = find(index);
    const group = groups.get(root);
    if (group) {
      group.push(index);
    } else {
      groups.set(root, [index]);
    }
  }
  for (const pair of pairs) {
    const root = find(pair.left);
    const group = pairsByRoot.get(root);
    if (group) {
      group.push(pair);
    } else {
      pairsByRoot.set(root, [pair]);
    }
  }

  const clusters: Cluster[] = [];
  for (const [root, indices] of groups) {
    const componentPairs = pairsByRoot.get(root) ?? [];
    const cliqueEdges = (indices.length * (indices.length - 1)) / 2;
    if (componentPairs.length === cliqueEdges) {
      clusters.push({ members: indices.map((index) => members[index]!) });
      continue;
    }
    for (const cluster of agglomerateComponent(members, indices, componentPairs)) {
      clusters.push(cluster);
    }
  }
  return clusters;
}

function pairsWithinDiameter(members: LocatedMember[]): DiameterPair[] {
  const origin = members[0]?.coordinate;
  if (!origin) {
    return [];
  }
  const latMeters = 111_320;
  const lngMeters = Math.max(1e-6, latMeters * Math.cos((origin.latitude * Math.PI) / 180));
  const cellMeters = DELAY_HOTSPOT_DIAMETER_METERS;
  const buckets = new Map<string, number[]>();
  const cells = members.map((member) => {
    const x = (member.coordinate.longitude - origin.longitude) * lngMeters;
    const y = (member.coordinate.latitude - origin.latitude) * latMeters;
    return {
      cellX: Math.floor(x / cellMeters),
      cellY: Math.floor(y / cellMeters),
    };
  });
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!;
    const key = `${cell.cellX}:${cell.cellY}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      buckets.set(key, [index]);
    }
  }

  const pairs: DiameterPair[] = [];
  for (let left = 0; left < members.length; left += 1) {
    const cell = cells[left]!;
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
        const bucket = buckets.get(`${cell.cellX + offsetX}:${cell.cellY + offsetY}`);
        if (!bucket) {
          continue;
        }
        for (const right of bucket) {
          if (right <= left) {
            continue;
          }
          const distance = haversineMeters(members[left]!.coordinate, members[right]!.coordinate);
          if (distance <= DELAY_HOTSPOT_DIAMETER_METERS) {
            pairs.push({ left, right, distance });
          }
        }
      }
    }
  }
  return pairs;
}

function agglomerateComponent(
  members: LocatedMember[],
  indices: readonly number[],
  pairs: readonly DiameterPair[],
): Cluster[] {
  const byId = new Map<number, WorkingCluster>();
  const neighbors = new Map<number, Map<number, number>>();
  for (const index of indices) {
    const member = members[index];
    if (!member) {
      continue;
    }
    byId.set(index, {
      id: index,
      members: [member],
      identities: [`${member.attemptId}|${member.eventId}`],
      active: true,
    });
  }
  for (const pair of pairs) {
    addClusterLink(neighbors, pair.left, pair.right, pair.distance);
  }

  let nextId = members.length;
  while (true) {
    const best = chooseNextClusterMerge(byId, neighbors);
    if (!best) {
      break;
    }
    const left = byId.get(best.leftId);
    const right = byId.get(best.rightId);
    if (!left || !right) {
      break;
    }
    const mergedId = nextId;
    nextId += 1;
    const merged: WorkingCluster = {
      id: mergedId,
      members: [...left.members, ...right.members],
      identities: mergeIdentities(left.identities, right.identities),
      active: true,
    };
    byId.set(mergedId, merged);
    const leftLinks = new Map(neighbors.get(left.id) ?? []);
    const rightLinks = new Map(neighbors.get(right.id) ?? []);
    deactivateCluster(neighbors, left);
    deactivateCluster(neighbors, right);
    const neighborIds = new Set<number>([...leftLinks.keys(), ...rightLinks.keys()]);
    neighborIds.delete(left.id);
    neighborIds.delete(right.id);
    for (const otherId of neighborIds) {
      const other = byId.get(otherId);
      if (!other?.active) {
        continue;
      }
      const leftDistance = leftLinks.get(otherId);
      const rightDistance = rightLinks.get(otherId);
      if (leftDistance === undefined || rightDistance === undefined) {
        continue;
      }
      const distance = Math.max(leftDistance, rightDistance);
      if (distance <= DELAY_HOTSPOT_DIAMETER_METERS) {
        addClusterLink(neighbors, mergedId, otherId, distance);
      }
    }
  }

  const clusters: Cluster[] = [];
  for (const cluster of byId.values()) {
    if (cluster.active) {
      clusters.push({ members: cluster.members });
    }
  }
  return clusters;
}

function chooseNextClusterMerge(
  byId: ReadonlyMap<number, WorkingCluster>,
  neighbors: ReadonlyMap<number, ReadonlyMap<number, number>>,
): { leftId: number; rightId: number } | null {
  let best: { leftId: number; rightId: number; distance: number; unionKey: string } | null = null;
  for (const [leftId, links] of neighbors) {
    const left = byId.get(leftId);
    if (!left?.active) {
      continue;
    }
    for (const [rightId, distance] of links) {
      if (rightId < leftId || distance > DELAY_HOTSPOT_DIAMETER_METERS) {
        continue;
      }
      const right = byId.get(rightId);
      if (!right?.active) {
        continue;
      }
      if (best && distance > best.distance) {
        continue;
      }
      const unionKey = mergeIdentities(left.identities, right.identities).join(';');
      if (!best || distance < best.distance || unionKey < best.unionKey) {
        best = { leftId, rightId, distance, unionKey };
      }
    }
  }
  return best ? { leftId: best.leftId, rightId: best.rightId } : null;
}

function addClusterLink(
  neighbors: Map<number, Map<number, number>>,
  leftId: number,
  rightId: number,
  distance: number,
): void {
  const link = (fromId: number, toId: number): void => {
    let links = neighbors.get(fromId);
    if (!links) {
      links = new Map();
      neighbors.set(fromId, links);
    }
    links.set(toId, distance);
  };
  link(leftId, rightId);
  link(rightId, leftId);
}

function deactivateCluster(neighbors: Map<number, Map<number, number>>, cluster: WorkingCluster): void {
  const links = neighbors.get(cluster.id);
  if (links) {
    for (const otherId of links.keys()) {
      neighbors.get(otherId)?.delete(cluster.id);
    }
  }
  neighbors.delete(cluster.id);
  cluster.active = false;
}

function mergeIdentities(left: readonly string[], right: readonly string[]): string[] {
  const merged: string[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftId = left[leftIndex]!;
    const rightId = right[rightIndex]!;
    if (leftId.localeCompare(rightId) <= 0) {
      merged.push(leftId);
      leftIndex += 1;
    } else {
      merged.push(rightId);
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) {
    merged.push(left[leftIndex]!);
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    merged.push(right[rightIndex]!);
    rightIndex += 1;
  }
  return merged;
}

function finalizeHotspot(
  members: LocatedMember[],
  attempts: readonly IncludedAttempt[],
  asOfMs: number,
): DelayHotspot {
  const coordinate = centroid(members);
  const spreadMeters = memberSpread(members);
  const byAttempt = new Map<string, DelayHotspotAttemptShare>();
  for (const member of members) {
    const existing = byAttempt.get(member.attemptId);
    if (existing) {
      existing.confirmedWaitMs += member.durationMs;
      existing.eventIds.push(member.eventId);
      continue;
    }
    byAttempt.set(member.attemptId, {
      attemptId: member.attemptId,
      finishedAtMs: member.finishedAtMs,
      confirmedWaitMs: member.durationMs,
      eventIds: [member.eventId],
    });
  }
  const shares = [...byAttempt.values()].sort(compareShares);
  for (const share of shares) {
    share.eventIds.sort((left, right) => left.localeCompare(right));
  }
  const encountered = attempts.filter((attempt) => pathEncounters(attempt.referencePath, coordinate));
  const encounteredAttempts = encountered.length;
  const waitedAttempts = shares.length;
  const perAttemptWaits = shares.map((share) => share.confirmedWaitMs);
  const totalConfirmedWaitMs = perAttemptWaits.reduce((sum, value) => sum + value, 0);
  const worstWaitMs = perAttemptWaits.reduce((max, value) => Math.max(max, value), 0);
  const frequency = encounteredAttempts > 0 ? waitedAttempts / encounteredAttempts : 0;
  return {
    id: `hotspot:${memberKey(members)}`,
    coordinate,
    spreadMeters,
    confidence: spreadMeters <= DELAY_HOTSPOT_TIGHT_SPREAD_METERS ? 'tight' : 'wide',
    encounteredAttempts,
    waitedAttempts,
    frequency,
    totalConfirmedWaitMs,
    averageWaitMs: waitedAttempts > 0 ? totalConfirmedWaitMs / waitedAttempts : 0,
    medianWaitMs: median(perAttemptWaits),
    worstWaitMs,
    memberEventIds: [...members].map((member) => member.eventId).sort((left, right) => left.localeCompare(right)),
    attempts: shares,
    recent: recentSignal(encountered, shares, frequency, asOfMs),
  };
}

function recentSignal(
  encountered: readonly IncludedAttempt[],
  shares: readonly DelayHotspotAttemptShare[],
  allTimeFrequency: number,
  asOfMs: number,
): DelayHotspotRecent | null {
  const recentEncountered = encountered.filter((attempt) =>
    isInRollingElapsedWindow(attempt.finishedAtMs, asOfMs, ROLLING_WINDOW_30_DAYS),
  );
  if (recentEncountered.length < MIN_RECENT_ENCOUNTERED_ATTEMPTS) {
    return null;
  }
  const recentEncounteredIds = new Set(recentEncountered.map((attempt) => attempt.attemptId));
  const recentShares = shares.filter((share) => recentEncounteredIds.has(share.attemptId));
  const waitedAttempts = recentShares.length;
  const totalConfirmedWaitMs = recentShares.reduce((sum, share) => sum + share.confirmedWaitMs, 0);
  const frequency = waitedAttempts / recentEncountered.length;
  const delta = frequency - allTimeFrequency;
  const versusAllTime: RecentWaitVersusAllTime =
    Math.abs(delta) < RECENT_FREQUENCY_SIMILAR_EPSILON
      ? 'similar'
      : delta > 0
        ? 'more-often'
        : 'less-often';
  return {
    windowDays: ROLLING_WINDOW_30_DAYS,
    encounteredAttempts: recentEncountered.length,
    waitedAttempts,
    frequency,
    averageWaitMs: waitedAttempts > 0 ? totalConfirmedWaitMs / waitedAttempts : null,
    totalConfirmedWaitMs,
    versusAllTime,
  };
}

function pathEncounters(path: readonly LatLng[], coordinate: LatLng): boolean {
  const projection = projectOntoReferencePath([...path], coordinate);
  return projection != null && projection.snapDistanceMeters <= DELAY_HOTSPOT_DIAMETER_METERS;
}

function centroid(members: LocatedMember[]): LatLng {
  let latitude = 0;
  let longitude = 0;
  for (const member of members) {
    latitude += member.coordinate.latitude;
    longitude += member.coordinate.longitude;
  }
  return {
    latitude: latitude / members.length,
    longitude: longitude / members.length,
  };
}

function memberSpread(members: LocatedMember[]): number {
  let maxDistance = 0;
  for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
      const left = members[leftIndex];
      const right = members[rightIndex];
      if (!left || !right) {
        continue;
      }
      maxDistance = Math.max(maxDistance, haversineMeters(left.coordinate, right.coordinate));
    }
  }
  return maxDistance;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function memberKey(members: LocatedMember[]): string {
  return [...members]
    .map((member) => `${member.attemptId}|${member.eventId}`)
    .sort((left, right) => left.localeCompare(right))
    .join(';');
}

function compareAttemptIdentity(left: DelayHotspotAttemptInput, right: DelayHotspotAttemptInput): number {
  if (left.finishedAtMs !== right.finishedAtMs) {
    return left.finishedAtMs - right.finishedAtMs;
  }
  return left.attemptId.localeCompare(right.attemptId);
}

function compareEventIdentity(left: WaitEvent, right: WaitEvent): number {
  if (left.startMs !== right.startMs) {
    return left.startMs - right.startMs;
  }
  return left.id.localeCompare(right.id);
}

function compareShares(left: DelayHotspotAttemptShare, right: DelayHotspotAttemptShare): number {
  if (left.finishedAtMs !== right.finishedAtMs) {
    return right.finishedAtMs - left.finishedAtMs;
  }
  return left.attemptId.localeCompare(right.attemptId);
}

function compareRankedHotspots(left: DelayHotspot, right: DelayHotspot, rank: DelayHotspotRank): number {
  if (rank === 'worst') {
    if (left.worstWaitMs !== right.worstWaitMs) {
      return right.worstWaitMs - left.worstWaitMs;
    }
    if (left.totalConfirmedWaitMs !== right.totalConfirmedWaitMs) {
      return right.totalConfirmedWaitMs - left.totalConfirmedWaitMs;
    }
    return left.id.localeCompare(right.id);
  }
  if (left.frequency !== right.frequency) {
    return right.frequency - left.frequency;
  }
  if (left.waitedAttempts !== right.waitedAttempts) {
    return right.waitedAttempts - left.waitedAttempts;
  }
  if (left.totalConfirmedWaitMs !== right.totalConfirmedWaitMs) {
    return right.totalConfirmedWaitMs - left.totalConfirmedWaitMs;
  }
  return left.id.localeCompare(right.id);
}
