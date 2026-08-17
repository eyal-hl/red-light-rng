import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import {
  addCheckpointFromPending,
  beginMoveMarker,
  cancelMove,
  clearPendingSnap,
  commitMoveFromPending,
  deleteSelectedCheckpoint,
  draftCheckpointsInOrder,
  draftValidation,
  FINISH_MARKER_ID,
  previewMapTap,
  renameSelectedCheckpoint,
  selectMarker,
  selectedMarkerLabel,
  setFinishZoneRadiusMeters,
  setStartZoneRadiusMeters,
  START_MARKER_ID,
  type CourseEditorDraft,
  type CourseMarkerId,
} from '../domain/course-editor';
import { checkpointMapPoints, parseZoneRadiusInput } from '../domain/course-layout';
import { createId } from '../domain/ids';
import { RouteMap } from '../map/RouteMap';
import { styles } from './styles';

type CourseEditorScreenProps = {
  draft: CourseEditorDraft;
  busy: boolean;
  error: string | null;
  onChangeDraft: (next: CourseEditorDraft) => void;
  onSave: () => void;
  onCancel: () => void;
};

function editorStatusCopy(draft: CourseEditorDraft): string {
  const label = selectedMarkerLabel(draft);
  if (draft.mode === 'move' && label) {
    return `Moving ${label}. Tap the route to preview a new place, then PLACE HERE. Pan and pinch still move the map.`;
  }
  return 'Tap the route to preview a checkpoint. Use MOVE START or MOVE FINISH to relocate those markers. Pan and pinch to navigate; that does not place a point.';
}

function MarkerMoveButton({
  draft,
  markerId,
  label,
  busy,
  onChangeDraft,
}: {
  draft: CourseEditorDraft;
  markerId: CourseMarkerId;
  label: string;
  busy: boolean;
  onChangeDraft: (next: CourseEditorDraft) => void;
}) {
  const movingThis = draft.mode === 'move' && draft.selectedMarkerId === markerId;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() =>
        onChangeDraft(movingThis ? cancelMove(draft) : beginMoveMarker(draft, markerId))
      }
      style={[
        styles.button,
        styles.secondaryButton,
        styles.markerAction,
        busy ? styles.disabledButton : null,
      ]}
    >
      <Text style={styles.buttonText}>{movingThis ? 'CANCEL MOVE' : label}</Text>
    </Pressable>
  );
}

function ZoneRadiusField({
  label,
  value,
  busy,
  onChange,
}: {
  label: string;
  value: number;
  busy: boolean;
  onChange: (radiusMeters: number) => void;
}) {
  return (
    <View style={styles.radiusField}>
      <Text style={styles.radiusLabel}>{label}</Text>
      <View style={styles.radiusInputRow}>
        <TextInput
          accessibilityLabel={label}
          editable={!busy}
          keyboardType="number-pad"
          inputMode="numeric"
          value={Number.isFinite(value) ? String(value) : ''}
          onChangeText={(text) => onChange(parseZoneRadiusInput(text))}
          placeholder="30"
          placeholderTextColor="#6b6f76"
          style={[styles.input, styles.radiusInput]}
        />
        <Text style={styles.radiusUnit}>m</Text>
      </View>
    </View>
  );
}

