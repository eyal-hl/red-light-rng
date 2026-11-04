import type { Attempt } from '../domain/attempt';
import { reconstructAttemptLocalStart } from '../domain/attempt-local-time';
import {
  evaluateAttemptRecalculation,
  isBlockingRecalculationStatus,
  RECALCULATION_CANCELLED_MESSAGE,
  RECALCULATION_LIVE_ATTEMPT_REASON,
  RECALCULATION_NO_CANDIDATES_REASON,
  RECALCULATION_PLACES_CHANGED_MESSAGE,
  recalculationPlacesFingerprint,
  type RecalculationJobStatus,
} from '../domain/history-recalculation';
import { createId } from '../domain/ids';
import type { LocationSample } from '../domain/location-sample';
import type { AttemptStore } from '../persistence/attempt-store';
import type { LocationSampleStore } from '../persistence/location-sample-store';
import type { PlaceStore } from '../persistence/place-store';
import type {
  RecalculationCounts,
  RecalculationItemResult,
  RecalculationJob,
  RecalculationJobStore,
} from '../persistence/recalculation-job-store';
import { yieldToEventLoop, type IdleYield } from './idle-yield';

export const RECALCULATION_DEFAULT_CHUNK_SIZE = 20;

export type RecalculationPreview = {
  candidateCount: number;
  preSkippedMissingPlace: number;
  preSkippedNoTrace: number;
  openAttempt: boolean;
  existingJob: RecalculationProgress | null;
};

export type RecalculationProgress = {
  job: RecalculationJob;
  /** Status shown to the user: `paused` is `running` while an attempt is armed/active. */
  displayStatus: RecalculationJobStatus | 'paused';
  counts: RecalculationCounts;
  /** Candidates + pre-skipped completed runs. */
  totalCompletedRuns: number;
  preSkipped: number;
  /** All skipped runs the user should see: pre-skipped plus skipped during processing. */
  skippedTotal: number;
  /** Failed attempt IDs are retried via `retryFailed()`. */
  canRetryFailed: boolean;
};

export type StartRecalculationResult =
  | { ok: true; alreadyExists: boolean; progress: RecalculationProgress }
  | { ok: false; reason: string };

export type RunRecalculationResult =
  | { status: 'none' }
  | { status: 'already_running'; progress: RecalculationProgress | null }
  | { status: 'paused'; progress: RecalculationProgress }
  | { status: 'stopped'; progress: RecalculationProgress }
  | { status: 'published'; progress: RecalculationProgress }
  | { status: 'cancelled'; progress: RecalculationProgress }
  | { status: 'publish_failed'; progress: RecalculationProgress; error: string };

export type HistoryRecalculationDeps = {
  jobs: RecalculationJobStore;
  attempts: AttemptStore;
  sessions: LocationSampleStore;
  places: PlaceStore;
  /** Path-variant / split reassignment for a changed official window (AttemptRuntime). */
  reassignPathVariant: (attempt: Attempt, samples: LocationSample[]) => Promise<Attempt>;
  now?: () => number;
  createJobId?: () => string;
  yieldToIdle?: IdleYield;
  chunkSize?: number;
};

export class HistoryRecalculationService {
  private running = false;
  private onPublished: () => void = () => {};
  private readonly now: () => number;
  private readonly createJobId: () => string;
  private readonly yieldToIdle: IdleYield;
  private readonly chunkSize: number;

  constructor(private readonly deps: HistoryRecalculationDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.createJobId = deps.createJobId ?? createId;
    this.yieldToIdle = deps.yieldToIdle ?? yieldToEventLoop;
    this.chunkSize = Math.max(1, deps.chunkSize ?? RECALCULATION_DEFAULT_CHUNK_SIZE);
  }

  /** Called after a successful publication so derived caches/statistics are dropped. */
  setOnPublished(callback: () => void): void {
    this.onPublished = callback;
  }

