import {
  incompleteAttemptLabel,
  isJourneyCompetitive,
  officialTimeMs,
  type Attempt,
  type IncompleteAttemptLabel,
} from './attempt';
import {
  analyzeFocusAttempt,
  deriveAnchoredLayoutAttempt,
  timingCourseFromRoute,
  type CurrentLayoutAttempt,
  type FocusAttemptAnalysis,
  type HistoryRow,
} from './attempt-analysis';
import type { LocationSample } from './location-sample';
import { isMovementDisplayable, type MovementBreakdown } from './movement-analysis';
import type { Place } from './place';
import { isCompatiblePathVariant } from './path-variant';
import {
  emptyResultExplanation,
  explainOfficialDelta,
  type ResultExplanation,
} from './result-explanation';
import type { Route, TransportationMode } from './route';
import { compareAttemptWaiting, type WaitComparison } from './wait-comparison';
import { journeyPoolKey, journeyTitle, type JourneyPoolId } from './journey';

export const PATH_ANALYTICS_UNAVAILABLE_MESSAGE = 'Path analytics unavailable — different/unmatched path';

export type JourneyAttemptTrace = {
  attempt: Attempt;
  samples: LocationSample[];
};

export function tracesFromAttempts(attempts: readonly Attempt[]): JourneyAttemptTrace[] {
  return attempts.map((attempt) => ({ attempt, samples: [] }));
}

export function attemptInPool(attempt: Attempt, pool: JourneyPoolId): boolean {
  const id = attemptJourneyPool(attempt);
  return (
    id != null &&
    id.originPlaceId === pool.originPlaceId &&
    id.destinationPlaceId === pool.destinationPlaceId &&
    id.transportationMode === pool.transportationMode
  );
}

export type JourneyPoolSummary = {
  originPlaceId: string;
  destinationPlaceId: string;
  originName: string;
  destinationName: string;
  title: string;
  transportationMode: TransportationMode;
  rankedAttemptCount: number;
  pbAttemptId: string | null;
  pbTimeMs: number | null;
  lastAttemptId: string | null;
  lastTimeMs: number | null;
  lastFinishedAtMs: number | null;
};

export type JourneyHistoryRow = HistoryRow & {
  originPlaceId: string | null;
  destinationPlaceId: string | null;
};

export type JourneyFocusAnalysis = {
  summary: JourneyPoolSummary;
  officialTimeMs: number | null;
  rank: number | null;
  isPb: boolean;
  previousAttemptId: string | null;
  previousTimeMs: number | null;
  deltaVsPreviousMs: number | null;
  pbBeforeThisTimeMs: number | null;
  deltaVsPbMs: number | null;
  comparisonAttemptId: string | null;
  resultExplanation: ResultExplanation;
  pathAnalytics: FocusAttemptAnalysis | null;
  pathUnavailable: boolean;
};

function competitiveTime(attempt: Attempt): number {
  return officialTimeMs(attempt) ?? Number.MAX_SAFE_INTEGER;
}

function compareJourneyCompetitive(a: Attempt, b: Attempt): number {
  const aTime = competitiveTime(a);
  const bTime = competitiveTime(b);
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
  return a.id.localeCompare(b.id);
}

function compareJourneyChronological(a: Attempt, b: Attempt): number {
  const aTime = a.finishedAtMs ?? a.armedAtMs;
  const bTime = b.finishedAtMs ?? b.armedAtMs;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  if (a.armedAtMs !== b.armedAtMs) {
    return b.armedAtMs - a.armedAtMs;
  }
  return b.id.localeCompare(a.id);
}

export function attemptJourneyPool(attempt: Attempt): JourneyPoolId | null {
  if (!attempt.originPlaceId || !attempt.destinationPlaceId) {
    return null;
  }
  return {
    originPlaceId: attempt.originPlaceId,
    destinationPlaceId: attempt.destinationPlaceId,
    transportationMode: attempt.transportationMode,
  };
}

