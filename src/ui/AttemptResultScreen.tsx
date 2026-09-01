import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  describeUnavailability,
  segmentEndpointLabel,
  shouldShowPersistedUnrankedWarning,
  type FocusAttemptAnalysis,
} from '../domain/attempt-analysis';
import { incompleteAttemptLabel, type Attempt } from '../domain/attempt';
import { checkpointMapPoints } from '../domain/course-layout';
import {
  nearestDebugSample,
  type AttemptDebugReport,
  type AttemptDebugSample,
} from '../domain/attempt-debug';
import { formatElapsed, formatPercent, formatRankAmong, formatSignedDelta, formatTimeOfDay } from '../domain/duration';
import { type GhostChartSelection } from '../domain/ghost-chart';
import { isMovementDisplayable, type MovementBreakdown } from '../domain/movement-analysis';
import { pointAtProgress } from '../domain/path-projection';
import type { Route } from '../domain/route';
import {
  formatWaitEventDuration,
  formatWaitEventLocation,
  waitEventIdNearPoint,
  type WaitEvent,
} from '../domain/wait-events';
import {
  describeWaitComparisonUnavailable,
  formatWaitComparisonDelta,
  formatWaitComparisonLocation,
  waitComparisonLocationIdNearPoint,
  type WaitComparison,
  type WaitComparisonLocationEntry,
} from '../domain/wait-comparison';
import { RouteMap, type RouteMapWaitMarkerTone } from '../map/RouteMap';
import { GhostDeltaChart } from './GhostDeltaChart';
import { styles } from './styles';

type AttemptResultScreenProps = {
  route: Route | null;
  attempt: Attempt;
  analysis: FocusAttemptAnalysis | null;
  debug?: AttemptDebugReport | null;
  busy: boolean;
  error: string | null;
  doneLabel?: string;
  onDone: () => void;
};

function qualityLabel(quality: AttemptDebugSample['match']['quality']): string {
  switch (quality) {
    case 'accepted':
      return 'accepted';
    case 'poor_accuracy':
      return 'poor accuracy';
    case 'off_course':
      return 'off course';
    case 'out_of_window':
      return 'out of window';
    case 'unprojected':
      return 'unprojected';
  }
}

function incompleteSubtitle(attempt: Attempt, debug: AttemptDebugReport | null | undefined): string {
  if (attempt.lifecycle === 'abandoned') {
    return 'This attempt left the course and was not ranked.';
  }
  if (attempt.lifecycle === 'cancelled') {
    return 'This attempt was cancelled and is not an official run.';
  }
  const label = debug?.incompleteLabel ?? incompleteAttemptLabel(attempt);
  if (label === 'DID NOT START') {
    return 'DID NOT START — automatic start was never recognized.';
  }
  if (label === 'DID NOT FINISH') {
    return 'DID NOT FINISH — automatic finish was never recognized.';
  }
  return 'This attempt is not available for current-layout comparison.';
}

function formatMeters(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  return `${Math.round(value)} m`;
}

function formatCoordinate(value: number): string {
  return value.toFixed(5);
}

function deltaStyle(deltaMs: number | null) {
  if (deltaMs == null || deltaMs === 0) {
    return styles.deltaNeutral;
  }
  return deltaMs < 0 ? styles.deltaFaster : styles.deltaSlower;
}

function stopCountLabel(count: number): string {
  return count === 1 ? '1 stop' : `${count} stops`;
}

function comparisonTone(deltaMs: number): RouteMapWaitMarkerTone {
  if (deltaMs > 0) {
    return 'more';
  }
  if (deltaMs < 0) {
    return 'less';
  }
  return 'wait';
}

