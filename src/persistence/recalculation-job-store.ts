import type { RecalculationJobStatus, StagedAttemptUpdate } from '../domain/history-recalculation';

export type RecalculationItemState = 'pending' | 'updated' | 'unchanged' | 'skipped' | 'error';

export type RecalculationJob = {
  id: string;
  status: RecalculationJobStatus;
  /** Fingerprint of every Place's ID, centre and both radii when the job started. */
  placesFingerprint: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
  /** Candidates fixed at job start (completed attempts with a trace and both Places). */
  candidateCount: number;
  preSkippedMissingPlace: number;
  preSkippedNoTrace: number;
  /** Persisted checkpoint: candidates already processed (never redone on resume). */
  checkpointProcessed: number;
  message: string | null;
};

export type RecalculationItem = {
  jobId: string;
  attemptId: string;
  seq: number;
  state: RecalculationItemState;
  /** Skip reason code (`endpoint_changed` / `insufficient_gps`) or an error message. */
  detail: string | null;
  baseStartedAtMs: number | null;
  baseFinishedAtMs: number | null;
  staged: StagedAttemptUpdate | null;
};

export type RecalculationItemResult = {
  attemptId: string;
  state: Exclude<RecalculationItemState, 'pending'>;
  detail: string | null;
  baseStartedAtMs: number | null;
  baseFinishedAtMs: number | null;
  staged: StagedAttemptUpdate | null;
};

export type RecalculationCounts = {
  candidates: number;
  pending: number;
  processed: number;
  updated: number;
  unchanged: number;
  skipped: number;
  skippedEndpointChanged: number;
  skippedInsufficientGps: number;
  errors: number;
};

export type CreateRecalculationJobResult =
  | { created: true; job: RecalculationJob }
  | { created: false; job: RecalculationJob };

export type PublishRecalculationResult =
  | { ok: true }
  | { ok: false; reason: 'no_job' | 'not_ready' | 'open_attempt' | 'places_changed' };

/**
 * Local operational state for the manual history recalculation. Never part of the portable backup.
 * At most one job exists; terminal jobs (published/cancelled) stay only as the last summary until the
 * next job replaces them.
 */
export interface RecalculationJobStore {
  getJob(): Promise<RecalculationJob | null>;
  /** Atomic. Returns the existing job instead of creating a second one while one is running/ready. */
  createJob(job: RecalculationJob, attemptIds: string[]): Promise<CreateRecalculationJobResult>;
  listPendingItems(jobId: string, limit: number): Promise<RecalculationItem[]>;
  listItems(jobId: string, states?: RecalculationItemState[]): Promise<RecalculationItem[]>;
  countItems(jobId: string): Promise<RecalculationCounts>;
  /** Atomically records a chunk and advances the checkpoint. No-op unless the job is still running. */
  recordResults(jobId: string, results: RecalculationItemResult[], nowMs: number): Promise<boolean>;
  /** running -> ready once nothing is pending. */
  markReady(jobId: string, nowMs: number): Promise<boolean>;
  /** Discards all staged results and ends the job as cancelled with a message. */
  discardJob(jobId: string, message: string, nowMs: number): Promise<void>;
  /**
   * ONE atomic publication: re-checks no open attempt and the Places fingerprint, writes every staged
   * attempt update with its split/variant reassignment, and marks the job published. Either the old
   * state or the new state is visible, never a mix.
   */
  publishJob(jobId: string, nowMs: number): Promise<PublishRecalculationResult>;
  /** Restore: drop any job, in-progress or terminal. */
  clearAll(): Promise<void>;
}
