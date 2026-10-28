import { isJourneyCompetitive, type Attempt } from './attempt';
import { deriveAnchoredLayoutAttempt, timingCourseFromRoute } from './attempt-analysis';
import { haversineMeters, type LatLng } from './geo';
import { journeyPoolKey, type JourneyPoolId } from './journey';
import type { JourneyAttemptTrace } from './journey-analysis';
import { isInRollingElapsedWindow, ROLLING_WINDOW_30_DAYS } from './journey-statistics';
import type { Place } from './place';
import { isCompatiblePathVariant, routeEndpointsMatchJourney } from './path-variant';
import { projectOntoReferencePath } from './path-projection';
import type { Route } from './route';
import { MIN_USER_VISIBLE_WAIT_MS, type WaitEvent } from './wait-events';

/*
 * Recurring journey delay hotspots (pure, deterministic).
 *
 * Identity and population rules (all thresholds are centralized below):
 * - Population: valid completed attempts (`isJourneyCompetitive`) of one directional
 *   journey + transportation mode whose assigned `routeId` resolves to a path variant that
 *   still matches the journey endpoints AND is compatible with the attempt's own telemetry
 *   (`isCompatiblePathVariant`). Everything else contributes nothing (no located events, no
 *   encounters, no unlocated totals). Wait events are never projected on a default variant.
 * - Hotspot identity is geographic complete-linkage over the located wait coordinates: two
 *   events share a hotspot only if EVERY pair in the cluster is within
 *   HOTSPOT_CLUSTER_DIAMETER_METERS. Chains cannot grow past that diameter.
 * - One wait event belongs to exactly one cluster. Several waits by one attempt in a
 *   cluster add their durations but count the attempt once as `waited`.
 * - Encountered = population attempts whose saved variant reference path passes within
 *   HOTSPOT_ENCOUNTER_RADIUS_METERS of the hotspot coordinate (or that waited there, which
 *   keeps waited <= encountered even if projection rounding disagrees).
 * - Confirmed waiting is observed stopped time; it is not time lost versus a personal best.
 */

/**
 * Complete-linkage cluster diameter: the largest allowed distance between ANY two wait
 * coordinates in one hotspot. 30 m merges waits at the same intersection and the 20 m
 * merge fixture, but splits the 40 m / 50 m / 60 m parallel-street fixtures (projected
 * wait coordinates of those fixtures are about 39.96 m / 49.94 m / 59.93 m apart). It is
 * deliberately NOT the 40 m wait-comparison radius, which would merge the 40 m pair.
 */
export const HOTSPOT_CLUSTER_DIAMETER_METERS = 30;

/**
 * An attempt encountered a hotspot if its saved reference path passes within this distance
 * of the hotspot coordinate. Equal to the cluster diameter, so any path that produced a
 * member event passes within it.
 */
export const HOTSPOT_ENCOUNTER_RADIUS_METERS = 30;

/** A hotspot is "recurring" (listed and drawn) only when this many attempts waited there. */
export const HOTSPOT_MIN_WAITED_ATTEMPTS = 2;

/** Trend needs at least this many encountered attempts inside the recent window... */
export const HOTSPOT_TREND_MIN_RECENT_ENCOUNTERS = 3;

/** ...and at least this many older encountered attempts as the baseline. */
export const HOTSPOT_TREND_MIN_OLDER_ENCOUNTERS = 3;

/** Recent window for the trend, as a rolling finishedAtMs window (same as journey stats). */
export const HOTSPOT_TREND_RECENT_WINDOW_DAYS = ROLLING_WINDOW_30_DAYS;

/** Recent vs all-time mean waiting per encounter within this relative band reads as steady. */
export const HOTSPOT_TREND_STEADY_RATIO = 0.2;

/** Default number of hotspots shown before the user expands the list. */
export const HOTSPOT_DEFAULT_VISIBLE_COUNT = 3;

/** Confidence thresholds on waited attempts and spread. */
export const HOTSPOT_HIGH_CONFIDENCE_MIN_WAITED = 5;
export const HOTSPOT_MEDIUM_CONFIDENCE_MIN_WAITED = 3;
export const HOTSPOT_HIGH_CONFIDENCE_MAX_SPREAD_METERS = 15;

export type HotspotConfidence = 'low' | 'medium' | 'high';

export type HotspotTrendDirection = 'worse' | 'better' | 'steady';

export type HotspotTrend = {
  direction: HotspotTrendDirection;
  recentEncountered: number;
  recentMeanWaitMs: number;
  allTimeMeanWaitMs: number;
};

