import { sameJourneyPool, type JourneyPoolId } from '../domain/journey';
import type { JourneyPoolSummary } from '../domain/journey-analysis';
import type { DelayHotspotAnalysis } from '../domain/delay-hotspots';
import type { Place } from '../domain/place';

export type JourneySnapshotGateInput = {
  snapshotReady: boolean;
  pool: JourneyPoolId;
  origin: Place | null;
  destination: Place | null;
  summary: JourneyPoolSummary | null;
};

export type JourneyPresentationLoad<TLoaded> =
  | { kind: 'ready'; loaded: TLoaded }
  | { kind: 'missing' }
  | { kind: 'superseded' };

export function beginJourneySnapshotLoad(currentToken: number): {
  token: number;
  snapshotReady: false;
} {
  return {
    token: currentToken + 1,
    snapshotReady: false,
  };
}

export function journeyLoadCommitKind(
  token: number,
  currentToken: number,
  activePool: JourneyPoolId | null,
  loadedPool: JourneyPoolId,
): 'commit' | 'superseded' {
  if (token !== currentToken) {
    return 'superseded';
  }
  if (!activePool || !sameJourneyPool(activePool, loadedPool)) {
    return 'superseded';
  }
  return 'commit';
}

export function finishJourneySnapshotLoad<TLoaded>(
  token: number,
  currentToken: number,
  activePool: JourneyPoolId | null,
  loadedPool: JourneyPoolId,
  loaded: TLoaded | null,
): JourneyPresentationLoad<TLoaded> {
  if (journeyLoadCommitKind(token, currentToken, activePool, loadedPool) === 'superseded') {
    return { kind: 'superseded' };
  }
  if (!loaded) {
    return { kind: 'missing' };
  }
  return { kind: 'ready', loaded };
}

export function canPresentRetainedJourney(input: JourneySnapshotGateInput): boolean {
  if (!input.snapshotReady) {
    return false;
  }
  const { origin, destination, summary, pool } = input;
  return (
    origin != null &&
    destination != null &&
    summary != null &&
    origin.id === pool.originPlaceId &&
    destination.id === pool.destinationPlaceId &&
    summary.transportationMode === pool.transportationMode
  );
}

export function canOpenJourneyHistory(input: JourneySnapshotGateInput): boolean {
  return canPresentRetainedJourney(input);
}

/**
 * Recurring-hotspot hydration is deferred: it loads raw samples for the whole pool, so it
 * starts only after the journey shell has painted (snapshot ready) and never blocks it.
 */
export type JourneyHotspotsState =
  | { status: 'idle' }
  | { status: 'loading'; pool: JourneyPoolId }
  | { status: 'ready'; pool: JourneyPoolId; analysis: DelayHotspotAnalysis }
  | { status: 'error'; pool: JourneyPoolId };

export function journeyHotspotsViewFor(
  state: JourneyHotspotsState,
  pool: JourneyPoolId,
): JourneyHotspotsState {
  if (state.status === 'idle' || !sameJourneyPool(state.pool, pool)) {
    return { status: 'idle' };
  }
  return state;
}

export function shouldHydrateJourneyHotspots(input: {
  snapshotReady: boolean;
  pool: JourneyPoolId;
  state: JourneyHotspotsState;
}): boolean {
  return input.snapshotReady && journeyHotspotsViewFor(input.state, input.pool).status === 'idle';
}
