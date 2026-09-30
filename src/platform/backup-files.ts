import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export function backupFileName(createdAtMs: number): string {
  return `red-light-rng-backup-${createdAtMs}.json`;
}

export async function shareBackupFile(contents: string, createdAtMs: number): Promise<void> {
  const file = new File(Paths.cache, backupFileName(createdAtMs));
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(contents);
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Choose a device that can save or share a file, then export again.');
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: 'application/json',
    dialogTitle: 'Export backup',
    UTI: 'public.json',
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
  return new File(asset.uri).text();
}
