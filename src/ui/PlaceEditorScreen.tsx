import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { parseZoneRadiusInput } from '../domain/course-layout';
import {
  DEFAULT_PLACE_RADIUS_METERS,
  PLACE_ARRIVAL_RADIUS_HELP,
  PLACE_DEPARTURE_RADIUS_HELP,
  PLACE_RADIUS_PREVIEW_LEGEND,
  placeEditorPreviewZones,
} from '../domain/place';
import type { LatLng } from '../domain/geo';
import { RouteMap } from '../map/RouteMap';
import { styles } from './styles';

export type PlaceEditorDraft = {
  id: string | null;
  name: string;
  center: LatLng;
  departureRadiusMeters: number;
  arrivalRadiusMeters: number;
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
  onArchive: () => void;
  onDeletePermanently: () => void;
};

function RadiusField({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  onChange: (meters: number) => void;
}) {
  return (
    <View style={styles.radiusField}>
      <Text style={styles.radiusLabel}>{label}</Text>
      <View style={styles.radiusInputRow}>
        <TextInput
          accessibilityLabel={label}
          keyboardType="number-pad"
          inputMode="numeric"
          value={Number.isFinite(value) ? String(value) : ''}
          onChangeText={(text) => onChange(parseZoneRadiusInput(text) || DEFAULT_PLACE_RADIUS_METERS)}
          placeholder={String(DEFAULT_PLACE_RADIUS_METERS)}
          placeholderTextColor="#6b7076"
          style={[styles.input, styles.radiusInput]}
        />
        <Text style={styles.radiusUnit}>m</Text>
      </View>
      <Text style={styles.mutedText}>{help}</Text>
    </View>
  );
}

export function PlaceEditorScreen({
  draft,
  busy,
  error,
  onChangeDraft,
  onUseCurrentLocation,
  onSave,
  onCancel,
  onArchive,
  onDeletePermanently,
}: PlaceEditorScreenProps) {
  const { startZone, finishZone } = placeEditorPreviewZones(draft);

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
            startZone={startZone}
            finishZone={finishZone}
            onMapPress={(point) => onChangeDraft({ ...draft, center: point })}
            cameraGesturesEnabled
          />
        </View>
        <Text style={styles.mutedText}>Tap the map to set the center, or use your current location.</Text>
        <Text style={styles.mutedText}>{PLACE_RADIUS_PREVIEW_LEGEND}</Text>
        <RadiusField
          label="Departure radius"
          help={PLACE_DEPARTURE_RADIUS_HELP}
          value={draft.departureRadiusMeters}
          onChange={(departureRadiusMeters) => onChangeDraft({ ...draft, departureRadiusMeters })}
        />
        <RadiusField
          label="Arrival radius"
          help={PLACE_ARRIVAL_RADIUS_HELP}
          value={draft.arrivalRadiusMeters}
          onChange={(arrivalRadiusMeters) => onChangeDraft({ ...draft, arrivalRadiusMeters })}
        />
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
            <View>
              {draft.status === 'active' ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={onArchive}
                  style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
                >
                  <Text style={styles.buttonText}>ARCHIVE</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${draft.name || 'place'} permanently`}
                disabled={busy}
                onPress={onDeletePermanently}
                style={[
                  styles.button,
                  styles.dangerButton,
                  draft.status === 'active' ? styles.placeDeleteButton : null,
                  busy ? styles.disabledButton : null,
                ]}
              >
                <Text style={styles.buttonText}>DELETE PERMANENTLY</Text>
              </Pressable>
            </View>
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
