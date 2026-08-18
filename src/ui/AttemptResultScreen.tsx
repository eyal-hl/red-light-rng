import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  describeUnavailability,
  segmentEndpointLabel,
  shouldShowPersistedUnrankedWarning,
  type FocusAttemptAnalysis,
} from '../domain/attempt-analysis';
import { type Attempt } from '../domain/attempt';
import { checkpointMapPoints } from '../domain/course-layout';
import { formatElapsed, formatPercent, formatRankAmong, formatSignedDelta, formatTimeOfDay } from '../domain/duration';
import { isMovementDisplayable, type MovementBreakdown } from '../domain/movement-analysis';
import type { Route } from '../domain/route';
import {
  formatWaitEventDuration,
  formatWaitEventLocation,
  waitEventIdNearPoint,
  type WaitEvent,
} from '../domain/wait-events';
import { RouteMap } from '../map/RouteMap';
import { styles } from './styles';

type AttemptResultScreenProps = {
  route: Route | null;
  attempt: Attempt;
  analysis: FocusAttemptAnalysis | null;
  busy: boolean;
  error: string | null;
  doneLabel?: string;
  onDone: () => void;
};

function deltaStyle(deltaMs: number | null) {
  if (deltaMs == null || deltaMs === 0) {
    return styles.deltaNeutral;
  }
  return deltaMs < 0 ? styles.deltaFaster : styles.deltaSlower;
}

function stopCountLabel(count: number): string {
  return count === 1 ? '1 stop' : `${count} stops`;
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

export function AttemptResultScreen({
  route,
  attempt,
  analysis,
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
  const [selection, setSelection] = useState<{ attemptId: string; waitId: string } | null>(null);
  const selectedWaitId = selection?.attemptId === attempt.id ? selection.waitId : null;
  const selectWait = (waitId: string) => {
    setSelection({ attemptId: attempt.id, waitId });
  };

  const checkpoints = route ? checkpointMapPoints(route.referencePath, route.checkpoints) : [];
  const waitMarkers = locatedWaits.flatMap((event) =>
    event.coordinate
      ? [
          {
            id: event.id,
            point: event.coordinate,
            label: formatWaitEventDuration(event.durationMs),
          },
        ]
      : [],
  );

  return (
    <View style={styles.screen}>
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

      {competitive && route ? (
        <View style={styles.attemptMapPane} collapsable={false}>
          <RouteMap
            path={route.referencePath}
            startZone={route.startZone}
            finishZone={route.finishZone}
            checkpoints={checkpoints}
            waitMarkers={waitMarkers}
            selectedMarkerId={selectedWaitId}
            onWaitMarkerPress={selectWait}
            onMapPress={(point) => {
              const tappedId = waitEventIdNearPoint(visibleWaitEvents, point);
              if (tappedId) {
                selectWait(tappedId);
              }
            }}
            style={styles.attemptMap}
          />
        </View>
      ) : null}

      <ScrollView
        style={competitive ? styles.attemptResultScroll : undefined}
        contentContainerStyle={competitive ? styles.attemptResultScrollContent : styles.content}
      >
        {!competitive ? (
          <View>
            <Text style={styles.kicker}>{completed ? 'ATTEMPT COMPLETE' : 'ATTEMPT ENDED'}</Text>
            <Text style={styles.title}>{route?.name ?? 'Attempt'}</Text>
            <Text style={styles.subtitle}>
              {attempt.lifecycle === 'abandoned'
                ? 'This attempt left the course and was not ranked.'
                : attempt.lifecycle === 'cancelled'
                  ? 'This attempt was cancelled and is not an official run.'
                  : 'This attempt is not available for current-layout comparison.'}
            </Text>
          </View>
        ) : null}
        {competitive && focus?.movement ? (
          <MovementBreakdownBlock
            breakdown={focus.movement}
            waitEvents={visibleWaitEvents}
            selectedWaitId={selectedWaitId}
            onSelectWait={selectWait}
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
