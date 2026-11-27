import { MAX_ZONE_RADIUS_METERS, MIN_ZONE_RADIUS_METERS } from './course-layout';
import { haversineMeters, type LatLng } from './geo';
import type { JourneyPoolId } from './journey';
import type { Place } from './place';

/**
 * Competitive checkpoints (DEC-016, issue #81). A configuration is scoped to the directional
 * journey pool (origin place, destination place, mode). It is separate from the path-variant
 * analytics checkpoints in `route.ts` and never finishes a journey or changes official timing.
 *
 * Configurations are immutable and versioned: every create/edit/reorder/delete writes a new
 * version, so a derived result can always be matched against the definition it was computed with
 * and is recognised as stale once the current version moves on.
 */

export const MIN_COMPETITIVE_CHECKPOINT_RADIUS_METERS = MIN_ZONE_RADIUS_METERS;
export const MAX_COMPETITIVE_CHECKPOINT_RADIUS_METERS = MAX_ZONE_RADIUS_METERS;
export const DEFAULT_COMPETITIVE_CHECKPOINT_RADIUS_METERS = 30;
export const MAX_COMPETITIVE_CHECKPOINTS_PER_POOL = 8;

export type CompetitiveCheckpointPool = JourneyPoolId;

export type CompetitiveCheckpoint = {
  /** Stable across configuration versions so partial attempts and results can name a checkpoint. */
  id: string;
  name: string;
  center: LatLng;
  radiusMeters: number;
};

export type CompetitiveCheckpointConfigStatus = 'current' | 'superseded';

export type CompetitiveCheckpointConfig = {
  /** Unique id of this immutable version row. */
  id: string;
  pool: CompetitiveCheckpointPool;
  /** 1-based, monotonically increasing per pool. */
  version: number;
  status: CompetitiveCheckpointConfigStatus;
  createdAtMs: number;
  /** Ordered along the route from origin to destination. */
  checkpoints: CompetitiveCheckpoint[];
};

export type CompetitiveCheckpointDraft = CompetitiveCheckpoint;

export type CompetitiveCheckpointIssueCode =
  | 'too_many'
  | 'duplicate_id'
  | 'empty_name'
  | 'invalid_center'
  | 'radius_out_of_range'
  | 'overlaps_place'
  | 'overlaps_checkpoint';

export type CompetitiveCheckpointIssue = {
  code: CompetitiveCheckpointIssueCode;
  checkpointId: string | null;
  /** The Place or other checkpoint this one collides with, when applicable. */
  otherId: string | null;
  message: string;
};

export class CompetitiveCheckpointValidationError extends Error {
  readonly issues: CompetitiveCheckpointIssue[];

  constructor(issues: CompetitiveCheckpointIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'CompetitiveCheckpointValidationError';
    this.issues = issues;
  }
}

export const COMPETITIVE_CHECKPOINT_RADIUS_REASON = `Checkpoint radius must be between ${MIN_COMPETITIVE_CHECKPOINT_RADIUS_METERS} and ${MAX_COMPETITIVE_CHECKPOINT_RADIUS_METERS} m.`;
export const COMPETITIVE_CHECKPOINT_OPEN_ATTEMPT_REASON =
  'Finish or cancel the current run before changing checkpoints. Editing them now would change how that run is timed.';
export const COMPETITIVE_CHECKPOINT_RECALC_JOB_REASON =
  'A segment recalculation job exists. Finish or cancel it before changing checkpoints.';

export function isValidCompetitiveCheckpointRadius(radiusMeters: number): boolean {
  return (
    Number.isFinite(radiusMeters) &&
    radiusMeters >= MIN_COMPETITIVE_CHECKPOINT_RADIUS_METERS &&
    radiusMeters <= MAX_COMPETITIVE_CHECKPOINT_RADIUS_METERS
  );
}

/** The widest zone a Place can ever use (departure or arrival), for overlap checks. */
export function placeFootprintRadiusMeters(place: Pick<Place, 'departureRadiusMeters' | 'arrivalRadiusMeters'>): number {
  return Math.max(place.departureRadiusMeters, place.arrivalRadiusMeters);
}

/** Two circles overlap (or touch) when the centres are no further apart than the radii sum. */
export function zonesOverlap(
  a: { center: LatLng; radiusMeters: number },
  b: { center: LatLng; radiusMeters: number },
): boolean {
  return haversineMeters(a.center, b.center) <= a.radiusMeters + b.radiusMeters;
}

function validLatLng(point: LatLng): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

/**
 * Save-time validation of a complete ordered checkpoint list for one pool. Returns every issue;
 * an empty list means the configuration may be saved. Archived Places are ignored; every ACTIVE
 * Place (origin, destination or any other) must stay clear of every checkpoint circle, and no two
 * checkpoints of the pool may overlap, so a crossing can never be confused with a Place event.
 */