export function CourseEditorScreen({
  draft,
  busy,
  error,
  onChangeDraft,
  onSave,
  onCancel,
}: CourseEditorScreenProps) {
  const validation = draftValidation(draft);
  const checkpoints = checkpointMapPoints(draft.referencePath, draft.layout.checkpoints);
  const ordered = draftCheckpointsInOrder(draft);
  const selectedCheckpoint = ordered.find((checkpoint) => checkpoint.id === draft.selectedMarkerId);
  const saveDisabled = busy || !draft.dirty || !validation.valid;
  const canPlacePending = draft.pendingSnap != null && !busy;

  return (
    <View style={styles.screen}>
      <View style={styles.editorHeader}>
        <Pressable accessibilityRole="button" onPress={onCancel}>
          <Text style={styles.kicker}>← ROUTE DETAIL</Text>
        </Pressable>
        <Text style={styles.title}>Edit course</Text>
        <Text style={styles.editorSubtitle}>
          Map pan and pinch stay on the map. Checkpoints snap to the saved route. A route with no
          checkpoints is still valid. Auto-start and auto-finish radiuses are shown as circles.
        </Text>
      </View>

      <View style={styles.editorMapPane} collapsable={false}>
        <RouteMap
          path={draft.referencePath}
          startZone={draft.layout.startZone}
          finishZone={draft.layout.finishZone}
          checkpoints={checkpoints}
          previewPoint={draft.pendingSnap?.snapped ?? null}
          selectedMarkerId={draft.selectedMarkerId}
          onMapPress={(point) => {
            onChangeDraft(previewMapTap(draft, point));
          }}
          style={styles.editorMap}
        />
      </View>

      <View style={styles.editorStatus}>
        <Text style={draft.mode === 'move' ? styles.warningText : styles.mutedText}>
          {editorStatusCopy(draft)}
        </Text>
        {draft.tapRejection ? <Text style={styles.errorText}>{draft.tapRejection}</Text> : null}
        {draft.pendingSnap ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {draft.mode === 'move'
                ? `New place for ${selectedMarkerLabel(draft) ?? 'this marker'}`
                : 'Snapped to the route'}
            </Text>
            <Text style={styles.cardMeta}>
              {Math.round(draft.pendingSnap.progressMeters)} m along the course
            </Text>
            <View style={styles.actions}>
              {draft.mode === 'move' ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={!canPlacePending}
                  onPress={() => onChangeDraft(commitMoveFromPending(draft))}
                  style={[
                    styles.button,
                    styles.primaryButton,
                    !canPlacePending ? styles.disabledButton : null,
                  ]}
                >
                  <Text style={styles.buttonText}>PLACE HERE</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={!canPlacePending}
                  onPress={() => onChangeDraft(addCheckpointFromPending(draft, createId))}
                  style={[
                    styles.button,
                    styles.primaryButton,
                    !canPlacePending ? styles.disabledButton : null,
                  ]}
                >
                  <Text style={styles.buttonText}>ADD CHECKPOINT HERE</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() => onChangeDraft(clearPendingSnap(draft))}
                style={[styles.button, styles.secondaryButton]}
              >
                <Text style={styles.buttonText}>DISCARD TAP</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      <ScrollView
        style={styles.editorControls}
        contentContainerStyle={styles.editorControlsContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.sectionLabel}>COURSE MARKERS</Text>
        <View
          style={[styles.card, draft.selectedMarkerId === START_MARKER_ID ? styles.selectedCard : null]}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => onChangeDraft(selectMarker(draft, START_MARKER_ID))}
          >
            <Text style={styles.cardTitle}>Start</Text>
            <Text style={styles.cardMeta}>{Math.round(draft.layout.startProgressMeters)} m along course</Text>
          </Pressable>
          <ZoneRadiusField
            label="Auto-start radius"
            value={draft.layout.startZone.radiusMeters}
            busy={busy}
            onChange={(radiusMeters) => onChangeDraft(setStartZoneRadiusMeters(draft, radiusMeters))}
          />
          <MarkerMoveButton
            draft={draft}
            markerId={START_MARKER_ID}
            label="MOVE START"
            busy={busy}
            onChangeDraft={onChangeDraft}
          />
        </View>
        {ordered.map((checkpoint) => (
          <View
            key={checkpoint.id}
            style={[
              styles.card,
              draft.selectedMarkerId === checkpoint.id ? styles.selectedCard : null,
            ]}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => onChangeDraft(selectMarker(draft, checkpoint.id))}
            >
              <Text style={styles.cardTitle}>{checkpoint.name}</Text>
              <Text style={styles.cardMeta}>{Math.round(checkpoint.progressMeters)} m</Text>
            </Pressable>
            <MarkerMoveButton
              draft={draft}
              markerId={checkpoint.id}
              label="MOVE"
              busy={busy}
              onChangeDraft={onChangeDraft}
            />
          </View>
        ))}
        <View
          style={[styles.card, draft.selectedMarkerId === FINISH_MARKER_ID ? styles.selectedCard : null]}
        >
          <Pressable
            accessibilityRole="button"
            onPress={() => onChangeDraft(selectMarker(draft, FINISH_MARKER_ID))}
          >
            <Text style={styles.cardTitle}>Finish</Text>
            <Text style={styles.cardMeta}>{Math.round(draft.layout.finishProgressMeters)} m along course</Text>
          </Pressable>
          <ZoneRadiusField
            label="Auto-finish radius"
            value={draft.layout.finishZone.radiusMeters}
            busy={busy}
            onChange={(radiusMeters) => onChangeDraft(setFinishZoneRadiusMeters(draft, radiusMeters))}
          />
          <MarkerMoveButton
            draft={draft}
            markerId={FINISH_MARKER_ID}
            label="MOVE FINISH"
            busy={busy}
            onChangeDraft={onChangeDraft}
          />
        </View>

        {selectedCheckpoint ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Checkpoint name</Text>
            <TextInput
              value={selectedCheckpoint.name}
              onChangeText={(value) => onChangeDraft(renameSelectedCheckpoint(draft, value))}
              placeholder="Checkpoint name"
              placeholderTextColor="#6b6f76"
              style={styles.input}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => onChangeDraft(deleteSelectedCheckpoint(draft))}
              style={[styles.button, styles.dangerButton]}
            >
              <Text style={styles.buttonText}>DELETE CHECKPOINT</Text>
            </Pressable>
          </View>
        ) : null}

        {!validation.valid && validation.reason ? (
          <Text style={styles.errorText}>{validation.reason}</Text>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={saveDisabled}
            onPress={onSave}
            style={[styles.button, styles.primaryButton, saveDisabled ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>SAVE COURSE</Text>
          </Pressable>
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
