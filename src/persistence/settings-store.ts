import type { TransportationMode } from '../domain/route';

export const ACTIVE_TRANSPORTATION_MODE_KEY = 'active_transportation_mode';
export const PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY = 'path_variant_recompute_fingerprint';
export const DEFAULT_ACTIVE_TRANSPORTATION_MODE: TransportationMode = 'scooter';

export interface SettingsStore {
  getValue(key: string): Promise<string | null>;
  setValue(key: string, value: string): Promise<void>;
  getActiveTransportationMode(): Promise<TransportationMode>;
  setActiveTransportationMode(mode: TransportationMode): Promise<void>;
}

export function parseTransportationMode(value: string | null | undefined): TransportationMode {
  if (value === 'scooter' || value === 'bike' || value === 'run' || value === 'walk') {
    return value;
  }
  return DEFAULT_ACTIVE_TRANSPORTATION_MODE;
}
