import type { Attempt } from '../domain/attempt';
import {
  competitiveCheckpointEditBlockReason,
  CompetitiveCheckpointValidationError,
  type CompetitiveCheckpoint,
  type CompetitiveCheckpointConfig,
  type CompetitiveCheckpointIssue,
  type CompetitiveCheckpointPool,
} from '../domain/competitive-checkpoint';
import {
  HISTORY_JOB_BLOCKS_SEGMENTS_REASON,
  isBlockingRecalculationStatus,
  RECALCULATION_CANCELLED_MESSAGE,
  RECALCULATION_PLACES_CHANGED_MESSAGE,
  recalculationPlacesFingerprint,
  SEGMENT_RECALCULATION_CONFIG_CHANGED_MESSAGE,
  SEGMENT_RECALCULATION_LIVE_ATTEMPT_REASON,
  SEGMENT_RECALCULATION_NO_CANDIDATES_REASON,
  type RecalculationJobStatus,
  type SegmentRecalculationScope,
} from '../domain/history-recalculation';
import { createId } from '../domain/ids';
import { journeyPoolKey } from '../domain/journey';
import {
  deriveSegments,
  isSegmentResultStale,
  segmentResultsFromDerivation,
  type SegmentNotEligibleReason,
} from '../domain/segment-derivation';
import {
  buildSegmentBoards,
  type SegmentBoard,
  type SegmentBoardFilter,
  type SegmentBoardSort,
} from '../domain/segment-leaderboard';
import type { AttemptStore } from '../persistence/attempt-store';
import type { CompetitiveCheckpointStore } from '../persistence/competitive-checkpoint-store';
import type { LocationSampleStore } from '../persistence/location-sample-store';
import type { PlaceStore } from '../persistence/place-store';
import type {
  RecalculationItemResult,
  RecalculationJob,
  RecalculationJobStore,
} from '../persistence/recalculation-job-store';
import { yieldToEventLoop, type IdleYield } from './idle-yield';
import {
  RECALCULATION_DEFAULT_CHUNK_SIZE,
  type RecalculationProgress,
  type RunRecalculationResult,
  type StartRecalculationResult,
} from './history-recalculation';

/** Completed, valid attempt with official times and both endpoints: the only kind that derives segments. */
export function isSegmentEligibleAttempt(attempt: Attempt): boolean {
  return (
    attempt.lifecycle === 'completed' &&
    attempt.validity === 'valid' &&
    attempt.originPlaceId != null &&
    attempt.destinationPlaceId != null &&
    attempt.startedAtMs != null &&
    attempt.finishedAtMs != null
  );
}

function poolOf(attempt: Attempt): CompetitiveCheckpointPool | null {
  if (attempt.originPlaceId == null || attempt.destinationPlaceId == null) {
    return null;
  }
  return {
    originPlaceId: attempt.originPlaceId,
    destinationPlaceId: attempt.destinationPlaceId,
    transportationMode: attempt.transportationMode,
  };
}

/** A partial attempt's start is only meaningful against the exact configuration version it started in. */
function attemptMatchesConfig(attempt: Attempt, config: CompetitiveCheckpointConfig): boolean {
  return attempt.kind !== 'partial' || attempt.checkpointConfigVersion === config.version;
}

export type DeriveForAttemptResult =
  | { status: 'derived'; configVersion: number; resultCount: number }
  | { status: 'skipped'; reason: 'no_attempt' | 'no_config' | 'not_eligible' | 'config_mismatch' | 'error' };

export type SegmentPoolStatus = {
  pool: CompetitiveCheckpointPool;
  config: CompetitiveCheckpointConfig | null;
  /** Completed valid attempts that can derive segments under the current configuration. */
  eligibleAttemptCount: number;
  /** Of those, how many have results for the current configuration and algorithm version. */
  currentAttemptCount: number;
  /** Eligible attempts with no current results: need "Recalculate segments"; never shown mixed. */
  staleAttemptCount: number;
  needsRecalculation: boolean;
  /** Why the configuration cannot be edited right now, or null. */
  editLockReason: string | null;
  /** Kind of the job holding the shared slot, if one is running or waiting to be published. */
  blockingJobKind: 'history' | 'segments' | null;
};