  async hasBlockingJob(): Promise<boolean> {
    const job = await this.deps.jobs.getJob();
    return job != null && isBlockingRecalculationStatus(job.status);
  }

  async getProgress(): Promise<RecalculationProgress | null> {
    const job = await this.deps.jobs.getJob();
    return job ? this.progressFor(job) : null;
  }

  /** Read-only scope for the confirmation step. Writes nothing. */
  async preview(): Promise<RecalculationPreview> {
    const scope = await this.classifyScope();
    return {
      candidateCount: scope.candidateIds.length,
      preSkippedMissingPlace: scope.missingPlace,
      preSkippedNoTrace: scope.noTrace,
      openAttempt: (await this.deps.attempts.getOpenAttempt()) != null,
      existingJob: await this.getProgress(),
    };
  }

  /**
   * Starts a job (manual action only). A duplicate trigger returns the existing job. The candidate
   * list and the Places fingerprint are fixed here.
   */
  async start(options: { onlyAttemptIds?: string[] } = {}): Promise<StartRecalculationResult> {
    const existing = await this.deps.jobs.getJob();
    if (existing && isBlockingRecalculationStatus(existing.status)) {
      return { ok: true, alreadyExists: true, progress: await this.progressFor(existing) };
    }
    if (await this.deps.attempts.getOpenAttempt()) {
      return { ok: false, reason: RECALCULATION_LIVE_ATTEMPT_REASON };
    }
    const places = await this.deps.places.listPlaces();
    const scope = await this.classifyScope(places, options.onlyAttemptIds);
    if (scope.candidateIds.length === 0) {
      return { ok: false, reason: RECALCULATION_NO_CANDIDATES_REASON };
    }
    const nowMs = this.now();
    const created = await this.deps.jobs.createJob(
      {
        id: this.createJobId(),
        status: 'running',
        placesFingerprint: recalculationPlacesFingerprint(places),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        completedAtMs: null,
        candidateCount: scope.candidateIds.length,
        preSkippedMissingPlace: scope.missingPlace,
        preSkippedNoTrace: scope.noTrace,
        checkpointProcessed: 0,
        message: null,
      },
      scope.candidateIds,
    );
    return { ok: true, alreadyExists: !created.created, progress: await this.progressFor(created.job) };
  }

  /** Starts a follow-up job for exactly the attempts that errored in the last job. */
  async retryFailed(): Promise<StartRecalculationResult> {
    const job = await this.deps.jobs.getJob();
    if (!job) {
      return { ok: false, reason: 'There is no recalculation to retry.' };
    }
    if (isBlockingRecalculationStatus(job.status)) {
      return { ok: true, alreadyExists: true, progress: await this.progressFor(job) };
    }
    const failed = await this.deps.jobs.listItems(job.id, ['error']);
    if (failed.length === 0) {
      return { ok: false, reason: 'No failed runs to retry.' };
    }
    return this.start({ onlyAttemptIds: failed.map((item) => item.attemptId) });
  }

  /** Cancels before publication; staged results are discarded and nothing is changed. */
  async cancel(): Promise<{ ok: boolean; progress: RecalculationProgress | null }> {
    const job = await this.deps.jobs.getJob();
    if (!job || !isBlockingRecalculationStatus(job.status)) {
      return { ok: false, progress: job ? await this.progressFor(job) : null };
    }
    await this.deps.jobs.discardJob(job.id, RECALCULATION_CANCELLED_MESSAGE, this.now());
    return { ok: true, progress: await this.getProgress() };
  }

