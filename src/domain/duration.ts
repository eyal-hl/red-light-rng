import type { CaptureOutcome } from './session';

export function formatTimeOfDay(ms: number): string {
  const date = new Date(ms);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatSignedDelta(ms: number): string {
  if (ms === 0) {
    return formatElapsed(0);
  }
  const sign = ms < 0 ? '-' : '+';
  return `${sign}${formatElapsed(Math.abs(ms))}`;
}

export function formatOrdinal(value: number): string {
  const remainderHundred = value % 100;
  if (remainderHundred >= 11 && remainderHundred <= 13) {
    return `${value}th`;
  }
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}

export function formatRankAmong(rank: number, total: number): string {
  return `${formatOrdinal(rank)} fastest of ${total}`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) {
    return '0%';
  }
  return `${Math.round(Math.max(0, ratio) * 100)}%`;
}

export function formatAttemptStamp(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day} ${formatTimeOfDay(ms)}`;
}

export function recordingElapsedMs(startedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - startedAtMs);
}

export function reviewDurationMs(session: {
  captureOutcome: CaptureOutcome;
  startedAtMs: number;
  stoppedAtMs: number | null;
  lastSampleAtMs: number | null;
}): number | null {
  if (session.captureOutcome === 'finished' && session.stoppedAtMs != null) {
    return Math.max(0, session.stoppedAtMs - session.startedAtMs);
  }
  if (session.captureOutcome === 'interrupted' && session.lastSampleAtMs != null) {
    return Math.max(0, session.lastSampleAtMs - session.startedAtMs);
  }
  return null;
}
