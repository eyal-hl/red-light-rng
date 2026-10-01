import {
  EMPTY_ATTEMPT_LOCAL_START,
  isOpenAttempt,
  type Attempt,
  type AttemptCheckpointCrossing,
  type AttemptLifecycle,
  type AttemptLocalTimeSource,
  type AttemptValidity,
} from '../domain/attempt';
import { reconstructAttemptLocalStart } from '../domain/attempt-local-time';
import {
  CURRENT_ATTEMPT_RECONCILIATION_VERSION,
  type AttemptReconciliationStatus,
} from '../domain/attempt-reconciliation';
import type { LocationSample } from '../domain/location-sample';
import type { Place, PlaceStatus } from '../domain/place';
import { replayPlaceTrace } from '../domain/place-timing';
import type { Route, RouteKind, RouteStatus, TransportationMode } from '../domain/route';
import type { CaptureOutcome, ReviewDisposition, SessionPurpose } from '../domain/session';
import { sha256Hex } from '../domain/sha256';
import type { TrackingSessionRecord } from './location-sample-store';
import {
  ACTIVE_TRANSPORTATION_MODE_KEY,
  PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY,
} from './settings-store';

export const BACKUP_FORMAT_VERSION = 2;
export const OLDEST_SUPPORTED_BACKUP_FORMAT_VERSION = 1;

export const BACKUP_PRIVACY_NOTICE =
  'Backup files contain your precise location history. They stay on this device until you choose where to save or share them. Red Light RNG does not upload backups.';
export const BACKUP_EXPORT_LABEL = 'Export backup';
export const BACKUP_RESTORE_LABEL = 'Restore backup';
export const BACKUP_REPLACE_CONFIRM_LABEL = 'Replace local data with this backup';
export const BACKUP_REPLACE_WARNING =
  'This replaces the places, routes, attempts, and GPS history stored on this device.';

export const MALFORMED_BACKUP_MESSAGE = 'This backup file is truncated or malformed.';
export const NEWER_BACKUP_MESSAGE = 'This backup was created by a newer app version and cannot be restored.';
export const INTEGRITY_BACKUP_MESSAGE = 'This backup file does not match its integrity check.';
export const INVALID_BACKUP_MESSAGE =
  'This backup is missing data it refers to or contains invalid records, so it was not restored.';

const EXCLUDED_SETTING_KEYS = new Set([PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY]);
const SECRET_SETTING_PATTERN = /secret|token|password|credential/i;

export class BackupRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRejectedError';
  }
}

export type BackupSetting = {
  key: string;
  value: string;
};

export type BackupSnapshot = {
  createdAtMs: number;
  sourceSchemaVersion: number;
  sourceAppVersion: string | null;
  places: Place[];
  routes: Route[];
  sessions: TrackingSessionRecord[];
  samples: LocationSample[];
  attempts: Attempt[];
  settings: BackupSetting[];
};

export type BackupPreview = {
  backupFormatVersion: number;
  createdAtMs: number;
  sourceSchemaVersion: number;
  counts: {
    places: number;
    routes: number;
    attempts: number;
    locationSamples: number;
  };
};

export type ParsedBackup = {
  preview: BackupPreview;
  snapshot: BackupSnapshot;
};

type JsonRecord = Record<string, unknown>;

export function isDurableProductSetting(key: string): boolean {
  if (EXCLUDED_SETTING_KEYS.has(key) || SECRET_SETTING_PATTERN.test(key)) {
    return false;
  }
  return key === ACTIVE_TRANSPORTATION_MODE_KEY;
}

