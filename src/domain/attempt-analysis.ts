import type { Attempt } from './attempt';
import {
  finishTriggerProgressMeters,
  replayAttemptTrace,
  START_PROGRESS_NOISE_METERS,
  type AttemptEngineState,
  type DerivedCrossing,
  type TimingCourse,
} from './attempt-timing';
import { orderedCheckpoints, type RouteCheckpoint } from './course-layout';
import type { LocationSample } from './location-sample';
import {
  analyzeAttemptMovementTimeline,
  emptyMovementBreakdown,
  type MovementBreakdown,
} from './movement-analysis';
import type { Route } from './route';
import { compareAttemptGhost, type GhostComparison } from './ghost-comparison';
import { compareAttemptWaiting, type WaitComparison } from './wait-comparison';
import { deriveWaitEvents, type WaitEvent } from './wait-events';

export type AttemptUnavailabilityReason =
  | 'missing_telemetry'
  | 'not_completed'
  | 'not_valid'
  | 'missing_start_coverage'
  | 'replay_incomplete';

export type SegmentEndpoint =
  | { kind: 'start'; label: string }
  | { kind: 'checkpoint'; id: string; name: string }
  | { kind: 'finish'; label: string };

export type SegmentSpec = {
  id: string;
  from: SegmentEndpoint;
  to: SegmentEndpoint;
};

export type SegmentTiming = {
  spec: SegmentSpec;
  durationMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
};

export type CurrentLayoutAttempt = {
  attemptId: string;
  routeId: string;
  armedAtMs: number;
  recordedFinishedAtMs: number | null;
  layoutIdentity: string;
  eligible: boolean;
  unavailabilityReason: AttemptUnavailabilityReason | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  officialTimeMs: number | null;
  movement: MovementBreakdown | null;
  waitEvents: WaitEvent[];
  segments: SegmentTiming[];
};

export type AttemptTrace = {
  attempt: Attempt;
  samples: LocationSample[];
};

export type AnalyzedSegment = SegmentTiming & {
  pbRunDurationMs: number | null;
  deltaVsPbRunMs: number | null;
  goldDurationMs: number | null;
  isNewGold: boolean;
};

export type RouteCompetitiveSummary = {
  layoutIdentity: string;
  rankedAttemptCount: number;
  pbAttemptId: string | null;
  pbTimeMs: number | null;
  lastAttemptId: string | null;
  lastTimeMs: number | null;
  lastFinishedAtMs: number | null;
  sumOfBestMs: number | null;
};

export type HistoryRow = {
  attemptId: string;
  armedAtMs: number;
  finishedAtMs: number | null;
  officialTimeMs: number | null;
  rank: number | null;
  isPb: boolean;
  eligible: boolean;
  unavailabilityReason: AttemptUnavailabilityReason | null;
};

export type RouteAttemptAnalysis = {
  layoutIdentity: string;
  derived: CurrentLayoutAttempt[];
  competitive: CurrentLayoutAttempt[];
  ranked: CurrentLayoutAttempt[];
  summary: RouteCompetitiveSummary;
  chronologicalHistory: HistoryRow[];
  rankedHistory: HistoryRow[];
};

export type FocusAttemptAnalysis = {
  focus: CurrentLayoutAttempt;
  summary: RouteCompetitiveSummary;
  rank: number | null;
  isPb: boolean;
  previousAttemptId: string | null;
  previousTimeMs: number | null;
  deltaVsPreviousMs: number | null;
  pbBeforeThisTimeMs: number | null;
  deltaVsPbMs: number | null;
  comparisonPbAttemptId: string | null;
  waitingComparison: WaitComparison;
  ghostComparison: GhostComparison;
  segments: AnalyzedSegment[];
  sumOfBestMs: number | null;
};

export function timingCourseFromRoute(route: Route): TimingCourse {
  return {
    referencePath: route.referencePath,
    startProgressMeters: route.startProgressMeters,
    finishProgressMeters: route.finishProgressMeters,
    startZone: route.startZone,
    finishZone: route.finishZone,
    checkpoints: route.checkpoints,
  };
}

