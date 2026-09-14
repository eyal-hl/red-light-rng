import { isJourneyCompetitive, officialTimeMs, type Attempt } from './attempt';
import { defaultCourseProgress } from './course-layout';
import {
  createCourseMatchState,
  MAX_SAMPLE_ACCURACY_METERS,
  matchSampleToCourse,
} from './course-matching';
import { haversineMeters, pathDistanceMeters, type LatLng } from './geo';
import type { JourneyPoolId } from './journey';
import type { LocationSample } from './location-sample';
import { pointAtProgress } from './path-projection';
import {
  isCompatiblePathVariant,
  listCompatiblePathVariants,
  pathVariantsForJourney,
} from './path-variant';
import { placeZone, type Place } from './place';
import type { Route, TransportationMode } from './route';
import { MIN_REFERENCE_POINTS, MIN_STEP_METERS } from './route-derivation';

export const PATH_VARIANT_CLASSIFICATION_VERSION = 1;
export const PATH_VARIANT_RECURRENCE_MIN_ATTEMPTS = 3;
export const PATH_SHAPE_SPACING_METERS = 10;

export type JourneyAttemptTrace = {
  attempt: Attempt;
  samples: LocationSample[];
};

export type PathVariantAssignment = {
  attemptId: string;
  routeId: string | null;
};

export type PathVariantRecomputePlan = {
  classificationVersion: number;
  newRoutes: Route[];
  assignments: PathVariantAssignment[];
};

export type JourneyPathVariantSummary = {
  route: Route;
  attemptCount: number;
  pbTimeMs: number | null;
  typicalTimeMs: number | null;
};

type TimingWindow = {
  startedAtMs: number;
  finishedAtMs: number;
};

type PreparedTrace = {
  attempt: Attempt;
  samples: LocationSample[];
  window: TimingWindow;
  shape: LatLng[];
};

export function clipTrustworthyWindowSamples(
  samples: LocationSample[],
  window: TimingWindow,
): LocationSample[] {
  return samples.filter((sample) => {
    if (sample.recordedAtMs < window.startedAtMs || sample.recordedAtMs > window.finishedAtMs) {
      return false;
    }
    if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) {
      return false;
    }
    if (
      sample.horizontalAccuracyMeters != null &&
      sample.horizontalAccuracyMeters > MAX_SAMPLE_ACCURACY_METERS
    ) {
      return false;
    }
    return true;
  });
}

export function resamplePolyline(
  path: LatLng[],
  spacingMeters: number = PATH_SHAPE_SPACING_METERS,
): LatLng[] {
  if (path.length === 0) {
    return [];
  }
  const total = pathDistanceMeters(path);
  if (total <= 0) {
    return [{ ...path[0]! }];
  }
  const points: LatLng[] = [];
  for (let progress = 0; progress < total; progress += spacingMeters) {
    points.push(pointAtProgress(path, progress));
  }
  const end = pointAtProgress(path, total);
  const last = points[points.length - 1];
  if (!last || haversineMeters(last, end) > 0.5) {
    points.push(end);
  }
  return points;
}

export function preparePathShape(samples: LocationSample[], window: TimingWindow): LatLng[] | null {
  const clipped = clipTrustworthyWindowSamples(samples, window);
  if (clipped.length < MIN_REFERENCE_POINTS) {
    return null;
  }
  const simplified: LatLng[] = [];
  for (const sample of clipped) {
    const point = { latitude: sample.latitude, longitude: sample.longitude };
    const last = simplified[simplified.length - 1];
    if (!last || haversineMeters(last, point) >= MIN_STEP_METERS) {
      simplified.push(point);
    }
  }
  const finish = clipped[clipped.length - 1];
  if (finish) {
    const finishPoint = { latitude: finish.latitude, longitude: finish.longitude };
    const last = simplified[simplified.length - 1];
    if (!last || haversineMeters(last, finishPoint) > 0.5) {
      simplified.push(finishPoint);
    }
  }
  if (simplified.length < MIN_REFERENCE_POINTS) {
    return null;
  }
  const resampled = resamplePolyline(simplified, PATH_SHAPE_SPACING_METERS);
  return resampled.length >= MIN_REFERENCE_POINTS ? resampled : null;
}

