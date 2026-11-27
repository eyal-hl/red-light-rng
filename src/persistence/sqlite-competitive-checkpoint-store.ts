import {
  cloneCompetitiveCheckpointConfig,
  CompetitiveCheckpointValidationError,
  validateCompetitiveCheckpoints,
  type CompetitiveCheckpoint,
  type CompetitiveCheckpointConfig,
  type CompetitiveCheckpointPool,
} from '../domain/competitive-checkpoint';
import { createId } from '../domain/ids';
import type { TransportationMode } from '../domain/route';
import type { AttemptSegmentResult, SegmentUnavailableReason } from '../domain/segment-derivation';
import {
  type CompetitiveCheckpointStore,
  type SaveCompetitiveCheckpointConfigInput,
  type SegmentResultBatchItem,
} from './competitive-checkpoint-store';
import type {
  AttemptSegmentResultRow,
  CompetitiveCheckpointConfigRow,
  CompetitiveCheckpointRow,
} from './schema';
import type { SqlExecutor } from './sql-executor';

function mapResult(row: AttemptSegmentResultRow): AttemptSegmentResult {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    configVersion: row.config_version,
    derivationVersion: row.derivation_version,
    fromCheckpointId: row.from_checkpoint_id,
    toCheckpointId: row.to_checkpoint_id,
    status: row.status === 'valid' ? 'valid' : 'unavailable',
    unavailableReason: (row.unavailable_reason as SegmentUnavailableReason | null) ?? null,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    durationMs: row.duration_ms,
    derivedAtMs: row.derived_at_ms,
  };
}

export function sameCheckpointLists(
  a: readonly CompetitiveCheckpoint[],
  b: readonly CompetitiveCheckpoint[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index]!;
      return (
        item.id === other.id &&
        item.name === other.name &&
        item.center.latitude === other.center.latitude &&
        item.center.longitude === other.center.longitude &&
        item.radiusMeters === other.radiusMeters
      );
    })
  );
}