  /**
   * Processes the job in bounded chunks, yielding between them, until it is published, cancelled,
   * paused behind a live attempt, or `shouldStop` returns true. Safe to call again at any time (e.g.
   * after relaunch): completed work lives in the persisted checkpoint and is never redone. No
   * elapsed-time cutoff exists.
   */
  async run(
    options: { onProgress?: (progress: RecalculationProgress) => void | Promise<void>; shouldStop?: () => boolean } = {},
  ): Promise<RunRecalculationResult> {
    if (this.running) {
      return { status: 'already_running', progress: await this.getProgress() };
    }
    this.running = true;
    try {
      for (;;) {
        const job = await this.deps.jobs.getJob();
        if (!job || !isBlockingRecalculationStatus(job.status)) {
          return job ? { status: 'cancelled', progress: await this.progressFor(job) } : { status: 'none' };
        }
        // Resume and every chunk: results are only valid for the exact Places they were computed with.
        if (await this.placesChanged(job)) {
          await this.deps.jobs.discardJob(job.id, RECALCULATION_PLACES_CHANGED_MESSAGE, this.now());
          return { status: 'cancelled', progress: (await this.getProgress())! };
        }
        if (await this.deps.attempts.getOpenAttempt()) {
          return { status: 'paused', progress: await this.progressFor(job) };
        }
        if (options.shouldStop?.()) {
          return { status: 'stopped', progress: await this.progressFor(job) };
        }
        if (job.status === 'running') {
          const pending = await this.deps.jobs.listPendingItems(job.id, this.chunkSize);
          if (pending.length > 0) {
            const places = await this.deps.places.listPlaces();
            const results: RecalculationItemResult[] = [];
            for (const item of pending) {
              results.push(await this.processAttempt(item.attemptId, places));
            }
            await this.deps.jobs.recordResults(job.id, results, this.now());
            await options.onProgress?.(await this.progressFor((await this.deps.jobs.getJob()) ?? job));
            await this.yieldToIdle();
            continue;
          }
          await this.deps.jobs.markReady(job.id, this.now());
          continue;
        }
        // status === 'ready': publish in one atomic step.
        let published;
        try {
          published = await this.deps.jobs.publishJob(job.id, this.now());
        } catch (error) {
          return {
            status: 'publish_failed',
            progress: await this.progressFor((await this.deps.jobs.getJob()) ?? job),
            error: error instanceof Error ? error.message : 'Publishing failed.',
          };
        }
        if (published.ok) {
          this.onPublished();
          const progress = (await this.getProgress())!;
          await options.onProgress?.(progress);
          return { status: 'published', progress };
        }
        if (published.reason === 'open_attempt') {
          return { status: 'paused', progress: await this.progressFor(job) };
        }
        if (published.reason === 'places_changed') {
          await this.deps.jobs.discardJob(job.id, RECALCULATION_PLACES_CHANGED_MESSAGE, this.now());
          return { status: 'cancelled', progress: (await this.getProgress())! };
        }
        return { status: 'cancelled', progress: await this.progressFor((await this.deps.jobs.getJob()) ?? job) };
      }
    } finally {
      this.running = false;
    }
  }

  private async placesChanged(job: RecalculationJob): Promise<boolean> {
    const places = await this.deps.places.listPlaces();
    return recalculationPlacesFingerprint(places) !== job.placesFingerprint;
  }

  private async classifyScope(
    placesInput?: Awaited<ReturnType<PlaceStore['listPlaces']>>,
    onlyAttemptIds?: string[],
  ): Promise<{ candidateIds: string[]; missingPlace: number; noTrace: number }> {
    const places = placesInput ?? (await this.deps.places.listPlaces());
    const known = new Set(places.map((place) => place.id));
    const only = onlyAttemptIds ? new Set(onlyAttemptIds) : null;
    const attempts = (await this.deps.attempts.listAttempts())
      .filter((attempt) => attempt.lifecycle === 'completed' && (!only || only.has(attempt.id)))
      .sort((a, b) => a.armedAtMs - b.armedAtMs || a.id.localeCompare(b.id));
    const candidateIds: string[] = [];
    let missingPlace = 0;
    let noTrace = 0;
    let sinceYield = 0;
    for (const attempt of attempts) {
      if (
        attempt.originPlaceId == null ||
        attempt.destinationPlaceId == null ||
        !known.has(attempt.originPlaceId) ||
        !known.has(attempt.destinationPlaceId)
      ) {
        missingPlace += 1;
        continue;
      }
      if ((await this.deps.sessions.countSamples(attempt.sessionId)) === 0) {
        noTrace += 1;
        continue;
      }
      candidateIds.push(attempt.id);
      sinceYield += 1;
      if (sinceYield % 100 === 0) {
        await this.yieldToIdle();
      }
    }
    return { candidateIds, missingPlace, noTrace };
  }

