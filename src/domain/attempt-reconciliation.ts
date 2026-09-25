import { isOpenAttempt, type Attempt } from './attempt';

export type AttemptReconciliationStatus = 'pending' | 'reconciled' | 'failed';

export const CURRENT_ATTEMPT_RECONCILIATION_VERSION = 1;

export function parseAttemptReconciliationStatus(
  value: string | null | undefined,
): AttemptReconciliationStatus {
  if (value === 'reconciled' || value === 'failed') {
    return value;
  }
  return 'pending';
}

export function attemptReconciliationStatus(
  attempt: Pick<Attempt, 'reconciliationStatus'>,
): AttemptReconciliationStatus {
  return parseAttemptReconciliationStatus(attempt.reconciliationStatus);
}

export function attemptReconciliationVersion(attempt: Pick<Attempt, 'reconciliationVersion'>): number {
  return attempt.reconciliationVersion ?? 0;
}

export function withAttemptReconciliation(
  attempt: Attempt,
  status: AttemptReconciliationStatus,
  version: number = CURRENT_ATTEMPT_RECONCILIATION_VERSION,
): Attempt {
  return {
    ...attempt,
    reconciliationStatus: status,
    reconciliationVersion: version,
  };
}

export function attemptNeedsReconciliation(
  attempt: Pick<Attempt, 'lifecycle' | 'reconciliationStatus' | 'reconciliationVersion'>,
  currentVersion: number = CURRENT_ATTEMPT_RECONCILIATION_VERSION,
): boolean {
  if (isOpenAttempt(attempt as Attempt)) {
    return false;
  }
  const status = parseAttemptReconciliationStatus(attempt.reconciliationStatus);
  if (status === 'pending' || status === 'failed') {
    return true;
  }
  return attemptReconciliationVersion(attempt) !== currentVersion;
}

export type AttemptReconciliationTiming = {
  attemptId: string;
  durationMs: number;
  listSamplesCalls: number;
  status: AttemptReconciliationStatus;
  error: string | null;
};

export type AttemptReconciliationReport = {
  selectedAttemptIds: string[];
  selectedCount: number;
  listSamplesCalls: number;
  perAttempt: AttemptReconciliationTiming[];
  totalDurationMs: number;
};

export function emptyAttemptReconciliationReport(): AttemptReconciliationReport {
  return {
    selectedAttemptIds: [],
    selectedCount: 0,
    listSamplesCalls: 0,
    perAttempt: [],
    totalDurationMs: 0,
  };
}