/** Transaction-free: the caller owns the transaction (used by atomic job publication). */
export async function replaceSegmentResultsOn(sql: SqlExecutor, batch: SegmentResultBatchItem[]): Promise<void> {
  for (const item of batch) {
    await sql.run('DELETE FROM attempt_segment_result WHERE attempt_id = ? AND config_version = ?', [
      item.attemptId,
      item.configVersion,
    ]);
    for (const result of item.results) {
      await sql.run(
        `INSERT INTO attempt_segment_result (
           id, attempt_id, config_version, derivation_version, from_checkpoint_id, to_checkpoint_id,
           status, unavailable_reason, started_at_ms, ended_at_ms, duration_ms, derived_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.id,
          item.attemptId,
          item.configVersion,
          result.derivationVersion,
          result.fromCheckpointId,
          result.toCheckpointId,
          result.status,
          result.unavailableReason,
          result.startedAtMs,
          result.endedAtMs,
          result.durationMs,
          result.derivedAtMs,
        ],
      );
    }
  }
}

/** Transaction-free prune of every result of the pool not computed for `keepVersion`. */
export async function pruneStaleSegmentResultsOn(
  sql: SqlExecutor,
  pool: CompetitiveCheckpointPool,
  keepVersion: number,
): Promise<number> {
  const rows = await sql.getAll<{ id: string }>(
    `SELECT r.id FROM attempt_segment_result r
     JOIN attempt a ON a.id = r.attempt_id
     WHERE a.origin_place_id = ? AND a.destination_place_id = ? AND a.transportation_mode = ?
       AND r.config_version != ?`,
    [pool.originPlaceId, pool.destinationPlaceId, pool.transportationMode, keepVersion],
  );
  for (const row of rows) {
    await sql.run('DELETE FROM attempt_segment_result WHERE id = ?', [row.id]);
  }
  return rows.length;
}

export class SqliteCompetitiveCheckpointStore implements CompetitiveCheckpointStore {
  constructor(private readonly getSql: () => Promise<SqlExecutor>) {}

  private async loadConfigs(
    sql: SqlExecutor,
    where: string,
    params: (string | number)[],
  ): Promise<CompetitiveCheckpointConfig[]> {
    const rows = await sql.getAll<CompetitiveCheckpointConfigRow>(
      `SELECT * FROM competitive_checkpoint_config WHERE ${where} ORDER BY version ASC`,
      params,
    );
    const configs: CompetitiveCheckpointConfig[] = [];
    for (const row of rows) {
      const checkpointRows = await sql.getAll<CompetitiveCheckpointRow>(
        `SELECT * FROM competitive_checkpoint WHERE config_id = ? ORDER BY seq ASC`,
        [row.id],
      );
      configs.push({
        id: row.id,
        pool: {
          originPlaceId: row.origin_place_id,
          destinationPlaceId: row.destination_place_id,
          transportationMode: row.transportation_mode as TransportationMode,
        },
        version: row.version,
        status: row.status === 'current' ? 'current' : 'superseded',
        createdAtMs: row.created_at_ms,
        checkpoints: checkpointRows.map((item) => ({
          id: item.checkpoint_id,
          name: item.name,
          center: { latitude: item.latitude, longitude: item.longitude },
          radiusMeters: item.radius_meters,
        })),
      });
    }
    return configs;
  }

  private poolWhere = `origin_place_id = ? AND destination_place_id = ? AND transportation_mode = ?`;

  private poolParams(pool: CompetitiveCheckpointPool): string[] {
    return [pool.originPlaceId, pool.destinationPlaceId, pool.transportationMode];
  }

  async getCurrentConfig(pool: CompetitiveCheckpointPool) {
    const sql = await this.getSql();
    const [config] = await this.loadConfigs(
      sql,
      `${this.poolWhere} AND status = 'current'`,
      this.poolParams(pool),
    );
    return config ?? null;
  }

  async getConfig(pool: CompetitiveCheckpointPool, version: number) {
    const sql = await this.getSql();
    const [config] = await this.loadConfigs(sql, `${this.poolWhere} AND version = ?`, [
      ...this.poolParams(pool),
      version,
    ]);
    return config ?? null;
  }

  async listConfigs(pool: CompetitiveCheckpointPool) {
    const sql = await this.getSql();
    return this.loadConfigs(sql, this.poolWhere, this.poolParams(pool));
  }

  async saveConfig(input: SaveCompetitiveCheckpointConfigInput): Promise<CompetitiveCheckpointConfig> {
    const issues = validateCompetitiveCheckpoints(input.checkpoints, input.places);
    if (issues.length > 0) {
      throw new CompetitiveCheckpointValidationError(issues);
    }
    const sql = await this.getSql();
    return sql.withTransaction(async () => {
      const existing = await this.loadConfigs(sql, this.poolWhere, this.poolParams(input.pool));
      const current = existing.find((config) => config.status === 'current') ?? null;
      if (current && sameCheckpointLists(current.checkpoints, input.checkpoints)) {
        return cloneCompetitiveCheckpointConfig(current);
      }
      // A pool that never had checkpoints needs no version for an empty list.
      if (!current && input.checkpoints.length === 0) {
        return {
          id: '',
          pool: { ...input.pool },
          version: 0,
          status: 'superseded' as const,
          createdAtMs: input.nowMs,
          checkpoints: [],
        };
      }
      const version = existing.reduce((max, config) => Math.max(max, config.version), 0) + 1;
      const id = (input.createConfigId ?? createId)();
      await sql.run(
        `UPDATE competitive_checkpoint_config SET status = 'superseded'
         WHERE ${this.poolWhere} AND status = 'current'`,
        this.poolParams(input.pool),
      );
      await sql.run(
        `INSERT INTO competitive_checkpoint_config (
           id, origin_place_id, destination_place_id, transportation_mode, version, status, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, 'current', ?)`,
        [id, ...this.poolParams(input.pool), version, input.nowMs],
      );
      for (const [seq, checkpoint] of input.checkpoints.entries()) {
        await sql.run(
          `INSERT INTO competitive_checkpoint (
             config_id, checkpoint_id, seq, name, latitude, longitude, radius_meters
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            checkpoint.id,
            seq,
            checkpoint.name,
            checkpoint.center.latitude,
            checkpoint.center.longitude,
            checkpoint.radiusMeters,
          ],
        );
      }
      return {
        id,
        pool: { ...input.pool },
        version,
        status: 'current' as const,
        createdAtMs: input.nowMs,
        checkpoints: input.checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          name: checkpoint.name,
          center: { ...checkpoint.center },
          radiusMeters: checkpoint.radiusMeters,
        })),
      };
    });
  }

  async replaceSegmentResults(batch: SegmentResultBatchItem[]): Promise<void> {
    const sql = await this.getSql();
    await sql.withTransaction(() => replaceSegmentResultsOn(sql, batch));
  }

  async listSegmentResults(attemptId: string): Promise<AttemptSegmentResult[]> {
    const sql = await this.getSql();
    const rows = await sql.getAll<AttemptSegmentResultRow>(
      `SELECT * FROM attempt_segment_result WHERE attempt_id = ? ORDER BY config_version, id`,
      [attemptId],
    );
    return rows.map(mapResult);
  }

  async listSegmentResultsForPool(pool: CompetitiveCheckpointPool, configVersion: number) {
    const sql = await this.getSql();
    const rows = await sql.getAll<AttemptSegmentResultRow>(
      `SELECT r.* FROM attempt_segment_result r
       JOIN attempt a ON a.id = r.attempt_id
       WHERE a.origin_place_id = ? AND a.destination_place_id = ? AND a.transportation_mode = ?
         AND r.config_version = ?
       ORDER BY r.attempt_id, r.id`,
      [...this.poolParams(pool), configVersion],
    );
    return rows.map(mapResult);
  }

  async pruneStaleSegmentResults(pool: CompetitiveCheckpointPool, keepVersion: number): Promise<number> {
    const sql = await this.getSql();
    return sql.withTransaction(() => pruneStaleSegmentResultsOn(sql, pool, keepVersion));
  }

  async deleteSegmentResultsForAttempt(attemptId: string): Promise<void> {
    const sql = await this.getSql();
    await sql.run('DELETE FROM attempt_segment_result WHERE attempt_id = ?', [attemptId]);
  }

  async listCurrentConfigs(): Promise<CompetitiveCheckpointConfig[]> {
    const sql = await this.getSql();
    return this.loadConfigs(sql, `status = 'current'`, []);
  }
}
