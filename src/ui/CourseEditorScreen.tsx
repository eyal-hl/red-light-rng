import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import {
  addCheckpointFromPending,
  beginMoveSelected,
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
  START_MARKER_ID,
  type CourseEditorDraft,
} from '../domain/course-editor';
import { checkpointMapPoints } from '../domain/course-layout';
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
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onCancel}>
          <Text style={styles.kicker}>← ROUTE DETAIL</Text>
        </Pressable>
        <Text style={styles.title}>Edit course</Text>
        <Text style={styles.subtitle}>
          Tap the route to preview a snapped split, then add or move markers. A route with no
          checkpoints is still valid.
        </Text>

        <View style={styles.editorMapSlot}>
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
          />
        </View>

        {draft.mode === 'move' ? (
          <Text style={styles.warningText}>Tap the route to preview a new place for this marker.</Text>
        ) : (
          <Text style={styles.mutedText}>Tap the route to choose a checkpoint location.</Text>
        )}

        {draft.tapRejection ? <Text style={styles.errorText}>{draft.tapRejection}</Text> : null}

        {draft.pendingSnap ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Snapped to the route</Text>
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

        <Text style={styles.sectionLabel}>COURSE MARKERS</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => onChangeDraft(selectMarker(draft, START_MARKER_ID))}
          style={[styles.card, draft.selectedMarkerId === START_MARKER_ID ? styles.selectedCard : null]}
        >
          <Text style={styles.cardTitle}>Start</Text>
          <Text style={styles.cardMeta}>{Math.round(draft.layout.startProgressMeters)} m</Text>
        </Pressable>
        {ordered.map((checkpoint) => (
          <Pressable
            key={checkpoint.id}
            accessibilityRole="button"
            onPress={() => onChangeDraft(selectMarker(draft, checkpoint.id))}
            style={[
              styles.card,
              draft.selectedMarkerId === checkpoint.id ? styles.selectedCard : null,
            ]}
          >
            <Text style={styles.cardTitle}>{checkpoint.name}</Text>
            <Text style={styles.cardMeta}>{Math.round(checkpoint.progressMeters)} m</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={() => onChangeDraft(selectMarker(draft, FINISH_MARKER_ID))}
          style={[styles.card, draft.selectedMarkerId === FINISH_MARKER_ID ? styles.selectedCard : null]}
        >
          <Text style={styles.cardTitle}>Finish</Text>
          <Text style={styles.cardMeta}>{Math.round(draft.layout.finishProgressMeters)} m</Text>
        </Pressable>

        {draft.selectedMarkerId ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Selected marker</Text>
            {selectedCheckpoint ? (
              <TextInput
                value={selectedCheckpoint.name}
                onChangeText={(value) => onChangeDraft(renameSelectedCheckpoint(draft, value))}
                placeholder="Checkpoint name"
                placeholderTextColor="#6b6f76"
                style={styles.input}
              />
            ) : (
              <Text style={styles.mutedText}>
                Start and finish keep their route labels. Moving them keeps the existing zone
                radius.
              </Text>
            )}
            <View style={styles.actions}>
              {draft.mode === 'move' ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onChangeDraft(cancelMove(draft))}
                  style={[styles.button, styles.secondaryButton]}
                >
                  <Text style={styles.buttonText}>CANCEL MOVE</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onChangeDraft(beginMoveSelected(draft))}
                  style={[styles.button, styles.secondaryButton]}
                >
                  <Text style={styles.buttonText}>MOVE</Text>
                </Pressable>
              )}
              {selectedCheckpoint ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onChangeDraft(deleteSelectedCheckpoint(draft))}
                  style={[styles.button, styles.dangerButton]}
                >
                  <Text style={styles.buttonText}>DELETE CHECKPOINT</Text>
                </Pressable>
              ) : null}
            </View>
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
