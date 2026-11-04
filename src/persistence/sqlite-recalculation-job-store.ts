import {
  applyStagedUpdate,
  recalculationPlacesFingerprint,
  type RecalculationJobStatus,
  type StagedAttemptUpdate,
} from '../domain/history-recalculation';
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
import type { RecalcJobItemRow, RecalcJobRow } from './schema';
import { runIsolated, type SqlExecutor } from './sql-executor';
import { SqliteAttemptStore, writeAttemptRecord } from './sqlite-attempt-store';
import { SqlitePlaceStore } from './sqlite-place-store';

function parseStatus(value: string): RecalculationJobStatus {
  return value === 'ready' || value === 'published' || value === 'cancelled' ? value : 'running';
}

function mapJob(row: RecalcJobRow): RecalculationJob {
  return {
    id: row.id,
    status: parseStatus(row.status),
    placesFingerprint: row.places_fingerprint,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms,
    candidateCount: row.candidate_count,
    preSkippedMissingPlace: row.pre_skipped_missing_place,
    preSkippedNoTrace: row.pre_skipped_no_trace,
    checkpointProcessed: row.checkpoint_processed,
    message: row.message,
  };
}

function parseState(value: string): RecalculationItemState {
  return value === 'updated' || value === 'unchanged' || value === 'skipped' || value === 'error'
    ? value
    : 'pending';
}

function mapItem(row: RecalcJobItemRow): RecalculationItem {
  return {
    jobId: row.job_id,
    attemptId: row.attempt_id,
    seq: row.seq,
    state: parseState(row.state),
    detail: row.detail,
    baseStartedAtMs: row.base_started_at_ms,
    baseFinishedAtMs: row.base_finished_at_ms,
    staged: row.staged_json ? (JSON.parse(row.staged_json) as StagedAttemptUpdate) : null,
  };
}

export class SqliteRecalculationJobStore implements RecalculationJobStore {
  constructor(private readonly getSql: () => Promise<SqlExecutor>) {}

