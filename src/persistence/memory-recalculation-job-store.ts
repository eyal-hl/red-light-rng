import {
  applyStagedUpdate,
  recalculationPlacesFingerprint,
} from '../domain/history-recalculation';
import type { Attempt } from '../domain/attempt';
import type { MemoryAttemptStore } from './memory-attempt-store';
import type { PlaceStore } from './place-store';
import type {
  CreateRecalculationJobResult,
  PublishRecalculationResult,
  RecalculationCounts,
  RecalculationItem,
  RecalculationItemResult,
  RecalculationItemState,
  RecalculationJob,
  RecalculationJobStore,
} from './recalculation-job-store';
import type { RouteStore } from './route-store';

function cloneItem(item: RecalculationItem): RecalculationItem {
  return {
    ...item,
    staged: item.staged ? { ...item.staged, crossings: item.staged.crossings.map((c) => ({ ...c })) } : null,
  };
}

/** In-memory twin of `SqliteRecalculationJobStore`; same observable behaviour, used for parity tests. */
export class MemoryRecalculationJobStore implements RecalculationJobStore {
  private job: RecalculationJob | null = null;
  private items: RecalculationItem[] = [];

  constructor(
    private readonly attempts: MemoryAttemptStore,
    private readonly places: PlaceStore,
    private readonly routes?: RouteStore,
  ) {}

  async getJob(): Promise<RecalculationJob | null> {
    return this.job ? { ...this.job } : null;
  }

  async createJob(job: RecalculationJob, attemptIds: string[]): Promise<CreateRecalculationJobResult> {
    if (this.job && (this.job.status === 'running' || this.job.status === 'ready')) {
      return { created: false, job: { ...this.job } };
    }
    this.job = { ...job, checkpointProcessed: 0, completedAtMs: null, message: null };
    this.items = attemptIds.map((attemptId, seq) => ({
      jobId: job.id,
      attemptId,
      seq,
      state: 'pending',
      detail: null,
      baseStartedAtMs: null,
      baseFinishedAtMs: null,
      staged: null,
    }));
    return { created: true, job: { ...this.job } };
  }

  async listPendingItems(jobId: string, limit: number): Promise<RecalculationItem[]> {
    return this.items
      .filter((item) => item.jobId === jobId && item.state === 'pending')
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(cloneItem);
  }

  async listItems(jobId: string, states?: RecalculationItemState[]): Promise<RecalculationItem[]> {
    return this.items
      .filter((item) => item.jobId === jobId && (!states || states.includes(item.state)))
      .sort((a, b) => a.seq - b.seq)
      .map(cloneItem);
  }

  async countItems(jobId: string): Promise<RecalculationCounts> {
    const counts: RecalculationCounts = {
      candidates: 0,
      pending: 0,
      processed: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      skippedEndpointChanged: 0,
      skippedInsufficientGps: 0,
      errors: 0,
    };
    for (const item of this.items) {
      if (item.jobId !== jobId) {
        continue;
      }
      counts.candidates += 1;
      if (item.state === 'pending') counts.pending += 1;
      else if (item.state === 'updated') counts.updated += 1;
      else if (item.state === 'unchanged') counts.unchanged += 1;
      else if (item.state === 'error') counts.errors += 1;
      else {
        counts.skipped += 1;
        if (item.detail === 'insufficient_gps') counts.skippedInsufficientGps += 1;
        else counts.skippedEndpointChanged += 1;
      }
    }
    counts.processed = counts.candidates - counts.pending;
    return counts;
  }

  async recordResults(jobId: string, results: RecalculationItemResult[], nowMs: number): Promise<boolean> {
    if (!this.job || this.job.id !== jobId || this.job.status !== 'running') {
      return false;
    }
    for (const result of results) {
      const item = this.items.find((candidate) => candidate.jobId === jobId && candidate.attemptId === result.attemptId);
      if (item && item.state === 'pending') {
        item.state = result.state;
        item.detail = result.detail;
        item.baseStartedAtMs = result.baseStartedAtMs;
        item.baseFinishedAtMs = result.baseFinishedAtMs;
        item.staged = result.staged ? cloneItem({ ...item, staged: result.staged }).staged : null;
      }
    }
    this.job.checkpointProcessed = this.items.filter((item) => item.jobId === jobId && item.state !== 'pending').length;
    this.job.updatedAtMs = nowMs;
    return true;
  }

  async markReady(jobId: string, nowMs: number): Promise<boolean> {
    if (!this.job || this.job.id !== jobId) {
      return false;
    }
    if (this.items.some((item) => item.jobId === jobId && item.state === 'pending')) {
      return false;
    }
    if (this.job.status === 'running') {
      this.job.status = 'ready';
      this.job.updatedAtMs = nowMs;
    }
    return true;
  }

  async discardJob(jobId: string, message: string, nowMs: number): Promise<void> {
    if (!this.job || this.job.id !== jobId) {
      return;
    }
    this.items = this.items.filter((item) => item.jobId !== jobId);
    if (this.job.status === 'running' || this.job.status === 'ready') {
      this.job = { ...this.job, status: 'cancelled', message, updatedAtMs: nowMs, completedAtMs: nowMs };
    }
  }

  async publishJob(jobId: string, nowMs: number): Promise<PublishRecalculationResult> {
    const job = this.job;
    if (!job || job.id !== jobId) {
      return { ok: false, reason: 'no_job' };
    }
    if (job.status !== 'ready') {
      return { ok: false, reason: 'not_ready' };
    }
    if (await this.attempts.getOpenAttempt()) {
      return { ok: false, reason: 'open_attempt' };
    }
    if (recalculationPlacesFingerprint(await this.places.listPlaces()) !== job.placesFingerprint) {
      return { ok: false, reason: 'places_changed' };
    }
    // Build the complete new state first; nothing is visible until the single atomic swap below.
    const writes: Attempt[] = [];
    const itemUpdates: { item: RecalculationItem; error: string | null }[] = [];
    for (const item of this.items.filter((candidate) => candidate.jobId === jobId && candidate.state === 'updated')) {
      const current = await this.attempts.getAttempt(item.attemptId);
      if (
        !item.staged ||
        !current ||
        current.lifecycle !== 'completed' ||
        current.startedAtMs !== item.baseStartedAtMs ||
        current.finishedAtMs !== item.baseFinishedAtMs
      ) {
        itemUpdates.push({ item, error: 'Run changed or was removed during recalculation; original kept.' });
        continue;
      }
      let updated = applyStagedUpdate(current, item.staged);
      if (item.staged.routeId != null && this.routes && !(await this.routes.getRoute(item.staged.routeId))) {
        updated = { ...updated, routeId: null, crossings: [], reconciliationStatus: 'pending', reconciliationVersion: 0 };
      }
      writes.push(updated);
      itemUpdates.push({ item, error: null });
    }
    await this.attempts.saveAttemptsAtomically(writes);
    for (const { item, error } of itemUpdates) {
      if (error) {
        item.state = 'error';
        item.detail = error;
      }
      item.staged = null;
    }
    this.job = { ...job, status: 'published', updatedAtMs: nowMs, completedAtMs: nowMs };
    return { ok: true };
  }

  async clearAll(): Promise<void> {
    this.job = null;
    this.items = [];
  }
}