function WaitingVsPbBlock({
  comparison,
  selectedComparisonId,
  onSelectLocation,
}: {
  comparison: WaitComparison;
  selectedComparisonId: string | null;
  onSelectLocation: (location: WaitComparisonLocationEntry) => void;
}) {
  if (!comparison.available) {
    return (
      <View style={styles.movementSection}>
        <Text style={styles.sectionLabel}>WAITING VS PB</Text>
        <Text style={styles.mutedText}>
          {comparison.unavailableReason
            ? describeWaitComparisonUnavailable(comparison.unavailableReason)
            : 'Waiting comparison is unavailable.'}
        </Text>
      </View>
    );
  }

  const equal = comparison.waitingDeltaMs === 0;

  return (
    <View style={styles.movementSection}>
      <Text style={styles.sectionLabel}>WAITING VS PB</Text>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Waiting vs PB</Text>
        <Text style={deltaStyle(comparison.waitingDeltaMs)}>
          {formatWaitComparisonDelta(comparison.waitingDeltaMs)}
        </Text>
      </View>
      {equal && comparison.displayedLocations.length === 0 ? (
        <Text style={styles.mutedText}>About the same confirmed waiting as the PB run.</Text>
      ) : null}
      {comparison.displayedLocations.map((location) => {
        const selected = selectedComparisonId === location.id;
        return (
          <Pressable
            key={location.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Waiting versus PB ${formatWaitComparisonDelta(location.deltaMs)}, ${formatWaitComparisonLocation(location)}`}
            onPress={() => onSelectLocation(location)}
            style={[styles.waitRow, selected ? styles.selectedCard : null]}
          >
            <Text
              style={[
                styles.waitDuration,
                location.deltaMs > 0 ? styles.waitComparisonMore : null,
                location.deltaMs < 0 ? styles.waitComparisonLess : null,
              ]}
            >
              {formatWaitComparisonDelta(location.deltaMs)}
            </Text>
            <Text style={styles.waitLocation}>{formatWaitComparisonLocation(location)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function MovementBreakdownBlock({
  breakdown,
  waitEvents,
  selectedWaitId,
  onSelectWait,
}: {
  breakdown: MovementBreakdown;
  waitEvents: WaitEvent[];
  selectedWaitId: string | null;
  onSelectWait: (waitId: string) => void;
}) {
  if (!isMovementDisplayable(breakdown)) {
    return (
      <View style={styles.movementSection}>
        <Text style={styles.sectionLabel}>MOVEMENT</Text>
        <Text style={styles.mutedText}>
          Not enough trustworthy telemetry to classify moving vs waiting.
        </Text>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Coverage</Text>
          <Text style={styles.statValue}>{formatPercent(breakdown.coverageRatio)}</Text>
        </View>
      </View>
    );
  }

  const waitingShare =
    breakdown.officialTimeMs > 0 ? breakdown.waitingMs / breakdown.officialTimeMs : null;

  return (
    <View style={styles.movementSection}>
      <Text style={styles.sectionLabel}>MOVEMENT</Text>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Moving</Text>
        <Text style={styles.statValue}>{formatElapsed(breakdown.movingMs)}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Waiting</Text>
        <Text style={styles.statValue}>
          {formatElapsed(breakdown.waitingMs)}
          {waitingShare == null ? '' : ` · ${formatPercent(waitingShare)}`}
          {` · ${stopCountLabel(waitEvents.length)}`}
        </Text>
      </View>
      {waitEvents.map((event, index) => {
        const selected = selectedWaitId === event.id;
        return (
          <Pressable
            key={event.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Wait ${index + 1}, ${formatWaitEventDuration(event.durationMs)}, ${formatWaitEventLocation(event)}`}
            onPress={() => onSelectWait(event.id)}
            style={[styles.waitRow, selected ? styles.selectedCard : null]}
          >
            <Text style={styles.waitDuration}>
              {index + 1}. {formatWaitEventDuration(event.durationMs)}
            </Text>
            <Text style={styles.waitLocation}>{formatWaitEventLocation(event)}</Text>
          </Pressable>
        );
      })}
      {breakdown.trust === 'partial' ? (
        <View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Uncertain</Text>
            <Text style={styles.statValue}>{formatElapsed(breakdown.unknownMs)}</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Coverage</Text>
            <Text style={styles.statValue}>{formatPercent(breakdown.coverageRatio)}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function DebugTracePanel({
  debug,
  selectedSample,
  onSelectSample,
}: {
  debug: AttemptDebugReport;
  selectedSample: AttemptDebugSample | null;
  onSelectSample: (sampleId: string) => void;
}) {
  const selectedIndex = selectedSample
    ? debug.samples.findIndex((entry) => entry.sample.id === selectedSample.sample.id)
    : -1;
  const previous = selectedIndex > 0 ? debug.samples[selectedIndex - 1] : null;
  const next =
    selectedIndex >= 0 && selectedIndex < debug.samples.length - 1 ? debug.samples[selectedIndex + 1] : null;
  const rejectedTotal =
    debug.rejectedByQuality.poor_accuracy +
    debug.rejectedByQuality.off_course +
    debug.rejectedByQuality.out_of_window +
    debug.rejectedByQuality.unprojected;

  return (
    <View style={styles.debugPanel}>
      <Text style={styles.sectionLabel}>TRACE DEBUG</Text>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Raw samples</Text>
        <Text style={styles.statValue}>{debug.rawSampleCount}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Accepted</Text>
        <Text style={styles.statValue}>{debug.acceptedCount}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Rejected</Text>
        <Text style={styles.statValue}>{rejectedTotal}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Poor accuracy</Text>
        <Text style={styles.statValue}>{debug.rejectedByQuality.poor_accuracy}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Off course</Text>
        <Text style={styles.statValue}>{debug.rejectedByQuality.off_course}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Out of window</Text>
        <Text style={styles.statValue}>{debug.rejectedByQuality.out_of_window}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Unprojected</Text>
        <Text style={styles.statValue}>{debug.rejectedByQuality.unprojected}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>First / last</Text>
        <Text style={styles.statValue}>
          {debug.firstRecordedAtMs == null ? '—' : formatTimeOfDay(debug.firstRecordedAtMs)}
          {' → '}
          {debug.lastRecordedAtMs == null ? '—' : formatTimeOfDay(debug.lastRecordedAtMs)}
        </Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Accepted progress</Text>
        <Text style={styles.statValue}>
          {formatMeters(debug.acceptedProgressMinMeters)} – {formatMeters(debug.acceptedProgressMaxMeters)}
        </Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Start-zone evidence</Text>
        <Text style={styles.statValue}>{debug.anyAcceptedInStartZone ? 'yes' : 'no'}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>sawPreStart</Text>
        <Text style={styles.statValue}>
          {debug.sawPreStart ? 'yes' : 'no'}
          {debug.preStartRequired ? ' (required)' : ' (not required)'}
        </Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Qualifying departure</Text>
        <Text style={styles.statValue}>{debug.qualifyingDepartureFound ? 'yes' : 'no'}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Latest departure window</Text>
        <Text style={styles.statValue}>
          {debug.departure.windowSampleCount}/{debug.departure.minSamples} samples,{' '}
          {formatMeters(debug.departure.advanceMeters)}/{debug.departure.minAdvanceMeters} m,{' '}
          {debug.departure.windowMs / 1000}s
        </Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Reconstructed start</Text>
        <Text style={styles.statValue}>
          {debug.reconstructedStartAtMs == null ? '—' : formatTimeOfDay(debug.reconstructedStartAtMs)}
        </Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Finish trigger after start</Text>
        <Text style={styles.statValue}>{debug.finishTriggerReachedAfterStart ? 'yes' : 'no'}</Text>
      </View>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Engine lifecycle</Text>
        <Text style={styles.statValue}>{debug.engine.lifecycle}</Text>
      </View>
      {selectedSample ? (
        <View style={styles.debugSampleCard}>
          <Text style={styles.sectionLabel}>
            SAMPLE {selectedIndex + 1} / {debug.samples.length}
          </Text>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Time</Text>
            <Text style={styles.statValue}>{formatTimeOfDay(selectedSample.sample.recordedAtMs)}</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Accuracy</Text>
            <Text style={styles.statValue}>
              {selectedSample.sample.horizontalAccuracyMeters == null
                ? '—'
                : `${Math.round(selectedSample.sample.horizontalAccuracyMeters)} m`}
            </Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Location</Text>
            <Text style={styles.statValue}>
              {formatCoordinate(selectedSample.sample.latitude)}, {formatCoordinate(selectedSample.sample.longitude)}
            </Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Match</Text>
            <Text style={styles.statValue}>
              {selectedSample.match.accepted ? 'accepted' : 'rejected'} · {qualityLabel(selectedSample.match.quality)}
            </Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Progress</Text>
            <Text style={styles.statValue}>{formatMeters(selectedSample.match.progressMeters)}</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Distance from path</Text>
            <Text style={styles.statValue}>{formatMeters(selectedSample.match.distanceFromPathMeters)}</Text>
          </View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Zones</Text>
            <Text style={styles.statValue}>
              {selectedSample.inStartZone ? 'start' : '—'} / {selectedSample.inFinishZone ? 'finish' : '—'}
            </Text>
          </View>
          <View style={styles.debugSampleNav}>
            <Pressable
              accessibilityRole="button"
              disabled={!previous}
              onPress={() => {
                if (previous) {
                  onSelectSample(previous.sample.id);
                }
              }}
              style={[styles.button, styles.secondaryButton, !previous ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>PREV</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={!next}
              onPress={() => {
                if (next) {
                  onSelectSample(next.sample.id);
                }
              }}
              style={[styles.button, styles.secondaryButton, !next ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>NEXT</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function AttemptResultScreen({
  route,
  attempt,
  analysis,
  debug = null,
  busy,
  error,
  doneLabel = 'DONE',
  onDone,
}: AttemptResultScreenProps) {
  const completed = attempt.lifecycle === 'completed';
  const focus = analysis?.focus;
  const competitive = focus?.eligible === true;
  const official = competitive ? focus.officialTimeMs : null;
  const displayStartedAtMs = competitive ? focus.startedAtMs : attempt.startedAtMs;
  const displayFinishedAtMs = competitive ? focus.finishedAtMs : attempt.finishedAtMs;
  const waitEvents = competitive ? focus.waitEvents : [];
  const displayableMovement = focus?.movement != null && isMovementDisplayable(focus.movement);
  const visibleWaitEvents = displayableMovement ? waitEvents : [];
  const locatedWaits = visibleWaitEvents.filter(
    (event) => event.locationState === 'located' && event.coordinate != null,
  );
  const [selection, setSelection] = useState<{
    attemptId: string;
    markerId: string;
    comparisonId: string | null;
  } | null>(null);
  const [ghostSelection, setGhostSelection] = useState<{
    attemptId: string;
    point: GhostChartSelection;
  } | null>(null);
  const [pageScrollEnabled, setPageScrollEnabled] = useState(true);
  const [selectedSampleId, setSelectedSampleId] = useState<string | null>(null);
  const selectedWaitId = selection?.attemptId === attempt.id ? selection.markerId : null;
  const selectedComparisonId = selection?.attemptId === attempt.id ? selection.comparisonId : null;
  const activeGhostSelection = ghostSelection?.attemptId === attempt.id ? ghostSelection.point : null;
  const ghostMapPoint =
    competitive && route && activeGhostSelection
      ? pointAtProgress(route.referencePath, activeGhostSelection.progressMeters)
      : null;
  const waitingComparison = competitive ? analysis?.waitingComparison : null;
  const ghostComparison = competitive ? analysis?.ghostComparison : null;
  const displayedComparisonLocations =
    waitingComparison?.available === true ? waitingComparison.displayedLocations : [];
  const waitToneById = new Map<string, RouteMapWaitMarkerTone>();
  for (const location of displayedComparisonLocations) {
    const tone = comparisonTone(location.deltaMs);
    if (tone === 'wait') {
      continue;
    }
    for (const waitId of location.currentEventIds) {
      waitToneById.set(waitId, tone);
    }
  }
  const selectMarker = (markerId: string, comparisonId: string | null = null) => {
    setSelection({ attemptId: attempt.id, markerId, comparisonId });
  };
  const selectWait = (waitId: string) => {
    const location = displayedComparisonLocations.find((entry) => entry.currentEventIds.includes(waitId));
    selectMarker(waitId, location?.id ?? null);
  };
  const selectComparison = (location: WaitComparisonLocationEntry) => {
    const currentWaitId = location.currentEventIds.find((waitId) =>
      locatedWaits.some((event) => event.id === waitId),
    );
    selectMarker(currentWaitId ?? location.id, location.id);
  };

  const checkpoints = route ? checkpointMapPoints(route.referencePath, route.checkpoints) : [];
  const waitMarkers = [
    ...locatedWaits.flatMap((event) =>
      event.coordinate
        ? [
            {
              id: event.id,
              point: event.coordinate,
              label: formatWaitEventDuration(event.durationMs),
              tone: waitToneById.get(event.id) ?? 'wait',
            },
          ]
        : [],
    ),
    ...displayedComparisonLocations.flatMap((location) => {
      if (location.matchState !== 'reference-only' || location.coordinate == null) {
        return [];
      }
      return [
        {
          id: location.id,
          point: location.coordinate,
          label: formatWaitComparisonDelta(location.deltaMs),
          tone: comparisonTone(location.deltaMs),
        },
      ];
    }),
  ];
  const selectedDebugSample =
    debug?.samples.find((entry) => entry.sample.id === selectedSampleId) ?? debug?.samples[0] ?? null;
  const debugSamples = (debug?.samples ?? []).map((entry) => ({
    id: entry.sample.id,
    point: { latitude: entry.sample.latitude, longitude: entry.sample.longitude },
    accepted: entry.match.accepted,
  }));

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.attemptResultScroll}
        contentContainerStyle={competitive ? styles.attemptResultScrollContent : styles.content}
        scrollEnabled={pageScrollEnabled}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
      {competitive && route ? (
        <View style={styles.attemptResultHeader}>
          <Text style={styles.kicker}>{completed ? 'ATTEMPT COMPLETE' : 'ATTEMPT ENDED'}</Text>
          <Text style={styles.title}>{route.name}</Text>
          {official != null ? <Text style={styles.title}>{formatElapsed(official)}</Text> : null}
          {analysis?.isPb ? <Text style={styles.pbBadge}>PB</Text> : null}
          {analysis?.deltaVsPbMs != null ? (
            <Text style={deltaStyle(analysis.deltaVsPbMs)}>
              {formatSignedDelta(analysis.deltaVsPbMs)} vs PB
            </Text>
          ) : null}
          {analysis?.deltaVsPreviousMs != null ? (
            <Text style={deltaStyle(analysis.deltaVsPreviousMs)}>
              {formatSignedDelta(analysis.deltaVsPreviousMs)} vs previous
            </Text>
          ) : null}
          {analysis?.rank != null ? (
            <Text style={styles.subtitle}>{formatRankAmong(analysis.rank, analysis.summary.rankedAttemptCount)}</Text>
          ) : null}
        </View>
      ) : null}

      {route ? (
        <View style={styles.attemptMapPane} collapsable={false}>
          <RouteMap
            path={route.referencePath}
            startZone={route.startZone}
            finishZone={route.finishZone}
            checkpoints={checkpoints}
            waitMarkers={waitMarkers}
            selectedMarkerId={selectedWaitId}
            previewPoint={ghostMapPoint}
            recordedPath={debug?.recordedPath ?? []}
            debugSamples={debugSamples}
            selectedSampleId={selectedDebugSample?.sample.id ?? null}
            officialStartPoint={debug?.officialStartPoint ?? null}
            officialFinishPoint={debug?.officialFinishPoint ?? null}
            onWaitMarkerPress={(markerId) => {
              const location = displayedComparisonLocations.find((entry) => entry.id === markerId);
              if (location) {
                selectComparison(location);
                return;
              }
              selectWait(markerId);
            }}
            onMapPress={(point) => {
              if (debug) {
                const tappedSample = nearestDebugSample(debug.samples, point);
                if (tappedSample) {
                  setSelectedSampleId(tappedSample.sample.id);
                  return;
                }
              }
              const tappedWaitId = waitEventIdNearPoint(visibleWaitEvents, point);
              if (tappedWaitId) {
                selectWait(tappedWaitId);
                return;
              }
              const tappedComparisonId = waitComparisonLocationIdNearPoint(displayedComparisonLocations, point);
              const location = displayedComparisonLocations.find((entry) => entry.id === tappedComparisonId);
              if (location) {
                selectComparison(location);
                return;
              }
              setGhostSelection(null);
            }}
            cameraGesturesEnabled={false}
            style={styles.attemptMap}
          />
        </View>
      ) : null}

      {competitive && ghostComparison ? (
        <View style={styles.ghostChartPane} collapsable={false}>
          <GhostDeltaChart
            comparison={ghostComparison}
            isCurrentPb={analysis?.isPb === true}
            selection={activeGhostSelection}
            onSelect={(point) => {
              setGhostSelection(point ? { attemptId: attempt.id, point } : null);
            }}
            onScrubChange={(active) => setPageScrollEnabled(!active)}
          />
        </View>
      ) : null}

        {!competitive ? (
          <View>
            <Text style={styles.kicker}>{completed ? 'ATTEMPT COMPLETE' : 'ATTEMPT ENDED'}</Text>
            <Text style={styles.title}>
              {debug?.incompleteLabel ?? incompleteAttemptLabel(attempt) ?? route?.name ?? 'Attempt'}
            </Text>
            <Text style={styles.subtitle}>{incompleteSubtitle(attempt, debug)}</Text>
          </View>
        ) : null}
        {debug ? <DebugTracePanel debug={debug} selectedSample={selectedDebugSample} onSelectSample={setSelectedSampleId} /> : null}
        {competitive && focus?.movement ? (
          <MovementBreakdownBlock
            breakdown={focus.movement}
            waitEvents={visibleWaitEvents}
            selectedWaitId={selectedWaitId}
            onSelectWait={selectWait}
          />
        ) : null}
        {competitive && waitingComparison ? (
          <WaitingVsPbBlock
            comparison={waitingComparison}
            selectedComparisonId={selectedComparisonId}
            onSelectLocation={selectComparison}
          />
        ) : null}
        {focus && !focus.eligible && focus.unavailabilityReason ? (
          <Text style={styles.warningText}>{describeUnavailability(focus.unavailabilityReason)}</Text>
        ) : null}
        {shouldShowPersistedUnrankedWarning({
          lifecycle: attempt.lifecycle,
          persistedValidity: attempt.validity,
          focus,
        }) ? (
          <Text style={styles.warningText}>Unranked — the course match was not reliable enough.</Text>
        ) : null}

        {competitive ? (
          <View>
            <Text style={styles.sectionLabel}>SPLITS</Text>
            <View style={styles.splitHeader}>
              <Text style={styles.splitHeaderText}>SEGMENT</Text>
              <Text style={styles.splitHeaderText}>TIME    Δ PB</Text>
            </View>
            {analysis?.segments.map((segment) => (
              <View key={segment.spec.id} style={styles.splitBlock}>
                <Text style={styles.splitConnector}>{segmentEndpointLabel(segment.spec.from)}</Text>
                <Text style={styles.splitConnector}>↓</Text>
                <View style={styles.statRow}>
                  <Text style={styles.statLabel}>{segmentEndpointLabel(segment.spec.to)}</Text>
                  <Text style={styles.statValue}>
                    {segment.durationMs == null ? '—' : formatElapsed(segment.durationMs)}
                    {segment.deltaVsPbRunMs == null
                      ? ''
                      : `   ${formatSignedDelta(segment.deltaVsPbRunMs)}`}
                  </Text>
                </View>
                {segment.durationMs == null ? (
                  <Text style={styles.mutedText}>Unavailable for this layout</Text>
                ) : null}
                {segment.isNewGold ? <Text style={styles.goldText}>GOLD</Text> : null}
              </View>
            ))}
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>PB</Text>
              <Text style={styles.statValue}>
                {analysis?.summary.pbTimeMs == null ? '—' : formatElapsed(analysis.summary.pbTimeMs)}
              </Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>This run</Text>
              <Text style={styles.statValue}>{official == null ? '—' : formatElapsed(official)}</Text>
            </View>
            <View style={styles.statRow}>
              <Text style={styles.statLabel}>Sum of Best</Text>
              <Text style={styles.statValue}>
                {analysis?.sumOfBestMs == null ? '—' : formatElapsed(analysis.sumOfBestMs)}
              </Text>
            </View>
          </View>
        ) : null}

        {displayStartedAtMs != null ? (
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Started</Text>
            <Text style={styles.statValue}>{formatTimeOfDay(displayStartedAtMs)}</Text>
          </View>
        ) : null}
        {displayFinishedAtMs != null ? (
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Finished</Text>
            <Text style={styles.statValue}>{formatTimeOfDay(displayFinishedAtMs)}</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onDone}
            style={[styles.button, styles.primaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>{doneLabel}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}
