/** User-facing backup/restore copy, kept out of the React Native layer so tests can assert it. */
export const BACKUP_PRIVACY_WARNING =
  'A backup contains your precise location history: every saved place, route and raw GPS sample. Anyone who receives the file can see where you have been. Nothing is uploaded automatically; you choose where the file goes. Store it somewhere private.';
export const BACKUP_EXPORT_CONFIRM_TITLE = 'Export precise location history?';
export const BACKUP_EXPORT_CONFIRM_ACTION = 'Export';
export const RESTORE_REPLACE_WARNING =
  'Restoring REPLACES everything on this device (places, path variants, attempts, GPS samples and settings). It is not a merge and cannot be undone. Export a backup of your current data first if you may need it.';
export const RESTORE_CONFIRM_LABEL = 'Replace local data with this backup';
