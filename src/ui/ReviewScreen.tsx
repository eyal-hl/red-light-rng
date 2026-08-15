import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { formatElapsed, reviewDurationMs } from '../domain/duration';
import { formatDistance } from '../domain/geo';
import type { TransportationMode } from '../domain/route';
import { TRANSPORTATION_MODES } from '../domain/route';
import type { RouteDerivation } from '../domain/route-derivation';
import { RouteMap } from '../map/RouteMap';
import type { TrackingSessionRecord } from '../persistence/location-sample-store';
import { styles } from './styles';

type ReviewScreenProps = {
  session: TrackingSessionRecord;
  rawPointCount: number;
  derivation: RouteDerivation;
  name: string;
  mode: TransportationMode;
  busy: boolean;
  error: string | null;
  onChangeName: (value: string) => void;
  onChangeMode: (mode: TransportationMode) => void;
  onSave: () => void;
  onDiscard: () => void;
};

export function ReviewScreen({
  session,
  rawPointCount,
  derivation,
  name,
  mode,
  busy,
  error,
  onChangeName,
  onChangeMode,
  onSave,
  onDiscard,
}: ReviewScreenProps) {
  const durationMs = reviewDurationMs(session);
  const saveDisabled = busy || !derivation.saveable || name.trim().length === 0;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>NEW ROUTE</Text>
        <Text style={styles.title}>Review recording</Text>

        {session.captureOutcome === 'interrupted' ? (
          <Text style={styles.warningText}>
            This recording was interrupted. The captured path may be incomplete.
          </Text>
        ) : null}

        <View style={styles.mapSlot}>
          <RouteMap
            path={derivation.referencePath}
            startZone={derivation.startZone}
            finishZone={derivation.finishZone}
          />
        </View>

        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Distance</Text>
          <Text style={styles.statValue}>
            {derivation.saveable ? formatDistance(derivation.distanceMeters) : '—'}
          </Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Recorded</Text>
          <Text style={styles.statValue}>{durationMs == null ? '—' : formatElapsed(durationMs)}</Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>GPS points</Text>
          <Text style={styles.statValue}>{rawPointCount}</Text>
        </View>

        {!derivation.saveable ? (
          <Text style={styles.warningText}>
            {derivation.reason ?? 'This recording is too short or low-quality to save as a route.'}
          </Text>
        ) : null}

        <Text style={styles.sectionLabel}>Route name</Text>
        <TextInput
          value={name}
          onChangeText={onChangeName}
          placeholder="Home → Work"
          placeholderTextColor="#6b6f76"
          style={styles.input}
        />

        <Text style={styles.sectionLabel}>Mode</Text>
        <View style={styles.modeRow}>
          {TRANSPORTATION_MODES.map((item) => {
            const selected = item.id === mode;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                onPress={() => onChangeMode(item.id)}
                style={[styles.modeChip, selected ? styles.modeChipSelected : null]}
              >
                <Text style={styles.modeChipText}>
                  {item.icon} {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={saveDisabled}
            onPress={onSave}
            style={[
              styles.button,
              styles.primaryButton,
              saveDisabled ? styles.disabledButton : null,
            ]}
          >
            <Text style={styles.buttonText}>SAVE ROUTE</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onDiscard}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>DISCARD</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