export type HotspotAttemptInput = {
  attempt: Attempt;
  /** The attempt's own assigned path variant, if it exists. */
  route: Route | null;
  /** True only when `route` is compatible with this attempt's telemetry. */
  compatible: boolean;
  waitEvents: WaitEvent[];
};

export type DelayHotspotContribution = {
  attemptId: string;
  finishedAtMs: number | null;
  waitMs: number;
  eventCount: number;
  eventIds: string[];
};

export type DelayHotspot = {
  id: string;
  coordinate: LatLng;
  spreadMeters: number;
  confidence: HotspotConfidence;
  encounteredAttempts: number;
  waitedAttempts: number;
  /** waitedAttempts / encounteredAttempts, 0..1. */
  waitedRatio: number;
  eventCount: number;
  totalWaitMs: number;
  /** Mean / median / worst over per-attempt summed confirmed waiting at this hotspot. */
  averageWaitMs: number;
  medianWaitMs: number;
  worstWaitMs: number;
  worstAttemptId: string;
  trend: HotspotTrend | null;
  /** Newest first. */
  contributions: DelayHotspotContribution[];
};

export type DelayHotspotTotals = {
  analyzedAttemptCount: number;
  excludedAttemptCount: number;
  locatedWaitMs: number;
  recurringWaitMs: number;
  /** Located confirmed waiting in clusters that did not recur. */
  oneOffWaitMs: number;
  unlocatedWaitMs: number;
  unlocatedEventCount: number;
  unlocatedAttemptCount: number;
};

export type DelayHotspotAnalysis = {
  /** Recurring hotspots ranked by total confirmed waiting (default order). */
  hotspots: DelayHotspot[];
  totals: DelayHotspotTotals;
};

export type DelayHotspotOrder = 'total' | 'frequency';

type Member = {
  attemptId: string;
  eventId: string;
  durationMs: number;
  coordinate: LatLng;
};

export function emptyDelayHotspotAnalysis(): DelayHotspotAnalysis {
  return {
    hotspots: [],
    totals: {
      analyzedAttemptCount: 0,
      excludedAttemptCount: 0,
      locatedWaitMs: 0,
      recurringWaitMs: 0,
      oneOffWaitMs: 0,
      unlocatedWaitMs: 0,
      unlocatedEventCount: 0,
      unlocatedAttemptCount: 0,
    },
  };
}

/**
 * Resolve one attempt's hotspot input from its samples. Wait events come only from the
 * attempt's own compatible assigned variant, via the existing anchored derivation (which
 * calls `deriveWaitEvents`); no stop detection happens here.
 */
export function deriveHotspotAttemptInput(
  trace: JourneyAttemptTrace,
  routes: readonly Route[],
): HotspotAttemptInput {
  const { attempt, samples } = trace;
  const route = attempt.routeId ? (routes.find((item) => item.id === attempt.routeId) ?? null) : null;
  if (
    !route ||
    !isJourneyCompetitive(attempt) ||
    attempt.startedAtMs == null ||
    attempt.finishedAtMs == null ||
    !isCompatiblePathVariant(route, samples, {
      startedAtMs: attempt.startedAtMs,
      finishedAtMs: attempt.finishedAtMs,
    })
  ) {
    return { attempt, route, compatible: false, waitEvents: [] };
  }
  const derived = deriveAnchoredLayoutAttempt(timingCourseFromRoute(route), attempt, samples);
  return { attempt, route, compatible: true, waitEvents: derived.waitEvents };
}