export function courseLayoutIdentity(course: TimingCourse): string {
  const checkpoints = orderedCheckpoints(course.checkpoints)
    .map((checkpoint) => `${checkpoint.id}:${stableQty(checkpoint.progressMeters)}`)
    .join(',');
  return [
    `start=${stableQty(course.startProgressMeters)}`,
    `finish=${stableQty(course.finishProgressMeters)}`,
    `startR=${stableQty(course.startZone.radiusMeters)}`,
    `finishR=${stableQty(course.finishZone.radiusMeters)}`,
    `finishTrigger=${stableQty(finishTriggerProgressMeters(course))}`,
    `cp=[${checkpoints}]`,
  ].join('|');
}

export function interiorCheckpoints(course: TimingCourse): RouteCheckpoint[] {
  return orderedCheckpoints(course.checkpoints).filter(
    (checkpoint) =>
      checkpoint.progressMeters > course.startProgressMeters &&
      checkpoint.progressMeters < course.finishProgressMeters,
  );
}

export function segmentSpecsForCourse(course: TimingCourse): SegmentSpec[] {
  const checkpoints = interiorCheckpoints(course);
  const points: SegmentEndpoint[] = [
    { kind: 'start', label: 'Start' },
    ...checkpoints.map((checkpoint) => ({
      kind: 'checkpoint' as const,
      id: checkpoint.id,
      name: checkpoint.name,
    })),
    { kind: 'finish', label: 'Finish' },
  ];
  const specs: SegmentSpec[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (!from || !to) {
      continue;
    }
    specs.push({
      id: `${endpointId(from)}->${endpointId(to)}`,
      from,
      to,
    });
  }
  return specs;
}

export function startCoverageThresholdMeters(startProgressMeters: number): number {
  if (startProgressMeters <= START_PROGRESS_NOISE_METERS) {
    return START_PROGRESS_NOISE_METERS;
  }
  return startProgressMeters;
}

export function hasStartCoverage(
  accepted: { progressMeters: number }[],
  startProgressMeters: number,
): boolean {
  const threshold = startCoverageThresholdMeters(startProgressMeters);
  return accepted.some((sample) => sample.progressMeters <= threshold);
}

export function deriveCurrentLayoutAttempt(
  course: TimingCourse,
  attempt: Attempt,
  samples: LocationSample[],
): CurrentLayoutAttempt {
  const layoutIdentity = courseLayoutIdentity(course);
  const specs = segmentSpecsForCourse(course);
  const unavailable = (reason: AttemptUnavailabilityReason): CurrentLayoutAttempt => ({
    attemptId: attempt.id,
    routeId: attempt.routeId,
    armedAtMs: attempt.armedAtMs,
    recordedFinishedAtMs: attempt.finishedAtMs,
    layoutIdentity,
    eligible: false,
    unavailabilityReason: reason,
    startedAtMs: null,
    finishedAtMs: null,
    officialTimeMs: null,
    movement: null,
    waitEvents: [],
    segments: specs.map((spec) => unavailableSegment(spec)),
  });

  if (attempt.lifecycle !== 'completed') {
    return unavailable('not_completed');
  }

  if (samples.length === 0) {
    return unavailable('missing_telemetry');
  }

  const engine = replayAttemptTrace(course, samples);
  if (engine.lifecycle !== 'completed' || engine.startedAtMs == null || engine.finishedAtMs == null) {
    return unavailable('replay_incomplete');
  }
  if (engine.validity !== 'valid') {
    return unavailable('not_valid');
  }
  if (!hasStartCoverage(engine.accepted, course.startProgressMeters)) {
    return unavailable('missing_start_coverage');
  }

  const segments = deriveSegmentTimings(specs, interiorCheckpoints(course), engine);
  const officialTimeMs = Math.max(0, engine.finishedAtMs - engine.startedAtMs);
  const timeline =
    officialTimeMs > 0
      ? analyzeAttemptMovementTimeline({
          course,
          samples,
          startedAtMs: engine.startedAtMs,
          finishedAtMs: engine.finishedAtMs,
        })
      : { breakdown: emptyMovementBreakdown(officialTimeMs), intervals: [] };
  const waitEvents = deriveWaitEvents({
    intervals: timeline.intervals,
    startedAtMs: engine.startedAtMs,
    referencePath: course.referencePath,
  });
  return {
    attemptId: attempt.id,
    routeId: attempt.routeId,
    armedAtMs: attempt.armedAtMs,
    recordedFinishedAtMs: attempt.finishedAtMs,
    layoutIdentity,
    eligible: true,
    unavailabilityReason: null,
    startedAtMs: engine.startedAtMs,
    finishedAtMs: engine.finishedAtMs,
    officialTimeMs,
    movement: timeline.breakdown,
    waitEvents,
    segments,
  };
}

