import { sha256Hex } from '../domain/sha256';
import { ACTIVE_TRANSPORTATION_MODE_KEY } from './settings-store';

/**
 * Product-level portable backup format. It is deliberately independent of SQLite's `user_version`:
 * the file is the contract, the database layout is not. See docs/specs/backup-format.md.
 */
export const BACKUP_FORMAT_ID = 'red-light-rng-backup';
export const CURRENT_BACKUP_FORMAT_VERSION = 1;
export const BACKUP_INTEGRITY_ALGORITHM = 'sha256';

/** Durable settings that materially change product behavior. Anything else in app_setting is a recomputable cache. */
export const BACKUP_SETTING_KEYS = [ACTIVE_TRANSPORTATION_MODE_KEY] as const;

export type BackupErrorCode =
  | 'unreadable'
  | 'wrong_format'
  | 'unsupported_version'
  | 'checksum_mismatch'
  | 'invalid_structure'
  | 'duplicate_id'
  | 'broken_reference'
  | 'count_mismatch'
  | 'live_state'
  | 'restore_failed';

export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

export type BackupPlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  status: string;
  created_at_ms: number;
};

export type BackupTrackingSession = {
  id: string;
  started_at_ms: number;
  stopped_at_ms: number | null;
  is_active: number;
  purpose: string;
  capture_outcome: string;
  review_disposition: string;
  background_permission_confirmed: number;
};

export type BackupLocationSample = {
  id: string;
  session_id: string;
  recorded_at_ms: number;
  latitude: number;
  longitude: number;
  horizontal_accuracy_meters: number | null;
  speed_meters_per_second: number | null;
  heading_degrees: number | null;
};

export type BackupRoutePoint = { latitude: number; longitude: number };
export type BackupRouteCheckpoint = { id: string; name: string; progress_m: number };

export type BackupRoute = {
  id: string;
  name: string;
  transportation_mode: string;
  created_at_ms: number;
  source_recording_id: string;
  start_latitude: number;
  start_longitude: number;
  start_radius_meters: number;
  finish_latitude: number;
  finish_longitude: number;
  finish_radius_meters: number;
  start_progress_m: number;
  finish_progress_m: number;
  status: string;
  kind: string;
  cluster_signature: string | null;
  classification_version: number;
  reference_path: BackupRoutePoint[];
  checkpoints: BackupRouteCheckpoint[];
};

export type BackupAttemptCrossing = {
  id: string;
  checkpoint_id: string;
  checkpoint_name: string;
  checkpoint_progress_m: number;
  crossed_at_ms: number;
};

export type BackupAttempt = {
  id: string;
  route_id: string | null;
  origin_place_id: string | null;
  destination_place_id: string | null;
  transportation_mode: string;
  session_id: string;
  lifecycle: string;
  validity: string;
  armed_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  started_utc_offset_minutes: number | null;
  started_timezone_id: string | null;
  started_local_time_source: string | null;
  result_acknowledged: number;
  hidden_incomplete: number;
  reconciliation_status: string;
  reconciliation_version: number;
  crossings: BackupAttemptCrossing[];
};

export type BackupSettings = Partial<Record<(typeof BACKUP_SETTING_KEYS)[number], string>>;

export type BackupPayload = {
  places: BackupPlace[];
  tracking_sessions: BackupTrackingSession[];
  location_samples: BackupLocationSample[];
  routes: BackupRoute[];
  attempts: BackupAttempt[];
  settings: BackupSettings;
};

export type BackupCounts = {
  places: number;
  routes: number;
  attempts: number;
  tracking_sessions: number;
  location_samples: number;
  route_reference_points: number;
  route_checkpoints: number;
  attempt_checkpoint_crossings: number;
  settings: number;
};

export type BackupSource = {
  app_version: string;
  schema_version: number;
};

export type BackupDocument = {
  format: typeof BACKUP_FORMAT_ID;
  backup_format_version: number;
  created_at_ms: number;
  created_at_utc: string;
  source: BackupSource;
  counts: BackupCounts;
  payload: BackupPayload;
  integrity: { algorithm: typeof BACKUP_INTEGRITY_ALGORITHM; digest: string };
};

export type BackupPreview = {
  formatVersion: number;
  createdAtMs: number;
  appVersion: string;
  schemaVersion: number;
  counts: BackupCounts;
  /** Non-null when an older format was migrated in memory before validation. */
  migratedFromVersion: number | null;
};

