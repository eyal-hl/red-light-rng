import type { LatLng } from './geo';
import { isMovementDisplayable, type MovementBreakdown } from './movement-analysis';
import {
  formatWaitComparisonDelta,
  formatWaitComparisonLocation,
  MIN_DISPLAY_WAIT_COMPARISON_ABS_MS,
  WAIT_COMPARISON_LOCATION_RADIUS_METERS,
  type WaitComparison,
  type WaitComparisonLocationEntry,
} from './wait-comparison';

/**
 * Post-run explanation version identity. Results are derived on read from
 * existing journey/movement/wait analysis; this string exists so a later cache
 * cannot mix algorithm revisions.
 */
export const RESULT_EXPLANATION_VERSION = 'explanation-v1';

/**
 * Compact UI omits standalone additive rows and location details whose
 * absolute delta is below this. Reuses the wait-comparison display threshold
 * rather than introducing a second product cutoff.
 */
export const MIN_EXPLANATION_ABS_MS = MIN_DISPLAY_WAIT_COMPARISON_ABS_MS;

/**
 * Additive remainder within this many milliseconds is treated as reconciled
 * and omitted from display. Whole-second copy would otherwise show a leftover
 * that is only coverage/rounding noise.
 */
export const EXPLANATION_RECONCILE_TOLERANCE_MS = 1_000;

/** Ranked display keeps at most this many rows, including waiting-location details. */
export const MAX_EXPLANATION_ITEMS = 5;

/** Typical additive skeleton size: waiting, moving, remainder. */
export const TARGET_EXPLANATION_ITEMS = 3;

export type ResultExplanationAvailability = 'no_comparison_target' | 'headline_only' | 'additive';

export type ExplanationRowKind = 'waiting_total' | 'moving_total' | 'unexplained_remainder' | 'waiting_location';

export type ExplanationRowRole = 'additive' | 'detail';

export type ExplanationSource = 'movement_totals' | 'wait_comparison' | 'remainder';

export type ExplanationConfidence = 'trustworthy' | 'partial';

export type ExplanationRow = {
  id: string;
  kind: ExplanationRowKind;
  role: ExplanationRowRole;
  parentId: string | null;
  deltaMs: number;
  source: ExplanationSource;
  confidence: ExplanationConfidence;
  label: string;
  progressMeters: number | null;
  coordinate: LatLng | null;
  waitLocationId: string | null;
};

export type ResultExplanationAdditive = {
  waitingDeltaMs: number;
  movingDeltaMs: number;
  remainderMs: number;
  currentWaitingMs: number;
  referenceWaitingMs: number;
  currentMovingMs: number;
  referenceMovingMs: number;
  currentUnknownMs: number;
  referenceUnknownMs: number;
  reconciled: boolean;
};

export type ResultExplanation = {
  analysisVersion: string;
  availability: ResultExplanationAvailability;
  comparisonAttemptId: string | null;
  headlineDeltaMs: number | null;
  pathSpecificAvailable: boolean;
  additive: ResultExplanationAdditive | null;
  rows: ExplanationRow[];
};

const WAITING_TOTAL_ID = 'explanation:waiting_total';
const MOVING_TOTAL_ID = 'explanation:moving_total';
const REMAINDER_ID = 'explanation:remainder';

export function emptyResultExplanation(input: {
  availability: ResultExplanationAvailability;
  comparisonAttemptId?: string | null;
  headlineDeltaMs?: number | null;
  pathSpecificAvailable?: boolean;
}): ResultExplanation {
  return {
    analysisVersion: RESULT_EXPLANATION_VERSION,
    availability: input.availability,
    comparisonAttemptId: input.comparisonAttemptId ?? null,
    headlineDeltaMs: input.headlineDeltaMs ?? null,
    pathSpecificAvailable: input.pathSpecificAvailable ?? false,
    additive: null,
    rows: [],
  };
}