export function validateCompetitiveCheckpoints(
  checkpoints: readonly CompetitiveCheckpointDraft[],
  places: readonly Pick<Place, 'id' | 'name' | 'center' | 'departureRadiusMeters' | 'arrivalRadiusMeters' | 'status'>[],
): CompetitiveCheckpointIssue[] {
  const issues: CompetitiveCheckpointIssue[] = [];
  if (checkpoints.length > MAX_COMPETITIVE_CHECKPOINTS_PER_POOL) {
    issues.push({
      code: 'too_many',
      checkpointId: null,
      otherId: null,
      message: `A journey can have at most ${MAX_COMPETITIVE_CHECKPOINTS_PER_POOL} checkpoints.`,
    });
  }
  const seen = new Set<string>();
  for (const checkpoint of checkpoints) {
    const label = checkpoint.name.trim() || checkpoint.id;
    if (seen.has(checkpoint.id)) {
      issues.push({
        code: 'duplicate_id',
        checkpointId: checkpoint.id,
        otherId: null,
        message: `Checkpoint id ${checkpoint.id} is used twice.`,
      });
    }
    seen.add(checkpoint.id);
    if (checkpoint.name.trim().length === 0) {
      issues.push({
        code: 'empty_name',
        checkpointId: checkpoint.id,
        otherId: null,
        message: 'Every checkpoint needs a name.',
      });
    }
    if (!validLatLng(checkpoint.center)) {
      issues.push({
        code: 'invalid_center',
        checkpointId: checkpoint.id,
        otherId: null,
        message: `Checkpoint ${label} has an invalid location.`,
      });
      continue;
    }
    if (!isValidCompetitiveCheckpointRadius(checkpoint.radiusMeters)) {
      issues.push({
        code: 'radius_out_of_range',
        checkpointId: checkpoint.id,
        otherId: null,
        message: COMPETITIVE_CHECKPOINT_RADIUS_REASON,
      });
      continue;
    }
    for (const place of places) {
      if (place.status !== 'active') {
        continue;
      }
      if (
        zonesOverlap(
          { center: checkpoint.center, radiusMeters: checkpoint.radiusMeters },
          { center: place.center, radiusMeters: placeFootprintRadiusMeters(place) },
        )
      ) {
        issues.push({
          code: 'overlaps_place',
          checkpointId: checkpoint.id,
          otherId: place.id,
          message: `Checkpoint ${label} overlaps the place ${place.name}. Move it or shrink its radius.`,
        });
      }
    }
  }
  for (let i = 0; i < checkpoints.length; i += 1) {
    for (let j = i + 1; j < checkpoints.length; j += 1) {
      const a = checkpoints[i]!;
      const b = checkpoints[j]!;
      if (
        validLatLng(a.center) &&
        validLatLng(b.center) &&
        isValidCompetitiveCheckpointRadius(a.radiusMeters) &&
        isValidCompetitiveCheckpointRadius(b.radiusMeters) &&
        zonesOverlap(
          { center: a.center, radiusMeters: a.radiusMeters },
          { center: b.center, radiusMeters: b.radiusMeters },
        )
      ) {
        issues.push({
          code: 'overlaps_checkpoint',
          checkpointId: b.id,
          otherId: a.id,
          message: `Checkpoint ${b.name.trim() || b.id} overlaps checkpoint ${a.name.trim() || a.id}.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Edit lock for later stages (editor / recalculation): a configuration may not change while a run
 * is armed or active, or while any recalculation job exists. Pure so every caller applies the same
 * rule; returns the user-facing reason or null when editing is allowed.
 */
export function competitiveCheckpointEditBlockReason(state: {
  openAttempt: boolean;
  recalculationJobExists: boolean;
}): string | null {
  if (state.openAttempt) {
    return COMPETITIVE_CHECKPOINT_OPEN_ATTEMPT_REASON;
  }
  if (state.recalculationJobExists) {
    return COMPETITIVE_CHECKPOINT_RECALC_JOB_REASON;
  }
  return null;
}

export function cloneCompetitiveCheckpoint(checkpoint: CompetitiveCheckpoint): CompetitiveCheckpoint {
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    center: { latitude: checkpoint.center.latitude, longitude: checkpoint.center.longitude },
    radiusMeters: checkpoint.radiusMeters,
  };
}

export function cloneCompetitiveCheckpointConfig(
  config: CompetitiveCheckpointConfig,
): CompetitiveCheckpointConfig {
  return {
    id: config.id,
    pool: { ...config.pool },
    version: config.version,
    status: config.status,
    createdAtMs: config.createdAtMs,
    checkpoints: config.checkpoints.map(cloneCompetitiveCheckpoint),
  };
}