export function analyzeRouteAttempts(course: TimingCourse, traces: AttemptTrace[]): RouteAttemptAnalysis {
  const layoutIdentity = courseLayoutIdentity(course);
  const derived = traces.map((trace) => deriveCurrentLayoutAttempt(course, trace.attempt, trace.samples));
  const competitive = derived.filter((item) => item.eligible && item.officialTimeMs != null);
  const ranked = [...competitive].sort(compareCompetitive);
  const chronological = [...competitive].sort(compareChronological);
  const last = chronological[0] ?? null;
  const pb = ranked[0] ?? null;
  const specs = segmentSpecsForCourse(course);
  const golds = goldDurations(specs, competitive);
  const sumOfBestMs = sumOfBest(specs, golds);

  const summary: RouteCompetitiveSummary = {
    layoutIdentity,
    rankedAttemptCount: competitive.length,
    pbAttemptId: pb?.attemptId ?? null,
    pbTimeMs: pb?.officialTimeMs ?? null,
    lastAttemptId: last?.attemptId ?? null,
    lastTimeMs: last?.officialTimeMs ?? null,
    lastFinishedAtMs: last?.finishedAtMs ?? null,
    sumOfBestMs,
  };

  const rankById = new Map(ranked.map((item, index) => [item.attemptId, index + 1]));
  const historyRows = traces
    .map((trace) => derived.find((item) => item.attemptId === trace.attempt.id))
    .filter((item): item is CurrentLayoutAttempt => item != null)
    .filter((item) => shouldShowInHistory(item, traces.find((trace) => trace.attempt.id === item.attemptId)?.attempt))
    .map((item) => toHistoryRow(item, rankById, pb?.attemptId ?? null));

  const chronologicalHistory = [...historyRows].sort((a, b) => {
    const aTime = a.finishedAtMs ?? a.armedAtMs;
    const bTime = b.finishedAtMs ?? b.armedAtMs;
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    if (a.armedAtMs !== b.armedAtMs) {
      return b.armedAtMs - a.armedAtMs;
    }
    return b.attemptId.localeCompare(a.attemptId);
  });
  const rankedHistory = historyRows
    .filter((row) => row.eligible && row.rank != null)
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));

  return {
    layoutIdentity,
    derived,
    competitive,
    ranked,
    summary,
    chronologicalHistory,
    rankedHistory,
  };
}

