import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { RECALCULATION_CONFIRM_WARNING } from '../domain/history-recalculation';
import type {
  HistoryRecalculationService,
  RecalculationPreview,
  RecalculationProgress,
} from '../product/history-recalculation';
import { styles } from './styles';

const PAUSED_RETRY_MS = 3_000;

type Props = {
  service: HistoryRecalculationService;
  /** True right after the user saved changed Place radii: nudges, never runs automatically. */
  radiiJustChanged: boolean;
  /** Called after a job was published so lists/stats can be refreshed. */
  onPublished: () => void;
};

/**
 * Manual "Recalculate history" action (#77). Nothing here runs without an explicit press: not on
 * save, upgrade, restore or browsing. A job found on relaunch is only offered for resuming.
 */
export function HistoryRecalculationPanel({ service, radiiJustChanged, onPublished }: Props) {
  const [progress, setProgress] = useState<RecalculationProgress | null>(null);
  const [preview, setPreview] = useState<RecalculationPreview | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const runningRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void service.getProgress().then((current) => {
      if (mounted.current) setProgress(current);
    });
    return () => {
      mounted.current = false;
    };
  }, [service]);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setWorking(true);
    setNotice(null);
    try {
      const result = await service.run({
        onProgress: (next) => {
          if (mounted.current) setProgress(next);
        },
      });
      if (result.status === 'published') {
        onPublished();
      }
      if (!mounted.current) return;
      if (result.status === 'publish_failed') {
        setNotice(`Publishing failed and nothing was changed (${result.error}). You can resume to try again.`);
      }
      if ('progress' in result && result.progress) setProgress(result.progress);
    } catch (caught) {
      if (mounted.current) {
        setNotice(caught instanceof Error ? caught.message : 'Recalculation failed.');
      }
    } finally {
      runningRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }, [onPublished, service]);

  // While paused behind a live attempt, poll gently; it resumes by itself once no run is open.
  const paused = progress?.displayStatus === 'paused';
  useEffect(() => {
    if (!paused || working) return undefined;
    const timer = setTimeout(() => {
      void run();
    }, PAUSED_RETRY_MS);
    return () => clearTimeout(timer);
  }, [paused, working, run, progress]);

  const openConfirmation = async () => {
    setNotice(null);
    setPreview(await service.preview());
  };

  const confirm = async () => {
    const started = await service.start();
    setPreview(null);
    if (!started.ok) {
      setNotice(started.reason);
      return;
    }
    setProgress(started.progress);
    if (started.alreadyExists) {
      setNotice('A recalculation is already in progress.');
    }
    void run();
  };

  const cancel = async () => {
    const result = await service.cancel();
    setProgress(result.progress);
  };

  const retryFailed = async () => {
    const started = await service.retryFailed();
    if (!started.ok) {
      setNotice(started.reason);
      return;
    }
    setProgress(started.progress);
    void run();
  };

  const active = progress && (progress.job.status === 'running' || progress.job.status === 'ready');

  return (
    <View style={styles.card} accessibilityLabel="History recalculation">
      <Text style={styles.cardTitle}>Recalculate history</Text>
      <Text style={styles.cardMeta}>
        {radiiJustChanged
          ? 'You changed place radii. Past runs keep their old times until you recalculate them with the current radii (optional).'
          : 'Re-time past runs from their saved GPS using the current place radii. Manual only; nothing changes until you confirm.'}
      </Text>

      {preview ? (
        <View>
          <Text style={styles.warningText}>{RECALCULATION_CONFIRM_WARNING}</Text>
          <Text style={styles.statusText}>
            {preview.candidateCount} run{preview.candidateCount === 1 ? '' : 's'} can be recalculated.
          </Text>
          <Text style={styles.mutedText}>
            {preview.preSkippedMissingPlace + preview.preSkippedNoTrace} completed run
            {preview.preSkippedMissingPlace + preview.preSkippedNoTrace === 1 ? '' : 's'} will be skipped up front (
            {preview.preSkippedMissingPlace} missing a place, {preview.preSkippedNoTrace} without a GPS trace).
          </Text>
          {preview.openAttempt ? (
            <Text style={styles.errorText}>Finish or cancel the current run before recalculating history.</Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={preview.openAttempt || preview.candidateCount === 0}
              onPress={() => void confirm()}
              style={[
                styles.button,
                styles.primaryButton,
                preview.openAttempt || preview.candidateCount === 0 ? styles.disabledButton : null,
              ]}
            >
              <Text style={styles.buttonText}>CONFIRM RECALCULATION</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPreview(null)}
              style={[styles.button, styles.secondaryButton]}
            >
              <Text style={styles.buttonText}>NOT NOW</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {progress ? <ProgressSummary progress={progress} /> : null}
      {notice ? <Text style={styles.warningText}>{notice}</Text> : null}

      <View style={styles.actions}>
        {!preview && !active ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void openConfirmation()}
            style={[styles.button, styles.primaryButton]}
          >
            <Text style={styles.buttonText}>RECALCULATE HISTORY</Text>
          </Pressable>
        ) : null}
        {active && !working ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void run()}
            style={[styles.button, styles.primaryButton]}
          >
            <Text style={styles.buttonText}>RESUME</Text>
          </Pressable>
        ) : null}
        {active ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void cancel()}
            style={[styles.button, styles.secondaryButton]}
          >
            <Text style={styles.buttonText}>CANCEL RECALCULATION</Text>
          </Pressable>
        ) : null}
        {progress?.canRetryFailed && !working ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void retryFailed()}
            style={[styles.button, styles.secondaryButton]}
          >
            <Text style={styles.buttonText}>RETRY FAILED ({progress.counts.errors})</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ProgressSummary({ progress }: { progress: RecalculationProgress }) {
  const { counts, job } = progress;
  const label =
    progress.displayStatus === 'paused'
      ? 'Paused while a run is open. It continues when no run is armed or active.'
      : progress.displayStatus === 'running'
        ? 'Recalculating... place edits are locked until this finishes or is cancelled.'
        : progress.displayStatus === 'ready'
          ? 'Ready to publish.'
          : progress.displayStatus === 'published'
            ? 'Finished. Results were applied in one step.'
            : 'Cancelled. No run was changed.';
  return (
    <View accessibilityLabel="Recalculation progress">
      <Text style={styles.statusText}>{label}</Text>
      {job.message ? <Text style={styles.warningText}>{job.message}</Text> : null}
      {job.status !== 'cancelled' ? (
        <>
          <Text style={styles.mutedText}>
            Processed {counts.processed} of {counts.candidates}
          </Text>
          <Text style={styles.mutedText}>
            Updated {counts.updated} · Unchanged {counts.unchanged} · Skipped {progress.skippedTotal} · Errors{' '}
            {counts.errors}
          </Text>
          {job.status === 'published' ? (
            <Text style={styles.mutedText}>
              Skipped runs kept their original times: {counts.skippedEndpointChanged} endpoint/geometry changed,{' '}
              {counts.skippedInsufficientGps} insufficient GPS, {progress.preSkipped} missing a place or GPS trace
              before starting. Updated runs now use the current radii.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
