import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { BackupFileGateway } from '../product/backup-service';

const BACKUP_FILE_PREFIX = 'red-light-rng-backup-';
/** Refuse absurd files before reading them into memory. */
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

function removeQuietly(file: File): void {
  try {
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Best effort: the cache directory is app-private and the OS can reclaim it.
  }
}

/** Deletes backup copies left in the app-private cache by earlier exports (they hold location history). */
function clearStaleBackupCopies(): void {
  try {
    for (const entry of new Directory(Paths.cache).list()) {
      if (entry instanceof File && entry.name.startsWith(BACKUP_FILE_PREFIX)) {
        removeQuietly(entry);
      }
    }
  } catch {
    // Listing is best effort.
  }
}

/**
 * Native adapter for export/restore I/O. It needs no OS permission: the share sheet and the system
 * document picker give the user explicit control over where the file goes or comes from.
 */
export function createExpoBackupFiles(): BackupFileGateway {
  return {
    async shareBackupFile(fileName, text) {
      clearStaleBackupCopies();
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error('Sharing or saving files is not available on this device.');
      }
      const file = new File(Paths.cache, fileName);
      removeQuietly(file);
      file.create();
      file.write(text);
      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/json',
        UTI: 'public.json',
        dialogTitle: 'Save Red Light RNG backup',
      });
    },

    async pickBackupFile() {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) {
        return null;
      }
      const asset = result.assets[0]!;
      const copy = new File(asset.uri);
      try {
        if (asset.size != null && asset.size > MAX_BACKUP_BYTES) {
          throw new Error('This file is too large to be a Red Light RNG backup.');
        }
        return { name: asset.name, text: await copy.text() };
      } finally {
        removeQuietly(copy);
      }
    },
  };
}