export type SaveCheckpointsResult =
  | { ok: true; config: CompetitiveCheckpointConfig; changed: boolean }
  | { ok: false; reason: string; issues: CompetitiveCheckpointIssue[] };

export type SegmentBoardsResult = {
  config: CompetitiveCheckpointConfig | null;
  status: SegmentPoolStatus;
  /** Empty while no configuration exists. Results of stale versions are never included. */
  boards: SegmentBoard[];
};

export type CompetitiveSegmentsDeps = {
  checkpoints: CompetitiveCheckpointStore;
  attempts: AttemptStore;
  sessions: LocationSampleStore;
  places: PlaceStore;
  jobs: RecalculationJobStore;
  now?: () => number;
  /** Called after results change so derived views can be refreshed. */
  onResultsChanged?: () => void;
};

/**
 * Product API for competitive checkpoint segments (DEC-016): live derivation when a run finishes,
 * the checkpoint edit lock, per-pool stale status and the segment leaderboards. The manual
 * backfill job is `SegmentRecalculationService`. Derived rows only: official attempt timing,
 * ranks and PBs are never touched.
 */
export class CompetitiveSegmentsService {
  private readonly now: () => number;

  constructor(private readonly deps: CompetitiveSegmentsDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Derives and stores segment results of one finished attempt for the pool's CURRENT configuration.
   * Meant to run off the critical path after the official result is saved; never throws, and a
   * failure leaves the official attempt and any earlier results untouched.
   */
  async deriveForAttempt(attemptId: string): Promise<DeriveForAttemptResult> {
    try {
      const attempt = await this.deps.attempts.getAttempt(attemptId);
      if (!attempt) {
        return { status: 'skipped', reason: 'no_attempt' };
      }
      const pool = poolOf(attempt);
      if (!pool || !isSegmentEligibleAttempt(attempt)) {
        return { status: 'skipped', reason: 'not_eligible' };
      }
      const config = await this.deps.checkpoints.getCurrentConfig(pool);
      if (!config || config.checkpoints.length === 0) {
        return { status: 'skipped', reason: 'no_config' };
      }
      if (!attemptMatchesConfig(attempt, config)) {
        return { status: 'skipped', reason: 'config_mismatch' };
      }
      const [origin, destination, samples] = await Promise.all([
        this.deps.places.getPlace(pool.originPlaceId),
        this.deps.places.getPlace(pool.destinationPlaceId),
        this.deps.sessions.listSamples(attempt.sessionId),
      ]);
      const derivation = deriveSegments({ attempt, samples, config, origin, destination });
      if (derivation.status !== 'derived') {
        return { status: 'skipped', reason: 'not_eligible' };
      }
      const results = segmentResultsFromDerivation(derivation, this.now());
      await this.deps.checkpoints.replaceSegmentResults([
        { attemptId: attempt.id, configVersion: config.version, results },
      ]);
      this.deps.onResultsChanged?.();
      return { status: 'derived', configVersion: config.version, resultCount: results.length };
    } catch {
      return { status: 'skipped', reason: 'error' };
    }
  }

  async getCurrentConfig(pool: CompetitiveCheckpointPool): Promise<CompetitiveCheckpointConfig | null> {
    return this.deps.checkpoints.getCurrentConfig(pool);
  }

  async getEditLockReason(): Promise<string | null> {
    const [open, job] = await Promise.all([this.deps.attempts.getOpenAttempt(), this.deps.jobs.getJob()]);
    return competitiveCheckpointEditBlockReason({
      openAttempt: open != null,
      recalculationJobExists: job != null && isBlockingRecalculationStatus(job.status),
    });
  }

  /**
   * Saves a new configuration version. Rejected while a run is armed/active or any recalculation
   * job (either kind) exists, and when it breaks the radius/overlap rules. Existing results become
   * stale by version; nothing is recomputed automatically.
   */
  async saveCheckpoints(
    pool: CompetitiveCheckpointPool,
    checkpoints: CompetitiveCheckpoint[],
  ): Promise<SaveCheckpointsResult> {
    const lock = await this.getEditLockReason();
    if (lock) {
      return { ok: false, reason: lock, issues: [] };
    }
    const places = await this.deps.places.listPlaces();
    if (!places.some((p) => p.id === pool.originPlaceId) || !places.some((p) => p.id === pool.destinationPlaceId)) {
      return { ok: false, reason: 'This journey no longer exists.', issues: [] };
    }
    const before = await this.deps.checkpoints.getCurrentConfig(pool);
    try {
      const config = await this.deps.checkpoints.saveConfig({ pool, checkpoints, places, nowMs: this.now() });
      return { ok: true, config, changed: config.version !== (before?.version ?? 0) };
    } catch (error) {
      if (error instanceof CompetitiveCheckpointValidationError) {
        return { ok: false, reason: error.issues[0]?.message ?? error.message, issues: error.issues };
      }
      throw error;
    }
  }

  async getPoolStatus(pool: CompetitiveCheckpointPool): Promise<SegmentPoolStatus> {
    const [config, attempts, results, lock, job] = await Promise.all([
      this.deps.checkpoints.getCurrentConfig(pool),
      this.deps.attempts.listAttemptsForJourney(
        pool.originPlaceId,
        pool.destinationPlaceId,
        pool.transportationMode,
        { kind: 'all' },
      ),
      this.currentResultsLookup(pool),
      this.getEditLockReason(),
      this.deps.jobs.getJob(),
    ]);
    let eligible = 0;
    let current = 0;
    if (config && config.checkpoints.length > 0) {
      for (const attempt of attempts) {
        if (!isSegmentEligibleAttempt(attempt) || !attemptMatchesConfig(attempt, config)) {
          continue;
        }
        eligible += 1;
        if (results.has(attempt.id)) {
          current += 1;
        }
      }
    }
    return {
      pool,
      config,
      eligibleAttemptCount: eligible,
      currentAttemptCount: current,
      staleAttemptCount: eligible - current,
      needsRecalculation: eligible - current > 0,
      editLockReason: lock,
      blockingJobKind: job && isBlockingRecalculationStatus(job.status) ? job.kind : null,
    };
  }

  /** Attempt ids having at least one result for the current configuration and algorithm version. */
  private async currentResultsLookup(pool: CompetitiveCheckpointPool): Promise<Set<string>> {
    const config = await this.deps.checkpoints.getCurrentConfig(pool);
    if (!config) {
      return new Set();
    }
    const rows = await this.deps.checkpoints.listSegmentResultsForPool(pool, config.version);
    return new Set(rows.filter((row) => !isSegmentResultStale(row, config.version)).map((row) => row.attemptId));
  }

  /**
   * Segment leaderboards for the pool's current configuration. The full-route board is a separate,
   * unchanged code path and stays the default; this only returns derived segment boards.
   */
  async loadSegmentBoards(
    pool: CompetitiveCheckpointPool,
    options: { filter?: SegmentBoardFilter; sort?: SegmentBoardSort } = {},
  ): Promise<SegmentBoardsResult> {
    const status = await this.getPoolStatus(pool);
    const config = status.config;
    if (!config || config.checkpoints.length === 0) {
      return { config, status, boards: [] };
    }
    const [origin, destination, attempts, results] = await Promise.all([
      this.deps.places.getPlace(pool.originPlaceId),
      this.deps.places.getPlace(pool.destinationPlaceId),
      this.deps.attempts.listAttemptsForJourney(
        pool.originPlaceId,
        pool.destinationPlaceId,
        pool.transportationMode,
        { kind: 'all' },
      ),
      this.deps.checkpoints.listSegmentResultsForPool(pool, config.version),
    ]);
    const boards = buildSegmentBoards({
      config,
      originName: origin?.name ?? 'Start',
      destinationName: destination?.name ?? 'Finish',
      results,
      attempts: attempts.filter((attempt) => attemptMatchesConfig(attempt, config)),
      filter: options.filter,
      sort: options.sort,
    });
    return { config, status, boards };
  }
}

export type SegmentRecalculationPreview = {
  candidateCount: number;
  configuredPoolCount: number;
  openAttempt: boolean;
  /** Kind of the other job currently holding the shared slot, if any. */
  blockingJobKind: 'history' | 'segments' | null;
  existingJob: RecalculationProgress | null;
};

export type SegmentRecalculationDeps = CompetitiveSegmentsDeps & {
  createJobId?: () => string;
  yieldToIdle?: IdleYield;
  chunkSize?: number;
};

/**
 * Manual, user-confirmed, resumable "Recalculate segments" job (DEC-016, #81). A distinct kind in
 * the shared recalculation job slot (at most one job of ANY kind), following DEC-015: bounded
 * chunks with yields, a persisted checkpoint, resume after relaunch, cancel before publication,
 * retry of failed runs as a follow-up job, pause behind a live attempt, and ONE atomic publication
 * of derived rows. It never starts automatically and never writes an attempt.
 */
export class SegmentRecalculationService {
  private running = false;
  private onPublished: () => void = () => {};
  private readonly now: () => number;
  private readonly createJobId: () => string;
  private readonly yieldToIdle: IdleYield;
  private readonly chunkSize: number;

