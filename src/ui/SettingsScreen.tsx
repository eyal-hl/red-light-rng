import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  TRANSPORTATION_MODES,
  transportationModeIcon,
  transportationModeLabel,
  type TransportationMode,
} from '../domain/route';
import type { BackupPreview } from '../persistence/backup-format';
import { BACKUP_PRIVACY_WARNING, RESTORE_CONFIRM_LABEL, RESTORE_REPLACE_WARNING } from '../product/backup-copy';
import { styles } from './styles';

export type RestorePreviewView = {
  fileName: string;
  preview: BackupPreview;
};

type SettingsScreenProps = {
  mode: TransportationMode;
  busy: boolean;
  error: string | null;
  notice?: string | null;
  restorePreview?: RestorePreviewView | null;
  onBack: () => void;
  onChangeMode: (mode: TransportationMode) => void;
  onExportBackup?: () => void;
  onChooseRestoreFile?: () => void;
  onConfirmRestore?: () => void;
  onCancelRestore?: () => void;
};

export function formatBackupDate(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleString();
}

export function SettingsScreen({
  mode,
  busy,
  error,
  notice = null,
  restorePreview = null,
  onBack,
  onChangeMode,
  onExportBackup,
  onChooseRestoreFile,
  onConfirmRestore,
  onCancelRestore,
}: SettingsScreenProps) {
  const counts = restorePreview?.preview.counts;
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← HOME</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>
        <Text style={styles.subtitle}>
          Active transportation mode for START. Changing this does not add a chooser to the live run.
        </Text>
        <Text style={styles.sectionLabel}>TRANSPORTATION MODE</Text>
        <View style={styles.modeRow}>
          {TRANSPORTATION_MODES.map((item) => {
            const selected = item.id === mode;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => onChangeMode(item.id)}
                style={[styles.modeChip, selected ? styles.modeChipSelected : null]}
              >
                <Text style={styles.modeChipText}>
                  {transportationModeIcon(item.id)} {transportationModeLabel(item.id)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {onExportBackup && onChooseRestoreFile ? (
          <>
            <Text style={[styles.sectionLabel, { marginTop: 28 }]}>DATA</Text>
            <Text style={styles.subtitle}>{BACKUP_PRIVACY_WARNING}</Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onExportBackup}
              style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>Export backup</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onChooseRestoreFile}
              style={[styles.button, styles.secondaryButton, { marginTop: 12 }, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>Restore backup</Text>
            </Pressable>
          </>
        ) : null}

        {restorePreview && counts ? (
          <View style={[styles.card, { marginTop: 20 }]}>
            <Text style={styles.sectionLabel}>BACKUP PREVIEW</Text>
            <Text style={styles.subtitle}>{restorePreview.fileName}</Text>
            <Text style={styles.mutedText}>Format version: {restorePreview.preview.formatVersion}</Text>
            <Text style={styles.mutedText}>Created: {formatBackupDate(restorePreview.preview.createdAtMs)}</Text>
            <Text style={styles.mutedText}>
              From app {restorePreview.preview.appVersion} (database schema {restorePreview.preview.schemaVersion})
            </Text>
            <Text style={styles.mutedText}>Places: {counts.places}</Text>
            <Text style={styles.mutedText}>Routes / path variants: {counts.routes}</Text>
            <Text style={styles.mutedText}>Attempts: {counts.attempts}</Text>
            <Text style={styles.mutedText}>Tracking sessions: {counts.tracking_sessions}</Text>
            <Text style={styles.mutedText}>GPS samples: {counts.location_samples}</Text>
            <Text style={styles.errorText}>{RESTORE_REPLACE_WARNING}</Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onConfirmRestore}
              style={[styles.button, styles.dangerButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>{RESTORE_CONFIRM_LABEL}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onCancelRestore}
              style={[styles.button, styles.secondaryButton, { marginTop: 12 }]}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}

        {notice ? <Text style={styles.mutedText}>{notice}</Text> : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}
