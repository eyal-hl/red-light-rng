import type { TransportationMode } from '../domain/route';
import {
  ACTIVE_TRANSPORTATION_MODE_KEY,
  DEFAULT_ACTIVE_TRANSPORTATION_MODE,
  parseTransportationMode,
  type SettingsStore,
} from './settings-store';
import type { SqlExecutor } from './sql-executor';

export class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly getSql: () => Promise<SqlExecutor>) {}

  async getActiveTransportationMode(): Promise<TransportationMode> {
    const sql = await this.getSql();
    const row = await sql.getFirst<{ value: string }>(
      'SELECT value FROM app_setting WHERE key = ?',
      [ACTIVE_TRANSPORTATION_MODE_KEY],
    );
    return parseTransportationMode(row?.value ?? DEFAULT_ACTIVE_TRANSPORTATION_MODE);
  }

  async setActiveTransportationMode(mode: TransportationMode): Promise<void> {
    const sql = await this.getSql();
    await sql.run(
      `INSERT INTO app_setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [ACTIVE_TRANSPORTATION_MODE_KEY, mode],
    );
  }
}
