import { Pressable, ScrollView, Text, View } from 'react-native';

import {
  describeUnavailability,
  segmentEndpointLabel,
  shouldShowPersistedUnrankedWarning,
  type FocusAttemptAnalysis,
} from '../domain/attempt-analysis';
import { type Attempt } from '../domain/attempt';
import { formatElapsed, formatRankAmong, formatSignedDelta, formatTimeOfDay } from '../domain/duration';
import type { Route } from '../domain/route';
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

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.kicker}>{completed ? 'ATTEMPT COMPLETE' : 'ATTEMPT ENDED'}</Text>
        <Text style={styles.title}>{route?.name ?? 'Attempt'}</Text>
        {competitive && official != null ? (
          <Text style={styles.title}>{formatElapsed(official)}</Text>
        ) : (
          <Text style={styles.subtitle}>
            {attempt.lifecycle === 'abandoned'
              ? 'This attempt left the course and was not ranked.'
              : attempt.lifecycle === 'cancelled'
                ? 'This attempt was cancelled and is not an official run.'
                : 'This attempt is not available for current-layout comparison.'}
          </Text>
        )}
        {analysis?.isPb ? <Text style={styles.pbBadge}>PB</Text> : null}
        {competitive && analysis?.deltaVsPbMs != null ? (
          <Text style={deltaStyle(analysis.deltaVsPbMs)}>
            {formatSignedDelta(analysis.deltaVsPbMs)} vs PB
          </Text>
        ) : null}
        {competitive && analysis?.deltaVsPreviousMs != null ? (
          <Text style={deltaStyle(analysis.deltaVsPreviousMs)}>
            {formatSignedDelta(analysis.deltaVsPreviousMs)} vs previous
          </Text>
        ) : null}
        {competitive && analysis?.rank != null ? (
          <Text style={styles.subtitle}>{formatRankAmong(analysis.rank, analysis.summary.rankedAttemptCount)}</Text>
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
