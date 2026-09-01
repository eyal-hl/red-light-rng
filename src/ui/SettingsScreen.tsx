import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  TRANSPORTATION_MODES,
  transportationModeIcon,
  transportationModeLabel,
  type TransportationMode,
} from '../domain/route';
import { styles } from './styles';

type SettingsScreenProps = {
  mode: TransportationMode;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onChangeMode: (mode: TransportationMode) => void;
};

export function SettingsScreen({ mode, busy, error, onBack, onChangeMode }: SettingsScreenProps) {
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
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </View>
  );
}
