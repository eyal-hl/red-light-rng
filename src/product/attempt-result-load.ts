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
  /** Debug inspection and the deferred headline. Retry does not advance this. */
  loadToken: number;
  /** Path analytics only. Retry advances this and leaves debug and headline current. */
  pathToken: number;
};

export function nextResultRequest(gate: ResultPresentationGate): ResultPresentationGate {
  return { requestId: gate.requestId + 1, loadToken: gate.loadToken, pathToken: gate.pathToken };
}

export function isCurrentResultRequest(gate: ResultPresentationGate, requestId: number): boolean {
  return gate.requestId === requestId;
}

export function nextSecondaryLoad(gate: ResultPresentationGate): ResultPresentationGate {
  return { requestId: gate.requestId, loadToken: gate.loadToken + 1, pathToken: gate.pathToken };
}

export function isCurrentSecondaryLoad(gate: ResultPresentationGate, loadToken: number): boolean {
  return gate.loadToken === loadToken;
}

export function nextPathAnalyticsLoad(gate: ResultPresentationGate): ResultPresentationGate {
  return { requestId: gate.requestId, loadToken: gate.loadToken, pathToken: gate.pathToken + 1 };
}

export function isCurrentPathAnalyticsLoad(gate: ResultPresentationGate, pathToken: number): boolean {
  return gate.pathToken === pathToken;
}

