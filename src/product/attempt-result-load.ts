import type { Attempt } from '../domain/attempt';
import { sameJourneyPool, type JourneyPoolId } from '../domain/journey';
import { JourneyFocusStoppedError } from '../domain/journey-analysis';
import type { AnalyzeJourneyResult, CombinedAttemptDebug } from './route-workspace';

export const ATTEMPT_DEBUG_LOAD_ERROR = 'Could not load debug trace.';
export const ATTEMPT_PATH_ANALYTICS_LOAD_ERROR = 'Could not load path analytics.';
/**
 * Deadline for one non-yielding async step (a SQLite read or a promise that
 * never returns). Cooperative yields reset it. It is not a deadline for the
 * whole cohort: synchronous projection cannot be cancelled by a timer, and a
 * single deadline around every sample read made Retry throw that work away
 * and miss the same limit again.
 */
export const PATH_ANALYTICS_BUDGET_MS = 8_000;
export const PATH_ANALYTICS_BUDGET_MESSAGE = 'Path analytics took too long.';
export const PATH_ANALYTICS_INTERRUPTED_MESSAGE = 'Path analytics was interrupted.';
export const ATTEMPT_ACK_FAILURE_MESSAGE =
  'Could not save that this result was closed. It will show again the next time the app opens.';

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

export type ResultExitDestination =
  | { kind: 'journey'; pool: JourneyPoolId }
  | { kind: 'home' };

export function resultExitDestination(attempt: Attempt): ResultExitDestination {
  const pool = journeyPoolForAttempt(attempt);
  if (!pool) {
    return { kind: 'home' };
  }
  return { kind: 'journey', pool };
}

export type AcknowledgementLease = {
  attemptId: string;
};

/** One in-flight close per attempt. A repeated Done or system Back is a no-op. */
export function claimAcknowledgement(
  lease: AcknowledgementLease | null,
  attemptId: string,
): { lease: AcknowledgementLease; claimed: boolean } {
  if (lease?.attemptId === attemptId) {
    return { lease, claimed: false };
  }
  return { lease: { attemptId }, claimed: true };
}

export function releaseAcknowledgement(
  lease: AcknowledgementLease | null,
  attemptId: string,
): AcknowledgementLease | null {
  if (lease?.attemptId !== attemptId) {
    return lease;
  }
  return null;
}

export function acknowledgementFailureStillVisible(
  screen: { kind: string; pool?: JourneyPoolId },
  destination: ResultExitDestination,
): boolean {
  if (destination.kind === 'home') {
    return screen.kind === 'home';
  }
  if (screen.kind !== 'journey' || !screen.pool) {
    return false;
  }
  return sameJourneyPool(screen.pool, destination.pool);
}

export type SettledPathAnalyticsView = 'cancelled' | 'error' | 'skipped' | 'unavailable' | 'ready';

export function settledPathAnalyticsView(update: {
  pathAnalytics: { focus: { pathUnavailable: boolean } | null } | null;
  pathAnalyticsError: string | null;
  skipped: boolean;
  cancelled: boolean;
}): SettledPathAnalyticsView {
  if (update.cancelled) {
    return 'cancelled';
  }
  if (update.pathAnalyticsError) {
    return 'error';
  }
  if (update.skipped) {
    return 'skipped';
  }
  if (update.pathAnalytics == null || update.pathAnalytics.focus == null || update.pathAnalytics.focus.pathUnavailable) {
    return 'unavailable';
  }
  return 'ready';
}

/** Abort `external` into a child controller, and drop the parent listener when the child ends. */
export function forwardAbortSignal(external?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!external) {
    return controller;
  }
  if (external.aborted) {
    controller.abort();
    return controller;
  }
  const onExternalAbort = () => {
    controller.abort();
  };
  external.addEventListener('abort', onExternalAbort);
  controller.signal.addEventListener('abort', () => {
    external.removeEventListener('abort', onExternalAbort);
  });
  return controller;
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
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  const clearBudget = () => {
    if (budgetTimer != null) {
      clearTimeout(budgetTimer);
      budgetTimer = null;
    }
  };
  const armBudget = () => {
    clearBudget();
    budgetTimer = setTimeout(() => {
      finish(
        pathUpdate({
          pathAnalytics: null,
          pathAnalyticsError: PATH_ANALYTICS_BUDGET_MESSAGE,
          skipped: false,
          cancelled: false,
        }),
      );
    }, budgetMs);
  };
  armBudget();

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

  const yieldToIdle = options?.yieldToIdle
    ? async () => {
        await options.yieldToIdle?.();
        if (delivered == null && !signal?.aborted) {
          armBudget();
        }
      }
    : undefined;

  void workspace
    .analyzeJourney(pool, attempt.id, {
      yieldToIdle,
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
    clearBudget();
    signal?.removeEventListener('abort', onAbort);
  }
}