export function filterTracesForJourney(
  traces: JourneyAttemptTrace[],
  pool: JourneyPoolId,
): JourneyAttemptTrace[] {
  return traces.filter((trace) => attemptInPool(trace.attempt, pool));
}

export function summarizeJourneyPool(
  pool: JourneyPoolId,
  origin: Place,
  destination: Place,
  traces: JourneyAttemptTrace[],
): JourneyPoolSummary {
  const inPool = filterTracesForJourney(traces, pool);
  const competitive = inPool.map((trace) => trace.attempt).filter(isJourneyCompetitive);
  const ranked = [...competitive].sort(compareJourneyCompetitive);
  const chronological = [...competitive].sort(compareJourneyChronological);
  const pb = ranked[0] ?? null;
  const last = chronological[0] ?? null;
  return {
    originPlaceId: pool.originPlaceId,
    destinationPlaceId: pool.destinationPlaceId,
    originName: origin.name,
    destinationName: destination.name,
    title: journeyTitle(origin.name, destination.name),
    transportationMode: pool.transportationMode,
    rankedAttemptCount: competitive.length,
    pbAttemptId: pb?.id ?? null,
    pbTimeMs: pb ? officialTimeMs(pb) : null,
    lastAttemptId: last?.id ?? null,
    lastTimeMs: last ? officialTimeMs(last) : null,
    lastFinishedAtMs: last?.finishedAtMs ?? null,
  };
}

export function listJourneyPools(
  traces: JourneyAttemptTrace[],
  placesById: Map<string, Place>,
): JourneyPoolSummary[] {
  const keys = new Map<string, JourneyPoolId>();
  for (const trace of traces) {
    const pool = attemptJourneyPool(trace.attempt);
    if (!pool) {
      continue;
    }
    keys.set(journeyPoolKey(pool), pool);
  }
  const summaries: JourneyPoolSummary[] = [];
  for (const pool of keys.values()) {
    const origin = placesById.get(pool.originPlaceId);
    const destination = placesById.get(pool.destinationPlaceId);
    if (!origin || !destination) {
      continue;
    }
    summaries.push(summarizeJourneyPool(pool, origin, destination, traces));
  }
  return summaries.sort((a, b) => a.title.localeCompare(b.title) || a.transportationMode.localeCompare(b.transportationMode));
}

export function journeyHistoryRows(
  pool: JourneyPoolId,
  traces: JourneyAttemptTrace[],
): JourneyHistoryRow[] {
  const inPool = filterTracesForJourney(traces, pool);
  const competitive = inPool.map((trace) => trace.attempt).filter(isJourneyCompetitive);
  const ranked = [...competitive].sort(compareJourneyCompetitive);
  const rankById = new Map(ranked.map((attempt, index) => [attempt.id, index + 1]));
  const pbId = ranked[0]?.id ?? null;
  return inPool
    .map((trace) => trace.attempt)
    .filter((attempt) => isJourneyCompetitive(attempt) || attempt.lifecycle === 'ended')
    .map((attempt) => {
      const eligible = isJourneyCompetitive(attempt);
      return {
        attemptId: attempt.id,
        armedAtMs: attempt.armedAtMs,
        finishedAtMs: attempt.finishedAtMs,
        officialTimeMs: officialTimeMs(attempt),
        rank: rankById.get(attempt.id) ?? null,
        isPb: pbId === attempt.id,
        eligible,
        unavailabilityReason: eligible ? null : attempt.lifecycle === 'ended' ? 'not_completed' : 'not_valid',
        lifecycle: attempt.lifecycle,
        incompleteLabel: incompleteAttemptLabel(attempt),
        originPlaceId: attempt.originPlaceId,
        destinationPlaceId: attempt.destinationPlaceId,
      } satisfies JourneyHistoryRow;
    })
    .sort((a, b) => {
      const aTime = a.finishedAtMs ?? a.armedAtMs;
      const bTime = b.finishedAtMs ?? b.armedAtMs;
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      return b.armedAtMs - a.armedAtMs;
    });
}