  /** Never throws: any failure becomes an `error` result and the original attempt stays untouched. */
  private async processAttempt(
    attemptId: string,
    places: Awaited<ReturnType<PlaceStore['listPlaces']>>,
  ): Promise<RecalculationItemResult> {
    try {
      const attempt = await this.deps.attempts.getAttempt(attemptId);
      if (!attempt || attempt.lifecycle !== 'completed') {
        return errorResult(attemptId, 'Run is no longer a completed run; original kept.');
      }
      const samples = await this.deps.sessions.listSamples(attempt.sessionId);
      const outcome = evaluateAttemptRecalculation({ attempt, samples, places });
      const base = { baseStartedAtMs: attempt.startedAtMs, baseFinishedAtMs: attempt.finishedAtMs };
      if (outcome.kind === 'unchanged') {
        return { attemptId, state: 'unchanged', detail: null, ...base, staged: null };
      }
      if (outcome.kind === 'skipped') {
        return { attemptId, state: 'skipped', detail: outcome.reason, ...base, staged: null };
      }
      const local =
        outcome.startedAtMs === attempt.startedAtMs &&
        attempt.startedUtcOffsetMinutes != null &&
        attempt.startedLocalTimeSource != null
          ? {
              startedUtcOffsetMinutes: attempt.startedUtcOffsetMinutes,
              startedTimezoneId: attempt.startedTimezoneId,
              startedLocalTimeSource: attempt.startedLocalTimeSource,
            }
          : reconstructAttemptLocalStart(outcome.startedAtMs);
      const retimed: Attempt = {
        ...attempt,
        startedAtMs: outcome.startedAtMs,
        finishedAtMs: outcome.finishedAtMs,
        ...local,
      };
      const reassigned = await this.deps.reassignPathVariant(retimed, samples);
      return {
        attemptId,
        state: 'updated',
        detail: null,
        ...base,
        staged: {
          startedAtMs: outcome.startedAtMs,
          finishedAtMs: outcome.finishedAtMs,
          ...local,
          routeId: reassigned.routeId,
          crossings: reassigned.crossings,
        },
      };
    } catch (error) {
      return errorResult(attemptId, error instanceof Error ? error.message : 'Recalculation failed; original kept.');
    }
  }

  private async progressFor(job: RecalculationJob): Promise<RecalculationProgress> {
    const counts = await this.deps.jobs.countItems(job.id);
    // Cancelled jobs have no items left; their summary is the message.
    const preSkipped = job.preSkippedMissingPlace + job.preSkippedNoTrace;
    let displayStatus: RecalculationProgress['displayStatus'] = job.status;
    if (job.status === 'running' && (await this.deps.attempts.getOpenAttempt())) {
      displayStatus = 'paused';
    }
    return {
      job,
      displayStatus,
      counts: job.status === 'cancelled' ? { ...counts, candidates: job.candidateCount } : counts,
      totalCompletedRuns: job.candidateCount + preSkipped,
      preSkipped,
      skippedTotal: counts.skipped + preSkipped,
      canRetryFailed: job.status === 'published' && counts.errors > 0,
    };
  }
}

function errorResult(attemptId: string, message: string): RecalculationItemResult {
  return {
    attemptId,
    state: 'error',
    detail: message,
    baseStartedAtMs: null,
    baseFinishedAtMs: null,
    staged: null,
  };
}