export function invalidateResultPresentation(gate: ResultPresentationGate): ResultPresentationGate {
  return {
    requestId: gate.requestId + 1,
    loadToken: gate.loadToken + 1,
    pathToken: gate.pathToken + 1,
  };
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

export type ResultDismissal = {
  generation: number;
  attemptId: string | null;
  /** Generation at which each attempt was closed. Later closes do not forget earlier ones. */
  closedAt: Readonly<Record<string, number>>;
};

export type ResultSession = {
  gate: ResultPresentationGate;
  acknowledgement: AcknowledgementLease | null;
  dismissal: ResultDismissal;
};

export function createResultSession(): ResultSession {
  return {
    gate: { requestId: 0, loadToken: 0, pathToken: 0 },
    acknowledgement: null,
    dismissal: { generation: 0, attemptId: null, closedAt: {} },
  };
}

export type BegunResultPresentation = {
  session: ResultSession;
  requestId: number;
};

/** A new result request. In-flight debug, headline, and path loads stay current until their replacements start. */
export function beginResultPresentation(session: ResultSession): BegunResultPresentation {
  const gate = nextResultRequest(session.gate);
  return { session: { ...session, gate }, requestId: gate.requestId };
}

export type StartedResultLoads = {
  session: ResultSession;
  loadToken: number;
  pathToken: number;
};

export function startResultLoads(session: ResultSession): StartedResultLoads {
  const gate = nextPathAnalyticsLoad(nextSecondaryLoad(session.gate));
  return {
    session: { ...session, gate },
    loadToken: gate.loadToken,
    pathToken: gate.pathToken,
  };
}

export type OpenedResultSession = BegunResultPresentation & StartedResultLoads;

/** Paint a result that was not aborted before its secondary loads started. */
export function openResultSession(session: ResultSession): OpenedResultSession {
  const begun = beginResultPresentation(session);
  const started = startResultLoads(begun.session);
  return {
    session: started.session,
    requestId: begun.requestId,
    loadToken: started.loadToken,
    pathToken: started.pathToken,
  };
}

export type RetriedPathAnalytics = {
  session: ResultSession;
  pathToken: number;
};

/** Retry path analytics without dropping an in-flight debug read or headline. */
export function retryPathAnalyticsSession(session: ResultSession): RetriedPathAnalytics {
  const gate = nextPathAnalyticsLoad(session.gate);
  return { session: { ...session, gate }, pathToken: gate.pathToken };
}

export type AttemptClose = {
  session: ResultSession;
  claimed: boolean;
  generation: number;
};

/**
 * One in-flight close. Leaving invalidates result presentation immediately.
 * The dismissal generation stays after the write settles so a home refresh that
 * started earlier cannot put the result back.
 */
export function beginAttemptClose(session: ResultSession, attemptId: string): AttemptClose {
  const claim = claimAcknowledgement(session.acknowledgement, attemptId);
  if (!claim.claimed) {
    return {
      session: { ...session, acknowledgement: claim.lease },
      claimed: false,
      generation: session.dismissal.generation,
    };
  }
  const generation = session.dismissal.generation + 1;
  const dismissal: ResultDismissal = {
    generation,
    attemptId,
    closedAt: { ...session.dismissal.closedAt, [attemptId]: generation },
  };
  return {
    claimed: true,
    generation,
    session: {
      ...session,
      acknowledgement: claim.lease,
      dismissal,
      gate: invalidateResultPresentation(session.gate),
    },
  };
}

/** Release the in-flight lease after the acknowledgement write succeeds or fails. */
export function finishAttemptClose(session: ResultSession, attemptId: string, generation: number): ResultSession {
  if (session.dismissal.generation !== generation || session.dismissal.attemptId !== attemptId) {
    return session;
  }
  return {
    ...session,
    acknowledgement: releaseAcknowledgement(session.acknowledgement, attemptId),
  };
}

export type ResultWorkCapture = {
  requestId: number;
  dismissalGeneration: number;
};

export function captureResultWork(session: ResultSession): ResultWorkCapture {
  return {
    requestId: session.gate.requestId,
    dismissalGeneration: session.dismissal.generation,
  };
}

function closedDuring(session: ResultSession, attemptId: string, seenGeneration: number): boolean {
  const closedAt = session.dismissal.closedAt[attemptId];
  return closedAt != null && closedAt > seenGeneration;
}

export function modeUpdateMayReopen(session: ResultSession, captured: ResultWorkCapture, attemptId: string): boolean {
  if (session.gate.requestId !== captured.requestId) {
    return false;
  }
  if (session.acknowledgement?.attemptId === attemptId) {
    return false;
  }
  if (closedDuring(session, attemptId, captured.dismissalGeneration)) {
    return false;
  }
  return true;
}

export type ResumeWatch = {
  dismissalGeneration: number;
  closingAttemptId: string | null;
};

export function captureResumeWatch(session: ResultSession): ResumeWatch {
  return {
    dismissalGeneration: session.dismissal.generation,
    closingAttemptId: session.acknowledgement?.attemptId ?? null,
  };
}

export function resumeMayReopenAttempt(session: ResultSession, seen: ResumeWatch, attemptId: string): boolean {
  if (session.acknowledgement?.attemptId === attemptId) {
    return false;
  }
  if (seen.closingAttemptId === attemptId) {
    return false;
  }
  if (closedDuring(session, attemptId, seen.dismissalGeneration)) {
    return false;
  }
  return true;
}

export type ResultSurfaceKind = 'attempt-result' | 'attempt-detail' | 'other';

export function resultSurfaceKind(kind: string): ResultSurfaceKind {
  if (kind === 'attempt-result' || kind === 'attempt-detail') {
    return kind;
  }
  return 'other';
}

export function hideNavigationAfterDismiss(
  session: ResultSession,
  attemptId: string,
  captured: ResultWorkCapture,
  capturedSurface: ResultSurfaceKind,
  currentSurface: ResultSurfaceKind,
): 'home' | 'history' | 'stay' {
  if (session.acknowledgement?.attemptId === attemptId) {
    return 'stay';
  }
  if (closedDuring(session, attemptId, captured.dismissalGeneration)) {
    return 'stay';
  }
  if (capturedSurface !== currentSurface) {
    return 'stay';
  }
  if (currentSurface === 'attempt-detail') {
    return 'history';
  }
  if (currentSurface === 'attempt-result') {
    return 'home';
  }
  return 'stay';
}

export function restoreMayTouchAttempt(
  session: ResultSession,
  attemptId: string,
  captured: ResultWorkCapture,
): boolean {
  if (session.acknowledgement?.attemptId === attemptId) {
    return false;
  }
  if (closedDuring(session, attemptId, captured.dismissalGeneration)) {
    return false;
  }
  return true;
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
