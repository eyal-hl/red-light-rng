import {
  cloneCompetitiveCheckpointConfig,
  CompetitiveCheckpointValidationError,
  validateCompetitiveCheckpoints,
  type CompetitiveCheckpointConfig,
  type CompetitiveCheckpointPool,
} from '../domain/competitive-checkpoint';
import { createId } from '../domain/ids';
import { journeyPoolKey } from '../domain/journey';
import type { AttemptSegmentResult } from '../domain/segment-derivation';
import type {
  CompetitiveCheckpointStore,
  SaveCompetitiveCheckpointConfigInput,
  SegmentResultBatchItem,
} from './competitive-checkpoint-store';
import type { MemoryAttemptStore } from './memory-attempt-store';
import { sameCheckpointLists } from './sqlite-competitive-checkpoint-store';

/** In-memory twin of `SqliteCompetitiveCheckpointStore`, same observable behaviour (parity tests). */
export class MemoryCompetitiveCheckpointStore implements CompetitiveCheckpointStore {
  private readonly configs = new Map<string, CompetitiveCheckpointConfig[]>();
  private results: AttemptSegmentResult[] = [];

  constructor(private readonly attempts?: MemoryAttemptStore) {
    attempts?.onAttemptDeleted((attemptId) => {
      this.results = this.results.filter((result) => result.attemptId !== attemptId);
    });
  }

  private poolConfigs(pool: CompetitiveCheckpointPool): CompetitiveCheckpointConfig[] {
    return this.configs.get(journeyPoolKey(pool)) ?? [];
  }

  async getCurrentConfig(pool: CompetitiveCheckpointPool) {
    const current = this.poolConfigs(pool).find((config) => config.status === 'current');
    return current ? cloneCompetitiveCheckpointConfig(current) : null;
  }

  async getConfig(pool: CompetitiveCheckpointPool, version: number) {
    const found = this.poolConfigs(pool).find((config) => config.version === version);
    return found ? cloneCompetitiveCheckpointConfig(found) : null;
  }

  async listConfigs(pool: CompetitiveCheckpointPool) {
    return [...this.poolConfigs(pool)]
      .sort((a, b) => a.version - b.version)
      .map(cloneCompetitiveCheckpointConfig);
  }

  async saveConfig(input: SaveCompetitiveCheckpointConfigInput): Promise<CompetitiveCheckpointConfig> {
    const issues = validateCompetitiveCheckpoints(input.checkpoints, input.places);
    if (issues.length > 0) {
      throw new CompetitiveCheckpointValidationError(issues);
    }
    const existing = this.poolConfigs(input.pool);
    const current = existing.find((config) => config.status === 'current') ?? null;
    if (current && sameCheckpointLists(current.checkpoints, input.checkpoints)) {
      return cloneCompetitiveCheckpointConfig(current);
    }
    if (!current && input.checkpoints.length === 0) {
      return {
        id: '',
        pool: { ...input.pool },
        version: 0,
        status: 'superseded',
        createdAtMs: input.nowMs,
        checkpoints: [],
      };
    }
    const version = existing.reduce((max, config) => Math.max(max, config.version), 0) + 1;
    const created: CompetitiveCheckpointConfig = {
      id: (input.createConfigId ?? createId)(),
      pool: { ...input.pool },
      version,
      status: 'current',
      createdAtMs: input.nowMs,
      checkpoints: input.checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        name: checkpoint.name,
        center: { ...checkpoint.center },
        radiusMeters: checkpoint.radiusMeters,
      })),
    };
    this.configs.set(journeyPoolKey(input.pool), [
      ...existing.map((config) => ({ ...config, status: 'superseded' as const })),
      created,
    ]);
    return cloneCompetitiveCheckpointConfig(created);
  }

  async replaceSegmentResults(batch: SegmentResultBatchItem[]): Promise<void> {
    // Build the next state first and swap it in one step: all-or-nothing like a transaction.
    let next = [...this.results];
    for (const item of batch) {
      next = next.filter(
        (result) => !(result.attemptId === item.attemptId && result.configVersion === item.configVersion),
      );
      for (const result of item.results) {
        next.push({ ...result, attemptId: item.attemptId, configVersion: item.configVersion });
      }
    }
    this.results = next;
  }

  async listSegmentResults(attemptId: string) {
    return this.results
      .filter((result) => result.attemptId === attemptId)
      .sort((a, b) => a.configVersion - b.configVersion || a.id.localeCompare(b.id))
      .map((result) => ({ ...result }));
  }

  private async attemptIdsInPool(pool: CompetitiveCheckpointPool): Promise<Set<string>> {
    const attempts = await this.attempts?.listAttemptsForJourney(
      pool.originPlaceId,
      pool.destinationPlaceId,
      pool.transportationMode,
      { kind: 'all' },
    );
    return new Set((attempts ?? []).map((attempt) => attempt.id));
  }

  async listSegmentResultsForPool(pool: CompetitiveCheckpointPool, configVersion: number) {
    const ids = await this.attemptIdsInPool(pool);
    return this.results
      .filter((result) => ids.has(result.attemptId) && result.configVersion === configVersion)
      .sort((a, b) => a.attemptId.localeCompare(b.attemptId) || a.id.localeCompare(b.id))
      .map((result) => ({ ...result }));
  }

  async pruneStaleSegmentResults(pool: CompetitiveCheckpointPool, keepVersion: number) {
    const ids = await this.attemptIdsInPool(pool);
    const before = this.results.length;
    this.results = this.results.filter(
      (result) => !(ids.has(result.attemptId) && result.configVersion !== keepVersion),
    );
    return before - this.results.length;
  }
}
