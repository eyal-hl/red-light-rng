export const APP_STARTUP_WATCHDOG_MS = 10_000;
export const APP_STARTUP_STAGE_TIMEOUT_MS = 8_000;

export type AppStartupStage =
  | 'opening-database'
  | 'tracker-recover'
  | 'attempt-reconcile'
  | 'load-home'
  | 'path-variant-recompute';

export const APP_STARTUP_STAGE_LABELS: Record<AppStartupStage, string> = {
  'opening-database': 'database open / migrations',
  'tracker-recover': 'tracker recovery',
  'attempt-reconcile': 'attempt reconcile',
  'load-home': 'load Home',
  'path-variant-recompute': 'path-variant recompute',
};

export type AppStartupFailure = {
  stage: AppStartupStage;
  message: string;
  timedOut: boolean;
};

export type AppStartupHost<TSnapshot> = {
  preparePersistence: () => Promise<void>;
  recoverTracker: () => Promise<void>;
  reconcileAttempts: () => Promise<void>;
  loadHome: () => Promise<TSnapshot>;
  recomputePathVariants: () => Promise<void>;
};

export type AppStartupEvents<TSnapshot> = {
  onStage: (stage: AppStartupStage) => void;
  onHomeReady: (snapshot: TSnapshot) => void | Promise<void>;
  onFailure: (failure: AppStartupFailure) => void;
  onDeferredRecomputeError?: (message: string) => void;
};

export type AppStartupTimers = {
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

export type AppStartupOptions = {
  watchdogMs?: number;
  stageTimeoutMs?: number;
  timers?: AppStartupTimers;
};

export type AppStartupSession = {
  cancel: () => void;
  finished: Promise<void>;
};

export class AppStartupTimeoutError extends Error {
  readonly stage: AppStartupStage;
  readonly timedOut = true as const;

  constructor(stage: AppStartupStage, message: string) {
    super(message);
    this.name = 'AppStartupTimeoutError';
    this.stage = stage;
  }
}

export function formatStartupError(failure: AppStartupFailure): string {
  const label = APP_STARTUP_STAGE_LABELS[failure.stage];
  return `${failure.message} (stage: ${failure.stage} — ${label})`;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string,
  timers: AppStartupTimers = defaultTimers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = timers.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);
    promise.then(
      (value) => {
        timers.clearTimeout(id);
        resolve(value);
      },
      (error: unknown) => {
        timers.clearTimeout(id);
        reject(error);
      },
    );
  });
}

const defaultTimers: AppStartupTimers = {
  setTimeout,
  clearTimeout,
};

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

export function startAppStartup<TSnapshot>(
  host: AppStartupHost<TSnapshot>,
  events: AppStartupEvents<TSnapshot>,
  options: AppStartupOptions = {},
): AppStartupSession {
  const watchdogMs = options.watchdogMs ?? APP_STARTUP_WATCHDOG_MS;
  const stageTimeoutMs = options.stageTimeoutMs ?? APP_STARTUP_STAGE_TIMEOUT_MS;
  const baseTimers = options.timers ?? defaultTimers;
  const pendingTimerIds = new Set<ReturnType<typeof setTimeout>>();
  const timers: AppStartupTimers = {
    setTimeout(handler, ms) {
      const id = baseTimers.setTimeout(() => {
        pendingTimerIds.delete(id);
        handler();
      }, ms);
      pendingTimerIds.add(id);
      return id;
    },
    clearTimeout(id) {
      pendingTimerIds.delete(id);
      baseTimers.clearTimeout(id);
    },
  };

  let cancelled = false;
  let settled = false;
  let currentStage: AppStartupStage = 'opening-database';
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const clearAllTimers = () => {
    for (const id of pendingTimerIds) {
      baseTimers.clearTimeout(id);
    }
    pendingTimerIds.clear();
  };

  const fail = (failure: AppStartupFailure) => {
    if (cancelled || settled) {
      return;
    }
    settled = true;
    clearAllTimers();
    events.onFailure(failure);
    resolveFinished();
  };

  const runStage = async <T>(stage: AppStartupStage, work: () => Promise<T>): Promise<T> => {
    if (cancelled || settled) {
      throw new Error('Startup cancelled.');
    }
    currentStage = stage;
    events.onStage(stage);
    try {
      return await withTimeout(
        work(),
        stageTimeoutMs,
        `Startup timed out after ${Math.round(stageTimeoutMs / 1000)} seconds during ${stage}.`,
        timers,
      );
    } catch (caught) {
      if (cancelled || settled) {
        throw caught;
      }
      if (caught instanceof Error && caught.message.includes('timed out')) {
        throw new AppStartupTimeoutError(stage, caught.message);
      }
      throw new Error(`Startup failed during ${stage}: ${errorMessage(caught, 'unknown error.')}`);
    }
  };

  timers.setTimeout(() => {
    fail({
      stage: currentStage,
      timedOut: true,
      message: `Startup timed out after ${Math.round(watchdogMs / 1000)} seconds during ${currentStage}.`,
    });
  }, watchdogMs);

  const startDeferredRecompute = () => {
    currentStage = 'path-variant-recompute';
    events.onStage('path-variant-recompute');
    void Promise.resolve()
      .then(() => host.recomputePathVariants())
      .catch((caught: unknown) => {
        events.onDeferredRecomputeError?.(
          errorMessage(caught, 'Path-variant recompute failed after Home was already shown.'),
        );
      });
  };

  void (async () => {
    try {
      await runStage('opening-database', () => host.preparePersistence());
      await runStage('tracker-recover', () => host.recoverTracker());
      await runStage('attempt-reconcile', () => host.reconcileAttempts());
      const snapshot = await runStage('load-home', () => host.loadHome());
      if (cancelled || settled) {
        return;
      }
      await events.onHomeReady(snapshot);
      if (cancelled || settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      startDeferredRecompute();
      resolveFinished();
    } catch (caught) {
      const timedOut = caught instanceof AppStartupTimeoutError;
      fail({
        stage: caught instanceof AppStartupTimeoutError ? caught.stage : currentStage,
        timedOut,
        message: errorMessage(caught, 'Could not open your saved data.'),
      });
    }
  })();

  return {
    cancel() {
      cancelled = true;
      clearAllTimers();
      if (!settled) {
        settled = true;
        resolveFinished();
      }
    },
    finished,
  };
}
