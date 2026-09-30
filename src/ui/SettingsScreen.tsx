import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  TRANSPORTATION_MODES,
  transportationModeIcon,
  transportationModeLabel,
  type TransportationMode,
} from '../domain/route';
import {
  BACKUP_EXPORT_LABEL,
  BACKUP_PRIVACY_NOTICE,
  BACKUP_REPLACE_CONFIRM_LABEL,
  BACKUP_REPLACE_WARNING,
  BACKUP_RESTORE_LABEL,
  type BackupPreview,
} from '../persistence/backup-document';
import { styles } from './styles';

type SettingsScreenProps = {
  mode: TransportationMode;
  busy: boolean;
  error: string | null;
  restorePreview: BackupPreview | null;
  onBack: () => void;
  onChangeMode: (mode: TransportationMode) => void;
  onExportBackup: () => void;
  onPickRestore: () => void;
  onConfirmReplace: () => void;
  onCancelRestore: () => void;
};

function formatBackupWhen(createdAtMs: number): string {
  return new Date(createdAtMs).toISOString();
}

export function SettingsScreen({
  mode,
  busy,
  error,
  restorePreview,
  onBack,
  onChangeMode,
  onExportBackup,
  onPickRestore,
  onConfirmReplace,
  onCancelRestore,
}: SettingsScreenProps) {
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
        <Text style={styles.sectionLabel}>DATA</Text>
        <Text style={styles.subtitle}>{BACKUP_PRIVACY_NOTICE}</Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onExportBackup}
          style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
        >
          <Text style={styles.buttonText}>{BACKUP_EXPORT_LABEL}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onPickRestore}
          style={[styles.button, styles.secondaryButton, styles.stackedButton, busy ? styles.disabledButton : null]}
        >
          <Text style={styles.buttonText}>{BACKUP_RESTORE_LABEL}</Text>
        </Pressable>
        {restorePreview ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Backup preview</Text>
            <Text style={styles.cardMeta}>Created {formatBackupWhen(restorePreview.createdAtMs)}</Text>
            <Text style={styles.cardMeta}>Format version {restorePreview.backupFormatVersion}</Text>
            <Text style={styles.cardMeta}>Places {restorePreview.counts.places}</Text>
            <Text style={styles.cardMeta}>Routes {restorePreview.counts.routes}</Text>
            <Text style={styles.cardMeta}>Attempts {restorePreview.counts.attempts}</Text>
            <Text style={styles.cardMeta}>GPS samples {restorePreview.counts.locationSamples}</Text>
            <Text style={styles.subtitle}>{BACKUP_REPLACE_WARNING}</Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onConfirmReplace}
              style={[styles.button, styles.dangerButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>{BACKUP_REPLACE_CONFIRM_LABEL}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onCancelRestore}
              style={[styles.button, styles.secondaryButton, styles.stackedButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}