function previousCompetitiveAttempt(competitive: Attempt[], focus: Attempt): Attempt | null {
  const earlier = competitive
    .filter((item) => item.id !== focus.id)
    .filter((item) => compareJourneyChronological(item, focus) > 0)
    .sort(compareJourneyChronological);
  return earlier[0] ?? null;
}

function pbBeforeAttempt(ranked: Attempt[], focus: Attempt): Attempt | null {
  const earlier = ranked.filter((item) => item.id !== focus.id && compareJourneyChronological(item, focus) > 0);
  return [...earlier].sort(compareJourneyCompetitive)[0] ?? null;
}

function headlineDelta(
  focusTimeMs: number | null,
  currentPbTimeMs: number | null,
  previousPbTimeMs: number | null,
  isPb: boolean,
): number | null {
  if (focusTimeMs == null) {
    return null;
  }
  if (isPb) {
    if (previousPbTimeMs == null) {
      return null;
    }
    return focusTimeMs - previousPbTimeMs;
  }
  if (currentPbTimeMs == null) {
    return null;
  }
  return focusTimeMs - currentPbTimeMs;
}

type JourneyHeadlineParts = {
  inPool: JourneyAttemptTrace[];
  focusTrace: JourneyAttemptTrace;
  summary: JourneyPoolSummary;
  competitive: Attempt[];
  ranked: Attempt[];
  focus: Attempt;
  focusTime: number | null;
  rankIndex: number;
  isPb: boolean;
  previous: Attempt | null;
  pbBefore: Attempt | null;
  comparisonAttempt: Attempt | null;
  deltaVsPbMs: number | null;
};

function journeyHeadlineParts(
  pool: JourneyPoolId,
  origin: Place,
  destination: Place,
  traces: JourneyAttemptTrace[],
  focusAttemptId: string,
): JourneyHeadlineParts | null {
  const inPool = filterTracesForJourney(traces, pool);
  const focusTrace = inPool.find((trace) => trace.attempt.id === focusAttemptId);
  if (!focusTrace) {
    return null;
  }
  const summary = summarizeJourneyPool(pool, origin, destination, traces);
  const competitive = inPool.map((trace) => trace.attempt).filter(isJourneyCompetitive);
  const ranked = [...competitive].sort(compareJourneyCompetitive);
  const focus = focusTrace.attempt;
  const focusTime = officialTimeMs(focus);
  const rankIndex = ranked.findIndex((item) => item.id === focus.id);
  const isPb = summary.pbAttemptId === focus.id;
  const previous = previousCompetitiveAttempt(competitive, focus);
  const pbBefore = pbBeforeAttempt(ranked, focus);
  const comparisonAttempt = headlineComparisonAttempt({
    competitive: isJourneyCompetitive(focus),
    isPb,
    pbBefore,
    currentPb: ranked[0] ?? null,
    focusId: focus.id,
  });
  return {
    inPool,
    focusTrace,
    summary,
    competitive,
    ranked,
    focus,
    focusTime,
    rankIndex,
    isPb,
    previous,
    pbBefore,
    comparisonAttempt,
    deltaVsPbMs: headlineDelta(focusTime, summary.pbTimeMs, pbBefore ? officialTimeMs(pbBefore) : null, isPb),
  };
}

