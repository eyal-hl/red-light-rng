import {
  EMPTY_ATTEMPT_LOCAL_START,
  type Attempt,
  type AttemptLocalStartMetadata,
  type AttemptLocalTimeSource,
} from './attempt';

export const DEPARTURE_BUCKET_MINUTES = 60;

export type LocalWallClock = {
  weekday: number;
  minutesSinceMidnight: number;
  hourBucket: number;
};

function currentTimeZoneId(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function utcOffsetMinutesAt(utcMs: number): number {
  return 0 - new Date(utcMs).getTimezoneOffset();
}

export function captureAttemptLocalStart(
  startedAtMs: number,
  source: AttemptLocalTimeSource = 'captured',
): AttemptLocalStartMetadata {
  return {
    startedUtcOffsetMinutes: utcOffsetMinutesAt(startedAtMs),
    startedTimezoneId: currentTimeZoneId(),
    startedLocalTimeSource: source,
  };
}

export function reconstructAttemptLocalStart(startedAtMs: number): AttemptLocalStartMetadata {
  return captureAttemptLocalStart(startedAtMs, 'reconstructed');
}

export function attachAttemptLocalStart(previous: Attempt, next: Attempt): Attempt {
  if (next.startedAtMs == null) {
    return { ...next, ...EMPTY_ATTEMPT_LOCAL_START };
  }
  if (
    previous.startedAtMs === next.startedAtMs &&
    previous.startedUtcOffsetMinutes != null &&
    previous.startedLocalTimeSource != null
  ) {
    return {
      ...next,
      startedUtcOffsetMinutes: previous.startedUtcOffsetMinutes,
      startedTimezoneId: previous.startedTimezoneId,
      startedLocalTimeSource: previous.startedLocalTimeSource,
    };
  }
  return { ...next, ...captureAttemptLocalStart(next.startedAtMs) };
}

export function localWallClockFromOffset(
  utcMs: number,
  utcOffsetMinutes: number,
  bucketMinutes: number = DEPARTURE_BUCKET_MINUTES,
): LocalWallClock {
  const shifted = new Date(utcMs + utcOffsetMinutes * 60_000);
  const minutesSinceMidnight =
    shifted.getUTCHours() * 60 +
    shifted.getUTCMinutes() +
    shifted.getUTCSeconds() / 60 +
    shifted.getUTCMilliseconds() / 60_000;
  return {
    weekday: shifted.getUTCDay(),
    minutesSinceMidnight,
    hourBucket: Math.floor(minutesSinceMidnight / bucketMinutes),
  };
}

export function attemptDepartureWallClock(attempt: Pick<Attempt, 'startedAtMs' | 'startedUtcOffsetMinutes'>): LocalWallClock | null {
  if (attempt.startedAtMs == null || attempt.startedUtcOffsetMinutes == null) {
    return null;
  }
  return localWallClockFromOffset(attempt.startedAtMs, attempt.startedUtcOffsetMinutes);
}
