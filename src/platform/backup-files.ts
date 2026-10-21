import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  isBackupCacheUri,
  readBackupTextAndRemoveCacheCopy,
  shareTemporaryBackupFile,
  type BackupCacheFile,
} from './backup-file-session';

export function backupFileName(createdAtMs: number): string {
  return `red-light-rng-backup-${createdAtMs}.json`;
}

function asBackupCacheFile(file: File): BackupCacheFile {
  return {
    uri: file.uri,
    get exists() {
      return file.exists;
    },
    delete: () => {
      file.delete();
    },
    create: () => {
      file.create();
    },
    write: (contents) => {
      file.write(contents);
    },
    text: () => file.text(),
  };
}

export async function shareBackupFile(contents: string, createdAtMs: number): Promise<void> {
  const file = asBackupCacheFile(new File(Paths.cache, backupFileName(createdAtMs)));
  await shareTemporaryBackupFile(file, contents, async (uri) => {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      throw new Error('Choose a device that can save or share a file, then export again.');
    }
    await Sharing.shareAsync(uri, {
      mimeType: 'application/json',
      dialogTitle: 'Export backup',
      UTI: 'public.json',
    });
  });
}

export async function pickBackupFileText(): Promise<string | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain', 'application/octet-stream'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled) {
    return null;
  }
  const asset = picked.assets[0];
  if (!asset) {
    return null;
  }
  const file = asBackupCacheFile(new File(asset.uri));
  return readBackupTextAndRemoveCacheCopy(file, isBackupCacheUri(asset.uri, Paths.cache.uri));
}