  constructor(private readonly deps: SegmentRecalculationDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.createJobId = deps.createJobId ?? createId;
    this.yieldToIdle = deps.yieldToIdle ?? yieldToEventLoop;
    this.chunkSize = Math.max(1, deps.chunkSize ?? RECALCULATION_DEFAULT_CHUNK_SIZE);
  }

  setOnPublished(callback: () => void): void {
    this.onPublished = callback;
  }

  private async segmentsJob(): Promise<RecalculationJob | null> {
    const job = await this.deps.jobs.getJob();
    return job && job.kind === 'segments' ? job : null;
  }

  /** A job of any kind is running or waiting to be published. */
  async hasBlockingJob(): Promise<boolean> {
    const job = await this.deps.jobs.getJob();
    return job != null && isBlockingRecalculationStatus(job.status);
  }

  async getProgress(): Promise<RecalculationProgress | null> {
    const job = await this.segmentsJob();
    return job ? this.progressFor(job) : null;
  }

  async preview(pool?: CompetitiveCheckpointPool): Promise<SegmentRecalculationPreview> {
    const scope = await this.buildScope(pool);
    const job = await this.deps.jobs.getJob();
    return {
      candidateCount: (await this.candidateIds(scope)).length,
      configuredPoolCount: scope.pools.length,
      openAttempt: (await this.deps.attempts.getOpenAttempt()) != null,
      blockingJobKind: job && isBlockingRecalculationStatus(job.status) ? job.kind : null,
      existingJob: await this.getProgress(),
    };
  }