export function analyzeFocusAttempt(
  course: TimingCourse,
  traces: AttemptTrace[],
  focusAttemptId: string,
): FocusAttemptAnalysis | null {
  const routeAnalysis = analyzeRouteAttempts(course, traces);
  const focus = routeAnalysis.derived.find((item) => item.attemptId === focusAttemptId);
  if (!focus) {
    return null;
  }

  const ranked = routeAnalysis.ranked;
  const rank = ranked.findIndex((item) => item.attemptId === focusAttemptId);
  const isPb = routeAnalysis.summary.pbAttemptId === focusAttemptId;
  const previous = previousCompetitive(routeAnalysis.competitive, focus);
  const pbBefore = pbBeforeAttempt(ranked, focus);
  const currentPbRun = ranked.find((item) => item.attemptId === routeAnalysis.summary.pbAttemptId) ?? null;
  const comparisonPbRun = isPb ? pbBefore : currentPbRun;
  const golds = goldDurations(segmentSpecsForCourse(course), routeAnalysis.competitive);
  const previousGolds = goldDurations(
    segmentSpecsForCourse(course),
    routeAnalysis.competitive.filter((item) => compareChronological(item, focus) > 0),
  );

  const currentTrace = traces.find((trace) => trace.attempt.id === focus.attemptId);
  const referenceTrace = comparisonPbRun
    ? traces.find((trace) => trace.attempt.id === comparisonPbRun.attemptId)
    : null;
  const ghostComparison = compareAttemptGhost({
    course,
    current: focus,
    currentSamples: currentTrace?.samples ?? [],
    reference: comparisonPbRun,
    referenceSamples: referenceTrace?.samples ?? [],
  });

  const segments: AnalyzedSegment[] = focus.segments.map((segment) => {
    const pbRunDurationMs = durationForSegment(comparisonPbRun, segment.spec.id);
    const goldDurationMs = golds.get(segment.spec.id) ?? null;
    const previousGold = previousGolds.get(segment.spec.id) ?? null;
    const isNewGold =
      focus.eligible &&
      segment.durationMs != null &&
      goldDurationMs != null &&
      segment.durationMs === goldDurationMs &&
      (previousGold == null || segment.durationMs < previousGold);
    return {
      ...segment,
      pbRunDurationMs,
      deltaVsPbRunMs:
        segment.durationMs != null && pbRunDurationMs != null ? segment.durationMs - pbRunDurationMs : null,
      goldDurationMs,
      isNewGold,
    };
  });

  return {
    focus,
    summary: routeAnalysis.summary,
    rank: rank >= 0 ? rank + 1 : null,
    isPb,
    previousAttemptId: previous?.attemptId ?? null,
    previousTimeMs: previous?.officialTimeMs ?? null,
    deltaVsPreviousMs:
      focus.officialTimeMs != null && previous?.officialTimeMs != null
        ? focus.officialTimeMs - previous.officialTimeMs
        : null,
    pbBeforeThisTimeMs: pbBefore?.officialTimeMs ?? null,
    deltaVsPbMs: headlineDeltaVsPb(focus, routeAnalysis.summary.pbTimeMs, pbBefore?.officialTimeMs ?? null, isPb),
    comparisonPbAttemptId: comparisonPbRun?.attemptId ?? null,
    waitingComparison: compareAttemptWaiting({
      current: focus,
      reference: comparisonPbRun,
      referencePath: course.referencePath,
    }),
    ghostComparison,
    segments,
    sumOfBestMs: routeAnalysis.summary.sumOfBestMs,
  };
}

function headlineDeltaVsPb(
  focus: CurrentLayoutAttempt,
  currentPbTimeMs: number | null,
  previousPbTimeMs: number | null,
  isPb: boolean,
): number | null {
  if (!focus.eligible || focus.officialTimeMs == null) {
    return null;
  }
  if (isPb) {
    if (previousPbTimeMs == null) {
      return null;
    }
    return focus.officialTimeMs - previousPbTimeMs;
  }
  if (currentPbTimeMs == null) {
    return null;
  }
  return focus.officialTimeMs - currentPbTimeMs;
}

function deriveSegmentTimings(
  specs: SegmentSpec[],
  checkpoints: RouteCheckpoint[],
  engine: AttemptEngineState,
): SegmentTiming[] {
  if (engine.startedAtMs == null || engine.finishedAtMs == null) {
    return specs.map((spec) => ({
      spec,
      durationMs: null,
      startedAtMs: null,
      endedAtMs: null,
    }));
  }

  const usable = usableCrossingsByCheckpointId(
    checkpoints,
    engine.crossings,
    engine.startedAtMs,
    engine.finishedAtMs,
  );

  return specs.map((spec) => {
    const startedAtMs = endpointTime(spec.from, engine.startedAtMs, engine.finishedAtMs, usable);
    const endedAtMs = endpointTime(spec.to, engine.startedAtMs, engine.finishedAtMs, usable);
    if (startedAtMs == null || endedAtMs == null || endedAtMs < startedAtMs) {
      return {
        spec,
        durationMs: null,
        startedAtMs,
        endedAtMs,
      };
    }
    return {
      spec,
      durationMs: endedAtMs - startedAtMs,
      startedAtMs,
      endedAtMs,
    };
  });
}

