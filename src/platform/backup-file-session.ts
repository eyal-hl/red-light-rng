export type BackupCacheFile = {
  uri: string;
  readonly exists: boolean;
  delete(): void;
  create(): void;
  write(contents: string): void;
  text(): Promise<string>;
};

export function isBackupCacheUri(uri: string, cacheUri: string): boolean {
  if (cacheUri.length === 0) {
    return false;
  }
  const prefix = cacheUri.endsWith('/') ? cacheUri : `${cacheUri}/`;
  return uri.startsWith(prefix);
}

export async function shareTemporaryBackupFile(
  file: BackupCacheFile,
  contents: string,
  share: (uri: string) => Promise<void>,
): Promise<void> {
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(contents);
  try {
    await share(file.uri);
  } finally {
    if (file.exists) {
      file.delete();
    }
  }
}

export async function readBackupTextAndRemoveCacheCopy(
  file: BackupCacheFile,
  removeAfterRead: boolean,
): Promise<string> {
  try {
    return await file.text();
  } finally {
    if (removeAfterRead && file.exists) {
      file.delete();
    }
  }
}