function journeyHeadlineAnalysis(parts: JourneyHeadlineParts): JourneyFocusAnalysis {
  return {
    summary: parts.summary,
    officialTimeMs: parts.focusTime,
    rank: parts.rankIndex >= 0 ? parts.rankIndex + 1 : null,
    isPb: parts.isPb,
    previousAttemptId: parts.previous?.id ?? null,
    previousTimeMs: parts.previous ? officialTimeMs(parts.previous) : null,
    deltaVsPreviousMs:
      parts.focusTime != null && parts.previous != null && officialTimeMs(parts.previous) != null
        ? parts.focusTime - (officialTimeMs(parts.previous) as number)
        : null,
    pbBeforeThisTimeMs: parts.pbBefore ? officialTimeMs(parts.pbBefore) : null,
    deltaVsPbMs: parts.deltaVsPbMs,
    comparisonAttemptId: parts.comparisonAttempt?.id ?? null,
    resultExplanation: emptyResultExplanation({ availability: 'no_comparison_target' }),
    pathAnalytics: null,
    pathUnavailable: false,
  };
}

export function analyzeJourneyHeadline(
  pool: JourneyPoolId,
  origin: Place,
  destination: Place,
  traces: JourneyAttemptTrace[],
  focusAttemptId: string,
): JourneyFocusAnalysis | null {
  const parts = journeyHeadlineParts(pool, origin, destination, traces, focusAttemptId);
  return parts ? journeyHeadlineAnalysis(parts) : null;
}

export function analyzeJourneyFocus(
  pool: JourneyPoolId,
  origin: Place,
  destination: Place,
  traces: JourneyAttemptTrace[],
  focusAttemptId: string,
  routes: Route[],
): JourneyFocusAnalysis | null {
  const parts = journeyHeadlineParts(pool, origin, destination, traces, focusAttemptId);
  if (!parts) {
    return null;
  }
  const {
    inPool,
    focusTrace,
    summary,
    focus,
    focusTime,
    rankIndex,
    isPb,
    previous,
    pbBefore,
    comparisonAttempt,
    deltaVsPbMs,
  } = parts;
  const variantTraces = inPool.filter((trace) => {
    if (!isJourneyCompetitive(trace.attempt) || !trace.attempt.routeId) {
      return false;
    }
    const route = routes.find((item) => item.id === trace.attempt.routeId);
    if (!route || !trace.attempt.startedAtMs || !trace.attempt.finishedAtMs) {
      return false;
    }
    return isCompatiblePathVariant(route, trace.samples, {
      startedAtMs: trace.attempt.startedAtMs,
      finishedAtMs: trace.attempt.finishedAtMs,
    });
  });
  const focusRoute = focus.routeId ? routes.find((route) => route.id === focus.routeId) ?? null : null;
  const focusCompatible =
    focusRoute != null &&
    focus.startedAtMs != null &&
    focus.finishedAtMs != null &&
    isCompatiblePathVariant(focusRoute, focusTrace.samples, {
      startedAtMs: focus.startedAtMs,
      finishedAtMs: focus.finishedAtMs,
    });
  const sameVariantTraces = focusRoute
    ? variantTraces.filter((trace) => trace.attempt.routeId === focusRoute.id)
    : [];
  const pathAnalytics =
    focusCompatible && focusRoute
      ? analyzeFocusAttempt(
          {
            referencePath: focusRoute.referencePath,
            startProgressMeters: focusRoute.startProgressMeters,
            finishProgressMeters: focusRoute.finishProgressMeters,
            startZone: focusRoute.startZone,
            finishZone: focusRoute.finishZone,
            checkpoints: focusRoute.checkpoints,
          },
          sameVariantTraces,
          focus.id,
          deriveAnchoredLayoutAttempt,
        )
      : null;

  const comparisonTrace = comparisonAttempt
    ? (inPool.find((trace) => trace.attempt.id === comparisonAttempt.id) ?? null)
    : null;
  const currentLayout = compatibleLayoutForTrace(focusTrace, routes);
  const comparisonLayout = comparisonTrace ? compatibleLayoutForTrace(comparisonTrace, routes) : null;
  const currentMovement = displayableMovementOf(currentLayout?.derived ?? pathAnalytics?.focus ?? null);
  const referenceMovement = displayableMovementOf(comparisonLayout?.derived ?? null);
  const waitComparison = waitComparisonForHeadlineTarget({
    comparisonAttemptId: comparisonAttempt?.id ?? null,
    current: currentLayout,
    comparison: comparisonLayout,
  });
  const resultExplanation = isJourneyCompetitive(focus)
    ? explainOfficialDelta({
        comparisonAttemptId: comparisonAttempt?.id ?? null,
        headlineDeltaMs: deltaVsPbMs,
        currentMovement,
        referenceMovement,
        waitComparison,
      })
    : emptyResultExplanation({ availability: 'no_comparison_target' });

  return {
    summary,
    officialTimeMs: focusTime,
    rank: rankIndex >= 0 ? rankIndex + 1 : null,
    isPb,
    previousAttemptId: previous?.id ?? null,
    previousTimeMs: previous ? officialTimeMs(previous) : null,
    deltaVsPreviousMs:
      focusTime != null && previous != null && officialTimeMs(previous) != null
        ? focusTime - (officialTimeMs(previous) as number)
        : null,
    pbBeforeThisTimeMs: pbBefore ? officialTimeMs(pbBefore) : null,
    deltaVsPbMs,
    comparisonAttemptId: comparisonAttempt?.id ?? null,
    resultExplanation,
    pathAnalytics,
    pathUnavailable: isJourneyCompetitive(focus) && pathAnalytics == null,
  };
}