/**
 * Explain the official journey headline delta using movement totals versus the
 * same comparison attempt, plus path-specific wait-location details when that
 * pair shares compatible path-variant semantics.
 *
 * Ghost/progress curves are intentionally not a cause source: occupancy at a
 * wait is the same stop as waiting analysis, unique-first increasing-flank
 * elapsed times can hide stop losses, and the ghost finish-trigger delta
 * restates the official delta.
 */
export function explainOfficialDelta(input: {
  comparisonAttemptId: string | null;
  headlineDeltaMs: number | null;
  currentMovement: MovementBreakdown | null;
  referenceMovement: MovementBreakdown | null;
  waitComparison: WaitComparison | null;
}): ResultExplanation {
  if (input.comparisonAttemptId == null || input.headlineDeltaMs == null) {
    return emptyResultExplanation({
      availability: 'no_comparison_target',
      comparisonAttemptId: input.comparisonAttemptId,
      headlineDeltaMs: input.headlineDeltaMs,
    });
  }

  const pathSpecificAvailable =
    input.waitComparison?.available === true &&
    input.waitComparison.comparisonAttemptId === input.comparisonAttemptId;

  const currentDisplayable = input.currentMovement != null && isMovementDisplayable(input.currentMovement);
  const referenceDisplayable =
    input.referenceMovement != null && isMovementDisplayable(input.referenceMovement);
  if (!currentDisplayable || !referenceDisplayable || !input.currentMovement || !input.referenceMovement) {
    return emptyResultExplanation({
      availability: 'headline_only',
      comparisonAttemptId: input.comparisonAttemptId,
      headlineDeltaMs: input.headlineDeltaMs,
      pathSpecificAvailable: false,
    });
  }

  const current = input.currentMovement;
  const reference = input.referenceMovement;
  const waitingDeltaMs = current.waitingMs - reference.waitingMs;
  const movingDeltaMs = current.movingMs - reference.movingMs;
  const remainderMs = input.headlineDeltaMs - waitingDeltaMs - movingDeltaMs;
  const reconciled = Math.abs(remainderMs) <= EXPLANATION_RECONCILE_TOLERANCE_MS;
  const confidence: ExplanationConfidence =
    current.trust === 'complete' && reference.trust === 'complete' ? 'trustworthy' : 'partial';

  const additive: ResultExplanationAdditive = {
    waitingDeltaMs,
    movingDeltaMs,
    remainderMs,
    currentWaitingMs: current.waitingMs,
    referenceWaitingMs: reference.waitingMs,
    currentMovingMs: current.movingMs,
    referenceMovingMs: reference.movingMs,
    currentUnknownMs: current.unknownMs,
    referenceUnknownMs: reference.unknownMs,
    reconciled,
  };

  const locationDetails = pathSpecificAvailable
    ? waitingLocationDetails(input.waitComparison!, WAITING_TOTAL_ID, confidence)
    : [];
  const showWaiting = Math.abs(waitingDeltaMs) >= MIN_EXPLANATION_ABS_MS || locationDetails.length > 0;
  const showMoving = Math.abs(movingDeltaMs) >= MIN_EXPLANATION_ABS_MS;
  const foldedRemainderMs =
    remainderMs + (showWaiting ? 0 : waitingDeltaMs) + (showMoving ? 0 : movingDeltaMs);
  const showRemainder = Math.abs(foldedRemainderMs) > EXPLANATION_RECONCILE_TOLERANCE_MS;

  const additiveRows: ExplanationRow[] = [];
  if (showWaiting) {
    additiveRows.push(
      makeRow({
        id: WAITING_TOTAL_ID,
        kind: 'waiting_total',
        role: 'additive',
        parentId: null,
        deltaMs: waitingDeltaMs,
        source: 'movement_totals',
        confidence,
        label: waitingTotalLabel(waitingDeltaMs),
        progressMeters: null,
        coordinate: null,
        waitLocationId: null,
      }),
    );
  }
  if (showMoving) {
    additiveRows.push(
      makeRow({
        id: MOVING_TOTAL_ID,
        kind: 'moving_total',
        role: 'additive',
        parentId: null,
        deltaMs: movingDeltaMs,
        source: 'movement_totals',
        confidence,
        label: movingTotalLabel(movingDeltaMs),
        progressMeters: null,
        coordinate: null,
        waitLocationId: null,
      }),
    );
  }
  if (showRemainder) {
    additiveRows.push(
      makeRow({
        id: REMAINDER_ID,
        kind: 'unexplained_remainder',
        role: 'additive',
        parentId: null,
        deltaMs: foldedRemainderMs,
        source: 'remainder',
        confidence: reconciled && showWaiting && showMoving ? 'trustworthy' : 'partial',
        label: 'unexplained / uncovered',
        progressMeters: null,
        coordinate: null,
        waitLocationId: null,
      }),
    );
  }

  const childSlots = Math.max(0, MAX_EXPLANATION_ITEMS - additiveRows.length);
  const shownDetails = locationDetails.slice(0, childSlots);
  const rows = interleaveWaitingDetails(additiveRows, shownDetails);

  return {
    analysisVersion: RESULT_EXPLANATION_VERSION,
    availability: 'additive',
    comparisonAttemptId: input.comparisonAttemptId,
    headlineDeltaMs: input.headlineDeltaMs,
    pathSpecificAvailable,
    additive,
    rows,
  };
}

