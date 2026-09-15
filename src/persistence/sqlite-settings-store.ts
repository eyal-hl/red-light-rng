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

  async getValue(key: string): Promise<string | null> {
    const sql = await this.getSql();
    const row = await sql.getFirst<{ value: string }>('SELECT value FROM app_setting WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async setValue(key: string, value: string): Promise<void> {
    const sql = await this.getSql();
    await sql.run(
      `INSERT INTO app_setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async getActiveTransportationMode(): Promise<TransportationMode> {
    return parseTransportationMode((await this.getValue(ACTIVE_TRANSPORTATION_MODE_KEY)) ?? DEFAULT_ACTIVE_TRANSPORTATION_MODE);
  }

  async setActiveTransportationMode(mode: TransportationMode): Promise<void> {
    await this.setValue(ACTIVE_TRANSPORTATION_MODE_KEY, mode);
  }
}
