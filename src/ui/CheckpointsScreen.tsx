import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import {
  MAX_COMPETITIVE_CHECKPOINT_RADIUS_METERS,
  MIN_COMPETITIVE_CHECKPOINT_RADIUS_METERS,
  type CompetitiveCheckpoint,
  type CompetitiveCheckpointPool,
} from '../domain/competitive-checkpoint';
import { parseZoneRadiusInput } from '../domain/course-layout';
import type { LatLng } from '../domain/geo';
import { createId } from '../domain/ids';
import { placeZone, type Place } from '../domain/place';
import { RouteMap } from '../map/RouteMap';
import type { PathVariantMapLine } from '../map/path-variant-display';
import type {
  CompetitiveSegmentsService,
  SegmentPoolStatus,
  SegmentRecalculationService,
} from '../product/competitive-segments';
import {
  addCheckpoint,
  CHECKPOINT_NO_IMPACT_NOTE,
  checkpointEditorView,
  checkpointRing,
  deleteCheckpoint,
  editorItemsFromConfig,
  moveCheckpoint,
  renameCheckpoint,
  segmentPreview,
  setCheckpointCenter,
  setCheckpointRadius,
} from '../product/competitive-segments-view';
import { DeferredMapSlot } from './DeferredMapSlot';
import { SegmentRecalculationPanel } from './SegmentRecalculationPanel';
import { styles } from './styles';

type Props = {
  pool: CompetitiveCheckpointPool;
  origin: Place;
  destination: Place;
  places: Place[];
  segments: CompetitiveSegmentsService;
  recalculation: SegmentRecalculationService;
  getCurrentPosition: () => Promise<LatLng | null>;
  onBack: () => void;
  /** Called after saved checkpoints or published results so the journey screen refreshes. */
  onChanged: () => void;
};

type Placing = { kind: 'add' } | { kind: 'move'; id: string } | null;

const RING_COLOR = '#ffb300';

/**
 * "Checkpoints & segments" for one journey (#81). The original start (green) and finish (red) are
 * the journey's places and are not editable here; checkpoints are ordered, named, scoped to this
 * direction and mode, and never finish a run. Every edit creates a new configuration version; the
 * impact on existing segment results is stated before saving.
 */