export function formatExplanationDelta(deltaMs: number): string {
  return formatWaitComparisonDelta(deltaMs);
}

export function additiveDisplayedSumMs(rows: ExplanationRow[]): number {
  return rows.filter((row) => row.role === 'additive').reduce((sum, row) => sum + row.deltaMs, 0);
}

/**
 * Progress that waiting comparison already attributed. Ghost occupancy at these
 * locations is the same stop and must not become a moving-section cause.
 */
export function isProgressWaitAttributed(
  progressMeters: number,
  waitLocations: Pick<WaitComparisonLocationEntry, 'progressMeters'>[],
  radiusMeters: number = WAIT_COMPARISON_LOCATION_RADIUS_METERS,
): boolean {
  return waitLocations.some(
    (location) => Math.abs(location.progressMeters - progressMeters) <= radiusMeters,
  );
}

function waitingLocationDetails(
  comparison: WaitComparison,
  parentId: string,
  confidence: ExplanationConfidence,
): ExplanationRow[] {
  const ranked = [...comparison.displayedLocations].sort(compareLocationDetailOrder);
  return ranked.map((location) =>
    makeRow({
      id: `explanation:waiting_location:${location.id}`,
      kind: 'waiting_location',
      role: 'detail',
      parentId,
      deltaMs: location.deltaMs,
      source: 'wait_comparison',
      confidence,
      label: formatWaitComparisonLocation(location),
      progressMeters: location.progressMeters,
      coordinate: location.coordinate,
      waitLocationId: location.id,
    }),
  );
}

function compareLocationDetailOrder(a: WaitComparisonLocationEntry, b: WaitComparisonLocationEntry): number {
  const impact = Math.abs(b.deltaMs) - Math.abs(a.deltaMs);
  if (impact !== 0) {
    return impact;
  }
  if (a.progressMeters !== b.progressMeters) {
    return a.progressMeters - b.progressMeters;
  }
  return a.id.localeCompare(b.id);
}

function interleaveWaitingDetails(additiveRows: ExplanationRow[], details: ExplanationRow[]): ExplanationRow[] {
  const rows: ExplanationRow[] = [];
  for (const row of additiveRows) {
    rows.push(row);
    if (row.id === WAITING_TOTAL_ID) {
      rows.push(...details);
    }
  }
  return rows;
}

function waitingTotalLabel(deltaMs: number): string {
  if (deltaMs > 0) {
    return 'more waiting';
  }
  if (deltaMs < 0) {
    return 'less waiting';
  }
  return 'waiting';
}

function movingTotalLabel(deltaMs: number): string {
  if (deltaMs > 0) {
    return 'slower moving time';
  }
  if (deltaMs < 0) {
    return 'faster moving time';
  }
  return 'moving time';
}

function makeRow(row: ExplanationRow): ExplanationRow {
  return row;
}