export type ParsedBackup = {
  payload: BackupPayload;
  preview: BackupPreview;
};

/**
 * Older-format adapters. Entry `n` converts the payload of format version `n` into version `n + 1`.
 * Format 1 is the first version, so the production registry is empty; the mechanism is exercised in
 * tests with a synthetic legacy fixture. Migrations must be pure and deterministic.
 */
export type BackupMigration = (payload: unknown) => unknown;
export const BACKUP_MIGRATIONS: Readonly<Record<number, BackupMigration>> = {};

export type ParseBackupOptions = {
  currentVersion?: number;
  migrations?: Readonly<Record<number, BackupMigration>>;
};

// ---------------------------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------------------------

/** JSON with recursively sorted object keys and no whitespace, so equal data is byte-identical. */
export function canonicalStringify(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BackupError('invalid_structure', 'Backup values must be finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item === undefined ? null : item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalStringify(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new BackupError('invalid_structure', 'Backup contains a value that cannot be serialized.');
}

export function countBackupRecords(payload: BackupPayload): BackupCounts {
  return {
    places: payload.places.length,
    routes: payload.routes.length,
    attempts: payload.attempts.length,
    tracking_sessions: payload.tracking_sessions.length,
    location_samples: payload.location_samples.length,
    route_reference_points: payload.routes.reduce((sum, route) => sum + route.reference_path.length, 0),
    route_checkpoints: payload.routes.reduce((sum, route) => sum + route.checkpoints.length, 0),
    attempt_checkpoint_crossings: payload.attempts.reduce((sum, attempt) => sum + attempt.crossings.length, 0),
    settings: Object.keys(payload.settings).length,
  };
}

function integrityDigest(document: Omit<BackupDocument, 'integrity'>): string {
  return sha256Hex(canonicalStringify(document));
}

export function buildBackupDocument(
  payload: BackupPayload,
  meta: { createdAtMs: number; source: BackupSource },
): BackupDocument {
  const body: Omit<BackupDocument, 'integrity'> = {
    format: BACKUP_FORMAT_ID,
    backup_format_version: CURRENT_BACKUP_FORMAT_VERSION,
    created_at_ms: meta.createdAtMs,
    created_at_utc: new Date(meta.createdAtMs).toISOString(),
    source: meta.source,
    counts: countBackupRecords(payload),
    payload,
  };
  return {
    ...body,
    integrity: { algorithm: BACKUP_INTEGRITY_ALGORITHM, digest: integrityDigest(body) },
  };
}

/** Serializes to the exact file text. Re-validates the output so a bad backup is never offered to the user. */
export function serializeBackup(
  payload: BackupPayload,
  meta: { createdAtMs: number; source: BackupSource },
): string {
  const text = canonicalStringify(buildBackupDocument(payload, meta));
  parseBackup(text);
  return text;
}

// ---------------------------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------------------------

type FieldCheck = (value: unknown) => boolean;

const isString: FieldCheck = (value) => typeof value === 'string';
const isNonEmptyString: FieldCheck = (value) => typeof value === 'string' && value.length > 0;
const isTimestamp: FieldCheck = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
// GPS-derived times are legitimately fractional: expo-location on iOS reports fix timestamps in
// fractional milliseconds (timeIntervalSince1970 * 1000), so stored sample times, place/route
// crossing times and the attempt/session times derived from them keep their exact values rather
// than being rounded or rejected. Other schema timestamps and integer counters retain strict checks.
const isInterpolatedTimestamp: FieldCheck = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const isNonNegativeInt: FieldCheck = isTimestamp;
const isFinite_: FieldCheck = (value) => typeof value === 'number' && Number.isFinite(value);
const isNonNegativeFinite: FieldCheck = (value) => isFinite_(value) && (value as number) >= 0;
const isPositiveFinite: FieldCheck = (value) => isFinite_(value) && (value as number) > 0;
const isLatitude: FieldCheck = (value) => isFinite_(value) && Math.abs(value as number) <= 90;
const isLongitude: FieldCheck = (value) => isFinite_(value) && Math.abs(value as number) <= 180;
const isBit: FieldCheck = (value) => value === 0 || value === 1;
const isUtcOffset: FieldCheck = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 24 * 60;
const isHeading: FieldCheck = (value) => isFinite_(value) && (value as number) >= 0 && (value as number) <= 360;
const nullable =
  (check: FieldCheck): FieldCheck =>
  (value) =>
    value === null || check(value);
const oneOf =
  (...allowed: string[]): FieldCheck =>
  (value) =>
    typeof value === 'string' && allowed.includes(value);

const MODES = oneOf('scooter', 'bike', 'run', 'walk');

type FieldSpec = Record<string, FieldCheck>;

const PLACE_FIELDS: FieldSpec = {
  id: isNonEmptyString,
  name: isString,
  latitude: isLatitude,
  longitude: isLongitude,
  radius_meters: isPositiveFinite,
  status: oneOf('active', 'archived'),
  created_at_ms: isTimestamp,
};

const SESSION_FIELDS: FieldSpec = {
  id: isNonEmptyString,
  started_at_ms: isInterpolatedTimestamp,
  stopped_at_ms: nullable(isInterpolatedTimestamp),
  is_active: isBit,
  purpose: oneOf('legacy', 'route_creation', 'attempt'),
  capture_outcome: oneOf('active', 'finished', 'cancelled', 'interrupted', 'unknown'),
  review_disposition: oneOf('pending', 'saved', 'discarded'),
  background_permission_confirmed: isBit,
};

const SAMPLE_FIELDS: FieldSpec = {
  id: isNonEmptyString,
  session_id: isNonEmptyString,
  recorded_at_ms: isInterpolatedTimestamp,
  latitude: isLatitude,
  longitude: isLongitude,
  horizontal_accuracy_meters: nullable(isNonNegativeFinite),
  speed_meters_per_second: nullable(isNonNegativeFinite),
  heading_degrees: nullable(isHeading),
};

const ROUTE_FIELDS: FieldSpec = {
  id: isNonEmptyString,
  name: isString,
  transportation_mode: MODES,
  created_at_ms: isTimestamp,
  source_recording_id: isNonEmptyString,
  start_latitude: isLatitude,
  start_longitude: isLongitude,
  start_radius_meters: isPositiveFinite,
  finish_latitude: isLatitude,
  finish_longitude: isLongitude,
  finish_radius_meters: isPositiveFinite,
  start_progress_m: isNonNegativeFinite,
  finish_progress_m: isNonNegativeFinite,
  status: oneOf('active', 'archived'),
  kind: oneOf('explicit', 'discovered'),
  cluster_signature: nullable(isString),
  classification_version: isNonNegativeInt,
  reference_path: (value) => Array.isArray(value),
  checkpoints: (value) => Array.isArray(value),
};

const ROUTE_POINT_FIELDS: FieldSpec = { latitude: isLatitude, longitude: isLongitude };
const ROUTE_CHECKPOINT_FIELDS: FieldSpec = {
  id: isNonEmptyString,
  name: isString,
  progress_m: isNonNegativeFinite,
};

const ATTEMPT_FIELDS: FieldSpec = {
  id: isNonEmptyString,
  route_id: nullable(isNonEmptyString),
  origin_place_id: nullable(isNonEmptyString),
  destination_place_id: nullable(isNonEmptyString),
  transportation_mode: MODES,
  session_id: isNonEmptyString,
  lifecycle: oneOf('armed', 'active', 'completed', 'cancelled', 'abandoned', 'ended'),
  validity: oneOf('pending', 'valid', 'unranked'),
  armed_at_ms: isTimestamp,
  started_at_ms: nullable(isInterpolatedTimestamp),
  finished_at_ms: nullable(isInterpolatedTimestamp),
  started_utc_offset_minutes: nullable(isUtcOffset),
  started_timezone_id: nullable(isString),
  started_local_time_source: nullable(oneOf('captured', 'reconstructed')),
  result_acknowledged: isBit,
  hidden_incomplete: isBit,
  reconciliation_status: oneOf('pending', 'reconciled', 'failed'),
  reconciliation_version: isNonNegativeInt,
  crossings: (value) => Array.isArray(value),
};

const CROSSING_FIELDS: FieldSpec = {
  id: isNonEmptyString,
  checkpoint_id: isNonEmptyString,
  checkpoint_name: isString,
  checkpoint_progress_m: isNonNegativeFinite,
  crossed_at_ms: isInterpolatedTimestamp,
};

function invalid(message: string): never {
  throw new BackupError('invalid_structure', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkRecord(value: unknown, spec: FieldSpec, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return invalid(`${path} must be an object.`);
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!(key in spec)) {
      return invalid(`${path} has an unexpected field "${key}".`);
    }
  }
  for (const [key, check] of Object.entries(spec)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return invalid(`${path} is missing "${key}".`);
    }
    if (!check(value[key])) {
      return invalid(`${path}.${key} has an invalid value.`);
    }
  }
  return value;
}

