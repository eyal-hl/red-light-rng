import type { TransportationMode } from './route';
import type { AttemptReconciliationStatus } from './attempt-reconciliation';

export type AttemptLifecycle = 'armed' | 'active' | 'completed' | 'cancelled' | 'abandoned' | 'ended';

export type AttemptValidity = 'pending' | 'valid' | 'unranked';

/**
 * `full` is an ordinary origin-place -> destination-place attempt (every attempt that existed
 * before #81). `partial` starts at a competitive checkpoint (DEC-016): it may only rank on
 * competitive segment boards and must never appear in full-route ranking, PB, median, statistics
 * or DNF accounting.
 */
export type AttemptKind = 'full' | 'partial';

export type AttemptLocalTimeSource = 'captured' | 'reconstructed';

export type AttemptLocalStartMetadata = {
  startedUtcOffsetMinutes: number | null;
  startedTimezoneId: string | null;
  startedLocalTimeSource: AttemptLocalTimeSource | null;
};

export const EMPTY_ATTEMPT_LOCAL_START: AttemptLocalStartMetadata = {
  startedUtcOffsetMinutes: null,
  startedTimezoneId: null,
  startedLocalTimeSource: null,
};

export type AttemptCheckpointCrossing = {
  id: string;
  attemptId: string;
  checkpointId: string;
  checkpointName: string;
  checkpointProgressMeters: number;
  crossedAtMs: number;
};

export type Attempt = {
  id: string;
  routeId: string | null;
  originPlaceId: string | null;
  destinationPlaceId: string | null;
  transportationMode: TransportationMode;
  sessionId: string;
  lifecycle: AttemptLifecycle;
  validity: AttemptValidity;
  armedAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  startedUtcOffsetMinutes: number | null;
  startedTimezoneId: string | null;
  startedLocalTimeSource: AttemptLocalTimeSource | null;
  resultAcknowledged: boolean;
  hiddenIncomplete?: boolean;
  crossings: AttemptCheckpointCrossing[];
  reconciliationStatus?: AttemptReconciliationStatus;
  reconciliationVersion?: number;
  /** Absent means `full` (legacy rows and every attempt created before partial starts existed). */
  kind?: AttemptKind;
  /** Partial attempts only: the competitive checkpoint the run started at. */
  startCheckpointId?: string | null;
  /** Partial attempts only: the competitive checkpoint configuration version the start refers to. */
  checkpointConfigVersion?: number | null;
};

export function attemptKind(attempt: Pick<Attempt, 'kind'>): AttemptKind {
  return attempt.kind === 'partial' ? 'partial' : 'full';
}

export function isFullAttempt(attempt: Pick<Attempt, 'kind'>): boolean {
  return attemptKind(attempt) === 'full';
}

export function isPartialAttempt(attempt: Pick<Attempt, 'kind'>): boolean {
  return attemptKind(attempt) === 'partial';
}

export function parseAttemptKind(value: string | null | undefined): AttemptKind {
  return value === 'partial' ? 'partial' : 'full';
}

export function isOpenAttempt(attempt: Attempt): boolean {
  return attempt.lifecycle === 'armed' || attempt.lifecycle === 'active';
}

export function officialTimeMs(attempt: Attempt): number | null {
  if (attempt.startedAtMs == null || attempt.finishedAtMs == null) {
    return null;
  }
  return Math.max(0, attempt.finishedAtMs - attempt.startedAtMs);
}

export function isOfficialAttempt(attempt: Attempt): boolean {
  return isFullAttempt(attempt) && attempt.lifecycle === 'completed' && attempt.validity === 'valid';
}

/**
 * Full-route competitive eligibility (rank, PB, median, statistics). Partial attempts are never
 * full-route competitive, whatever their lifecycle or validity (DEC-016).
 */
export function isJourneyCompetitive(attempt: Attempt): boolean {
  return (
    isFullAttempt(attempt) &&
    attempt.lifecycle === 'completed' &&
    attempt.validity === 'valid' &&
    attempt.originPlaceId != null &&
    attempt.destinationPlaceId != null &&
    attempt.startedAtMs != null &&
    attempt.finishedAtMs != null
  );
}

export type IncompleteAttemptLabel =
  | 'DID NOT START'
  | 'DID NOT FINISH'
  | 'PARTIAL DID NOT START'
  | 'PARTIAL DID NOT FINISH';

/** A partial DNF is a clearly labeled non-result, never a full-route DNF. */
export function incompleteAttemptLabel(
  attempt: Pick<Attempt, 'lifecycle' | 'startedAtMs'> & Pick<Partial<Attempt>, 'kind'>,
): IncompleteAttemptLabel | null {
  if (attempt.lifecycle !== 'ended') {
    return null;
  }
  const started = attempt.startedAtMs != null;
  if (isPartialAttempt(attempt)) {
    return started ? 'PARTIAL DID NOT FINISH' : 'PARTIAL DID NOT START';
  }
  return started ? 'DID NOT FINISH' : 'DID NOT START';
}

export function isHiddenIncomplete(attempt: Pick<Attempt, 'lifecycle' | 'hiddenIncomplete'>): boolean {
  return attempt.lifecycle === 'ended' && attempt.hiddenIncomplete === true;
}

export function canHideIncompleteAttempt(attempt: Pick<Attempt, 'lifecycle' | 'hiddenIncomplete'>): boolean {
  return attempt.lifecycle === 'ended' && attempt.hiddenIncomplete !== true;
}

export function canRestoreIncompleteAttempt(attempt: Pick<Attempt, 'lifecycle' | 'hiddenIncomplete'>): boolean {
  return isHiddenIncomplete(attempt);
}

export function hideIncompleteAttemptRecord(attempt: Attempt): Attempt | null {
  if (!canHideIncompleteAttempt(attempt)) {
    return null;
  }
  return {
    ...attempt,
    hiddenIncomplete: true,
    resultAcknowledged: true,
  };
}

export function restoreIncompleteAttemptRecord(attempt: Attempt): Attempt | null {
  if (!canRestoreIncompleteAttempt(attempt)) {
    return null;
  }
  return {
    ...attempt,
    hiddenIncomplete: false,
  };
}

export const HIDE_INCOMPLETE_TITLE = 'Hide this incomplete attempt?';
export const HIDE_INCOMPLETE_MESSAGE =
  'It will leave INCOMPLETE but stay on this device. You can restore it later from SHOW HIDDEN INCOMPLETE.';

export function parseAttemptLocalTimeSource(value: string | null | undefined): AttemptLocalTimeSource | null {
  if (value === 'captured' || value === 'reconstructed') {
    return value;
  }
  return null;
}
