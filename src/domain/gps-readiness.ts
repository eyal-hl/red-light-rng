import type { LocationSample } from './location-sample';
import {
  derivePlaceStartZoneStatus,
  isAccuracyAccepted,
  type PlaceEngineState,
  type PlaceStartZoneStatus,
  type PlaceTimingPlace,
} from './place-timing';

export type GpsReadinessState = 'waiting' | 'poor' | 'good';

export type GpsReadiness = {
  state: GpsReadinessState;
  horizontalAccuracyMeters: number | null;
};

export type AttemptCaptureHealth = {
  sessionActive: boolean;
  osUpdating: boolean;
  servicesEnabled: boolean;
  foregroundPermissionGranted: boolean;
  lastError: string | null;
};

export const WAITING_GPS_READINESS: GpsReadiness = {
  state: 'waiting',
  horizontalAccuracyMeters: null,
};

const LOCATING_START_ZONE: PlaceStartZoneStatus = {
  status: 'locating',
  placeId: null,
  placeName: null,
  distanceMeters: null,
  overlapTieBreak: null,
};

export function isAttemptCaptureAvailable(health: AttemptCaptureHealth): boolean {
  return (
    health.sessionActive &&
    health.osUpdating &&
    health.servicesEnabled &&
    health.foregroundPermissionGranted &&
    health.lastError == null
  );
}

export function deriveGpsReadiness(
  samples: LocationSample[],
  captureAvailable: boolean,
): GpsReadiness {
  const latest = samples[samples.length - 1] ?? null;
  if (!captureAvailable || !latest) {
    return {
      state: 'waiting',
      horizontalAccuracyMeters: latest?.horizontalAccuracyMeters ?? null,
    };
  }
  if (!isAccuracyAccepted(latest)) {
    return {
      state: 'poor',
      horizontalAccuracyMeters: latest.horizontalAccuracyMeters,
    };
  }
  return {
    state: 'good',
    horizontalAccuracyMeters: latest.horizontalAccuracyMeters,
  };
}

export function presentArmedAttemptStatus(
  places: PlaceTimingPlace[],
  samples: LocationSample[],
  engine: PlaceEngineState,
  captureHealth: AttemptCaptureHealth,
): {
  gpsReadiness: GpsReadiness;
  startZoneStatus: PlaceStartZoneStatus;
} {
  const gpsReadiness = deriveGpsReadiness(samples, isAttemptCaptureAvailable(captureHealth));
  if (engine.lifecycle !== 'armed' || gpsReadiness.state !== 'good') {
    return { gpsReadiness, startZoneStatus: LOCATING_START_ZONE };
  }
  return {
    gpsReadiness,
    startZoneStatus: derivePlaceStartZoneStatus(places, samples, engine),
  };
}

export function formatGpsReadinessLabel(readiness: GpsReadiness): string {
  const accuracy =
    readiness.state !== 'waiting' && readiness.horizontalAccuracyMeters != null
      ? ` · ±${Math.round(readiness.horizontalAccuracyMeters)} m`
      : '';
  if (readiness.state === 'waiting') {
    return 'GPS WAITING';
  }
  if (readiness.state === 'poor') {
    return `GPS POOR${accuracy}`;
  }
  return `GPS GOOD${accuracy}`;
}