export function clusterSignature(
  path: LatLng[],
  version: number = PATH_VARIANT_CLASSIFICATION_VERSION,
): string {
  const body = path.map((point) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`).join(';');
  return `v${version}:${body}`;
}

export function defaultDiscoveredPathName(existingNames: Iterable<string>): string {
  const used = new Set(existingNames);
  let index = 1;
  while (used.has(`Path ${index}`)) {
    index += 1;
  }
  return `Path ${index}`;
}

export function routeFromDiscoveredShape(
  shape: LatLng[],
  origin: Place,
  destination: Place,
  transportationMode: TransportationMode,
  fields: Pick<
    Route,
    | 'id'
    | 'name'
    | 'createdAtMs'
    | 'sourceRecordingId'
    | 'status'
    | 'kind'
    | 'clusterSignature'
    | 'classificationVersion'
  >,
): Route {
  const progress = defaultCourseProgress(shape);
  return {
    ...fields,
    transportationMode,
    referencePath: shape.map((point) => ({ ...point })),
    startZone: placeZone(origin),
    finishZone: placeZone(destination),
    startProgressMeters: progress.startProgressMeters,
    finishProgressMeters: progress.finishProgressMeters,
    checkpoints: [],
  };
}

function attemptWindow(attempt: Attempt): TimingWindow | null {
  if (attempt.startedAtMs == null || attempt.finishedAtMs == null) {
    return null;
  }
  return { startedAtMs: attempt.startedAtMs, finishedAtMs: attempt.finishedAtMs };
}

function tracesCompatible(
  left: PreparedTrace,
  right: PreparedTrace,
  origin: Place,
  destination: Place,
): boolean {
  const leftRoute = routeFromDiscoveredShape(
    left.shape,
    origin,
    destination,
    left.attempt.transportationMode,
    {
      id: `shape:${left.attempt.id}`,
      name: left.attempt.id,
      createdAtMs: left.attempt.armedAtMs,
      sourceRecordingId: left.attempt.sessionId,
      status: 'active',
      kind: 'discovered',
      clusterSignature: null,
      classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
    },
  );
  const rightRoute = routeFromDiscoveredShape(
    right.shape,
    origin,
    destination,
    right.attempt.transportationMode,
    {
      id: `shape:${right.attempt.id}`,
      name: right.attempt.id,
      createdAtMs: right.attempt.armedAtMs,
      sourceRecordingId: right.attempt.sessionId,
      status: 'active',
      kind: 'discovered',
      clusterSignature: null,
      classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
    },
  );
  return (
    isCompatiblePathVariant(leftRoute, right.samples, right.window) &&
    isCompatiblePathVariant(rightRoute, left.samples, left.window)
  );
}

function completeLinkageClusters(
  prepared: PreparedTrace[],
  origin: Place,
  destination: Place,
): PreparedTrace[][] {
  const byId = new Map(prepared.map((trace) => [trace.attempt.id, trace] as const));
  const ids = [...byId.keys()].sort((a, b) => a.localeCompare(b));
  const compatible = new Map<string, boolean>();
  const pairKey = (left: string, right: string) => (left < right ? `${left}|${right}` : `${right}|${left}`);
  for (let i = 0; i < ids.length; i += 1) {
    const leftId = ids[i]!;
    const left = byId.get(leftId)!;
    for (let j = i + 1; j < ids.length; j += 1) {
      const rightId = ids[j]!;
      const right = byId.get(rightId)!;
      compatible.set(pairKey(leftId, rightId), tracesCompatible(left, right, origin, destination));
    }
  }

  let clusters: string[][] = ids.map((id) => [id]);
  const canMerge = (left: string[], right: string[]) => {
    for (const leftId of left) {
      for (const rightId of right) {
        if (!compatible.get(pairKey(leftId, rightId))) {
          return false;
        }
      }
    }
    return true;
  };

  while (clusters.length > 1) {
    let best: { left: number; right: number; members: string[] } | null = null;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const left = clusters[i]!;
        const right = clusters[j]!;
        if (!canMerge(left, right)) {
          continue;
        }
        const members = [...left, ...right].sort((a, b) => a.localeCompare(b));
        if (
          !best ||
          members.length > best.members.length ||
          (members.length === best.members.length && members.join('|') < best.members.join('|'))
        ) {
          best = { left: i, right: j, members };
        }
      }
    }
    if (!best) {
      break;
    }
    clusters = clusters.filter((_, index) => index !== best.left && index !== best.right);
    clusters.push(best.members);
  }

  return clusters
    .map((memberIds) =>
      memberIds
        .slice()
        .sort((a, b) => a.localeCompare(b))
        .map((id) => byId.get(id)!),
    )
    .sort((a, b) => {
      if (b.length !== a.length) {
        return b.length - a.length;
      }
      return a[0]!.attempt.id.localeCompare(b[0]!.attempt.id);
    });
}

function meanAcceptedSnapMeters(route: Route, samples: LocationSample[], window: TimingWindow): number {
  const inWindow = samples.filter(
    (sample) => sample.recordedAtMs >= window.startedAtMs && sample.recordedAtMs <= window.finishedAtMs,
  );
  let total = 0;
  let count = 0;
  let state = createCourseMatchState();
  for (const sample of inWindow) {
    const match = matchSampleToCourse(route.referencePath, sample, state, route.startProgressMeters);
    if (match.quality === 'poor_accuracy') {
      continue;
    }
    if (match.accepted && match.distanceFromPathMeters != null) {
      total += match.distanceFromPathMeters;
      count += 1;
      state = match.state;
    }
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count;
}

function pickMedoid(cluster: PreparedTrace[], origin: Place, destination: Place): PreparedTrace {
  const ranked = [...cluster].sort((a, b) => a.attempt.id.localeCompare(b.attempt.id));
  let best = ranked[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of ranked) {
    const route = routeFromDiscoveredShape(
      candidate.shape,
      origin,
      destination,
      candidate.attempt.transportationMode,
      {
        id: `medoid:${candidate.attempt.id}`,
        name: candidate.attempt.id,
        createdAtMs: candidate.attempt.armedAtMs,
        sourceRecordingId: candidate.attempt.sessionId,
        status: 'active',
        kind: 'discovered',
        clusterSignature: null,
        classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
      },
    );
    let score = 0;
    for (const other of ranked) {
      if (other.attempt.id === candidate.attempt.id) {
        continue;
      }
      score += meanAcceptedSnapMeters(route, other.samples, other.window);
    }
    if (score < bestScore || (score === bestScore && candidate.attempt.id < best.attempt.id)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function matchesExistingVariant(
  trace: PreparedTrace,
  variants: Route[],
  origin: Place,
  destination: Place,
): Route[] {
  return listCompatiblePathVariants(
    variants,
    origin,
    destination,
    trace.attempt.transportationMode,
    trace.samples,
    trace.window,
    { includeArchived: true },
  );
}

function syntheticSamplesAlong(path: LatLng[], window: TimingWindow): LocationSample[] {
  const resampled = resamplePolyline(path, PATH_SHAPE_SPACING_METERS);
  const span = Math.max(1, window.finishedAtMs - window.startedAtMs);
  return resampled.map((point, index) => ({
    id: `synthetic-${index}`,
    sessionId: 'synthetic',
    recordedAtMs: window.startedAtMs + Math.round((index / Math.max(1, resampled.length - 1)) * span),
    latitude: point.latitude,
    longitude: point.longitude,
    horizontalAccuracyMeters: 5,
    speedMetersPerSecond: 4,
    headingDegrees: 0,
  }));
}

function variantConsumesCluster(
  medoid: PreparedTrace,
  variants: Route[],
  origin: Place,
  destination: Place,
): boolean {
  const signature = clusterSignature(medoid.shape);
  if (variants.some((route) => route.clusterSignature === signature)) {
    return true;
  }
  const medoidRoute = routeFromDiscoveredShape(
    medoid.shape,
    origin,
    destination,
    medoid.attempt.transportationMode,
    {
      id: `probe:${medoid.attempt.id}`,
      name: medoid.attempt.id,
      createdAtMs: medoid.attempt.armedAtMs,
      sourceRecordingId: medoid.attempt.sessionId,
      status: 'active',
      kind: 'discovered',
      clusterSignature: signature,
      classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
    },
  );
  return variants.some((route) => {
    if (
      pathVariantsForJourney([route], origin, destination, medoid.attempt.transportationMode).length === 0
    ) {
      return false;
    }
    return (
      isCompatiblePathVariant(route, medoid.samples, medoid.window) &&
      isCompatiblePathVariant(medoidRoute, syntheticSamplesAlong(route.referencePath, medoid.window), medoid.window)
    );
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
  }
  return sorted[middle]!;
}

export function summarizeJourneyPathVariants(
  origin: Place,
  destination: Place,
  transportationMode: TransportationMode,
  traces: JourneyAttemptTrace[],
  routes: Route[],
): JourneyPathVariantSummary[] {
  const variants = pathVariantsForJourney(routes, origin, destination, transportationMode, {
    includeArchived: false,
  });
  const competitive = traces.map((trace) => trace.attempt).filter(isJourneyCompetitive);
  return variants.map((route) => {
    const assigned = competitive.filter((attempt) => attempt.routeId === route.id);
    const times = assigned
      .map((attempt) => officialTimeMs(attempt))
      .filter((time): time is number => time != null)
      .sort((a, b) => a - b);
    return {
      route,
      attemptCount: assigned.length,
      pbTimeMs: times[0] ?? null,
      typicalTimeMs: median(times),
    };
  });
}

export function planPathVariantRecompute(input: {
  pool: JourneyPoolId;
  origin: Place;
  destination: Place;
  traces: JourneyAttemptTrace[];
  routes: Route[];
  nowMs: number;
  createRouteId: () => string;
}): PathVariantRecomputePlan {
  const { pool, origin, destination, traces, routes, nowMs, createRouteId } = input;
  const existing = pathVariantsForJourney(routes, origin, destination, pool.transportationMode);
  const competitive = traces.filter(
    (trace) =>
      isJourneyCompetitive(trace.attempt) &&
      trace.attempt.originPlaceId === pool.originPlaceId &&
      trace.attempt.destinationPlaceId === pool.destinationPlaceId &&
      trace.attempt.transportationMode === pool.transportationMode,
  );

  const prepared: PreparedTrace[] = [];
  for (const trace of competitive) {
    const window = attemptWindow(trace.attempt);
    if (!window) {
      continue;
    }
    const shape = preparePathShape(trace.samples, window);
    if (!shape) {
      continue;
    }
    prepared.push({
      attempt: trace.attempt,
      samples: trace.samples,
      window,
      shape,
    });
  }

  const discoveryPool = prepared.filter(
    (trace) => matchesExistingVariant(trace, existing, origin, destination).length === 0,
  );
  const clusters = completeLinkageClusters(discoveryPool, origin, destination);
  const newRoutes: Route[] = [];
  const usedNames = existing.map((route) => route.name);

  for (const cluster of clusters) {
    if (cluster.length < PATH_VARIANT_RECURRENCE_MIN_ATTEMPTS) {
      continue;
    }
    const medoid = pickMedoid(cluster, origin, destination);
    const considered = [...existing, ...newRoutes];
    if (variantConsumesCluster(medoid, considered, origin, destination)) {
      continue;
    }
    const name = defaultDiscoveredPathName(usedNames);
    usedNames.push(name);
    newRoutes.push(
      routeFromDiscoveredShape(medoid.shape, origin, destination, pool.transportationMode, {
        id: createRouteId(),
        name,
        createdAtMs: nowMs,
        sourceRecordingId: medoid.attempt.sessionId,
        status: 'active',
        kind: 'discovered',
        clusterSignature: clusterSignature(medoid.shape),
        classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
      }),
    );
  }

  const allVariants = [...existing, ...newRoutes];
  const assignments: PathVariantAssignment[] = competitive.map((trace) => {
    const window = attemptWindow(trace.attempt);
    if (!window) {
      return { attemptId: trace.attempt.id, routeId: null };
    }
    const matches = listCompatiblePathVariants(
      allVariants,
      origin,
      destination,
      pool.transportationMode,
      trace.samples,
      window,
      { includeArchived: false },
    );
    return {
      attemptId: trace.attempt.id,
      routeId: matches.length === 1 ? matches[0]!.id : null,
    };
  });

  return {
    classificationVersion: PATH_VARIANT_CLASSIFICATION_VERSION,
    newRoutes,
    assignments,
  };
}