export function computeDelayHotspots(input: {
  pool: JourneyPoolId;
  origin: Place;
  destination: Place;
  attempts: readonly HotspotAttemptInput[];
  asOfMs: number;
  clusterDiameterMeters?: number;
}): DelayHotspotAnalysis {
  const diameter = input.clusterDiameterMeters ?? HOTSPOT_CLUSTER_DIAMETER_METERS;
  const poolKey = journeyPoolKey(input.pool);

  const included = input.attempts
    .filter((item) => isIncluded(item, input, poolKey))
    .sort((a, b) => a.attempt.id.localeCompare(b.attempt.id));
  const analysis = emptyDelayHotspotAnalysis();
  analysis.totals.analyzedAttemptCount = included.length;
  analysis.totals.excludedAttemptCount = input.attempts.length - included.length;

  const members: Member[] = [];
  const unlocatedAttempts = new Set<string>();
  for (const item of included) {
    for (const event of item.waitEvents) {
      if (event.locationState === 'located' && event.coordinate != null) {
        members.push({
          attemptId: item.attempt.id,
          eventId: event.id,
          durationMs: event.durationMs,
          coordinate: event.coordinate,
        });
        analysis.totals.locatedWaitMs += event.durationMs;
      } else {
        analysis.totals.unlocatedWaitMs += event.durationMs;
        analysis.totals.unlocatedEventCount += 1;
        unlocatedAttempts.add(item.attempt.id);
      }
    }
  }
  analysis.totals.unlocatedAttemptCount = unlocatedAttempts.size;

  const attemptById = new Map(included.map((item) => [item.attempt.id, item]));
  const hotspots: DelayHotspot[] = [];
  const encounterCache = new Map<string, boolean>();
  for (const cluster of clusterMembers(members, diameter)) {
    const byAttempt = groupByAttempt(cluster);
    if (byAttempt.size < HOTSPOT_MIN_WAITED_ATTEMPTS) {
      analysis.totals.oneOffWaitMs += cluster.reduce((sum, member) => sum + member.durationMs, 0);
      continue;
    }
    const hotspot = buildHotspot(cluster, byAttempt, included, attemptById, input.asOfMs, encounterCache);
    analysis.totals.recurringWaitMs += hotspot.totalWaitMs;
    hotspots.push(hotspot);
  }
  analysis.hotspots = rankDelayHotspots(hotspots, 'total');
  return analysis;
}

/** Deterministic ordering; the final tie-break is the stable hotspot id. */
export function rankDelayHotspots(
  hotspots: readonly DelayHotspot[],
  order: DelayHotspotOrder,
): DelayHotspot[] {
  return [...hotspots].sort((a, b) => {
    if (order === 'frequency') {
      if (a.waitedRatio !== b.waitedRatio) {
        return b.waitedRatio - a.waitedRatio;
      }
      if (a.waitedAttempts !== b.waitedAttempts) {
        return b.waitedAttempts - a.waitedAttempts;
      }
      if (a.totalWaitMs !== b.totalWaitMs) {
        return b.totalWaitMs - a.totalWaitMs;
      }
    } else {
      if (a.totalWaitMs !== b.totalWaitMs) {
        return b.totalWaitMs - a.totalWaitMs;
      }
      if (a.waitedAttempts !== b.waitedAttempts) {
        return b.waitedAttempts - a.waitedAttempts;
      }
      if (a.worstWaitMs !== b.worstWaitMs) {
        return b.worstWaitMs - a.worstWaitMs;
      }
    }
    return a.id.localeCompare(b.id);
  });
}

/** Default list is capped; expanding shows every recurring hotspot. */
export function visibleDelayHotspots(
  ranked: readonly DelayHotspot[],
  expanded: boolean,
): DelayHotspot[] {
  return expanded ? [...ranked] : ranked.slice(0, HOTSPOT_DEFAULT_VISIBLE_COUNT);
}

function isIncluded(
  item: HotspotAttemptInput,
  input: { pool: JourneyPoolId; origin: Place; destination: Place },
  poolKey: string,
): boolean {
  const { attempt, route } = item;
  if (!item.compatible || !route || !isJourneyCompetitive(attempt)) {
    return false;
  }
  if (
    attempt.routeId !== route.id ||
    attempt.originPlaceId == null ||
    attempt.destinationPlaceId == null ||
    journeyPoolKey({
      originPlaceId: attempt.originPlaceId,
      destinationPlaceId: attempt.destinationPlaceId,
      transportationMode: attempt.transportationMode,
    }) !== poolKey
  ) {
    return false;
  }
  return routeEndpointsMatchJourney(
    route,
    input.origin,
    input.destination,
    input.pool.transportationMode,
  );
}

function compareMembers(a: Member, b: Member): number {
  if (a.coordinate.latitude !== b.coordinate.latitude) {
    return a.coordinate.latitude - b.coordinate.latitude;
  }
  if (a.coordinate.longitude !== b.coordinate.longitude) {
    return a.coordinate.longitude - b.coordinate.longitude;
  }
  const attempt = a.attemptId.localeCompare(b.attemptId);
  return attempt !== 0 ? attempt : a.eventId.localeCompare(b.eventId);
}

