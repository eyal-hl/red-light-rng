import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { Attempt } from '../domain/attempt';
import { incompleteAttemptLabel } from '../domain/attempt';
import type { JourneyPoolSummary } from '../domain/journey-analysis';
import type { Place } from '../domain/place';
import {
  transportationModeIcon,
  transportationModeLabel,
  type TransportationMode,
} from '../domain/route';
import { formatElapsed } from '../domain/duration';
import { styles } from './styles';

type HomeScreenProps = {
  journeys: JourneyPoolSummary[];
  places: Place[];
  incompleteAttempts: Attempt[];
  hiddenIncompleteAttempts: Attempt[];
  activeTransportationMode: TransportationMode;
  pendingRecording: boolean;
  pendingInterrupted: boolean;
  canStartAttempt: boolean;
  canStartNewRecording: boolean;
  busy: boolean;
  error: string | null;
  failedReconciliationAttemptId: string | null;
  onStart: () => void;
  onOpenJourney: (originPlaceId: string, destinationPlaceId: string, mode: TransportationMode) => void;
  onOpenIncomplete: (attemptId: string) => void;
  onHideIncomplete: (attemptId: string) => void;
  onRestoreIncomplete: (attemptId: string) => void;
  onOpenPlaces: () => void;
  onOpenSettings: () => void;
  onRecordPathVariant: () => void;
  onOpenPending: () => void;
  onRetryReconciliation: () => void;
};