export function usableCrossingsByCheckpointId(
  checkpoints: RouteCheckpoint[],
  crossings: DerivedCrossing[],
  startedAtMs: number,
  finishedAtMs: number,
): Map<string, DerivedCrossing> {
  const byId = new Map<string, DerivedCrossing>();
  for (const crossing of crossings) {
    if (!byId.has(crossing.checkpointId)) {
      byId.set(crossing.checkpointId, crossing);
    }
  }

  const usable = new Map<string, DerivedCrossing>();
  let previousTime = startedAtMs;
  for (const checkpoint of checkpoints) {
    const crossing = byId.get(checkpoint.id);
    if (!crossing) {
      continue;
    }
    if (crossing.crossedAtMs < startedAtMs || crossing.crossedAtMs > finishedAtMs) {
      continue;
    }
    if (crossing.crossedAtMs <= previousTime) {
      continue;
    }
    usable.set(checkpoint.id, crossing);
    previousTime = crossing.crossedAtMs;
  }
  return usable;
}

function endpointTime(
  endpoint: SegmentEndpoint,
  startedAtMs: number | null,
  finishedAtMs: number | null,
  usable: Map<string, DerivedCrossing>,
): number | null {
  if (endpoint.kind === 'start') {
    return startedAtMs;
  }
  if (endpoint.kind === 'finish') {
    return finishedAtMs;
  }
  return usable.get(endpoint.id)?.crossedAtMs ?? null;
}

function unavailableSegment(spec: SegmentSpec): SegmentTiming {
  return { spec, durationMs: null, startedAtMs: null, endedAtMs: null };
}

function goldDurations(specs: SegmentSpec[], competitive: CurrentLayoutAttempt[]): Map<string, number> {
  const golds = new Map<string, number>();
  for (const spec of specs) {
    let best: number | null = null;
    for (const attempt of competitive) {
      const durationMs = durationForSegment(attempt, spec.id);
      if (durationMs == null) {
        continue;
      }
      if (best == null || durationMs < best) {
        best = durationMs;
      }
    }
    if (best != null) {
      golds.set(spec.id, best);
    }
  }
  return golds;
}

function sumOfBest(specs: SegmentSpec[], golds: Map<string, number>): number | null {
  if (specs.length === 0 || golds.size !== specs.length) {
    return null;
  }
  let total = 0;
  for (const spec of specs) {
    const durationMs = golds.get(spec.id);
    if (durationMs == null) {
      return null;
    }
    total += durationMs;
  }
  return total;
}

function durationForSegment(attempt: CurrentLayoutAttempt | null, segmentId: string): number | null {
  if (!attempt) {
    return null;
  }
  return attempt.segments.find((segment) => segment.spec.id === segmentId)?.durationMs ?? null;
}

function compareCompetitive(a: CurrentLayoutAttempt, b: CurrentLayoutAttempt): number {
  const aTime = a.officialTimeMs ?? Number.MAX_SAFE_INTEGER;
  const bTime = b.officialTimeMs ?? Number.MAX_SAFE_INTEGER;
  if (aTime !== bTime) {
    return aTime - bTime;
  }
  const aStarted = a.startedAtMs ?? a.armedAtMs;
  const bStarted = b.startedAtMs ?? b.armedAtMs;
  if (aStarted !== bStarted) {
    return aStarted - bStarted;
  }
  if (a.armedAtMs !== b.armedAtMs) {
    return a.armedAtMs - b.armedAtMs;
  }
  return a.attemptId.localeCompare(b.attemptId);
}

