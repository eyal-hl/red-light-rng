import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isBackupCacheUri,
  readBackupTextAndRemoveCacheCopy,
  shareTemporaryBackupFile,
  type BackupCacheFile,
} from '../src/platform/backup-file-session';

class MemoryBackupFile implements BackupCacheFile {
  uri: string;
  exists = false;
  contents = '';
  deleted = 0;

  constructor(uri: string) {
    this.uri = uri;
  }

  delete(): void {
    this.deleted += 1;
    this.exists = false;
    this.contents = '';
  }

  create(): void {
    this.exists = true;
  }

  write(contents: string): void {
    this.contents = contents;
  }

  async text(): Promise<string> {
    return this.contents;
  }
}

describe('backup cache files', () => {
  it('treats only files inside the cache directory as removable copies', () => {
    const cache = 'file:///data/cache';
    assert.equal(isBackupCacheUri('file:///data/cache/red-light-rng-backup-1.json', cache), true);
    assert.equal(isBackupCacheUri('file:///data/cache/red-light-rng-backup-1.json', `${cache}/`), true);
    assert.equal(isBackupCacheUri('file:///data/cache-other/backup.json', cache), false);
    assert.equal(isBackupCacheUri('content://documents/backup.json', cache), false);
    assert.equal(isBackupCacheUri('file:///data/cache/backup.json', ''), false);
  });

  it('deletes the share file after success, failure, and cancel', async () => {
    const saved = new MemoryBackupFile('file:///data/cache/red-light-rng-backup-1.json');
    saved.exists = true;
    saved.contents = 'old';
    await shareTemporaryBackupFile(saved, '{"backup":true}', async () => {});
    assert.equal(saved.exists, false);
    assert.equal(saved.deleted, 2);

    const failed = new MemoryBackupFile('file:///data/cache/red-light-rng-backup-2.json');
    await assert.rejects(
      shareTemporaryBackupFile(failed, '{"backup":true}', async () => {
        throw new Error('share failed');
      }),
      /share failed/,
    );
    assert.equal(failed.exists, false);
    assert.equal(failed.deleted, 1);

    const cancelled = new MemoryBackupFile('file:///data/cache/red-light-rng-backup-3.json');
    await shareTemporaryBackupFile(cancelled, '{"backup":true}', async () => {});
    assert.equal(cancelled.exists, false);
  });

  it('deletes a picked cache copy and leaves a file outside the cache', async () => {
    const copy = new MemoryBackupFile('file:///data/cache/DocumentPicker/backup.json');
    copy.exists = true;
    copy.contents = '{"ok":true}';
    assert.equal(await readBackupTextAndRemoveCacheCopy(copy, true), '{"ok":true}');
    assert.equal(copy.exists, false);

    const original = new MemoryBackupFile('content://documents/backup.json');
    original.exists = true;
    original.contents = '{"ok":true}';
    assert.equal(await readBackupTextAndRemoveCacheCopy(original, false), '{"ok":true}');
    assert.equal(original.exists, true);
    assert.equal(original.deleted, 0);
  });
});
