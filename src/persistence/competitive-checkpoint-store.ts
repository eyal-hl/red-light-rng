import type {
  CompetitiveCheckpoint,
  CompetitiveCheckpointConfig,
  CompetitiveCheckpointPool,
} from '../domain/competitive-checkpoint';
import type { Place } from '../domain/place';
import type { AttemptSegmentResult } from '../domain/segment-derivation';

export type SaveCompetitiveCheckpointConfigInput = {
  pool: CompetitiveCheckpointPool;
  /** The complete ordered list for the new version (empty = no competitive checkpoints). */
  checkpoints: CompetitiveCheckpoint[];
  /** Places used for the save-time overlap check; archived Places are ignored. */
  places: readonly Place[];
  nowMs: number;
  /** Test seam; defaults to `createId`. */
  createConfigId?: () => string;
};

export type SegmentResultBatchItem = {
  attemptId: string;
  configVersion: number;
  results: AttemptSegmentResult[];
};

/**
 * Competitive checkpoint configurations (immutable, versioned per directional journey pool) and the
 * derived per-attempt segment results (DEC-016). Segment results are DERIVED data only: nothing
 * here touches an attempt's official timing. Editing locks (open attempt, recalculation job) are
 * enforced by the caller via `competitiveCheckpointEditBlockReason`, like the Place radius lock.
 */
export interface CompetitiveCheckpointStore {
  getCurrentConfig(pool: CompetitiveCheckpointPool): Promise<CompetitiveCheckpointConfig | null>;
  getConfig(pool: CompetitiveCheckpointPool, version: number): Promise<CompetitiveCheckpointConfig | null>;
  /** Every version of a pool, oldest first (version history; superseded versions stay readable). */
  listConfigs(pool: CompetitiveCheckpointPool): Promise<CompetitiveCheckpointConfig[]>;
  /**
   * Validates (radius 8-250 m, no overlap with active Places or other checkpoints) and writes a NEW
   * version, superseding the current one. Saving a list identical to the current version is a no-op
   * that returns the current configuration, so results are not made stale needlessly. Throws
   * `CompetitiveCheckpointValidationError` and writes nothing when invalid.
   */
  saveConfig(input: SaveCompetitiveCheckpointConfigInput): Promise<CompetitiveCheckpointConfig>;

  /** Atomically replaces the results of each (attempt, configVersion) in the batch. */
  replaceSegmentResults(batch: SegmentResultBatchItem[]): Promise<void>;
  listSegmentResults(attemptId: string): Promise<AttemptSegmentResult[]>;
  /** Results of every attempt in the pool (any kind) computed for exactly `configVersion`. */
  listSegmentResultsForPool(
    pool: CompetitiveCheckpointPool,
    configVersion: number,
  ): Promise<AttemptSegmentResult[]>;
  /** Removes results of the pool computed for any configuration version other than `keepVersion`. */
  pruneStaleSegmentResults(pool: CompetitiveCheckpointPool, keepVersion: number): Promise<number>;
}