function headlineComparisonAttempt(input: {
  competitive: boolean;
  isPb: boolean;
  pbBefore: Attempt | null;
  currentPb: Attempt | null;
  focusId: string;
}): Attempt | null {
  if (!input.competitive) {
    return null;
  }
  if (input.isPb) {
    return input.pbBefore;
  }
  if (input.currentPb && input.currentPb.id !== input.focusId) {
    return input.currentPb;
  }
  return input.pbBefore;
}

function compatibleLayoutForTrace(
  trace: JourneyAttemptTrace,
  routes: Route[],
): { route: Route; derived: CurrentLayoutAttempt } | null {
  const attempt = trace.attempt;
  if (!attempt.routeId || attempt.startedAtMs == null || attempt.finishedAtMs == null) {
    return null;
  }
  const route = routes.find((item) => item.id === attempt.routeId);
  if (!route) {
    return null;
  }
  if (
    !isCompatiblePathVariant(route, trace.samples, {
      startedAtMs: attempt.startedAtMs,
      finishedAtMs: attempt.finishedAtMs,
    })
  ) {
    return null;
  }
  const derived = deriveAnchoredLayoutAttempt(timingCourseFromRoute(route), attempt, trace.samples);
  if (!derived.eligible) {
    return null;
  }
  return { route, derived };
}

function displayableMovementOf(layout: CurrentLayoutAttempt | null): MovementBreakdown | null {
  if (layout?.movement == null || !isMovementDisplayable(layout.movement)) {
    return null;
  }
  return layout.movement;
}

function waitComparisonForHeadlineTarget(input: {
  comparisonAttemptId: string | null;
  current: { route: Route; derived: CurrentLayoutAttempt } | null;
  comparison: { route: Route; derived: CurrentLayoutAttempt } | null;
}): WaitComparison | null {
  if (
    input.comparisonAttemptId == null ||
    input.current == null ||
    input.comparison == null ||
    input.current.route.id !== input.comparison.route.id
  ) {
    return null;
  }
  return compareAttemptWaiting({
    current: input.current.derived,
    reference: input.comparison.derived,
    referencePath: input.current.route.referencePath,
  });
}

export function incompleteAttempts(traces: JourneyAttemptTrace[]): Attempt[] {
  return traces
    .map((trace) => trace.attempt)
    .filter((attempt) => attempt.lifecycle === 'ended')
    .sort((a, b) => b.armedAtMs - a.armedAtMs);
}

export type { IncompleteAttemptLabel };