function checkList<T>(value: unknown, spec: FieldSpec, path: string): T[] {
  if (!Array.isArray(value)) {
    return invalid(`${path} must be a list.`);
  }
  return value.map((item, index) => checkRecord(item, spec, `${path}[${index}]`) as T);
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new BackupError('duplicate_id', `Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function broken(message: string): never {
  throw new BackupError('broken_reference', message);
}

export function validateBackupPayload(input: unknown): BackupPayload {
  if (!isPlainObject(input)) {
    return invalid('Backup payload must be an object.');
  }
  const allowed = ['places', 'tracking_sessions', 'location_samples', 'routes', 'attempts', 'settings'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return invalid(`Backup payload has an unexpected section "${key}".`);
    }
  }
  const places = checkList<BackupPlace>(input.places, PLACE_FIELDS, 'places');
  const sessions = checkList<BackupTrackingSession>(input.tracking_sessions, SESSION_FIELDS, 'tracking_sessions');
  const samples = checkList<BackupLocationSample>(input.location_samples, SAMPLE_FIELDS, 'location_samples');
  const routes = checkList<BackupRoute>(input.routes, ROUTE_FIELDS, 'routes');
  for (const [routeIndex, route] of routes.entries()) {
    route.reference_path = checkList<BackupRoutePoint>(
      route.reference_path,
      ROUTE_POINT_FIELDS,
      `routes[${routeIndex}].reference_path`,
    );
    route.checkpoints = checkList<BackupRouteCheckpoint>(
      route.checkpoints,
      ROUTE_CHECKPOINT_FIELDS,
      `routes[${routeIndex}].checkpoints`,
    );
  }
  const attempts = checkList<BackupAttempt>(input.attempts, ATTEMPT_FIELDS, 'attempts');
  for (const [attemptIndex, attempt] of attempts.entries()) {
    attempt.crossings = checkList<BackupAttemptCrossing>(
      attempt.crossings,
      CROSSING_FIELDS,
      `attempts[${attemptIndex}].crossings`,
    );
  }
  if (!isPlainObject(input.settings)) {
    return invalid('settings must be an object.');
  }
  const settings: BackupSettings = {};
  for (const [key, value] of Object.entries(input.settings)) {
    if (!(BACKUP_SETTING_KEYS as readonly string[]).includes(key)) {
      return invalid(`settings has an unexpected key "${key}".`);
    }
    if (typeof value !== 'string') {
      return invalid(`settings.${key} must be a string.`);
    }
    if (key === ACTIVE_TRANSPORTATION_MODE_KEY && !MODES(value)) {
      return invalid(`settings.${key} has an invalid value.`);
    }
    (settings as Record<string, string>)[key] = value;
  }

  assertUnique(places.map((item) => item.id), 'place id');
  assertUnique(sessions.map((item) => item.id), 'tracking session id');
  assertUnique(samples.map((item) => item.id), 'location sample id');
  assertUnique(routes.map((item) => item.id), 'route id');
  assertUnique(routes.map((item) => item.source_recording_id), 'route source recording');
  assertUnique(attempts.map((item) => item.id), 'attempt id');
  assertUnique(attempts.map((item) => item.session_id), 'attempt session');
  assertUnique(
    routes.flatMap((route) => route.checkpoints.map((item) => item.id)),
    'route checkpoint id',
  );
  assertUnique(
    attempts.flatMap((attempt) => attempt.crossings.map((item) => item.id)),
    'attempt crossing id',
  );

  const placeIds = new Set(places.map((item) => item.id));
  const sessionIds = new Set(sessions.map((item) => item.id));
  const routeIds = new Set(routes.map((item) => item.id));
  for (const sample of samples) {
    if (!sessionIds.has(sample.session_id)) {
      broken(`Location sample ${sample.id} references a missing tracking session.`);
    }
  }
  for (const route of routes) {
    if (!sessionIds.has(route.source_recording_id)) {
      broken(`Route ${route.id} references a missing source recording.`);
    }
  }
  for (const attempt of attempts) {
    if (!sessionIds.has(attempt.session_id)) {
      broken(`Attempt ${attempt.id} references a missing tracking session.`);
    }
    if (attempt.route_id != null && !routeIds.has(attempt.route_id)) {
      broken(`Attempt ${attempt.id} references a missing route.`);
    }
    for (const placeId of [attempt.origin_place_id, attempt.destination_place_id]) {
      if (placeId != null && !placeIds.has(placeId)) {
        broken(`Attempt ${attempt.id} references a missing place.`);
      }
    }
    if (
      attempt.started_at_ms != null &&
      attempt.finished_at_ms != null &&
      attempt.finished_at_ms < attempt.started_at_ms
    ) {
      invalid(`Attempt ${attempt.id} finishes before it starts.`);
    }
    if (attempt.started_at_ms == null && attempt.finished_at_ms != null) {
      invalid(`Attempt ${attempt.id} has a finish time but no start time.`);
    }
  }
  // Tracking session start/stop times come from the device wall clock, which can be corrected
  // backwards mid-recording. A stop-before-start ordering check here would make export fail for
  // real local history, so only the structural timestamp checks above apply to sessions.

  return {
    places,
    tracking_sessions: sessions,
    location_samples: samples,
    routes,
    attempts,
    settings,
  };
}

// ---------------------------------------------------------------------------------------------
// Parsing: unreadable/truncated -> wrong format -> version -> integrity -> migrate -> validate
// ---------------------------------------------------------------------------------------------

function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Parses and fully validates a backup file without touching any database. */
export function parseBackup(text: string, options: ParseBackupOptions = {}): ParsedBackup {
  const currentVersion = options.currentVersion ?? CURRENT_BACKUP_FORMAT_VERSION;
  const migrations = options.migrations ?? BACKUP_MIGRATIONS;

  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new BackupError(
      'unreadable',
      'This file is not a complete backup. It may be truncated, corrupted or not a Red Light RNG backup.',
    );
  }
  if (!isPlainObject(raw) || raw.format !== BACKUP_FORMAT_ID) {
    throw new BackupError('wrong_format', 'This is not a Red Light RNG backup file.');
  }
  const version = raw.backup_format_version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new BackupError('wrong_format', 'This backup has no valid format version.');
  }
  if (version > currentVersion) {
    throw new BackupError(
      'unsupported_version',
      `This backup uses format version ${version}, which is newer than this app supports (version ${currentVersion}). Update the app to restore it.`,
    );
  }
  for (let step = version; step < currentVersion; step += 1) {
    if (!migrations[step]) {
      throw new BackupError(
        'unsupported_version',
        `Backup format version ${version} is no longer supported by this app.`,
      );
    }
  }

  const integrity = raw.integrity;
  if (
    !isPlainObject(integrity) ||
    integrity.algorithm !== BACKUP_INTEGRITY_ALGORITHM ||
    !isHexDigest(integrity.digest)
  ) {
    throw new BackupError('checksum_mismatch', 'This backup has no valid integrity check.');
  }
  const { integrity: _integrity, ...body } = raw;
  if (sha256Hex(canonicalStringify(body)) !== integrity.digest) {
    throw new BackupError(
      'checksum_mismatch',
      'The integrity check failed. The backup is corrupted or was modified.',
    );
  }

  const bodyKeys = [
    'format',
    'backup_format_version',
    'created_at_ms',
    'created_at_utc',
    'source',
    'counts',
    'payload',
  ];
  for (const key of Object.keys(body)) {
    if (!bodyKeys.includes(key)) {
      invalid(`Backup has an unexpected field "${key}".`);
    }
  }
  if (!isTimestamp(body.created_at_ms)) {
    invalid('Backup creation time is invalid.');
  }
  if (body.created_at_utc !== new Date(body.created_at_ms as number).toISOString()) {
    invalid('Backup creation time is inconsistent.');
  }
  const source = checkRecord(body.source, { app_version: isString, schema_version: isNonNegativeInt }, 'source');

  let payloadInput: unknown = body.payload;
  for (let step = version; step < currentVersion; step += 1) {
    payloadInput = migrations[step]!(payloadInput);
  }
  const payload = validateBackupPayload(payloadInput);
  const counts = countBackupRecords(payload);
  if (version === currentVersion && canonicalStringify(body.counts) !== canonicalStringify(counts)) {
    throw new BackupError('count_mismatch', 'The record counts in the backup do not match its contents.');
  }

  return {
    payload,
    preview: {
      formatVersion: version,
      createdAtMs: body.created_at_ms as number,
      appVersion: source.app_version as string,
      schemaVersion: source.schema_version as number,
      counts,
      migratedFromVersion: version === currentVersion ? null : version,
    },
  };
}