  async start(options: { pool?: CompetitiveCheckpointPool; onlyAttemptIds?: string[] } = {}): Promise<StartRecalculationResult> {
    const existing = await this.deps.jobs.getJob();
    if (existing && isBlockingRecalculationStatus(existing.status)) {
      if (existing.kind !== 'segments') {
        return { ok: false, reason: HISTORY_JOB_BLOCKS_SEGMENTS_REASON };
      }
      return { ok: true, alreadyExists: true, progress: await this.progressFor(existing) };
    }
    if (await this.deps.attempts.getOpenAttempt()) {
      return { ok: false, reason: SEGMENT_RECALCULATION_LIVE_ATTEMPT_REASON };
    }
    const scope = await this.buildScope(options.pool);
    const only = options.onlyAttemptIds ? new Set(options.onlyAttemptIds) : null;
    const candidates = (await this.candidateIds(scope)).filter((id) => !only || only.has(id));
    if (candidates.length === 0) {
      return { ok: false, reason: SEGMENT_RECALCULATION_NO_CANDIDATES_REASON };
    }
    const nowMs = this.now();
    const created = await this.deps.jobs.createJob(
      {
        id: this.createJobId(),
        kind: 'segments',
        scope,
        status: 'running',
        placesFingerprint: recalculationPlacesFingerprint(await this.deps.places.listPlaces()),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        completedAtMs: null,
        candidateCount: candidates.length,
        preSkippedMissingPlace: 0,
        preSkippedNoTrace: 0,
        checkpointProcessed: 0,
        message: null,
      },
      candidates,
    );
    return { ok: true, alreadyExists: !created.created, progress: await this.progressFor(created.job) };
  }

