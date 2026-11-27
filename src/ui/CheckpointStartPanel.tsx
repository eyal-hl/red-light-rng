import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { CompetitiveCheckpointPool } from '../domain/competitive-checkpoint';
import type { LatLng } from '../domain/geo';
import { placeZone } from '../domain/place';
import {
  FULL_ROUTE_START,
  nearestStartJourney,
  sameStartSelection,
  startBoardPreview,
  suggestStartSelection,
  type StartOptionsJourney,
  type StartSelection,
} from '../domain/start-options';
import type { TransportationMode } from '../domain/route';
import { RouteMap } from '../map/RouteMap';
import type { CompetitiveSegmentsService } from '../product/competitive-segments';
import { DeferredMapSlot } from './DeferredMapSlot';
import { styles } from './styles';

type Props = {
  segments: CompetitiveSegmentsService;
  mode: TransportationMode;
  getCurrentPosition: () => Promise<LatLng | null>;
  disabled: boolean;
  /** Arms a partial attempt for the chosen checkpoint. */
  onStartAtCheckpoint: (pool: CompetitiveCheckpointPool, checkpointId: string) => void;
};

/**
 * Start options for journeys with competitive checkpoints (#81). Renders NOTHING when no journey of
 * the active mode has checkpoints, so the plain START flow is exactly the default. "Full route" is
 * that same START (origin detected automatically); "Start at <checkpoint>" arms a partial run.
 * A location-aware suggestion is preselected but can always be overridden. Checkpoints are never
 * finish places; the run finishes at the journey's destination.
 */
export function CheckpointStartPanel({ segments, mode, getCurrentPosition, disabled, onStartAtCheckpoint }: Props) {
  const [journeys, setJourneys] = useState<StartOptionsJourney[] | null>(null);
  const [position, setPosition] = useState<LatLng | null>(null);
  const [journeyKey, setJourneyKey] = useState<string | null>(null);
  const [override, setOverride] = useState<{ journey: string; selection: StartSelection } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const options = await segments.listStartOptions(mode);
      if (cancelled) return;
      setJourneys(options);
      if (options.length === 0) return;
      // The position is only read when there is something to suggest; failures just mean "no suggestion".
      const fix = await getCurrentPosition().catch(() => null);
      if (!cancelled) setPosition(fix);
    })().catch(() => {
      if (!cancelled) setJourneys([]);
    });
    return () => {
      cancelled = true;
    };
  }, [segments, mode, getCurrentPosition]);

  const nearest = useMemo(() => nearestStartJourney(position, journeys ?? []), [journeys, position]);
  const activeJourney =
    (journeys ?? []).find((item) => `${item.pool.originPlaceId}|${item.pool.destinationPlaceId}` === journeyKey) ?? nearest;
  const activeKey = activeJourney ? `${activeJourney.pool.originPlaceId}|${activeJourney.pool.destinationPlaceId}` : null;
  const suggestion = useMemo<StartSelection>(
    () =>
      activeJourney
        ? suggestStartSelection({ position, origin: activeJourney.origin, checkpoints: activeJourney.checkpoints })
        : FULL_ROUTE_START,
    [activeJourney, position],
  );
  const selection = override && override.journey === activeKey ? override.selection : suggestion;

  if (!journeys || journeys.length === 0 || !activeJourney || activeKey == null) {
    return null;
  }
  const preview = startBoardPreview({
    selection,
    checkpoints: activeJourney.checkpoints,
    originName: activeJourney.originName,
    destinationName: activeJourney.destinationName,
  });
  const selectedCheckpoint =
    selection.kind === 'checkpoint' ? activeJourney.checkpoints.find((item) => item.id === selection.checkpointId) : null;
  const options: { label: string; value: StartSelection }[] = [
    { label: 'Full route', value: FULL_ROUTE_START },
    ...activeJourney.checkpoints.map((item) => ({
      label: `Start at ${item.name}`,
      value: { kind: 'checkpoint', checkpointId: item.id } as StartSelection,
    })),
  ];

  return (
    <View accessibilityLabel="Checkpoint starts">
      <Text style={styles.sectionLabel}>START AT A CHECKPOINT</Text>
      {journeys.length > 1 ? (
        <View style={styles.segmentChipRow}>
          {journeys.map((item) => {
            const key = `${item.pool.originPlaceId}|${item.pool.destinationPlaceId}`;
            return (
              <Pressable
                key={key}
                accessibilityRole="button"
                onPress={() => setJourneyKey(key)}
                style={[styles.modeChip, key === activeKey ? styles.modeChipSelected : null]}
              >
                <Text style={styles.modeChipText}>
                  {item.originName} → {item.destinationName}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={styles.cardMeta}>
          {activeJourney.originName} → {activeJourney.destinationName}
        </Text>
      )}
      <View style={styles.segmentChipRow}>
        {options.map((option) => {
          const selected = sameStartSelection(option.value, selection);
          const suggested = sameStartSelection(option.value, suggestion) && position != null;
          return (
            <Pressable
              key={option.value.kind === 'full' ? 'full' : option.value.checkpointId}
              accessibilityRole="button"
              onPress={() => setOverride({ journey: activeKey, selection: option.value })}
              style={[styles.modeChip, selected ? styles.modeChipSelected : null]}
            >
              <Text style={styles.modeChipText}>
                {option.label}
                {suggested ? ' · suggested' : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.mapSlot}>
        <DeferredMapSlot style={styles.editorMap}>
          <RouteMap
            path={[]}
            startZone={placeZone(activeJourney.origin, 'departure')}
            finishZone={placeZone(activeJourney.destination, 'arrival')}
            checkpoints={activeJourney.checkpoints.map((item) => ({ id: item.id, name: item.name, point: item.center }))}
            selectedMarkerId={selectedCheckpoint?.id ?? null}
            previewPoint={position}
            cameraGesturesEnabled={false}
            style={styles.editorMap}
          />
        </DeferredMapSlot>
      </View>
      <Text style={styles.sectionLabel}>BOARDS THIS RUN COUNTS ON</Text>
      {selection.kind === 'full' ? (
        <Text style={styles.statusText}>
          {activeJourney.originName} → {activeJourney.destinationName} (full-route board)
        </Text>
      ) : null}
      {preview.map((row) => (
        <Text key={row.key} style={styles.statusText}>
          {row.label}
        </Text>
      ))}
      {selectedCheckpoint ? (
        <>
          <Text style={styles.mutedText}>
            Timing starts when you leave {selectedCheckpoint.name} toward {activeJourney.destinationName}. Walking to it is
            not timed, and passing other checkpoints never ends the run. It finishes at {activeJourney.destinationName}. This
            run never counts on the full-route board.
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => onStartAtCheckpoint(activeJourney.pool, selectedCheckpoint.id)}
              style={[styles.button, styles.primaryButton, disabled ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>START AT {selectedCheckpoint.name.toUpperCase()}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Text style={styles.mutedText}>Full route uses the normal START above.</Text>
      )}
    </View>
  );
}