export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (!isRecord(value)) {
    throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function serializeBackupSnapshot(snapshot: BackupSnapshot): string {
  const records = recordsToJson(orderSnapshot(snapshot));
  const envelope = {
    backup_format_version: BACKUP_FORMAT_VERSION,
    created_at_ms: snapshot.createdAtMs,
    source_schema_version: snapshot.sourceSchemaVersion,
    source_app_version: snapshot.sourceAppVersion,
    counts: countJsonRecords(records),
    integrity: {
      algorithm: 'sha256',
      payload_sha256: sha256Hex(canonicalJson(records)),
    },
    records,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseBackup(text: string, nowMs: number): ParsedBackup {
  const envelope = parseEnvelope(text);
  const version = requireFormatVersion(envelope);
  if (version > BACKUP_FORMAT_VERSION) {
    throw new BackupRejectedError(NEWER_BACKUP_MESSAGE);
  }
  if (version < OLDEST_SUPPORTED_BACKUP_FORMAT_VERSION) {
    throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
  }

  const createdAtMs = requireTimestamp(envelope, 'created_at_ms');
  const sourceSchemaVersion = requireNonNegativeInteger(envelope, 'source_schema_version');
  const sourceAppVersion = optionalNullableString(envelope, 'source_app_version');
  const migrated = version === 1 ? migrateVersion1(envelope) : acceptVersion2(envelope);
  const snapshot = terminalizeRestoredSnapshot(
    parseCurrentRecords(migrated.records, {
      createdAtMs,
      sourceSchemaVersion,
      sourceAppVersion,
    }),
    nowMs,
  );
  return {
    preview: {
      backupFormatVersion: version,
      createdAtMs,
      sourceSchemaVersion,
      counts: {
        places: migrated.counts.places,
        routes: migrated.counts.routes,
        attempts: migrated.counts.attempts,
        locationSamples: migrated.counts.location_samples,
      },
    },
    snapshot,
  };
}

export function terminalizeRestoredSnapshot(snapshot: BackupSnapshot, nowMs: number): BackupSnapshot {
  const samplesBySession = new Map<string, LocationSample[]>();
  for (const sample of snapshot.samples) {
    const list = samplesBySession.get(sample.sessionId) ?? [];
    list.push(sample);
    samplesBySession.set(sample.sessionId, list);
  }
  for (const list of samplesBySession.values()) {
    list.sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.id.localeCompare(right.id));
  }

  const attempts = snapshot.attempts.map((attempt) =>
    terminalizeAttempt(attempt, snapshot.places, samplesBySession.get(attempt.sessionId) ?? [], nowMs),
  );
  const attemptBySession = new Map(attempts.map((attempt) => [attempt.sessionId, attempt]));
  const sessions = snapshot.sessions.map((session) =>
    terminalizeSession(session, attemptBySession.get(session.id) ?? null, nowMs),
  );
  if (attempts.some((attempt) => isOpenAttempt(attempt)) || sessions.some((session) => session.isActive)) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return {
    ...snapshot,
    attempts,
    sessions,
    settings: snapshot.settings.filter((setting) => isDurableProductSetting(setting.key)),
  };
}

function terminalizeAttempt(
  attempt: Attempt,
  places: Place[],
  samples: LocationSample[],
  nowMs: number,
): Attempt {
  if (!isOpenAttempt(attempt)) {
    return attempt;
  }
  const engine = replayPlaceTrace(places, samples, { armedAtMs: attempt.armedAtMs, nowMs });
  if (
    engine.lifecycle === 'completed' &&
    engine.startedAtMs != null &&
    engine.finishedAtMs != null &&
    engine.originPlaceId != null &&
    engine.destinationPlaceId != null
  ) {
    return withRestoredLocalStart(attempt, {
      ...attempt,
      lifecycle: 'completed',
      validity: 'valid',
      originPlaceId: engine.originPlaceId,
      destinationPlaceId: engine.destinationPlaceId,
      startedAtMs: engine.startedAtMs,
      finishedAtMs: engine.finishedAtMs,
      resultAcknowledged: false,
      hiddenIncomplete: false,
      reconciliationStatus: 'pending',
      reconciliationVersion: 0,
    });
  }
  return withRestoredLocalStart(attempt, {
    ...attempt,
    lifecycle: 'ended',
    validity: 'unranked',
    originPlaceId: engine.originPlaceId ?? attempt.originPlaceId,
    destinationPlaceId: attempt.destinationPlaceId,
    startedAtMs: engine.startedAtMs ?? attempt.startedAtMs,
    finishedAtMs: null,
    resultAcknowledged: false,
    hiddenIncomplete: false,
    reconciliationStatus: 'reconciled',
    reconciliationVersion: CURRENT_ATTEMPT_RECONCILIATION_VERSION,
  });
}

function withRestoredLocalStart(previous: Attempt, next: Attempt): Attempt {
  if (next.startedAtMs == null) {
    return { ...next, ...EMPTY_ATTEMPT_LOCAL_START };
  }
  if (
    previous.startedAtMs === next.startedAtMs &&
    previous.startedUtcOffsetMinutes != null &&
    previous.startedLocalTimeSource != null
  ) {
    return {
      ...next,
      startedUtcOffsetMinutes: previous.startedUtcOffsetMinutes,
      startedTimezoneId: previous.startedTimezoneId,
      startedLocalTimeSource: previous.startedLocalTimeSource,
    };
  }
  return { ...next, ...reconstructAttemptLocalStart(next.startedAtMs) };
}

function terminalizeSession(
  session: TrackingSessionRecord,
  attempt: Attempt | null,
  nowMs: number,
): TrackingSessionRecord {
  const cleared: TrackingSessionRecord = { ...session, backgroundPermissionConfirmed: false };
  if (!session.isActive) {
    return cleared;
  }
  const stoppedAtMs = session.stoppedAtMs ?? nowMs;
  if (session.purpose === 'route_creation') {
    return {
      ...cleared,
      isActive: false,
      stoppedAtMs,
      captureOutcome: session.captureOutcome === 'active' ? 'interrupted' : session.captureOutcome,
      reviewDisposition: 'pending',
    };
  }
  if (attempt?.lifecycle === 'completed') {
    return {
      ...cleared,
      isActive: false,
      stoppedAtMs: attempt.finishedAtMs ?? stoppedAtMs,
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
    };
  }
  if (attempt?.lifecycle === 'cancelled') {
    return {
      ...cleared,
      isActive: false,
      stoppedAtMs,
      captureOutcome: 'cancelled',
      reviewDisposition: 'discarded',
    };
  }
  return {
    ...cleared,
    isActive: false,
    stoppedAtMs,
    captureOutcome: session.captureOutcome === 'active' ? 'interrupted' : session.captureOutcome,
    reviewDisposition: session.purpose === 'attempt' ? 'saved' : session.reviewDisposition,
  };
}

function parseEnvelope(text: string): JsonRecord {
  if (text.trim().length === 0) {
    throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
    }
    return parsed;
  } catch (error) {
    if (error instanceof BackupRejectedError) {
      throw error;
    }
    throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
  }
}

function acceptVersion2(envelope: JsonRecord): { records: JsonRecord; counts: BackupCountJson } {
  const records = requireRecord(envelope, 'records');
  verifyIntegrity(records, envelope);
  const counts = requireCounts(envelope, true);
  assertCounts(records, counts, true);
  return { records, counts };
}

function migrateVersion1(envelope: JsonRecord): { records: JsonRecord; counts: BackupCountJson } {
  const records = requireRecord(envelope, 'records');
  verifyIntegrity(records, envelope);
  const counts = requireCounts(envelope, false);
  assertCounts(records, counts, false);
  const mode = requireMode(envelope.active_transportation_mode);
  const routes = requireArray(records, 'routes').map((route) => {
    const row = requireObject(route);
    return {
      ...row,
      status: row.status ?? 'active',
      kind: row.kind ?? 'explicit',
      cluster_signature: row.cluster_signature ?? null,
      classification_version: row.classification_version ?? 1,
    };
  });
  const attempts = requireArray(records, 'attempts').map((attempt) => {
    const row = requireObject(attempt);
    return {
      ...row,
      result_acknowledged: row.result_acknowledged ?? false,
      hidden_incomplete: row.hidden_incomplete ?? false,
      started_utc_offset_minutes: row.started_utc_offset_minutes ?? null,
      started_timezone_id: row.started_timezone_id ?? null,
      started_local_time_source: row.started_local_time_source ?? null,
      reconciliation_status: row.reconciliation_status ?? 'pending',
      reconciliation_version: row.reconciliation_version ?? 0,
      crossings: row.crossings ?? [],
    };
  });
  return {
    counts: { ...counts, settings: 1 },
    records: {
      places: records.places,
      routes,
      tracking_sessions: records.tracking_sessions,
      location_samples: records.location_samples,
      attempts,
      settings: [{ key: ACTIVE_TRANSPORTATION_MODE_KEY, value: mode }],
    },
  };
}

type BackupCountJson = {
  places: number;
  routes: number;
  attempts: number;
  tracking_sessions: number;
  location_samples: number;
  settings: number;
};

function parseCurrentRecords(
  records: JsonRecord,
  meta: Pick<BackupSnapshot, 'createdAtMs' | 'sourceSchemaVersion' | 'sourceAppVersion'>,
): BackupSnapshot {
  const places = requireArray(records, 'places').map(parsePlace);
  const sessions = requireArray(records, 'tracking_sessions').map(parseSession);
  const samples = requireArray(records, 'location_samples').map(parseSample);
  const routes = requireArray(records, 'routes').map(parseRoute);
  const attempts = requireArray(records, 'attempts').map(parseAttempt);
  const settings = requireArray(records, 'settings').map(parseSetting);
  const snapshot: BackupSnapshot = { ...meta, places, routes, sessions, samples, attempts, settings };
  validateRelationships(snapshot);
  return snapshot;
}

function validateRelationships(snapshot: BackupSnapshot): void {
  const placeIds = uniqueIds(snapshot.places.map((place) => place.id));
  const sessionIds = uniqueIds(snapshot.sessions.map((session) => session.id));
  const routeIds = uniqueIds(snapshot.routes.map((route) => route.id));
  uniqueIds(snapshot.samples.map((sample) => sample.id));
  uniqueIds(snapshot.attempts.map((attempt) => attempt.id));
  const settingKeys = new Set<string>();
  for (const setting of snapshot.settings) {
    if (settingKeys.has(setting.key)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    settingKeys.add(setting.key);
  }

  const sourceIds = new Set<string>();
  const checkpointIds: string[] = [];
  for (const route of snapshot.routes) {
    if (!sessionIds.has(route.sourceRecordingId) || sourceIds.has(route.sourceRecordingId)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    sourceIds.add(route.sourceRecordingId);
    for (const checkpoint of route.checkpoints) {
      checkpointIds.push(checkpoint.id);
    }
  }
  uniqueIds(checkpointIds);
  for (const sample of snapshot.samples) {
    if (!sessionIds.has(sample.sessionId)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
  }
  const attemptSessions = new Set<string>();
  const crossingIds: string[] = [];
  for (const attempt of snapshot.attempts) {
    if (!sessionIds.has(attempt.sessionId) || attemptSessions.has(attempt.sessionId)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    attemptSessions.add(attempt.sessionId);
    if (attempt.routeId != null && !routeIds.has(attempt.routeId)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    if (attempt.originPlaceId != null && !placeIds.has(attempt.originPlaceId)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    if (attempt.destinationPlaceId != null && !placeIds.has(attempt.destinationPlaceId)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    if (
      attempt.startedAtMs != null &&
      attempt.finishedAtMs != null &&
      attempt.finishedAtMs < attempt.startedAtMs
    ) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    for (const crossing of attempt.crossings) {
      if (crossing.attemptId !== attempt.id) {
        throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
      }
      crossingIds.push(crossing.id);
    }
  }
  uniqueIds(crossingIds);
}

function parsePlace(value: unknown): Place {
  const row = requireObject(value);
  const status = requireOneOf(row.status, ['active', 'archived']) as PlaceStatus;
  return {
    id: requireId(row.id),
    name: requireName(row.name),
    center: { latitude: requireLatitude(row.latitude), longitude: requireLongitude(row.longitude) },
    radiusMeters: requirePositive(row.radius_meters),
    status,
    createdAtMs: requireTimestamp(row, 'created_at_ms'),
  };
}

function parseRoute(value: unknown): Route {
  const row = requireObject(value);
  const referencePath = requireArray(row, 'reference_path').map((point) => {
    const coords = requireObject(point);
    return { latitude: requireLatitude(coords.latitude), longitude: requireLongitude(coords.longitude) };
  });
  if (referencePath.length < 2) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return {
    id: requireId(row.id),
    name: requireName(row.name),
    transportationMode: requireMode(row.transportation_mode),
    createdAtMs: requireTimestamp(row, 'created_at_ms'),
    sourceRecordingId: requireId(row.source_recording_id),
    referencePath,
    startZone: parseZone(row.start_zone),
    finishZone: parseZone(row.finish_zone),
    startProgressMeters: requireNonNegative(row.start_progress_m),
    finishProgressMeters: requireNonNegative(row.finish_progress_m),
    checkpoints: requireArray(row, 'checkpoints').map(parseCheckpoint),
    status: requireOneOf(row.status, ['active', 'archived']) as RouteStatus,
    kind: requireOneOf(row.kind, ['explicit', 'discovered']) as RouteKind,
    clusterSignature: optionalNullableText(row.cluster_signature, 100_000),
    classificationVersion: requireNonNegativeIntegerValue(row.classification_version),
  };
}

function parseZone(value: unknown): Route['startZone'] {
  const row = requireObject(value);
  return {
    center: { latitude: requireLatitude(row.latitude), longitude: requireLongitude(row.longitude) },
    radiusMeters: requirePositive(row.radius_meters),
  };
}

function parseCheckpoint(value: unknown): Route['checkpoints'][number] {
  const row = requireObject(value);
  return {
    id: requireId(row.id),
    name: requireName(row.name),
    progressMeters: requireNonNegative(row.progress_m),
  };
}

function parseSession(value: unknown): TrackingSessionRecord {
  const row = requireObject(value);
  const startedAtMs = requireTimestamp(row, 'started_at_ms');
  const stoppedAtMs = optionalNullableTimestamp(row, 'stopped_at_ms');
  if (stoppedAtMs != null && stoppedAtMs < startedAtMs) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return {
    id: requireId(row.id),
    startedAtMs,
    stoppedAtMs,
    isActive: requireBoolean(row.is_active),
    purpose: requireOneOf(row.purpose, ['legacy', 'route_creation', 'attempt']) as SessionPurpose,
    captureOutcome: requireOneOf(row.capture_outcome, [
      'active',
      'finished',
      'cancelled',
      'interrupted',
      'unknown',
    ]) as CaptureOutcome,
    reviewDisposition: requireOneOf(row.review_disposition, ['pending', 'saved', 'discarded']) as ReviewDisposition,
    lastSampleAtMs: null,
    backgroundPermissionConfirmed: false,
  };
}

function parseSample(value: unknown): LocationSample {
  const row = requireObject(value);
  return {
    id: requireId(row.id),
    sessionId: requireId(row.session_id),
    recordedAtMs: requireTimestamp(row, 'recorded_at_ms'),
    latitude: requireLatitude(row.latitude),
    longitude: requireLongitude(row.longitude),
    horizontalAccuracyMeters: optionalNullableNonNegative(row.horizontal_accuracy_meters),
    speedMetersPerSecond: optionalNullableNonNegative(row.speed_meters_per_second),
    headingDegrees: optionalNullableHeading(row.heading_degrees),
  };
}

function parseAttempt(value: unknown): Attempt {
  const row = requireObject(value);
  const id = requireId(row.id);
  const localSource = optionalLocalSource(row.started_local_time_source);
  const startedUtcOffsetMinutes = optionalNullableOffset(row.started_utc_offset_minutes);
  if (localSource != null && startedUtcOffsetMinutes == null) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  if (localSource == null && startedUtcOffsetMinutes != null) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return {
    id,
    routeId: optionalNullableId(row.route_id),
    originPlaceId: optionalNullableId(row.origin_place_id),
    destinationPlaceId: optionalNullableId(row.destination_place_id),
    transportationMode: requireMode(row.transportation_mode),
    sessionId: requireId(row.session_id),
    lifecycle: requireOneOf(row.lifecycle, ['armed', 'active', 'completed', 'cancelled', 'abandoned', 'ended']) as AttemptLifecycle,
    validity: requireOneOf(row.validity, ['pending', 'valid', 'unranked']) as AttemptValidity,
    armedAtMs: requireTimestamp(row, 'armed_at_ms'),
    startedAtMs: optionalNullableTimestamp(row, 'started_at_ms'),
    finishedAtMs: optionalNullableTimestamp(row, 'finished_at_ms'),
    startedUtcOffsetMinutes,
    startedTimezoneId: optionalNullableStringValue(row.started_timezone_id),
    startedLocalTimeSource: localSource,
    resultAcknowledged: requireBoolean(row.result_acknowledged),
    hiddenIncomplete: requireBoolean(row.hidden_incomplete),
    crossings: requireArray(row, 'crossings').map((crossing) => parseCrossing(crossing, id)),
    reconciliationStatus: requireOneOf(row.reconciliation_status, ['pending', 'reconciled', 'failed']) as AttemptReconciliationStatus,
    reconciliationVersion: requireNonNegativeIntegerValue(row.reconciliation_version),
  };
}

function parseCrossing(value: unknown, attemptId: string): AttemptCheckpointCrossing {
  const row = requireObject(value);
  return {
    id: requireId(row.id),
    attemptId,
    checkpointId: requireId(row.checkpoint_id),
    checkpointName: requireName(row.checkpoint_name),
    checkpointProgressMeters: requireNonNegative(row.checkpoint_progress_m),
    crossedAtMs: requireTimestamp(row, 'crossed_at_ms'),
  };
}

function parseSetting(value: unknown): BackupSetting {
  const row = requireObject(value);
  const key = requireId(row.key);
  if (typeof row.value !== 'string') {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  if (key === ACTIVE_TRANSPORTATION_MODE_KEY) {
    return { key, value: requireMode(row.value) };
  }
  return { key, value: row.value };
}

function recordsToJson(snapshot: BackupSnapshot): JsonRecord {
  return {
    places: snapshot.places.map((place) => ({
      id: place.id,
      name: place.name,
      latitude: place.center.latitude,
      longitude: place.center.longitude,
      radius_meters: place.radiusMeters,
      status: place.status,
      created_at_ms: place.createdAtMs,
    })),
    routes: snapshot.routes.map((route) => ({
      id: route.id,
      name: route.name,
      transportation_mode: route.transportationMode,
      created_at_ms: route.createdAtMs,
      source_recording_id: route.sourceRecordingId,
      reference_path: route.referencePath.map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
      })),
      start_zone: zoneJson(route.startZone),
      finish_zone: zoneJson(route.finishZone),
      start_progress_m: route.startProgressMeters,
      finish_progress_m: route.finishProgressMeters,
      checkpoints: route.checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        name: checkpoint.name,
        progress_m: checkpoint.progressMeters,
      })),
      status: route.status,
      kind: route.kind,
      cluster_signature: route.clusterSignature,
      classification_version: route.classificationVersion,
    })),
    tracking_sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      started_at_ms: session.startedAtMs,
      stopped_at_ms: session.stoppedAtMs,
      is_active: session.isActive,
      purpose: session.purpose,
      capture_outcome: session.captureOutcome,
      review_disposition: session.reviewDisposition,
    })),
    location_samples: snapshot.samples.map((sample) => ({
      id: sample.id,
      session_id: sample.sessionId,
      recorded_at_ms: sample.recordedAtMs,
      latitude: sample.latitude,
      longitude: sample.longitude,
      horizontal_accuracy_meters: sample.horizontalAccuracyMeters,
      speed_meters_per_second: sample.speedMetersPerSecond,
      heading_degrees: sample.headingDegrees,
    })),
    attempts: snapshot.attempts.map((attempt) => ({
      id: attempt.id,
      route_id: attempt.routeId,
      origin_place_id: attempt.originPlaceId,
      destination_place_id: attempt.destinationPlaceId,
      transportation_mode: attempt.transportationMode,
      session_id: attempt.sessionId,
      lifecycle: attempt.lifecycle,
      validity: attempt.validity,
      armed_at_ms: attempt.armedAtMs,
      started_at_ms: attempt.startedAtMs,
      finished_at_ms: attempt.finishedAtMs,
      started_utc_offset_minutes: attempt.startedUtcOffsetMinutes,
      started_timezone_id: attempt.startedTimezoneId,
      started_local_time_source: attempt.startedLocalTimeSource,
      result_acknowledged: attempt.resultAcknowledged,
      hidden_incomplete: attempt.hiddenIncomplete === true,
      crossings: attempt.crossings.map((crossing) => ({
        id: crossing.id,
        checkpoint_id: crossing.checkpointId,
        checkpoint_name: crossing.checkpointName,
        checkpoint_progress_m: crossing.checkpointProgressMeters,
        crossed_at_ms: crossing.crossedAtMs,
      })),
      reconciliation_status: attempt.reconciliationStatus ?? 'pending',
      reconciliation_version: attempt.reconciliationVersion ?? 0,
    })),
    settings: snapshot.settings
      .filter((setting) => isDurableProductSetting(setting.key))
      .map((setting) => ({ key: setting.key, value: setting.value })),
  };
}