  async retryFailed(): Promise<StartRecalculationResult> {
    const job = await this.segmentsJob();
    if (!job) {
      return { ok: false, reason: 'There is no segment recalculation to retry.' };
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

  async cancel(): Promise<{ ok: boolean; progress: RecalculationProgress | null }> {
    const job = await this.segmentsJob();
    if (!job || !isBlockingRecalculationStatus(job.status)) {
      return { ok: false, progress: job ? await this.progressFor(job) : null };
    }
    await this.deps.jobs.discardJob(job.id, RECALCULATION_CANCELLED_MESSAGE, this.now());
    return { ok: true, progress: await this.getProgress() };
  }

  /** Same contract as `HistoryRecalculationService.run`: safe to call again after relaunch. */
  async run(
    options: { onProgress?: (progress: RecalculationProgress) => void | Promise<void>; shouldStop?: () => boolean } = {},
  ): Promise<RunRecalculationResult> {
    if (this.running) {
      return { status: 'already_running', progress: await this.getProgress() };
    }
    this.running = true;
    try {
      for (;;) {
        const job = await this.segmentsJob();
        if (!job || !isBlockingRecalculationStatus(job.status)) {
          return job ? { status: 'cancelled', progress: await this.progressFor(job) } : { status: 'none' };
        }
        if (await this.scopeChanged(job)) {
          await this.deps.jobs.discardJob(job.id, this.changedMessage(job), this.now());
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
            const results: RecalculationItemResult[] = [];
            for (const item of pending) {
              results.push(await this.processAttempt(job, item.attemptId));
            }
            await this.deps.jobs.recordResults(job.id, results, this.now());
            await options.onProgress?.(await this.progressFor((await this.deps.jobs.getJob()) ?? job));
            await this.yieldToIdle();
            continue;
          }
          await this.deps.jobs.markReady(job.id, this.now());
          continue;
        }
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
          this.deps.onResultsChanged?.();
          const progress = (await this.getProgress())!;
          await options.onProgress?.(progress);
          return { status: 'published', progress };
        }
        if (published.reason === 'open_attempt') {
          return { status: 'paused', progress: await this.progressFor(job) };
        }
        if (published.reason === 'places_changed' || published.reason === 'config_changed') {
          await this.deps.jobs.discardJob(job.id, this.changedMessage(job, published.reason), this.now());
          return { status: 'cancelled', progress: (await this.getProgress())! };
        }
        return { status: 'cancelled', progress: await this.progressFor((await this.deps.jobs.getJob()) ?? job) };
      }
    } finally {
      this.running = false;
    }
  }

  private changedMessage(_job: RecalculationJob, reason: 'places_changed' | 'config_changed' = 'config_changed'): string {
    return reason === 'places_changed'
      ? RECALCULATION_PLACES_CHANGED_MESSAGE
      : SEGMENT_RECALCULATION_CONFIG_CHANGED_MESSAGE;
  }

  /** Places or any scoped configuration changed since the job started: staged rows are no longer valid. */
  private async scopeChanged(job: RecalculationJob): Promise<boolean> {
    if (recalculationPlacesFingerprint(await this.deps.places.listPlaces()) !== job.placesFingerprint) {
      return true;
    }
    for (const entry of job.scope?.pools ?? []) {
      const current = await this.deps.checkpoints.getCurrentConfig(entry.pool);
      if (!current || current.version !== entry.configVersion) {
        return true;
      }
    }
    return false;
  }

