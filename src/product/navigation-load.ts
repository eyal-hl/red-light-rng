export type NavigationLoadOperation =
  | 'loadHome'
  | 'loadJourney'
  | 'analyzeJourneyHeadline'
  | 'analyzeJourney'
  | 'inspectAttempt'
  | 'analyzeRoute'
  | 'legacySampleScan'
  | 'recomputePathVariants'
  | 'reconcilePendingAttempts';

export type NavigationLoadCounters = {
  listSamplesCalls: number;
  pathVariantRecomputeRuns: number;
  pathVariantRecomputeSkips: number;
  pathVariantRecomputeListSamples: number;
  reconcilePendingRuns: number;
  reconcilePendingSkips: number;
  reconcilePendingSelected: number;
  reconcilePendingListSamples: number;
  loadHomeReads: number;
  loadHomeHits: number;
  loadHomeMisses: number;
  loadJourneyReads: number;
  loadJourneyHits: number;
  loadJourneyMisses: number;
  analyzeJourneyHeadlineReads: number;
  analyzeJourneyReads: number;
  analyzeJourneyHits: number;
  analyzeJourneyMisses: number;
  inspectAttemptReads: number;
  inspectAttemptHits: number;
  inspectAttemptMisses: number;
  analyzeRouteReads: number;
  analyzeRouteHits: number;
  analyzeRouteMisses: number;
};

export type NavigationLoadTiming = {
  operation: NavigationLoadOperation;
  durationMs: number;
  listSamplesDelta: number;
  cacheHit: boolean;
};

export function emptyNavigationLoadCounters(): NavigationLoadCounters {
  return {
    listSamplesCalls: 0,
    pathVariantRecomputeRuns: 0,
    pathVariantRecomputeSkips: 0,
    pathVariantRecomputeListSamples: 0,
    reconcilePendingRuns: 0,
    reconcilePendingSkips: 0,
    reconcilePendingSelected: 0,
    reconcilePendingListSamples: 0,
    loadHomeReads: 0,
    loadHomeHits: 0,
    loadHomeMisses: 0,
    loadJourneyReads: 0,
    loadJourneyHits: 0,
    loadJourneyMisses: 0,
    analyzeJourneyHeadlineReads: 0,
    analyzeJourneyReads: 0,
    analyzeJourneyHits: 0,
    analyzeJourneyMisses: 0,
    inspectAttemptReads: 0,
    inspectAttemptHits: 0,
    inspectAttemptMisses: 0,
    analyzeRouteReads: 0,
    analyzeRouteHits: 0,
    analyzeRouteMisses: 0,
  };
}

export type NavigationLoadState = {
  counters: NavigationLoadCounters;
  timings: NavigationLoadTiming[];
};

export function createNavigationLoadState(): NavigationLoadState {
  return {
    counters: emptyNavigationLoadCounters(),
    timings: [],
  };
}

export async function timeNavigationLoad<T>(
  state: NavigationLoadState,
  operation: NavigationLoadOperation,
  work: () => Promise<{ value: T; cacheHit: boolean }>,
): Promise<T> {
  const samplesBefore = state.counters.listSamplesCalls;
  const startedAt = performance.now();
  const { value, cacheHit } = await work();
  state.timings.push({
    operation,
    durationMs: performance.now() - startedAt,
    listSamplesDelta: state.counters.listSamplesCalls - samplesBefore,
    cacheHit,
  });
  return value;
}
