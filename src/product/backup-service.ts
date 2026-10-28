import {
  BackupError,
  parseBackup,
  type BackupCounts,
  type BackupPayload,
  type BackupPreview,
} from '../persistence/backup-format';
import { exportBackup } from '../persistence/backup-snapshot';
import type { SqlExecutor } from '../persistence/sql-executor';
import { assertNoLiveState, restoreBackupPayload, type TerminalizationReport } from './backup-restore';

/** Thin native boundary: only file pick and share live behind it. All format logic stays shared. */
export interface BackupFileGateway {
  /** Writes the backup to a temporary file and opens the OS share/save sheet. Never uploads anywhere. */
  shareBackupFile(fileName: string, text: string): Promise<void>;
  /** Opens the system document picker. Resolves null when the user cancels. */
  pickBackupFile(): Promise<{ name: string; text: string } | null>;
}

export type BackupRestoreHooks = {
  /** Stops any OS location updates left over from pre-restore app state. */
  stopLocationUpdates: () => Promise<void>;
  /** Drops every in-memory derived-view cache (Home, journey, focus, debug, route analysis). */
  invalidateDerivedCaches: () => void;
  /** Recomputes path variants and attempt reconciliation from the restored raw data. */
  recomputeDerived: () => Promise<void>;
};

export type PendingRestore = {
  fileName: string;
  preview: BackupPreview;
  payload: BackupPayload;
};

export type BackupExportResult = {
  fileName: string;
  counts: BackupCounts;
};

export type BackupRestoreOutcome = {
  counts: BackupCounts;
  terminalization: TerminalizationReport;
  /** Non-fatal follow-up problems (data is restored, but e.g. recomputation will retry on next launch). */
  warnings: string[];
};

export function backupFileName(createdAtMs: number): string {
  const stamp = new Date(createdAtMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `red-light-rng-backup-${stamp}.json`;
}

export class BackupService {
  constructor(
    private readonly getSql: () => Promise<SqlExecutor>,
    private readonly files: BackupFileGateway,
    private readonly hooks: BackupRestoreHooks,
    private readonly appVersion: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Snapshot -> deterministic file -> share sheet. Read-only on the database. */
  async exportBackup(): Promise<BackupExportResult> {
    const sql = await this.getSql();
    const exported = await exportBackup(sql, { nowMs: this.now(), appVersion: this.appVersion });
    const fileName = backupFileName(exported.createdAtMs);
    await this.files.shareBackupFile(fileName, exported.text);
    return { fileName, counts: parseBackup(exported.text).preview.counts };
  }

  /**
   * Pick, fully parse and validate without writing anything. Also refuses early when this device is
   * running a live attempt/session, so the user is told before they review the preview.
   */
  async pickAndPreview(): Promise<PendingRestore | null> {
    const picked = await this.files.pickBackupFile();
    if (!picked) {
      return null;
    }
    return this.previewText(picked.name, picked.text);
  }

  async previewText(fileName: string, text: string): Promise<PendingRestore> {
    const parsed = parseBackup(text);
    await assertNoLiveState(await this.getSql());
    return { fileName, preview: parsed.preview, payload: parsed.payload };
  }

  /** Replace-only restore of a previously previewed backup. Call only after explicit user confirmation. */
  async confirmRestore(pending: PendingRestore): Promise<BackupRestoreOutcome> {
    const sql = await this.getSql();
    const result = await restoreBackupPayload(sql, pending.payload);
    const warnings: string[] = [];
    try {
      await this.hooks.stopLocationUpdates();
    } catch (error) {
      warnings.push(`Could not stop leftover location updates: ${messageOf(error)}`);
    }
    this.hooks.invalidateDerivedCaches();
    try {
      await this.hooks.recomputeDerived();
    } catch (error) {
      warnings.push(`History was restored but statistics will finish recomputing later: ${messageOf(error)}`);
    }
    this.hooks.invalidateDerivedCaches();
    return { counts: result.counts, terminalization: result.terminalization, warnings };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export function describeBackupError(error: unknown): string {
  if (error instanceof BackupError) {
    return error.message;
  }
  return error instanceof Error ? error.message : 'Backup failed.';
}
