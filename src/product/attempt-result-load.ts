import type { Attempt } from '../domain/attempt';
import type { JourneyPoolId } from '../domain/journey';
import type { AnalyzeJourneyResult, CombinedAttemptDebug } from './route-workspace';

export const ATTEMPT_DEBUG_LOAD_ERROR = 'Could not load debug trace.';
export const ATTEMPT_PATH_ANALYTICS_LOAD_ERROR = 'Could not load path analytics.';

export type AttemptResultLoadWorkspace = {
  inspectAttempt(attemptId: string): Promise<CombinedAttemptDebug | null>;
  analyzeJourney(pool: JourneyPoolId, attemptId: string): Promise<AnalyzeJourneyResult | null>;
};

export type AttemptResultShell = {
  debug: null;
  debugPending: true;
  pathAnalyticsPending: boolean;
};

export type AttemptResultSecondaryUpdate =
  | {
      kind: 'debug';
      debug: CombinedAttemptDebug | null;
      debugError: string | null;
    }
  | {
      kind: 'pathAnalytics';
      pathAnalytics: AnalyzeJourneyResult | null;
      pathAnalyticsError: string | null;
      skipped: boolean;
    };

export type AttemptResultSecondary = {
  debug: CombinedAttemptDebug | null;
  debugError: string | null;
  pathAnalytics: AnalyzeJourneyResult | null;
  pathAnalyticsError: string | null;
  pathAnalyticsSkipped: boolean;
};

export function journeyPoolForAttempt(attempt: Attempt): JourneyPoolId | null {
  if (!attempt.originPlaceId || !attempt.destinationPlaceId) {
    return null;
  }
  return {
    originPlaceId: attempt.originPlaceId,
    destinationPlaceId: attempt.destinationPlaceId,
    transportationMode: attempt.transportationMode,
  };
}

export function createAttemptResultShell(attempt: Attempt): AttemptResultShell {
  return {
    debug: null,
    debugPending: true,
    pathAnalyticsPending: journeyPoolForAttempt(attempt) != null,
  };
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message.trim().length > 0 ? caught.message : fallback;
}

export async function loadAttemptResultSecondary(
  workspace: AttemptResultLoadWorkspace,
  attempt: Attempt,
  onProgress?: (update: AttemptResultSecondaryUpdate) => void,
): Promise<AttemptResultSecondary> {
  const pool = journeyPoolForAttempt(attempt);
  const result: AttemptResultSecondary = {
    debug: null,
    debugError: null,
    pathAnalytics: null,
    pathAnalyticsError: null,
    pathAnalyticsSkipped: pool == null,
  };

  const debugTask = workspace.inspectAttempt(attempt.id).then(
    (debug) => {
      result.debug = debug;
      onProgress?.({ kind: 'debug', debug, debugError: null });
    },
    (caught: unknown) => {
      result.debugError = errorMessage(caught, ATTEMPT_DEBUG_LOAD_ERROR);
      onProgress?.({ kind: 'debug', debug: null, debugError: result.debugError });
    },
  );

  const pathTask =
    pool == null
      ? Promise.resolve().then(() => {
          onProgress?.({
            kind: 'pathAnalytics',
            pathAnalytics: null,
            pathAnalyticsError: null,
            skipped: true,
          });
        })
      : workspace.analyzeJourney(pool, attempt.id).then(
          (pathAnalytics) => {
            result.pathAnalytics = pathAnalytics;
            onProgress?.({
              kind: 'pathAnalytics',
              pathAnalytics,
              pathAnalyticsError: null,
              skipped: false,
            });
          },
          (caught: unknown) => {
            result.pathAnalyticsError = errorMessage(caught, ATTEMPT_PATH_ANALYTICS_LOAD_ERROR);
            onProgress?.({
              kind: 'pathAnalytics',
              pathAnalytics: null,
              pathAnalyticsError: result.pathAnalyticsError,
              skipped: false,
            });
          },
        );

  await Promise.all([debugTask, pathTask]);
  return result;
}
