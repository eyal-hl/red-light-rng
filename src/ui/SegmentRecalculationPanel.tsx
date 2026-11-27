import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { CompetitiveCheckpointPool } from '../domain/competitive-checkpoint';
import { SEGMENT_RECALCULATION_CONFIRM_WARNING } from '../domain/history-recalculation';
import type {
  CompetitiveSegmentsService,
  SegmentPoolStatus,
  SegmentRecalculationPreview,
  SegmentRecalculationService,
} from '../product/competitive-segments';
import { segmentRecalcSummary } from '../product/competitive-segments-view';
import type { RecalculationProgress } from '../product/history-recalculation';
import { styles } from './styles';

const PAUSED_RETRY_MS = 3_000;

type Props = {
  service: SegmentRecalculationService;
  segments: CompetitiveSegmentsService;
  pool: CompetitiveCheckpointPool;
  /** Called after a job was published (or cancelled) so boards and status can refresh. */
  onChanged: () => void;
};

/**
 * Manual "Recalculate segments" action (#81). Nothing here runs without an explicit press: not on
 * save, upgrade, restore or browsing. A job found on relaunch is only offered for resuming. All work
 * happens in bounded background chunks, so navigation stays responsive.
 */
export function SegmentRecalculationPanel({ service, segments, pool, onChanged }: Props) {
  const [progress, setProgress] = useState<RecalculationProgress | null>(null);
  const [status, setStatus] = useState<SegmentPoolStatus | null>(null);
  const [preview, setPreview] = useState<SegmentRecalculationPreview | null>(null);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const runningRef = useRef(false);

  const refresh = useCallback(async () => {
    const [current, nextStatus] = await Promise.all([service.getProgress(), segments.getPoolStatus(pool)]);
    if (mounted.current) {
      setProgress(current);
      setStatus(nextStatus);
    }
  }, [pool, segments, service]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

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
        shouldStop: () => !mounted.current,
      });
      if (result.status === 'published') {
        onChanged();
      } else if (result.status === 'cancelled') {
        setNotice(result.progress.job.message);
      } else if (result.status === 'publish_failed') {
        setNotice(`Publishing failed and nothing was changed (${result.error}). You can resume to try again.`);
      }
      if ('progress' in result && result.progress && mounted.current) setProgress(result.progress);
      if (mounted.current) setStatus(await segments.getPoolStatus(pool));
    } catch (caught) {
      if (mounted.current) setNotice(caught instanceof Error ? caught.message : 'Segment recalculation failed.');
    } finally {
      runningRef.current = false;
      if (mounted.current) setWorking(false);
    }
  }, [onChanged, pool, segments, service]);

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
    setPreview(await service.preview(pool));
  };

  const confirm = async () => {
    const started = await service.start({ pool });
    setPreview(null);
    if (!started.ok) {
      setNotice(started.reason);
      return;
    }
    setProgress(started.progress);
    if (started.alreadyExists) setNotice('A segment recalculation is already in progress.');
    void run();
  };

  const cancel = async () => {
    const result = await service.cancel();
    setProgress(result.progress);
    await refresh();
    onChanged();
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
  const summary = status ? segmentRecalcSummary(status) : null;
  const otherJob = status?.blockingJobKind === 'history';

  return (
    <View style={styles.card} accessibilityLabel="Segment recalculation">
      <Text style={styles.cardTitle}>Recalculate segments</Text>
      <Text style={styles.cardMeta}>
        {summary?.headline ?? 'Checking segment results…'} Manual only; nothing changes until you confirm.
      </Text>
      {summary?.staleLabel ? <Text style={styles.warningText}>{summary.staleLabel}</Text> : null}

      {preview ? (
        <View>
          <Text style={styles.warningText}>{SEGMENT_RECALCULATION_CONFIRM_WARNING}</Text>
          <Text style={styles.statusText}>
            {preview.candidateCount} run{preview.candidateCount === 1 ? '' : 's'} will be processed.
          </Text>
          {preview.openAttempt ? (
            <Text style={styles.errorText}>Finish or cancel the current run before recalculating segments.</Text>
          ) : null}
          {preview.blockingJobKind === 'history' ? (
            <Text style={styles.errorText}>A history recalculation is in progress. Finish or cancel it first.</Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={preview.openAttempt || preview.candidateCount === 0 || preview.blockingJobKind === 'history'}
              onPress={() => void confirm()}
              style={[
                styles.button,
                styles.primaryButton,
                preview.openAttempt || preview.candidateCount === 0 || preview.blockingJobKind === 'history'
                  ? styles.disabledButton
                  : null,
              ]}
            >
              <Text style={styles.buttonText}>CONFIRM RECALCULATION</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPreview(null)} style={[styles.button, styles.secondaryButton]}>
              <Text style={styles.buttonText}>NOT NOW</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {progress ? <SegmentProgressSummary progress={progress} /> : null}
      {notice ? <Text style={styles.warningText}>{notice}</Text> : null}

      <View style={styles.actions}>
        {!preview && !active && summary?.offerRecalculate && !otherJob ? (
          <Pressable accessibilityRole="button" onPress={() => void openConfirmation()} style={[styles.button, styles.primaryButton]}>
            <Text style={styles.buttonText}>RECALCULATE SEGMENTS</Text>
          </Pressable>
        ) : null}
        {active && !working ? (
          <Pressable accessibilityRole="button" onPress={() => void run()} style={[styles.button, styles.primaryButton]}>
            <Text style={styles.buttonText}>RESUME</Text>
          </Pressable>
        ) : null}
        {active ? (
          <Pressable accessibilityRole="button" onPress={() => void cancel()} style={[styles.button, styles.secondaryButton]}>
            <Text style={styles.buttonText}>CANCEL RECALCULATION</Text>
          </Pressable>
        ) : null}
        {progress?.canRetryFailed && !working ? (
          <Pressable accessibilityRole="button" onPress={() => void retryFailed()} style={[styles.button, styles.secondaryButton]}>
            <Text style={styles.buttonText}>RETRY FAILED ({progress.counts.errors})</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function SegmentProgressSummary({ progress }: { progress: RecalculationProgress }) {
  const { counts, job } = progress;
  const label =
    progress.displayStatus === 'paused'
      ? 'Paused while a run is open. It continues when no run is armed or active.'
      : progress.displayStatus === 'running'
        ? 'Recalculating… checkpoint and place edits are locked until this finishes or is cancelled.'
        : progress.displayStatus === 'ready'
          ? 'Ready to publish.'
          : progress.displayStatus === 'published'
            ? 'Finished. Segment results were applied in one step.'
            : 'Cancelled. No results were changed.';
  return (
    <View accessibilityLabel="Segment recalculation progress">
      <Text style={styles.statusText}>{label}</Text>
      {job.message ? <Text style={styles.warningText}>{job.message}</Text> : null}
      {job.status !== 'cancelled' ? (
        <Text style={styles.mutedText}>
          Processed {counts.processed} of {counts.candidates} · Updated {counts.updated} · Skipped {progress.skippedTotal} ·
          Errors {counts.errors}
        </Text>
      ) : null}
    </View>
  );
}