/**
 * Complete-linkage agglomerative clustering. Members are first split into groups that are
 * connected at the diameter (cheap, lat-sorted sweep), then merged nearest-pair-first
 * inside each group, but only while the merged cluster's largest pairwise distance stays
 * within the diameter. Output order and tie-breaks depend only on member values.
 */
function clusterMembers(members: Member[], diameter: number): Member[][] {
  const sorted = [...members].sort(compareMembers);
  const count = sorted.length;
  const parent = sorted.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    let walk = index;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const maxLatDelta = diameter / 111_320 + 1e-9;
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (sorted[j]!.coordinate.latitude - sorted[i]!.coordinate.latitude > maxLatDelta) {
        break;
      }
      if (haversineMeters(sorted[i]!.coordinate, sorted[j]!.coordinate) <= diameter) {
        const a = find(i);
        const b = find(j);
        if (a !== b) {
          parent[Math.max(a, b)] = Math.min(a, b);
        }
      }
    }
  }
  const components = new Map<number, number[]>();
  for (let i = 0; i < count; i += 1) {
    const root = find(i);
    const list = components.get(root);
    if (list) {
      list.push(i);
    } else {
      components.set(root, [i]);
    }
  }
  const clusters: Member[][] = [];
  for (const root of [...components.keys()].sort((a, b) => a - b)) {
    for (const group of completeLinkage(components.get(root)!.map((i) => sorted[i]!), diameter)) {
      clusters.push(group);
    }
  }
  return clusters;
}

function completeLinkage(points: Member[], diameter: number): Member[][] {
  const n = points.length;
  if (n === 1) {
    return [points];
  }
  const dist: number[][] = points.map((a) =>
    points.map((b) => (a === b ? 0 : haversineMeters(a.coordinate, b.coordinate))),
  );
  const groups: number[][] = points.map((_, index) => [index]);
  const alive = points.map(() => true);
  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (!alive[i]) {
        continue;
      }
      for (let j = i + 1; j < n; j += 1) {
        if (alive[j] && dist[i]![j]! <= diameter && dist[i]![j]! < best) {
          best = dist[i]![j]!;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) {
      break;
    }
    groups[bestI] = [...groups[bestI]!, ...groups[bestJ]!];
    alive[bestJ] = false;
    for (let k = 0; k < n; k += 1) {
      if (alive[k] && k !== bestI) {
        const merged = Math.max(dist[bestI]![k]!, dist[bestJ]![k]!);
        dist[bestI]![k] = merged;
        dist[k]![bestI] = merged;
      }
    }
  }
  return groups
    .map((group, index) => (alive[index] ? group : null))
    .filter((group): group is number[] => group != null)
    .map((group) => group.map((index) => points[index]!));
}

function groupByAttempt(cluster: Member[]): Map<string, Member[]> {
  const byAttempt = new Map<string, Member[]>();
  for (const member of cluster) {
    const list = byAttempt.get(member.attemptId);
    if (list) {
      list.push(member);
    } else {
      byAttempt.set(member.attemptId, [member]);
    }
  }
  return byAttempt;
}

function buildHotspot(
  cluster: Member[],
  byAttempt: Map<string, Member[]>,
  included: HotspotAttemptInput[],
  attemptById: Map<string, HotspotAttemptInput>,
  asOfMs: number,
  encounterCache: Map<string, boolean>,
): DelayHotspot {
  const coordinate: LatLng = {
    latitude: cluster.reduce((sum, member) => sum + member.coordinate.latitude, 0) / cluster.length,
    longitude: cluster.reduce((sum, member) => sum + member.coordinate.longitude, 0) / cluster.length,
  };
  let spreadMeters = 0;
  for (let i = 0; i < cluster.length; i += 1) {
    for (let j = i + 1; j < cluster.length; j += 1) {
      spreadMeters = Math.max(
        spreadMeters,
        haversineMeters(cluster[i]!.coordinate, cluster[j]!.coordinate),
      );
    }
  }
  const id = `hotspot:${cluster
    .map((member) => `${member.attemptId}|${member.eventId}`)
    .sort()[0]!}`;

  const contributions: DelayHotspotContribution[] = [...byAttempt.entries()]
    .map(([attemptId, events]) => ({
      attemptId,
      finishedAtMs: attemptById.get(attemptId)?.attempt.finishedAtMs ?? null,
      waitMs: events.reduce((sum, event) => sum + event.durationMs, 0),
      eventCount: events.length,
      eventIds: events.map((event) => event.eventId).sort(),
    }))
    .sort((a, b) => {
      const aFinished = a.finishedAtMs ?? 0;
      const bFinished = b.finishedAtMs ?? 0;
      return aFinished !== bFinished ? bFinished - aFinished : a.attemptId.localeCompare(b.attemptId);
    });

  const waitedMs = contributions.map((item) => item.waitMs);
  const totalWaitMs = waitedMs.reduce((sum, value) => sum + value, 0);
  const worst = [...contributions].sort((a, b) =>
    a.waitMs !== b.waitMs ? b.waitMs - a.waitMs : a.attemptId.localeCompare(b.attemptId),
  )[0]!;

  const encountered = included.filter(
    (item) =>
      byAttempt.has(item.attempt.id) ||
      routePassesHotspot(item.route, coordinate, `${id}|${item.route?.id ?? ''}`, encounterCache),
  );
  const waitedAttempts = contributions.length;

  return {
    id,
    coordinate,
    spreadMeters,
    confidence: confidenceFor(waitedAttempts, spreadMeters),
    encounteredAttempts: encountered.length,
    waitedAttempts,
    waitedRatio: encountered.length > 0 ? waitedAttempts / encountered.length : 0,
    eventCount: cluster.length,
    totalWaitMs,
    averageWaitMs: totalWaitMs / waitedAttempts,
    medianWaitMs: median(waitedMs),
    worstWaitMs: worst.waitMs,
    worstAttemptId: worst.attemptId,
    trend: computeTrend(encountered, byAttempt, contributions, asOfMs),
    contributions,
  };
}

