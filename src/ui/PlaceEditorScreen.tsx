import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { parseZoneRadiusInput } from '../domain/course-layout';
import { DEFAULT_PLACE_RADIUS_METERS } from '../domain/place';
import type { LatLng } from '../domain/geo';
import { RouteMap } from '../map/RouteMap';
import { styles } from './styles';

export type PlaceEditorDraft = {
  id: string | null;
  name: string;
  center: LatLng;
  radiusMeters: number;
  status: 'active' | 'archived';
};

type PlaceEditorScreenProps = {
  draft: PlaceEditorDraft;
  busy: boolean;
  error: string | null;
  onChangeDraft: (draft: PlaceEditorDraft) => void;
  onUseCurrentLocation: () => void;
  onSave: () => void;
  onCancel: () => void;
  onArchiveOrDelete: () => void;
  archiveOrDeleteLabel: string;
};

export function PlaceEditorScreen({
  draft,
  busy,
  error,
  onChangeDraft,
  onUseCurrentLocation,
  onSave,
  onCancel,
  onArchiveOrDelete,
  archiveOrDeleteLabel,
}: PlaceEditorScreenProps) {
  const zone = { center: draft.center, radiusMeters: draft.radiusMeters };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onCancel}>
          <Text style={styles.kicker}>← PLACES</Text>
        </Pressable>
        <Text style={styles.title}>{draft.id ? 'Edit place' : 'New place'}</Text>
        <TextInput
          accessibilityLabel="Place name"
          value={draft.name}
          onChangeText={(name) => onChangeDraft({ ...draft, name })}
          placeholder="Home"
          placeholderTextColor="#6b7076"
          style={styles.input}
        />
        <View style={styles.mapSlot}>
          <RouteMap
            path={[]}
            startZone={zone}
            onMapPress={(point) => onChangeDraft({ ...draft, center: point })}
            cameraGesturesEnabled
          />
        </View>
        <Text style={styles.mutedText}>Tap the map to set the center, or use your current location.</Text>
        <View style={styles.radiusField}>
          <Text style={styles.radiusLabel}>Radius</Text>
          <View style={styles.radiusInputRow}>
            <TextInput
              accessibilityLabel="Place radius"
              keyboardType="number-pad"
              inputMode="numeric"
              value={Number.isFinite(draft.radiusMeters) ? String(draft.radiusMeters) : ''}
              onChangeText={(text) =>
                onChangeDraft({
                  ...draft,
                  radiusMeters: parseZoneRadiusInput(text) || DEFAULT_PLACE_RADIUS_METERS,
                })
              }
              placeholder={String(DEFAULT_PLACE_RADIUS_METERS)}
              placeholderTextColor="#6b7076"
              style={[styles.input, styles.radiusInput]}
            />
            <Text style={styles.radiusUnit}>m</Text>
          </View>
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onUseCurrentLocation}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>USE CURRENT LOCATION</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onSave}
            style={[styles.button, styles.primaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>SAVE PLACE</Text>
          </Pressable>
          {draft.id ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={onArchiveOrDelete}
              style={[styles.button, styles.dangerButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>{archiveOrDeleteLabel}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onCancel}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>CANCEL</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
