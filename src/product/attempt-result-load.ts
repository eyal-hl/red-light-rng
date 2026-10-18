import type { Attempt } from '../domain/attempt';
import { JourneyFocusStoppedError } from '../domain/journey-analysis';
import type { JourneyPoolId } from '../domain/journey';
import type { AnalyzeJourneyResult, CombinedAttemptDebug } from './route-workspace';

export const ATTEMPT_DEBUG_LOAD_ERROR = 'Could not load debug trace.';
export const ATTEMPT_PATH_ANALYTICS_LOAD_ERROR = 'Could not load path analytics.';
export const PATH_ANALYTICS_BUDGET_MS = 8_000;
export const PATH_ANALYTICS_BUDGET_MESSAGE = 'Path analytics took too long.';
export const PATH_ANALYTICS_INTERRUPTED_MESSAGE = 'Path analytics was interrupted.';

export type AttemptResultLoadWorkspace = {
  inspectAttempt(attemptId: string): Promise<CombinedAttemptDebug | null>;
  analyzeJourney(
    pool: JourneyPoolId,
    attemptId: string,
    options?: {
      yieldToIdle?: () => Promise<void>;
      shouldContinue?: () => boolean;
    },
  ): Promise<AnalyzeJourneyResult | null>;
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
      cancelled: boolean;
    };

export type AttemptResultSecondary = {
  debug: CombinedAttemptDebug | null;
  debugError: string | null;
  pathAnalytics: AnalyzeJourneyResult | null;
  pathAnalyticsError: string | null;
  pathAnalyticsSkipped: boolean;
  pathAnalyticsCancelled: boolean;
};

export type AttemptResultLoadOptions = {
  signal?: AbortSignal;
  pathAnalyticsBudgetMs?: number;
  yieldToIdle?: () => Promise<void>;
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

export type ResultPresentationGate = {
  requestId: number;
  loadToken: number;
};

export function nextResultRequest(gate: ResultPresentationGate): ResultPresentationGate {
  return { requestId: gate.requestId + 1, loadToken: gate.loadToken };
}

export function isCurrentResultRequest(gate: ResultPresentationGate, requestId: number): boolean {
  return gate.requestId === requestId;
}

export function nextSecondaryLoad(gate: ResultPresentationGate): ResultPresentationGate {
  return { requestId: gate.requestId, loadToken: gate.loadToken + 1 };
}

export function isCurrentSecondaryLoad(gate: ResultPresentationGate, loadToken: number): boolean {
  return gate.loadToken === loadToken;
}

export function invalidateResultPresentation(gate: ResultPresentationGate): ResultPresentationGate {
  return { requestId: gate.requestId + 1, loadToken: gate.loadToken + 1 };
}

export type ResultOpen = {
  requestId: number;
  promise: Promise<void>;
  finish: (error?: unknown) => void;
};

export function beginResultOpen(requestId: number): ResultOpen {
  let finish: (error?: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    };
  });
  promise.catch(() => {});
  return { requestId, promise, finish };
}

export function successorResultOpen(current: ResultOpen | null, requestId: number): Promise<void> | null {
  if (!current || current.requestId === requestId) {
    return null;
  }
  return current.promise;
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

function isStopped(caught: unknown): boolean {
  return caught instanceof JourneyFocusStoppedError || (caught instanceof Error && caught.name === 'JourneyFocusStoppedError');
}

type PathAnalyticsUpdate = Extract<AttemptResultSecondaryUpdate, { kind: 'pathAnalytics' }>;

function pathUpdate(input: {
  pathAnalytics: AnalyzeJourneyResult | null;
  pathAnalyticsError: string | null;
  skipped: boolean;
  cancelled: boolean;
}): PathAnalyticsUpdate {
  return { kind: 'pathAnalytics', ...input };
}

export async function loadAttemptResultSecondary(
  workspace: AttemptResultLoadWorkspace,
  attempt: Attempt,
  onProgress?: (update: AttemptResultSecondaryUpdate) => void,
  options?: AttemptResultLoadOptions,
): Promise<AttemptResultSecondary> {
  const pool = journeyPoolForAttempt(attempt);
  const result: AttemptResultSecondary = {
    debug: null,
    debugError: null,
    pathAnalytics: null,
    pathAnalyticsError: null,
    pathAnalyticsSkipped: pool == null,
    pathAnalyticsCancelled: false,
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

  const pathTask = loadAttemptPathAnalytics(workspace, attempt, (update) => {
    result.pathAnalytics = update.pathAnalytics;
    result.pathAnalyticsError = update.pathAnalyticsError;
    result.pathAnalyticsSkipped = update.skipped;
    result.pathAnalyticsCancelled = update.cancelled;
    onProgress?.(update);
  }, options);

  await Promise.all([debugTask, pathTask]);
  return result;
}

export async function loadAttemptPathAnalytics(
  workspace: AttemptResultLoadWorkspace,
  attempt: Attempt,
  onProgress?: (update: PathAnalyticsUpdate) => void,
  options?: AttemptResultLoadOptions,
): Promise<PathAnalyticsUpdate> {
  const pool = journeyPoolForAttempt(attempt);
  let delivered: PathAnalyticsUpdate | null = null;
  let resolveSettled: (update: PathAnalyticsUpdate) => void = () => {};
  const settled = new Promise<PathAnalyticsUpdate>((resolve) => {
    resolveSettled = resolve;
  });
  const finish = (update: PathAnalyticsUpdate): PathAnalyticsUpdate => {
    if (delivered) {
      return delivered;
    }
    delivered = update;
    resolveSettled(update);
    onProgress?.(update);
    return update;
  };

  if (!pool) {
    return finish(
      pathUpdate({
        pathAnalytics: null,
        pathAnalyticsError: null,
        skipped: true,
        cancelled: false,
      }),
    );
  }

  const signal = options?.signal;
  if (signal?.aborted) {
    return finish(
      pathUpdate({
        pathAnalytics: null,
        pathAnalyticsError: null,
        skipped: false,
        cancelled: true,
      }),
    );
  }

  const budgetMs = options?.pathAnalyticsBudgetMs ?? PATH_ANALYTICS_BUDGET_MS;
  const timer = setTimeout(() => {
    finish(
      pathUpdate({
        pathAnalytics: null,
        pathAnalyticsError: PATH_ANALYTICS_BUDGET_MESSAGE,
        skipped: false,
        cancelled: false,
      }),
    );
  }, budgetMs);

  const onAbort = () => {
    finish(
      pathUpdate({
        pathAnalytics: null,
        pathAnalyticsError: null,
        skipped: false,
        cancelled: true,
      }),
    );
  };
  signal?.addEventListener('abort', onAbort);

  void workspace
    .analyzeJourney(pool, attempt.id, {
      yieldToIdle: options?.yieldToIdle,
      shouldContinue: () => delivered == null && !signal?.aborted,
    })
    .then(
      (pathAnalytics) => {
        finish(
          pathUpdate({
            pathAnalytics,
            pathAnalyticsError: null,
            skipped: false,
            cancelled: false,
          }),
        );
      },
      (caught: unknown) => {
        if (signal?.aborted || isStopped(caught)) {
          finish(
            pathUpdate({
              pathAnalytics: null,
              pathAnalyticsError: null,
              skipped: false,
              cancelled: true,
            }),
          );
          return;
        }
        finish(
          pathUpdate({
            pathAnalytics: null,
            pathAnalyticsError: errorMessage(caught, ATTEMPT_PATH_ANALYTICS_LOAD_ERROR),
            skipped: false,
            cancelled: false,
          }),
        );
      },
    );

  try {
    return await settled;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