function routePassesHotspot(
  route: Route | null,
  coordinate: LatLng,
  cacheKey: string,
  cache: Map<string, boolean>,
): boolean {
  if (!route) {
    return false;
  }
  const cached = cache.get(cacheKey);
  if (cached != null) {
    return cached;
  }
  const projection = projectOntoReferencePath(route.referencePath, coordinate);
  const passes =
    projection != null && projection.snapDistanceMeters <= HOTSPOT_ENCOUNTER_RADIUS_METERS;
  cache.set(cacheKey, passes);
  return passes;
}

function confidenceFor(waitedAttempts: number, spreadMeters: number): HotspotConfidence {
  if (
    waitedAttempts >= HOTSPOT_HIGH_CONFIDENCE_MIN_WAITED &&
    spreadMeters <= HOTSPOT_HIGH_CONFIDENCE_MAX_SPREAD_METERS
  ) {
    return 'high';
  }
  return waitedAttempts >= HOTSPOT_MEDIUM_CONFIDENCE_MIN_WAITED ? 'medium' : 'low';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Recent vs all-time mean confirmed waiting per encountered attempt. Null unless the
 * recent window and the older baseline both have enough encountered attempts.
 */
function computeTrend(
  encountered: HotspotAttemptInput[],
  byAttempt: Map<string, Member[]>,
  contributions: DelayHotspotContribution[],
  asOfMs: number,
): HotspotTrend | null {
  const waitById = new Map(contributions.map((item) => [item.attemptId, item.waitMs]));
  let recentCount = 0;
  let recentTotal = 0;
  let olderCount = 0;
  let allTotal = 0;
  for (const item of encountered) {
    const waitMs = byAttempt.has(item.attempt.id) ? (waitById.get(item.attempt.id) ?? 0) : 0;
    allTotal += waitMs;
    const finishedAtMs = item.attempt.finishedAtMs;
    if (
      finishedAtMs != null &&
      isInRollingElapsedWindow(finishedAtMs, asOfMs, HOTSPOT_TREND_RECENT_WINDOW_DAYS)
    ) {
      recentCount += 1;
      recentTotal += waitMs;
    } else {
      olderCount += 1;
    }
  }
  if (recentCount < HOTSPOT_TREND_MIN_RECENT_ENCOUNTERS || olderCount < HOTSPOT_TREND_MIN_OLDER_ENCOUNTERS) {
    return null;
  }
  const recentMeanWaitMs = recentTotal / recentCount;
  const allTimeMeanWaitMs = allTotal / encountered.length;
  const delta = recentMeanWaitMs - allTimeMeanWaitMs;
  const band = Math.max(MIN_USER_VISIBLE_WAIT_MS, HOTSPOT_TREND_STEADY_RATIO * allTimeMeanWaitMs);
  return {
    direction: Math.abs(delta) <= band ? 'steady' : delta > 0 ? 'worse' : 'better',
    recentEncountered: recentCount,
    recentMeanWaitMs,
    allTimeMeanWaitMs,
  };
}