function compareChronological(a: CurrentLayoutAttempt, b: CurrentLayoutAttempt): number {
  const aTime = a.finishedAtMs ?? a.armedAtMs;
  const bTime = b.finishedAtMs ?? b.armedAtMs;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  if (a.armedAtMs !== b.armedAtMs) {
    return b.armedAtMs - a.armedAtMs;
  }
  return b.attemptId.localeCompare(a.attemptId);
}

function previousCompetitive(
  competitive: CurrentLayoutAttempt[],
  focus: CurrentLayoutAttempt,
): CurrentLayoutAttempt | null {
  const earlier = competitive
    .filter((item) => item.attemptId !== focus.attemptId)
    .filter((item) => compareChronological(item, focus) > 0)
    .sort(compareChronological);
  return earlier[0] ?? null;
}

function pbBeforeAttempt(
  ranked: CurrentLayoutAttempt[],
  focus: CurrentLayoutAttempt,
): CurrentLayoutAttempt | null {
  const earlier = ranked.filter((item) => item.attemptId !== focus.attemptId && compareChronological(item, focus) > 0);
  return [...earlier].sort(compareCompetitive)[0] ?? null;
}

function shouldShowInHistory(derived: CurrentLayoutAttempt, attempt: Attempt | undefined): boolean {
  if (!attempt) {
    return false;
  }
  if (derived.eligible) {
    return true;
  }
  if (attempt.lifecycle === 'cancelled' || attempt.lifecycle === 'abandoned' || attempt.lifecycle === 'armed') {
    return false;
  }
  if (attempt.lifecycle === 'active') {
    return false;
  }
  return (
    derived.unavailabilityReason === 'missing_start_coverage' ||
    derived.unavailabilityReason === 'replay_incomplete' ||
    derived.unavailabilityReason === 'missing_telemetry' ||
    derived.unavailabilityReason === 'not_valid'
  );
}

function toHistoryRow(
  item: CurrentLayoutAttempt,
  rankById: Map<string, number>,
  pbAttemptId: string | null,
): HistoryRow {
  return {
    attemptId: item.attemptId,
    armedAtMs: item.armedAtMs,
    finishedAtMs: item.finishedAtMs ?? item.recordedFinishedAtMs,
    officialTimeMs: item.officialTimeMs,
    rank: rankById.get(item.attemptId) ?? null,
    isPb: pbAttemptId === item.attemptId,
    eligible: item.eligible,
    unavailabilityReason: item.unavailabilityReason,
  };
}

function endpointId(endpoint: SegmentEndpoint): string {
  if (endpoint.kind === 'checkpoint') {
    return endpoint.id;
  }
  return endpoint.kind;
}

function stableQty(value: number): string {
  if (!Number.isFinite(value)) {
    return 'nan';
  }
  return value.toFixed(3);
}

export function describeUnavailability(reason: AttemptUnavailabilityReason): string {
  switch (reason) {
    case 'missing_start_coverage':
      return 'Not ranked — telemetry did not cover the start line.';
    case 'missing_telemetry':
      return 'Unavailable for the current course layout — raw telemetry is missing.';
    case 'replay_incomplete':
      return 'Unavailable for the current course layout.';
    case 'not_valid':
      return 'Unranked — the course match was not reliable enough.';
    case 'not_completed':
      return 'This attempt is not an official run.';
  }
}

export function shouldShowPersistedUnrankedWarning(options: {
  lifecycle: Attempt['lifecycle'];
  persistedValidity: Attempt['validity'];
  focus: Pick<CurrentLayoutAttempt, 'eligible'> | null | undefined;
}): boolean {
  return (
    options.lifecycle === 'completed' &&
    options.persistedValidity !== 'valid' &&
    options.focus == null
  );
}

export function segmentEndpointLabel(endpoint: SegmentEndpoint): string {
  if (endpoint.kind === 'checkpoint') {
    return endpoint.name;
  }
  if (endpoint.kind === 'start') {
    return 'Start';
  }
  return 'Finish';
}