export function HomeScreen({
  journeys,
  places,
  incompleteAttempts,
  hiddenIncompleteAttempts,
  activeTransportationMode,
  pendingRecording,
  pendingInterrupted,
  canStartAttempt,
  canStartNewRecording,
  busy,
  error,
  failedReconciliationAttemptId,
  onStart,
  onOpenJourney,
  onOpenIncomplete,
  onHideIncomplete,
  onRestoreIncomplete,
  onOpenPlaces,
  onOpenSettings,
  onRecordPathVariant,
  onOpenPending,
  onRetryReconciliation,
}: HomeScreenProps) {
  const startDisabled = busy || !canStartAttempt;
  const recordDisabled = busy || !canStartNewRecording;
  const activePlaceCount = places.filter((place) => place.status === 'active').length;
  const [showingHidden, setShowingHidden] = useState(false);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>RED LIGHT RNG</Text>
        <Text style={styles.title}>Start a journey</Text>
        <Pressable accessibilityRole="button" onPress={onOpenSettings}>
          <Text style={styles.subtitle}>
            {transportationModeIcon(activeTransportationMode)}{' '}
            {transportationModeLabel(activeTransportationMode)}
          </Text>
        </Pressable>

        {pendingRecording ? (
          <Pressable accessibilityRole="button" onPress={onOpenPending} style={styles.card}>
            <Text style={styles.cardTitle}>
              {pendingInterrupted ? 'Interrupted recording' : 'Unsaved recording'}
            </Text>
            <Text style={styles.cardMeta}>
              {pendingInterrupted
                ? 'Review this partial path variant, then save or discard it.'
                : 'Finish reviewing this recording before starting another.'}
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={startDisabled}
            onPress={onStart}
            style={[styles.button, styles.primaryButton, startDisabled ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>START</Text>
          </Pressable>
        </View>
        {activePlaceCount === 0 ? (
          <Text style={styles.mutedText}>
            Create saved places such as Home and Work. START watches those places automatically — no
            route or destination picker.
          </Text>
        ) : (
          <Text style={styles.mutedText}>
            Put the phone away. Timing starts after you leave a saved place and finishes at the first
            other saved place you enter.
          </Text>
        )}

        <Text style={styles.sectionLabel}>JOURNEYS</Text>
        {journeys.length === 0 ? (
          <Text style={styles.emptyText}>No journeys yet. Complete a START to see Home → Work history here.</Text>
        ) : (
          journeys.map((journey) => (
            <Pressable
              key={`${journey.originPlaceId}:${journey.destinationPlaceId}:${journey.transportationMode}`}
              accessibilityRole="button"
              onPress={() =>
                onOpenJourney(journey.originPlaceId, journey.destinationPlaceId, journey.transportationMode)
              }
              style={styles.card}
            >
              <Text style={styles.cardTitle}>{journey.title}</Text>
              <Text style={styles.cardMeta}>
                {transportationModeIcon(journey.transportationMode)}{' '}
                {transportationModeLabel(journey.transportationMode)}
                {journey.pbTimeMs == null ? '' : ` · PB ${formatElapsed(journey.pbTimeMs)}`}
                {` · ${journey.rankedAttemptCount} ranked`}
              </Text>
            </Pressable>
          ))
        )}

        {incompleteAttempts.length > 0 ? (
          <View>
            <Text style={styles.sectionLabel}>INCOMPLETE</Text>
            {incompleteAttempts.map((attempt) => (
              <IncompleteAttemptCard
                key={attempt.id}
                attempt={attempt}
                busy={busy}
                actionLabel="HIDE"
                accessibilityLabel={`Hide ${incompleteAttemptLabel(attempt) ?? 'incomplete attempt'}`}
                onOpen={() => onOpenIncomplete(attempt.id)}
                onAction={() => onHideIncomplete(attempt.id)}
                actionStyle="danger"
              />
            ))}
          </View>
        ) : null}

        {hiddenIncompleteAttempts.length > 0 ? (
          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showingHidden }}
              accessibilityLabel={
                showingHidden ? 'Hide hidden incomplete attempts' : 'Show hidden incomplete attempts'
              }
              onPress={() => setShowingHidden((open) => !open)}
            >
              <Text style={styles.sectionLabel}>
                {showingHidden
                  ? '▾ HIDDEN INCOMPLETE'
                  : `▸ SHOW HIDDEN INCOMPLETE · ${hiddenIncompleteAttempts.length}`}
              </Text>
            </Pressable>
            {showingHidden
              ? hiddenIncompleteAttempts.map((attempt) => (
                  <IncompleteAttemptCard
                    key={attempt.id}
                    attempt={attempt}
                    busy={busy}
                    actionLabel="RESTORE"
                    accessibilityLabel={`Restore ${incompleteAttemptLabel(attempt) ?? 'incomplete attempt'}`}
                    onOpen={() => onOpenIncomplete(attempt.id)}
                    onAction={() => onRestoreIncomplete(attempt.id)}
                    actionStyle="restore"
                  />
                ))
              : null}
          </View>
        ) : null}

        {failedReconciliationAttemptId ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Could not finish one attempt</Text>
            <Text style={styles.cardMeta}>
              Retry repairs only that attempt. Historical attempts that already finished stay untouched.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry failed attempt reconciliation"
              disabled={busy}
              onPress={onRetryReconciliation}
              style={[styles.button, styles.primaryButton, busy ? styles.disabledButton : null]}
            >
              <Text style={styles.buttonText}>RETRY</Text>
            </Pressable>
          </View>
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onOpenPlaces}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>PLACES</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onOpenSettings}
            style={[styles.button, styles.secondaryButton, busy ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>SETTINGS</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={recordDisabled}
            onPress={onRecordPathVariant}
            style={[styles.button, styles.secondaryButton, recordDisabled ? styles.disabledButton : null]}
          >
            <Text style={styles.buttonText}>RECORD PATH VARIANT</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function IncompleteAttemptCard({
  attempt,
  busy,
  actionLabel,
  accessibilityLabel,
  onOpen,
  onAction,
  actionStyle,
}: {
  attempt: Attempt;
  busy: boolean;
  actionLabel: string;
  accessibilityLabel: string;
  onOpen: () => void;
  onAction: () => void;
  actionStyle: 'danger' | 'restore';
}) {
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" disabled={busy} onPress={onOpen}>
        <Text style={styles.cardTitle}>{incompleteAttemptLabel(attempt) ?? 'Ended attempt'}</Text>
        <Text style={styles.cardMeta}>Debug trace preserved</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        disabled={busy}
        onPress={onAction}
        style={styles.cardDangerAction}
      >
        <Text style={actionStyle === 'danger' ? styles.cardDangerText : styles.cardRestoreText}>
          {actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}