  async getJob(): Promise<RecalculationJob | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<RecalcJobRow>(
      `SELECT * FROM recalc_job ORDER BY created_at_ms DESC, rowid DESC LIMIT 1`,
    );
    return row ? mapJob(row) : null;
  }

  async createJob(job: RecalculationJob, attemptIds: string[]): Promise<CreateRecalculationJobResult> {
    const sql = await this.getSql();
    return sql.withTransaction(async () => {
      const existing = await sql.getFirst<RecalcJobRow>(
        `SELECT * FROM recalc_job WHERE status IN ('running', 'ready') LIMIT 1`,
      );
      if (existing) {
        return { created: false as const, job: mapJob(existing) };
      }
      // Only the last terminal summary is kept; items cascade with their job.
      await sql.run('DELETE FROM recalc_job_item');
      await sql.run('DELETE FROM recalc_job');
      await sql.run(
        `INSERT INTO recalc_job (
           id, slot, status, places_fingerprint, created_at_ms, updated_at_ms, completed_at_ms,
           candidate_count, pre_skipped_missing_place, pre_skipped_no_trace, checkpoint_processed, message
         ) VALUES (?, 1, ?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL)`,
        [
          job.id,
          job.status,
          job.placesFingerprint,
          job.createdAtMs,
          job.updatedAtMs,
          job.candidateCount,
          job.preSkippedMissingPlace,
          job.preSkippedNoTrace,
        ],
      );
      for (let index = 0; index < attemptIds.length; index += 1) {
        await sql.run(
          `INSERT INTO recalc_job_item (job_id, attempt_id, seq, state) VALUES (?, ?, ?, 'pending')`,
          [job.id, attemptIds[index]!, index],
        );
      }
      return { created: true as const, job: { ...job, checkpointProcessed: 0, completedAtMs: null, message: null } };
    });
  }

  async listPendingItems(jobId: string, limit: number): Promise<RecalculationItem[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<RecalcJobItemRow>(
      `SELECT * FROM recalc_job_item WHERE job_id = ? AND state = 'pending' ORDER BY seq ASC LIMIT ?`,
      [jobId, limit],
    );
    return rows.map(mapItem);
  }

  async listItems(jobId: string, states?: RecalculationItemState[]): Promise<RecalculationItem[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<RecalcJobItemRow>(
      `SELECT * FROM recalc_job_item WHERE job_id = ? ORDER BY seq ASC`,
      [jobId],
    );
    return rows.map(mapItem).filter((item) => !states || states.includes(item.state));
  }

  async countItems(jobId: string): Promise<RecalculationCounts> {
    const sql = await this.getSql();
    const rows = await sql.getAll<{ state: string; detail: string | null; count: number }>(
      `SELECT state, CASE WHEN state = 'skipped' THEN detail ELSE NULL END AS detail, COUNT(*) AS count
       FROM recalc_job_item WHERE job_id = ? GROUP BY state, 2`,
      [jobId],
    );
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
    for (const row of rows) {
      counts.candidates += row.count;
      switch (parseState(row.state)) {
        case 'pending':
          counts.pending += row.count;
          break;
        case 'updated':
          counts.updated += row.count;
          break;
        case 'unchanged':
          counts.unchanged += row.count;
          break;
        case 'error':
          counts.errors += row.count;
          break;
        case 'skipped':
          counts.skipped += row.count;
          if (row.detail === 'insufficient_gps') {
            counts.skippedInsufficientGps += row.count;
          } else {
            counts.skippedEndpointChanged += row.count;
          }
          break;
      }
    }
    counts.processed = counts.candidates - counts.pending;
    return counts;
  }

  async recordResults(jobId: string, results: RecalculationItemResult[], nowMs: number): Promise<boolean> {
    const sql = await this.getSql();
    return sql.withTransaction(async () => {
      const job = await sql.getFirst<RecalcJobRow>('SELECT * FROM recalc_job WHERE id = ?', [jobId]);
      if (!job || job.status !== 'running') {
        return false;
      }
      for (const result of results) {
        await sql.run(
          `UPDATE recalc_job_item
           SET state = ?, detail = ?, base_started_at_ms = ?, base_finished_at_ms = ?, staged_json = ?
           WHERE job_id = ? AND attempt_id = ? AND state = 'pending'`,
          [
            result.state,
            result.detail,
            result.baseStartedAtMs,
            result.baseFinishedAtMs,
            result.staged ? JSON.stringify(result.staged) : null,
            jobId,
            result.attemptId,
          ],
        );
      }
      const processed = await sql.getFirst<{ count: number }>(
        `SELECT COUNT(*) AS count FROM recalc_job_item WHERE job_id = ? AND state != 'pending'`,
        [jobId],
      );
      await sql.run('UPDATE recalc_job SET checkpoint_processed = ?, updated_at_ms = ? WHERE id = ?', [
        processed?.count ?? 0,
        nowMs,
        jobId,
      ]);
      return true;
    });
  }

  async markReady(jobId: string, nowMs: number): Promise<boolean> {
    const sql = await this.getSql();
    return sql.withTransaction(async () => {
      const pending = await sql.getFirst<{ count: number }>(
        `SELECT COUNT(*) AS count FROM recalc_job_item WHERE job_id = ? AND state = 'pending'`,
        [jobId],
      );
      if ((pending?.count ?? 0) > 0) {
        return false;
      }
      await sql.run(
        `UPDATE recalc_job SET status = 'ready', updated_at_ms = ? WHERE id = ? AND status = 'running'`,
        [nowMs, jobId],
      );
      return true;
    });
  }

  async discardJob(jobId: string, message: string, nowMs: number): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      await sql.run('DELETE FROM recalc_job_item WHERE job_id = ?', [jobId]);
      await sql.run(
        `UPDATE recalc_job
         SET status = 'cancelled', message = ?, updated_at_ms = ?, completed_at_ms = ?
         WHERE id = ? AND status IN ('running', 'ready')`,
        [message, nowMs, nowMs, jobId],
      );
    });
  }

  async publishJob(jobId: string, nowMs: number): Promise<PublishRecalculationResult> {
    const sql = await this.getSql();
    // Isolated where the platform supports it, so no unrelated query interleaves with publication.
    return runIsolated(sql, async (tx) => {
      const job = await tx.getFirst<RecalcJobRow>('SELECT * FROM recalc_job WHERE id = ?', [jobId]);
      if (!job) {
        return { ok: false as const, reason: 'no_job' as const };
      }
      if (job.status !== 'ready') {
        return { ok: false as const, reason: 'not_ready' as const };
      }
      const open = await tx.getFirst<{ id: string }>(
        `SELECT id FROM attempt WHERE lifecycle IN ('armed', 'active') LIMIT 1`,
      );
      if (open) {
        return { ok: false as const, reason: 'open_attempt' as const };
      }
      const places = await new SqlitePlaceStore(async () => tx).listPlaces();
      if (recalculationPlacesFingerprint(places) !== job.places_fingerprint) {
        return { ok: false as const, reason: 'places_changed' as const };
      }
      const attempts = new SqliteAttemptStore(async () => tx);
      const rows = await tx.getAll<RecalcJobItemRow>(
        `SELECT * FROM recalc_job_item WHERE job_id = ? AND state = 'updated' ORDER BY seq ASC`,
        [jobId],
      );
      for (const item of rows.map(mapItem)) {
        const current = await attempts.getAttempt(item.attemptId);
        if (
          !item.staged ||
          !current ||
          current.lifecycle !== 'completed' ||
          current.startedAtMs !== item.baseStartedAtMs ||
          current.finishedAtMs !== item.baseFinishedAtMs
        ) {
          await tx.run(
            `UPDATE recalc_job_item
             SET state = 'error', detail = ?, staged_json = NULL
             WHERE job_id = ? AND attempt_id = ?`,
            ['Run changed or was removed during recalculation; original kept.', jobId, item.attemptId],
          );
          continue;
        }
        let updated = applyStagedUpdate(current, item.staged);
        if (item.staged.routeId != null) {
          const route = await tx.getFirst<{ id: string }>('SELECT id FROM route WHERE id = ?', [item.staged.routeId]);
          if (!route) {
            // The variant vanished while staged: leave it unassigned and let the existing
            // reconciliation pass reassign it from the same (new) times.
            updated = {
              ...updated,
              routeId: null,
              crossings: [],
              reconciliationStatus: 'pending',
              reconciliationVersion: 0,
            };
          }
        }
        await writeAttemptRecord(tx, updated);
        await tx.run('UPDATE recalc_job_item SET staged_json = NULL WHERE job_id = ? AND attempt_id = ?', [
          jobId,
          item.attemptId,
        ]);
      }
      await tx.run(
        `UPDATE recalc_job SET status = 'published', updated_at_ms = ?, completed_at_ms = ? WHERE id = ?`,
        [nowMs, nowMs, jobId],
      );
      return { ok: true as const };
    });
  }

  async clearAll(): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(async () => {
      await sql.run('DELETE FROM recalc_job_item');
      await sql.run('DELETE FROM recalc_job');
    });
  }
}

