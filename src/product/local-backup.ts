import {
  parseBackup,
  serializeBackupSnapshot,
  type BackupPreview,
  type BackupSnapshot,
} from '../persistence/backup-document';
import {
  BackupRestoreRefusedError,
  deviceHasLiveTracking,
  readDurableSnapshot,
  replaceDurableSnapshot,
} from '../persistence/backup-store';
import { CURRENT_SCHEMA_VERSION } from '../persistence/schema';
import type { SqlExecutor } from '../persistence/sql-executor';

export { BackupRestoreRefusedError };

export class LocalBackupService {
  constructor(
    private readonly getSql: () => Promise<SqlExecutor>,
    private readonly stopLocationUpdates: () => Promise<void>,
    private readonly invalidateDerivedViews: () => void,
    private readonly now: () => number = () => Date.now(),
    private readonly appVersion = '0.1.0',
  ) {}

  async exportBackup(): Promise<{ text: string; createdAtMs: number }> {
    const sql = await this.getSql();
    const snapshot = await readDurableSnapshot(sql, {
      createdAtMs: this.now(),
      sourceSchemaVersion: CURRENT_SCHEMA_VERSION,
      sourceAppVersion: this.appVersion,
    });
    return {
      text: serializeBackupSnapshot(snapshot),
      createdAtMs: snapshot.createdAtMs,
    };
  }

  previewBackup(text: string): BackupPreview {
    return parseBackup(text, this.now()).preview;
  }

  async restoreBackup(text: string): Promise<BackupPreview> {
    const parsed = parseBackup(text, this.now());
    const sql = await this.getSql();
    if (await deviceHasLiveTracking(sql)) {
      throw new BackupRestoreRefusedError();
    }
    await this.stopLocationUpdates();
    await replaceDurableSnapshot(sql, parsed.snapshot);
    this.invalidateDerivedViews();
    return parsed.preview;
  }
}

export type { BackupPreview, BackupSnapshot };
