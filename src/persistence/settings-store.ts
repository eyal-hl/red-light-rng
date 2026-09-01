import type { TransportationMode } from '../domain/route';

export const ACTIVE_TRANSPORTATION_MODE_KEY = 'active_transportation_mode';
export const DEFAULT_ACTIVE_TRANSPORTATION_MODE: TransportationMode = 'scooter';

export interface SettingsStore {
  getActiveTransportationMode(): Promise<TransportationMode>;
  setActiveTransportationMode(mode: TransportationMode): Promise<void>;
}

export function parseTransportationMode(value: string | null | undefined): TransportationMode {
  if (value === 'scooter' || value === 'bike' || value === 'run' || value === 'walk') {
    return value;
  }
  return DEFAULT_ACTIVE_TRANSPORTATION_MODE;
}