export function CheckpointsScreen({
  pool,
  origin,
  destination,
  places,
  segments,
  recalculation,
  getCurrentPosition,
  onBack,
  onChanged,
}: Props) {
  const [status, setStatus] = useState<SegmentPoolStatus | null>(null);
  const [items, setItems] = useState<CompetitiveCheckpoint[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [placing, setPlacing] = useState<Placing>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    const next = await segments.getPoolStatus(pool);
    if (!mounted.current) return;
    setStatus(next);
    setItems(editorItemsFromConfig(next.config));
    setLoaded(true);
  }, [pool, segments]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  const view = useMemo(
    () =>
      checkpointEditorView({
        current: status?.config ?? null,
        draft: items,
        places,
        lockReason: status?.editLockReason ?? null,
        runsWithResults: status?.currentAttemptCount ?? 0,
      }),
    [items, places, status],
  );
  const preview = useMemo(() => segmentPreview(items, origin.name, destination.name), [items, origin.name, destination.name]);
  const rings = useMemo<PathVariantMapLine[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        name: item.name,
        path: checkpointRing(item.center, Number.isFinite(item.radiusMeters) ? item.radiusMeters : 0),
        color: RING_COLOR,
      })),
    [items],
  );
  const mapCheckpoints = useMemo(
    () => items.map((item) => ({ id: item.id, name: item.name, point: item.center })),
    [items],
  );

  const place = (point: LatLng) => {
    if (!view.editable) return;
    if (placing?.kind === 'add') {
      const next = addCheckpoint(items, point, origin, createId);
      setItems(next);
      setSelectedId(next.find((item) => !items.some((existing) => existing.id === item.id))?.id ?? null);
    } else if (placing?.kind === 'move') {
      setItems(setCheckpointCenter(items, placing.id, point));
    }
    setPlacing(null);
  };

  const addAtCurrentLocation = async () => {
    const point = await getCurrentPosition();
    if (!point) {
      setMessage('Could not read the current location.');
      return;
    }
    setMessage(null);
    if (placing?.kind === 'move') {
      place(point);
      return;
    }
    const next = addCheckpoint(items, point, origin, createId);
    setItems(next);
    setSelectedId(next.find((item) => !items.some((existing) => existing.id === item.id))?.id ?? null);
    setPlacing(null);
  };

  const confirmDelete = (item: CompetitiveCheckpoint) => {
    const apply = () => {
      setItems((current) => deleteCheckpoint(current, item.id));
      setSelectedId((current) => (current === item.id ? null : current));
    };
    if ((status?.currentAttemptCount ?? 0) > 0) {
      Alert.alert(`Delete ${item.name}?`, 'Existing segment results become stale when you save. Official times are not changed.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: apply },
      ]);
      return;
    }
    apply();
  };

  const performSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const result = await segments.saveCheckpoints(pool, items);
      if (!result.ok) {
        setMessage(result.reason);
        return;
      }
      await reload();
      onChanged();
      setMessage(result.changed ? 'Saved. Run Recalculate segments to time past runs.' : 'No changes to save.');
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const save = () => {
    if (!view.canSave) return;
    if (view.impactWarning) {
      Alert.alert('Save checkpoints?', view.impactWarning, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: () => void performSave() },
      ]);
      return;
    }
    void performSave();
  };

  const selectedMarker = selectedId ?? (placing?.kind === 'move' ? placing.id : null);

  return (
    <View style={styles.screen}>
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={styles.kicker}>← JOURNEY</Text>
        </Pressable>
        <Text style={styles.title}>Checkpoints & segments</Text>
        <Text style={styles.subtitle}>
          {origin.name} → {destination.name}. Checkpoints only time segments of this journey. They never end a run and
          never change official times.
        </Text>

        {view.lockReason ? (
          <View accessibilityLabel="Checkpoint editing locked">
            <Text style={styles.warningText}>{view.lockReason}</Text>
          </View>
        ) : null}

        <View style={styles.mapSlot}>
          <DeferredMapSlot style={styles.editorMap}>
            <RouteMap
              path={[]}
              pathVariants={rings}
              startZone={placeZone(origin, 'departure')}
              finishZone={placeZone(destination, 'arrival')}
              checkpoints={mapCheckpoints}
              selectedMarkerId={selectedMarker}
              onMapPress={place}
              style={styles.editorMap}
            />
          </DeferredMapSlot>
        </View>
        <Text style={styles.mutedText}>
          Green: start ({origin.name}). Red: finish ({destination.name}). Amber: checkpoints.
          {placing?.kind === 'add' ? ' Tap the map to place the new checkpoint.' : ''}
          {placing?.kind === 'move' ? ' Tap the map to move the selected checkpoint.' : ''}
        </Text>

        <View style={[styles.endpointRow]}>
          <Text style={styles.cardTitle}>START · {origin.name}</Text>
        </View>
        {!loaded ? <Text style={styles.mutedText}>Loading checkpoints…</Text> : null}
        {loaded && items.length === 0 ? (
          <Text style={styles.mutedText}>No checkpoints yet. Add one to time a part of this journey.</Text>
        ) : null}
        {items.map((item, index) => {
          const selected = item.id === selectedId;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              onPress={() => setSelectedId(selected ? null : item.id)}
              style={[styles.checkpointCard, selected ? styles.checkpointCardSelected : null]}
            >
              <Text style={styles.cardMeta}>CHECKPOINT {index + 1}</Text>
              <TextInput
                accessibilityLabel={`Checkpoint ${index + 1} name`}
                editable={view.editable}
                value={item.name}
                onChangeText={(text) => setItems((current) => renameCheckpoint(current, item.id, text))}
                placeholder="Name"
                placeholderTextColor="#6b7076"
                style={styles.input}
              />
              <View style={styles.radiusInputRow}>
                <Text style={styles.radiusLabel}>Radius (m)</Text>
                <TextInput
                  accessibilityLabel={`Checkpoint ${index + 1} radius in meters`}
                  editable={view.editable}
                  keyboardType="number-pad"
                  inputMode="numeric"
                  value={Number.isFinite(item.radiusMeters) ? String(item.radiusMeters) : ''}
                  onChangeText={(text) =>
                    setItems((current) => setCheckpointRadius(current, item.id, parseZoneRadiusInput(text)))
                  }
                  style={[styles.input, styles.radiusInput]}
                />
              </View>
              <Text style={styles.mutedText}>
                {MIN_COMPETITIVE_CHECKPOINT_RADIUS_METERS}-{MAX_COMPETITIVE_CHECKPOINT_RADIUS_METERS} m
              </Text>
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${item.name} earlier`}
                  disabled={!view.editable || index === 0}
                  onPress={() => setItems((current) => moveCheckpoint(current, item.id, 'up'))}
                  style={[styles.button, styles.secondaryButton, !view.editable || index === 0 ? styles.disabledButton : null]}
                >
                  <Text style={styles.buttonText}>▲</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${item.name} later`}
                  disabled={!view.editable || index === items.length - 1}
                  onPress={() => setItems((current) => moveCheckpoint(current, item.id, 'down'))}
                  style={[
                    styles.button,
                    styles.secondaryButton,
                    !view.editable || index === items.length - 1 ? styles.disabledButton : null,
                  ]}
                >
                  <Text style={styles.buttonText}>▼</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!view.editable}
                  onPress={() => setPlacing({ kind: 'move', id: item.id })}
                  style={[styles.button, styles.secondaryButton, !view.editable ? styles.disabledButton : null]}
                >
                  <Text style={styles.buttonText}>MOVE ON MAP</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={!view.editable}
                  onPress={() => confirmDelete(item)}
                  style={[styles.button, styles.secondaryButton, !view.editable ? styles.disabledButton : null]}
                >
                  <Text style={styles.buttonText}>DELETE</Text>
                </Pressable>
              </View>
            </Pressable>
          );
        })}
        <View style={[styles.endpointRow, styles.endpointRowFinish]}>
          <Text style={styles.cardTitle}>FINISH · {destination.name}</Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={!view.editable}
            onPress={() => setPlacing({ kind: 'add' })}
            style={[styles.button, styles.primaryButton, !view.editable ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>ADD ON MAP</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!view.editable}
            onPress={() => void addAtCurrentLocation()}
            style={[styles.button, styles.secondaryButton, !view.editable ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>USE MY LOCATION</Text>
          </Pressable>
        </View>

        {view.issues.map((issue, index) => (
          <Text key={`${issue.code}-${issue.checkpointId ?? ''}-${index}`} style={styles.errorText}>
            {issue.message}
          </Text>
        ))}

        <Text style={styles.sectionLabel}>SEGMENTS THIS CREATES</Text>
        {preview.length === 0 ? (
          <Text style={styles.mutedText}>Add a checkpoint to see the segments a run through it qualifies for.</Text>
        ) : (
          <>
            {preview.map((row) => (
              <Text key={row.key} style={styles.statusText}>
                {row.label}
              </Text>
            ))}
            <Text style={styles.mutedText}>
              {origin.name} → {destination.name} stays the full-route board. A run that starts at a checkpoint only counts
              on the segments from that checkpoint onwards. Segment times can differ from the official time because a
              checkpoint is entered and left at different points.
            </Text>
          </>
        )}

        {view.impactWarning ? <Text style={styles.warningText}>{view.impactWarning}</Text> : null}
        {!view.impactWarning && view.changed ? <Text style={styles.mutedText}>{CHECKPOINT_NO_IMPACT_NOTE}</Text> : null}
        {message ? <Text style={styles.statusText}>{message}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={!view.canSave || saving}
            onPress={save}
            style={[styles.button, styles.primaryButton, !view.canSave || saving ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>SAVE CHECKPOINTS</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!view.changed || saving}
            onPress={() => {
              setItems(editorItemsFromConfig(status?.config ?? null));
              setPlacing(null);
              setMessage(null);
            }}
            style={[styles.button, styles.secondaryButton, !view.changed ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>DISCARD CHANGES</Text>
          </Pressable>
        </View>

        <SegmentRecalculationPanel
          service={recalculation}
          segments={segments}
          pool={pool}
          onChanged={() => {
            void reload();
            onChanged();
          }}
        />
      </ScrollView>
    </View>
  );
}