  private async buildScope(pool?: CompetitiveCheckpointPool): Promise<SegmentRecalculationScope> {
    const configs = await this.deps.checkpoints.listCurrentConfigs();
    return {
      pools: configs
        .filter(
          (config) =>
            config.checkpoints.length > 0 && (!pool || journeyPoolKey(config.pool) === journeyPoolKey(pool)),
        )
        .map((config) => ({ pool: config.pool, configVersion: config.version }))
        .sort((a, b) => journeyPoolKey(a.pool).localeCompare(journeyPoolKey(b.pool))),
    };
  }

  /** Completed valid attempts (any kind) of the scoped pools, in a stable order. */
  private async candidateIds(scope: SegmentRecalculationScope): Promise<string[]> {
    const wanted = new Set(scope.pools.map((entry) => journeyPoolKey(entry.pool)));
    if (wanted.size === 0) {
      return [];
    }
    const attempts = (await this.deps.attempts.listAttempts({ kind: 'all' }))
      .filter((attempt) => {
        const pool = poolOf(attempt);
        return pool != null && wanted.has(journeyPoolKey(pool)) && isSegmentEligibleAttempt(attempt);
      })
      .sort((a, b) => a.armedAtMs - b.armedAtMs || a.id.localeCompare(b.id));
    return attempts.map((attempt) => attempt.id);
  }

  /** Never throws: a failure becomes an `error` item and nothing is written for that attempt. */
  private async processAttempt(job: RecalculationJob, attemptId: string): Promise<RecalculationItemResult> {
    try {
      const attempt = await this.deps.attempts.getAttempt(attemptId);
      if (!attempt || !isSegmentEligibleAttempt(attempt)) {
        return failure(attemptId, 'Run is no longer an eligible completed run; nothing changed.');
      }
      const base = { baseStartedAtMs: attempt.startedAtMs, baseFinishedAtMs: attempt.finishedAtMs };
      const pool = poolOf(attempt)!;
      const entry = job.scope?.pools.find((item) => journeyPoolKey(item.pool) === journeyPoolKey(pool));
      const config = entry ? await this.deps.checkpoints.getConfig(pool, entry.configVersion) : null;
      if (!entry || !config) {
        return failure(attemptId, 'Checkpoint configuration is no longer available.');
      }
      if (!attemptMatchesConfig(attempt, config)) {
        return { attemptId, state: 'skipped', detail: 'config_mismatch', ...base, staged: null };
      }
      const [origin, destination, samples] = await Promise.all([
        this.deps.places.getPlace(pool.originPlaceId),
        this.deps.places.getPlace(pool.destinationPlaceId),
        this.deps.sessions.listSamples(attempt.sessionId),
      ]);
      const derivation = deriveSegments({ attempt, samples, config, origin, destination });
      if (derivation.status !== 'derived') {
        const reason: SegmentNotEligibleReason | null = derivation.notEligibleReason;
        return { attemptId, state: 'skipped', detail: reason ?? 'not_eligible', ...base, staged: null };
      }
      // `derivedAtMs` is the job's start time so a resumed or repeated job writes identical rows.
      const rows = segmentResultsFromDerivation(derivation, job.createdAtMs);
      return { attemptId, state: 'updated', detail: null, ...base, staged: null, stagedSegments: rows };
    } catch (error) {
      return failure(attemptId, error instanceof Error ? error.message : 'Segment recalculation failed; nothing changed.');
    }
  }

  private async progressFor(job: RecalculationJob): Promise<RecalculationProgress> {
    const counts = await this.deps.jobs.countItems(job.id);
    let displayStatus: RecalculationJobStatus | 'paused' = job.status;
    if (job.status === 'running' && (await this.deps.attempts.getOpenAttempt())) {
      displayStatus = 'paused';
    }
    return {
      job,
      displayStatus,
      counts: job.status === 'cancelled' ? { ...counts, candidates: job.candidateCount } : counts,
      totalCompletedRuns: job.candidateCount,
      preSkipped: 0,
      skippedTotal: counts.skipped,
      canRetryFailed: job.status === 'published' && counts.errors > 0,
    };
  }
}

function failure(attemptId: string, message: string): RecalculationItemResult {
  return {
    attemptId,
    state: 'error',
    detail: message,
    baseStartedAtMs: null,
    baseFinishedAtMs: null,
    staged: null,
  };
}
