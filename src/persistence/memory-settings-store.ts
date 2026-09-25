import type { TransportationMode } from '../domain/route';
import {
  ACTIVE_TRANSPORTATION_MODE_KEY,
  parseTransportationMode,
  type SettingsStore,
} from './settings-store';

export class MemorySettingsStore implements SettingsStore {
  private readonly values = new Map<string, string>();

  async getValue(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setValue(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async getActiveTransportationMode(): Promise<TransportationMode> {
    return parseTransportationMode(await this.getValue(ACTIVE_TRANSPORTATION_MODE_KEY));
  }

  async setActiveTransportationMode(mode: TransportationMode): Promise<void> {
    await this.setValue(ACTIVE_TRANSPORTATION_MODE_KEY, mode);
  }
}