function zoneJson(zone: Route['startZone']): JsonRecord {
  return {
    latitude: zone.center.latitude,
    longitude: zone.center.longitude,
    radius_meters: zone.radiusMeters,
  };
}

function countJsonRecords(records: JsonRecord): BackupCountJson {
  return {
    places: requireArray(records, 'places').length,
    routes: requireArray(records, 'routes').length,
    attempts: requireArray(records, 'attempts').length,
    tracking_sessions: requireArray(records, 'tracking_sessions').length,
    location_samples: requireArray(records, 'location_samples').length,
    settings: requireArray(records, 'settings').length,
  };
}

function orderSnapshot(snapshot: BackupSnapshot): BackupSnapshot {
  const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  return {
    ...snapshot,
    places: [...snapshot.places].sort(byId),
    routes: [...snapshot.routes].sort(byId).map((route) => ({
      ...route,
      checkpoints: [...route.checkpoints].sort(
        (left, right) => left.progressMeters - right.progressMeters || left.id.localeCompare(right.id),
      ),
    })),
    sessions: [...snapshot.sessions].sort(byId),
    samples: [...snapshot.samples].sort(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.recordedAtMs - right.recordedAtMs ||
        left.id.localeCompare(right.id),
    ),
    attempts: [...snapshot.attempts].sort(byId).map((attempt) => ({
      ...attempt,
      crossings: [...attempt.crossings].sort(
        (left, right) => left.crossedAtMs - right.crossedAtMs || left.id.localeCompare(right.id),
      ),
    })),
    settings: [...snapshot.settings].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function verifyIntegrity(records: unknown, envelope: JsonRecord): void {
  const integrity = requireRecord(envelope, 'integrity');
  if (integrity.algorithm !== 'sha256' || typeof integrity.payload_sha256 !== 'string') {
    throw new BackupRejectedError(INTEGRITY_BACKUP_MESSAGE);
  }
  let actual: string;
  try {
    actual = sha256Hex(canonicalJson(records));
  } catch {
    throw new BackupRejectedError(INTEGRITY_BACKUP_MESSAGE);
  }
  if (actual !== integrity.payload_sha256) {
    throw new BackupRejectedError(INTEGRITY_BACKUP_MESSAGE);
  }
}

function assertCounts(records: JsonRecord, counts: BackupCountJson, includeSettings: boolean): void {
  const actual = {
    places: arrayLength(records, 'places'),
    routes: arrayLength(records, 'routes'),
    attempts: arrayLength(records, 'attempts'),
    tracking_sessions: arrayLength(records, 'tracking_sessions'),
    location_samples: arrayLength(records, 'location_samples'),
    settings: includeSettings ? arrayLength(records, 'settings') : counts.settings,
  };
  if (
    actual.places !== counts.places ||
    actual.routes !== counts.routes ||
    actual.attempts !== counts.attempts ||
    actual.tracking_sessions !== counts.tracking_sessions ||
    actual.location_samples !== counts.location_samples ||
    (includeSettings && actual.settings !== counts.settings)
  ) {
    throw new BackupRejectedError(INTEGRITY_BACKUP_MESSAGE);
  }
}

function requireCounts(envelope: JsonRecord, includeSettings: boolean): BackupCountJson {
  const counts = requireRecord(envelope, 'counts');
  const parsed: BackupCountJson = {
    places: requireNonNegativeInteger(counts, 'places'),
    routes: requireNonNegativeInteger(counts, 'routes'),
    attempts: requireNonNegativeInteger(counts, 'attempts'),
    tracking_sessions: requireNonNegativeInteger(counts, 'tracking_sessions'),
    location_samples: requireNonNegativeInteger(counts, 'location_samples'),
    settings: includeSettings ? requireNonNegativeInteger(counts, 'settings') : 0,
  };
  return parsed;
}

function arrayLength(record: JsonRecord, key: string): number {
  return requireArray(record, key).length;
}

function requireFormatVersion(record: JsonRecord): number {
  const version = record.backup_format_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
  }
  return version;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  if (!isRecord(value)) {
    throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
  }
  return value;
}

function requireObject(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function requireArray(record: JsonRecord, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new BackupRejectedError(MALFORMED_BACKUP_MESSAGE);
  }
  return value;
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200 || /[\u0000-\u001f]/.test(value)) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function optionalNullableText(value: unknown, maxLength: number): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function optionalNullableId(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return requireId(value);
}

function optionalNullableString(record: JsonRecord, key: string): string | null {
  if (!(key in record) || record[key] == null) {
    return null;
  }
  if (typeof record[key] !== 'string' || (record[key] as string).length > 80) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return record[key] as string;
}

function optionalNullableStringValue(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string' || value.length > 200) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function requireTimestamp(record: JsonRecord, key: string): number {
  return requireNonNegative(record[key]);
}

function optionalNullableTimestamp(record: JsonRecord, key: string): number | null {
  if (!(key in record) || record[key] == null) {
    return null;
  }
  return requireNonNegative(record[key]);
}

function requireLatitude(value: unknown): number {
  const parsed = requireFiniteNumber(value);
  if (parsed < -90 || parsed > 90) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return parsed;
}

function requireLongitude(value: unknown): number {
  const parsed = requireFiniteNumber(value);
  if (parsed < -180 || parsed > 180) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return parsed;
}

function requirePositive(value: unknown): number {
  const parsed = requireFiniteNumber(value);
  if (parsed <= 0) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return parsed;
}

function requireNonNegative(value: unknown): number {
  const parsed = requireFiniteNumber(value);
  if (parsed < 0) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return parsed;
}

function optionalNullableNonNegative(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  return requireNonNegative(value);
}

function optionalNullableHeading(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const parsed = requireFiniteNumber(value);
  if (parsed < 0 || parsed > 360) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return parsed;
}

function optionalNullableOffset(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const parsed = requireFiniteNumber(value);
  if (!Number.isInteger(parsed) || parsed < -18 * 60 || parsed > 18 * 60) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return parsed;
}

function optionalLocalSource(value: unknown): AttemptLocalTimeSource | null {
  if (value == null) {
    return null;
  }
  if (value === 'captured' || value === 'reconstructed') {
    return value;
  }
  throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
}

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function requireNonNegativeInteger(record: JsonRecord, key: string): number {
  return requireNonNegativeIntegerValue(record[key]);
}

function requireNonNegativeIntegerValue(value: unknown): number {
  const parsed = requireFiniteNumber(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return parsed;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function requireOneOf(value: unknown, allowed: readonly string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
  }
  return value;
}

function requireMode(value: unknown): TransportationMode {
  return requireOneOf(value, ['scooter', 'bike', 'run', 'walk']) as TransportationMode;
}

function uniqueIds(ids: string[]): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new BackupRejectedError(INVALID_BACKUP_MESSAGE);
    }
    seen.add(id);
  }
  return seen;
}
