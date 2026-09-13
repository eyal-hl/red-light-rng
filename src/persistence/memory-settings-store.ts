import type { TransportationMode } from '../domain/route';
import {
  DEFAULT_ACTIVE_TRANSPORTATION_MODE,
  type SettingsStore,
} from './settings-store';

export class MemorySettingsStore implements SettingsStore {
  private mode: TransportationMode = DEFAULT_ACTIVE_TRANSPORTATION_MODE;

  async getActiveTransportationMode(): Promise<TransportationMode> {
    return this.mode;
  }

  async setActiveTransportationMode(mode: TransportationMode): Promise<void> {
    this.mode = mode;
  }
}
