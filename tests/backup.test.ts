import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { incompleteAttemptLabel } from '../src/domain/attempt';
import { attemptDepartureWallClock } from '../src/domain/attempt-local-time';
import { sha256Hex } from '../src/domain/sha256';
import { applyMigrations } from '../src/persistence/migrations';
import {
  BackupError,
  BACKUP_FORMAT_ID,
  CURRENT_BACKUP_FORMAT_VERSION,
  buildBackupDocument,
  canonicalStringify,
  parseBackup,
  serializeBackup,
  type BackupErrorCode,
  type BackupPayload,
} from '../src/persistence/backup-format';
import {
  BACKUP_EXCLUDED_SETTING_KEYS,
  BACKUP_SCHEMA_COVERAGE,
  exportBackup,
  readBackupSnapshot,
} from '../src/persistence/backup-snapshot';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import type { SqlExecutor } from '../src/persistence/sql-executor';
import {
  BACKUP_PRIVACY_WARNING,
  RESTORE_CONFIRM_LABEL,
  RESTORE_REPLACE_WARNING,
} from '../src/product/backup-copy';
import {
  assertNoLiveState,
  restoreBackupPayload,
  terminalizeRestoredLiveState,
} from '../src/product/backup-restore';
import { BackupService, backupFileName, type BackupFileGateway } from '../src/product/backup-service';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';
import {
  BASE_MS,
  HOME,
  OFFSET_PLUS_180_START_MS,
  WORK,
  baseAttempt,
  dumpDatabase,
  openMigratedDb,
  seedRepresentativeHistory,
  seedSession,
} from './helpers/backup-fixtures';
import { completeJourneySamples, departureOnlySamples } from './helpers/places';
import { northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';
import { createNodeSqlExecutor } from './helpers/node-sql-executor';
import { createSqliteWorkspace } from './helpers/workspace';

const CREATED_AT_MS = BASE_MS + 5_000_000;
const SOURCE = { app_version: '0.1.0', schema_version: 11 };

async function exportText(sql: SqlExecutor, nowMs = CREATED_AT_MS): Promise<string> {
  return (await exportBackup(sql, { nowMs, appVersion: '0.1.0' })).text;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resign(document: Record<string, unknown>): string {
  const { integrity: _ignored, ...body } = document;
  return canonicalStringify({
    ...body,
    integrity: { algorithm: 'sha256', digest: sha256Hex(canonicalStringify(body)) },
  });
}

function mutatePayload(text: string, mutate: (payload: Record<string, any>) => void): string {
  const document = JSON.parse(text) as Record<string, any>;
  mutate(document.payload);
  return resign(document);
}

/** Wraps an executor, counting writes and optionally failing statements that match. */
function instrument(
  base: SqlExecutor,
  options: { failWhen?: (sql: string) => boolean } = {},
): SqlExecutor & { writes: number } {
  const counter = { writes: 0 };
  const wrapped = {
    ...base,
    get writes() {
      return counter.writes;
    },
    async exec(sql: string) {
      counter.writes += 1;
      return base.exec(sql);
    },
    async run(sql: string, params?: Parameters<SqlExecutor['run']>[1]) {
      if (options.failWhen?.(sql)) {
        throw new Error(`injected failure: ${sql.slice(0, 40)}`);
      }
      counter.writes += 1;
      return base.run(sql, params);
    },
    async getAll<T>(sql: string, params?: Parameters<SqlExecutor['getAll']>[1]) {
      if (options.failWhen?.(sql)) {
        throw new Error(`injected failure: ${sql.slice(0, 40)}`);
      }
      return base.getAll<T>(sql, params);
    },
  };
  return wrapped as SqlExecutor & { writes: number };
}

async function expectBackupError(run: () => unknown | Promise<unknown>, code: BackupErrorCode) {
  await assert.rejects(
    async () => {
      await run();
    },
    (error: unknown) => {
      assert.ok(error instanceof BackupError, `expected BackupError, got ${String(error)}`);
      assert.equal(error.code, code, error.message);
      return true;
    },
  );
}

async function seedSecondHistory(sql: SqlExecutor): Promise<void> {
  await sql.run(
    `INSERT INTO place (id, name, latitude, longitude, radius_meters, status, created_at_ms)
     VALUES ('other-place', 'Elsewhere', 10, 10, 40, 'active', 7)`,
  );
  await seedSession(sql, {
    id: 'other-session',
    startedAtMs: 10,
    stoppedAtMs: 20,
    purpose: 'attempt',
    captureOutcome: 'finished',
    reviewDisposition: 'saved',
  });
  const attempts = new SqliteAttemptStore(async () => sql);
  await attempts.saveAttempt(
    baseAttempt({
      id: 'other-attempt',
      sessionId: 'other-session',
      originPlaceId: 'other-place',
      destinationPlaceId: 'other-place',
      armedAtMs: 10,
    }),
  );
}

async function seedLiveHistory(sql: SqlExecutor, options: { routeRecording?: boolean } = {}): Promise<void> {
  const places = [HOME, WORK];
  for (const place of places) {
    await sql.run(
      `INSERT INTO place (id, name, latitude, longitude, radius_meters, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [place.id, place.name, place.center.latitude, place.center.longitude, place.radiusMeters, place.status, place.createdAtMs],
    );
  }
  const attempts = new SqliteAttemptStore(async () => sql);
  // Armed attempt with complete official start + finish evidence in its stored samples.
  const strong = completeJourneySamples({ origin: HOME, destination: WORK, sessionId: 's-armed-strong', startMs: BASE_MS });
  await seedSession(
    sql,
    {
      id: 's-armed-strong',
      startedAtMs: BASE_MS - 2_000,
      stoppedAtMs: null,
      isActive: true,
      purpose: 'attempt',
      captureOutcome: 'active',
      reviewDisposition: 'pending',
      backgroundPermissionConfirmed: true,
    },
    strong,
  );
  await attempts.saveAttempt(
    baseAttempt({
      id: 'attempt-armed-strong',
      sessionId: 's-armed-strong',
      lifecycle: 'armed',
      validity: 'pending',
      armedAtMs: BASE_MS - 2_000,
      resultAcknowledged: false,
      reconciliationStatus: 'pending',
      reconciliationVersion: 0,
    }),
  );
  // Active attempt with only a dwell at the origin: no trustworthy finish.
  const weak = departureOnlySamples({ origin: HOME, sessionId: 's-active-weak', startMs: BASE_MS + 100_000 });
  await seedSession(
    sql,
    {
      id: 's-active-weak',
      startedAtMs: BASE_MS + 99_000,
      stoppedAtMs: null,
      isActive: true,
      purpose: 'attempt',
      captureOutcome: 'active',
      reviewDisposition: 'pending',
    },
    weak,
  );
  await attempts.saveAttempt(
    baseAttempt({
      id: 'attempt-active-weak',
      sessionId: 's-active-weak',
      lifecycle: 'active',
      validity: 'pending',
      originPlaceId: HOME.id,
      armedAtMs: BASE_MS + 99_000,
      startedAtMs: BASE_MS + 101_000,
      resultAcknowledged: false,
      reconciliationStatus: 'pending',
      reconciliationVersion: 0,
    }),
  );
  if (options.routeRecording === false) {
    return;
  }
  // An unfinished route recording that was still active.
  await seedSession(sql, {
    id: 's-route-active',
    startedAtMs: BASE_MS + 200_000,
    stoppedAtMs: null,
    isActive: true,
    purpose: 'route_creation',
    captureOutcome: 'active',
    reviewDisposition: 'pending',
  });
}

describe('sha256', () => {
  it('matches node:crypto across padding boundaries and unicode', () => {
    const inputs = [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(65),
      'héllo wörld ☃ \u{1f600} 日本語',
      JSON.stringify({ k: 'v'.repeat(100_000) }),
    ];
    for (const input of inputs) {
      assert.equal(sha256Hex(input), createHash('sha256').update(input, 'utf8').digest('hex'));
    }
  });
});

describe('backup format and deterministic serialization', () => {
  it('canonicalizes key order and serializes identically regardless of input order', async () => {
    assert.equal(canonicalStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    const sql = await openMigratedDb();
    await seedRepresentativeHistory(sql);
    const payload = await readBackupSnapshot(sql);
    const reordered = JSON.parse(JSON.stringify(payload, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value)) as BackupPayload;
    const meta = { createdAtMs: CREATED_AT_MS, source: SOURCE };
    assert.equal(serializeBackup(payload, meta), serializeBackup(reordered, meta));
    assert.equal(await exportText(sql), await exportText(sql));
  });

  it('writes the documented envelope with version, timestamps, source, counts and sha256 integrity', async () => {
    const sql = await openMigratedDb();
    await seedRepresentativeHistory(sql);
    const document = JSON.parse(await exportText(sql));
    assert.equal(document.format, BACKUP_FORMAT_ID);
    assert.equal(document.backup_format_version, CURRENT_BACKUP_FORMAT_VERSION);
    assert.equal(document.created_at_ms, CREATED_AT_MS);
    assert.equal(document.created_at_utc, new Date(CREATED_AT_MS).toISOString());
    assert.deepEqual(document.source, { app_version: '0.1.0', schema_version: 11 });
    assert.deepEqual(document.counts, {
      places: 3,
      routes: 2,
      attempts: 3,
      tracking_sessions: 6,
      location_samples: document.payload.location_samples.length,
      route_reference_points: document.payload.routes.reduce((n: number, r: any) => n + r.reference_path.length, 0),
      route_checkpoints: 2,
      attempt_checkpoint_crossings: 2,
      settings: 1,
    });
    assert.equal(document.integrity.algorithm, 'sha256');
    assert.match(document.integrity.digest, /^[0-9a-f]{64}$/);
    const { integrity, ...body } = document;
    assert.equal(integrity.digest, createHash('sha256').update(canonicalStringify(body)).digest('hex'));
    const parsed = parseBackup(JSON.stringify(document, null, 2));
    assert.equal(parsed.preview.formatVersion, 1);
    assert.equal(parsed.preview.createdAtMs, CREATED_AT_MS);
    assert.equal(parsed.preview.counts.attempts, 3);
    assert.equal(backupFileName(Date.UTC(2023, 10, 25, 8, 46, 40)), 'red-light-rng-backup-20231125T084640Z.json');
    assert.match(backupFileName(CREATED_AT_MS), /^red-light-rng-backup-\d{8}T\d{6}Z\.json$/);
  });

  it('accounts for every schema column: exported or explicitly excluded', async () => {
    const sql = await openMigratedDb();
    const tables = await sql.getAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );
    assert.deepEqual(
      tables.map((table) => table.name),
      Object.keys(BACKUP_SCHEMA_COVERAGE).sort(),
      'a new table must be added to BACKUP_SCHEMA_COVERAGE (exported) or consciously excluded',
    );
    for (const { name } of tables) {
      const columns = (await sql.getAll<{ name: string }>(`PRAGMA table_info(${name})`)).map((c) => c.name).sort();
      assert.deepEqual(columns, Object.keys(BACKUP_SCHEMA_COVERAGE[name]!).sort(), `columns of ${name}`);
    }
    assert.deepEqual(Object.keys(BACKUP_EXCLUDED_SETTING_KEYS), ['path_variant_recompute_fingerprint']);
  });
});

describe('backup round trips', () => {
  it('exports and restores fractional official and checkpoint times from real GPS interpolation unchanged', async () => {
    // Real place/route crossing interpolation produces fractional milliseconds. SQLite stores
    // these as REAL even in INTEGER-affinity columns; export must not reject or round them.
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    await source.run(
      "UPDATE attempt SET started_at_ms = started_at_ms + 0.375, finished_at_ms = finished_at_ms + 0.625 WHERE id = 'attempt-complete'",
    );
    await source.run(
      "UPDATE attempt_checkpoint_crossing SET crossed_at_ms = crossed_at_ms + 0.125 WHERE attempt_id = 'attempt-complete'",
    );
    const original = await source.getFirst<{ started_at_ms: number; finished_at_ms: number }>(
      "SELECT started_at_ms, finished_at_ms FROM attempt WHERE id = 'attempt-complete'",
    );
    assert.ok(original);
    assert.equal(original.started_at_ms % 1, 0.375);
    assert.equal(original.finished_at_ms % 1, 0.625);

    const fileText = await exportText(source);
    const { payload } = parseBackup(fileText);
    const attempt = payload.attempts.find((item) => item.id === 'attempt-complete');
    assert.ok(attempt);
    assert.equal(attempt.started_at_ms, original.started_at_ms);
    assert.equal(attempt.finished_at_ms, original.finished_at_ms);
    assert.ok(attempt.crossings.length > 0);
    assert.ok(attempt.crossings.some((crossing) => crossing.crossed_at_ms % 1 === 0.125));

    const target = await openMigratedDb();
    await restoreBackupPayload(target, payload);
    assert.equal(await exportText(target), fileText, 'no timestamp rounding or history loss');
  });

  it('round-trips a clean install, replacing existing data with an empty history', async () => {
    const empty = await openMigratedDb();
    const text = await exportText(empty);
    const parsed = parseBackup(text);
    assert.equal(parsed.preview.counts.attempts, 0);
    assert.equal(parsed.preview.counts.places, 0);

    const fresh = await openMigratedDb();
    await restoreBackupPayload(fresh, parsed.payload);
    assert.equal(await exportText(fresh), text);
    assert.deepEqual(await dumpDatabase(fresh), await dumpDatabase(empty));

    const populated = await openMigratedDb();
    await seedRepresentativeHistory(populated);
    await restoreBackupPayload(populated, parsed.payload);
    assert.equal(await exportText(populated), text);
    assert.equal((await populated.getFirst<{ n: number }>('SELECT COUNT(*) AS n FROM attempt'))?.n, 0);
  });

  it('round-trips a complete representative history field for field', async () => {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const text = await exportText(source);

    const target = await openMigratedDb();
    await seedSecondHistory(target);
    const parsed = parseBackup(text);
    const result = await restoreBackupPayload(target, parsed.payload);
    assert.deepEqual(result.terminalization, { attempts: [], sessionIds: [] });

    // Byte-identical re-export proves every exported field survived.
    assert.equal(await exportText(target), text);

    const sourceAttempts = await new SqliteAttemptStore(async () => source).listAttempts();
    const targetAttempts = await new SqliteAttemptStore(async () => target).listAttempts();
    assert.deepEqual(plain(targetAttempts), plain(sourceAttempts));
    const byId = new Map(targetAttempts.map((attempt) => [attempt.id, attempt]));
    const complete = byId.get('attempt-complete')!;
    assert.equal(complete.startedUtcOffsetMinutes, 120);
    assert.equal(complete.startedTimezoneId, 'Asia/Jerusalem');
    assert.equal(complete.startedLocalTimeSource, 'reconstructed');
    assert.equal(complete.resultAcknowledged, false);
    assert.equal(complete.routeId, 'route-explicit');
    assert.equal(complete.crossings.length, 2);
    assert.equal(complete.originPlaceId, HOME.id);
    assert.equal(complete.destinationPlaceId, WORK.id);
    assert.equal(byId.get('attempt-tz')!.reconciliationStatus, 'failed');
    const dnf = byId.get('attempt-dnf')!;
    assert.equal(dnf.hiddenIncomplete, true);
    assert.equal(dnf.resultAcknowledged, true);
    assert.equal(dnf.startedUtcOffsetMinutes, -300);
    assert.equal(dnf.startedTimezoneId, 'America/New_York');
    assert.equal(dnf.lifecycle, 'ended');

    const sourceRoutes = await new SqliteRouteStore(async () => source).listRoutes();
    const targetRoutes = await new SqliteRouteStore(async () => target).listRoutes();
    assert.deepEqual(plain(targetRoutes), plain(sourceRoutes));
    const discovered = targetRoutes.find((route) => route.id === 'route-discovered')!;
    assert.equal(discovered.status, 'archived');
    assert.equal(discovered.kind, 'discovered');
    assert.equal(discovered.clusterSignature, 'cluster-signature-1');
    assert.equal(discovered.sourceRecordingId, 's-complete');
    assert.equal(discovered.classificationVersion, 3);
    assert.equal(targetRoutes.find((route) => route.id === 'route-explicit')!.checkpoints.length, 2);

    const sourceSessions = new SqliteLocationSampleStore(async () => source);
    const targetSessions = new SqliteLocationSampleStore(async () => target);
    for (const id of ['s-complete', 's-tz', 's-dnf', 's-source', 's-pending', 's-legacy']) {
      assert.deepEqual(await targetSessions.getSession(id), await sourceSessions.getSession(id), id);
      assert.deepEqual(await targetSessions.listSamples(id), await sourceSessions.listSamples(id), id);
    }
    assert.equal((await targetSessions.findPendingRouteCreation())?.id, 's-pending');

    const settings = await target.getAll<{ key: string; value: string }>('SELECT key, value FROM app_setting ORDER BY key');
    assert.deepEqual(settings.map((row) => ({ ...row })), [{ key: 'active_transportation_mode', value: 'bike' }]);
    // The previous history is gone: replace, never merge.
    assert.equal(await targetSessions.getSession('other-session'), null);
    assert.equal((await target.getFirst<{ n: number }>(`SELECT COUNT(*) AS n FROM place WHERE id = 'other-place'`))?.n, 0);
  });

  it('keeps an attempt with a +180 minute offset on the same local weekday under a different process timezone', async () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const source = await openMigratedDb();
      await seedRepresentativeHistory(source);
      const text = await exportText(source);
      const original = (await new SqliteAttemptStore(async () => source).getAttempt('attempt-tz'))!;
      assert.equal(original.startedAtMs, OFFSET_PLUS_180_START_MS + 2_000);
      assert.equal(new Date(original.startedAtMs!).getUTCDay(), 2, 'Tuesday in UTC');
      const wallClock = attemptDepartureWallClock(original)!;
      assert.equal(wallClock.weekday, 3, 'Wednesday at UTC+3');

      process.env.TZ = 'America/Los_Angeles';
      assert.equal(new Date(original.startedAtMs!).getDay(), 2, 'device-local weekday would be Tuesday');
      const target = await openMigratedDb();
      await restoreBackupPayload(target, parseBackup(text).payload);
      const restored = (await new SqliteAttemptStore(async () => target).getAttempt('attempt-tz'))!;
      assert.equal(restored.startedUtcOffsetMinutes, 180);
      assert.equal(restored.startedTimezoneId, 'Europe/Moscow');
      assert.equal(restored.startedLocalTimeSource, 'captured');
      assert.deepEqual(attemptDepartureWallClock(restored), wallClock);
      assert.equal(attemptDepartureWallClock(restored)!.weekday, 3);
    } finally {
      if (previous === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previous;
      }
    }
  });
});

describe('backup validation rejects bad files with zero writes', () => {
  async function setup() {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const text = await exportText(source);
    const target = await openMigratedDb();
    await seedSecondHistory(target);
    const before = await dumpDatabase(target);
    const counted = instrument(target);
    const service = new BackupService(
      async () => counted,
      { shareBackupFile: async () => {}, pickBackupFile: async () => null },
      { stopLocationUpdates: async () => {}, invalidateDerivedCaches: () => {}, recomputeDerived: async () => {} },
      '0.1.0',
    );
    return { text, target, before, counted, service };
  }

  const cases: { name: string; code: BackupErrorCode; make: (text: string) => string }[] = [
    { name: 'empty file', code: 'unreadable', make: () => '' },
    { name: 'not JSON', code: 'unreadable', make: () => 'definitely not a backup' },
    { name: 'truncated file', code: 'unreadable', make: (text) => text.slice(0, Math.floor(text.length / 2)) },
    { name: 'truncated by one byte', code: 'unreadable', make: (text) => text.slice(0, -1) },
    { name: 'JSON of another kind', code: 'wrong_format', make: () => '{"hello":"world"}' },
    { name: 'JSON array', code: 'wrong_format', make: () => '[1,2,3]' },
    {
      name: 'checksum mismatch after edit',
      code: 'checksum_mismatch',
      make: (text) => text.replace('"name":"Home"', '"name":"Hame"'),
    },
    {
      name: 'checksum mismatch after sample tampering',
      code: 'checksum_mismatch',
      make: (text) => text.replace(/"latitude":(\d+)/, '"latitude":1$1'),
    },
    {
      name: 'missing integrity block',
      code: 'checksum_mismatch',
      make: (text) => {
        const document = JSON.parse(text);
        delete document.integrity;
        return JSON.stringify(document);
      },
    },
    {
      name: 'future format version',
      code: 'unsupported_version',
      make: (text) => text.replace('"backup_format_version":1', '"backup_format_version":2'),
    },
    {
      name: 'future format version with valid checksum',
      code: 'unsupported_version',
      make: (text) => {
        const document = JSON.parse(text);
        document.backup_format_version = 99;
        return resign(document);
      },
    },
    {
      name: 'unknown older version without a registered adapter',
      code: 'unsupported_version',
      make: (text) => {
        const document = JSON.parse(text);
        document.backup_format_version = 0;
        return resign(document);
      },
    },
    {
      name: 'broken attempt -> place reference',
      code: 'broken_reference',
      make: (text) => mutatePayload(text, (p) => { p.attempts[0].origin_place_id = 'missing-place'; }),
    },
    {
      name: 'broken attempt -> session reference',
      code: 'broken_reference',
      make: (text) => mutatePayload(text, (p) => { p.attempts[0].session_id = 'missing-session'; }),
    },
    {
      name: 'broken attempt -> route reference',
      code: 'broken_reference',
      make: (text) => mutatePayload(text, (p) => { p.attempts[0].route_id = 'missing-route'; }),
    },
    {
      name: 'broken sample -> session reference',
      code: 'broken_reference',
      make: (text) => mutatePayload(text, (p) => { p.location_samples[0].session_id = 'missing-session'; }),
    },
    {
      name: 'broken route -> source recording reference',
      code: 'broken_reference',
      make: (text) => mutatePayload(text, (p) => { p.routes[0].source_recording_id = 'missing-session'; }),
    },
    {
      name: 'duplicate place ids',
      code: 'duplicate_id',
      make: (text) => mutatePayload(text, (p) => { p.places[1].id = p.places[0].id; }),
    },
    {
      name: 'duplicate sample ids',
      code: 'duplicate_id',
      make: (text) => mutatePayload(text, (p) => { p.location_samples[1].id = p.location_samples[0].id; }),
    },
    {
      name: 'two attempts sharing one session',
      code: 'duplicate_id',
      make: (text) => mutatePayload(text, (p) => { p.attempts[1].session_id = p.attempts[0].session_id; }),
    },
    {
      name: 'latitude out of range',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.places[0].latitude = 91; }),
    },
    {
      name: 'longitude out of range',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.location_samples[0].longitude = -181; }),
    },
    {
      name: 'non-integer timestamp',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.attempts[0].armed_at_ms = 1.5; }),
    },
    {
      name: 'negative timestamp',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.tracking_sessions[0].started_at_ms = -1; }),
    },
    {
      name: 'string where a number belongs',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.places[0].radius_meters = '50'; }),
    },
    {
      name: 'unknown enum value',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.attempts[0].lifecycle = 'teleported'; }),
    },
    {
      name: 'unexpected field',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.places[0].secret = 'x'; }),
    },
    {
      name: 'missing field',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { delete p.attempts[0].hidden_incomplete; }),
    },
    {
      name: 'finish before start',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.attempts[0].finished_at_ms = 1; }),
    },
    {
      name: 'unexpected setting key',
      code: 'invalid_structure',
      make: (text) => mutatePayload(text, (p) => { p.settings.path_variant_recompute_fingerprint = 'x'; }),
    },
    {
      name: 'record counts that do not match contents',
      code: 'count_mismatch',
      make: (text) => {
        const document = JSON.parse(text);
        document.counts.attempts += 1;
        return resign(document);
      },
    },
  ];

  for (const testCase of cases) {
    it(`rejects: ${testCase.name}`, async () => {
      const { text, before, counted, service, target } = await setup();
      const bad = testCase.make(text);
      assert.notEqual(bad, text);
      await expectBackupError(() => service.previewText('bad.json', bad), testCase.code);
      await expectBackupError(() => parseBackup(bad), testCase.code);
      assert.equal(counted.writes, 0, 'no write statements issued');
      assert.deepEqual(await dumpDatabase(target), before, 'database unchanged');
    });
  }

  it('accepts the unmodified file', async () => {
    const { text, service } = await setup();
    const pending = await service.previewText('ok.json', text);
    assert.equal(pending.preview.counts.attempts, 3);
  });
});

describe('older-format migration mechanism', () => {
  it('migrates a synthetic legacy format deterministically and rejects gaps', async () => {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const current = JSON.parse(await exportText(source)) as Record<string, any>;

    // Synthetic format 0: places stored `lat`/`lng`/`radius` instead of the v1 field names.
    const legacy = structuredClone(current);
    legacy.backup_format_version = 0;
    legacy.payload.places = legacy.payload.places.map((place: Record<string, any>) => {
      const { latitude, longitude, radius_meters: radius, ...rest } = place;
      return { ...rest, lat: latitude, lng: longitude, radius };
    });
    delete legacy.counts;
    legacy.counts = { legacy: true };
    const legacyText = resign(legacy);

    const migrations = {
      0: (payload: unknown) => {
        const input = payload as Record<string, any>;
        return {
          ...input,
          places: input.places.map((place: Record<string, any>) => {
            const { lat, lng, radius, ...rest } = place;
            return { ...rest, latitude: lat, longitude: lng, radius_meters: radius };
          }),
        };
      },
    };

    const first = parseBackup(legacyText, { migrations });
    const second = parseBackup(legacyText, { migrations });
    assert.deepEqual(first, second, 'deterministic');
    assert.equal(first.preview.formatVersion, 0);
    assert.equal(first.preview.migratedFromVersion, 0);
    assert.deepEqual(plain(first.payload), plain(parseBackup(JSON.stringify(current)).payload));

    // Restores identically to a current-format file.
    const target = await openMigratedDb();
    await restoreBackupPayload(target, first.payload);
    assert.equal(await exportText(target), await exportText(source));

    // The production registry has no adapters yet, so format 0 is rejected cleanly without one.
    await expectBackupError(() => parseBackup(legacyText), 'unsupported_version');
    // Tampering is still caught before any adapter runs.
    await expectBackupError(
      () => parseBackup(legacyText.replace('Home', 'Hxme'), { migrations }),
      'checksum_mismatch',
    );
    // Multi-step chains need every step registered.
    await expectBackupError(
      () => parseBackup(legacyText, { currentVersion: 2, migrations }),
      'unsupported_version',
    );
    const chained = parseBackup(legacyText, {
      currentVersion: 2,
      migrations: { ...migrations, 1: (payload: unknown) => payload },
    });
    assert.equal(chained.preview.migratedFromVersion, 0);
    // And a file one version above the supported maximum is still refused.
    await expectBackupError(
      () => parseBackup(JSON.stringify(current), { currentVersion: 0, migrations }),
      'unsupported_version',
    );
  });
});

describe('atomic restore', () => {
  const failures: { name: string; when: (sql: string) => boolean }[] = [
    { name: 'on the very first wipe statement', when: (sql) => sql.startsWith('DELETE FROM attempt_checkpoint_crossing') },
    { name: 'after most tables are wiped', when: (sql) => sql.startsWith('DELETE FROM place') },
    { name: 'inserting places', when: (sql) => sql.startsWith('INSERT INTO place') },
    { name: 'inserting location samples', when: (sql) => sql.startsWith('INSERT INTO location_sample') },
    { name: 'inserting attempts', when: (sql) => sql.startsWith('INSERT INTO attempt (') },
    { name: 'inserting the last table', when: (sql) => sql.startsWith('INSERT INTO app_setting') },
    { name: 'during the relational verification', when: (sql) => sql === 'PRAGMA foreign_key_check' },
  ];

  for (const failure of failures) {
    it(`rolls back to the exact original database when the restore fails ${failure.name}`, async () => {
      const source = await openMigratedDb();
      await seedRepresentativeHistory(source);
      const { payload } = parseBackup(await exportText(source));

      const target = await openMigratedDb();
      await seedSecondHistory(target);
      const before = await dumpDatabase(target);
      const failing = instrument(target, { failWhen: failure.when });

      await expectBackupError(() => restoreBackupPayload(failing, payload), 'restore_failed');
      assert.deepEqual(await dumpDatabase(target), before);

      // The same payload restores fine once the fault is gone (nothing was left half-applied).
      await restoreBackupPayload(target, payload);
      assert.equal(await exportText(target), await exportText(source));
    });
  }

  it('rejects a payload whose references only break at write time and rolls back', async () => {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const { payload } = parseBackup(await exportText(source));
    const corrupt = structuredClone(payload);
    // Bypasses parse-time validation on purpose: the database must still refuse it atomically.
    corrupt.attempts[0]!.origin_place_id = 'not-a-place';
    const target = await openMigratedDb();
    await seedSecondHistory(target);
    const before = await dumpDatabase(target);
    await assert.rejects(() => restoreBackupPayload(target, corrupt));
    assert.deepEqual(await dumpDatabase(target), before);
  });

  it('does not duplicate history when the same backup is imported repeatedly', async () => {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const text = await exportText(source);
    const target = await openMigratedDb();
    await seedSecondHistory(target);
    for (let round = 0; round < 3; round += 1) {
      await restoreBackupPayload(target, parseBackup(text).payload);
      assert.equal(await exportText(target), text);
    }
    for (const [table, expected] of [
      ['place', 3],
      ['route', 2],
      ['attempt', 3],
      ['tracking_session', 6],
      ['attempt_checkpoint_crossing', 2],
    ] as const) {
      assert.equal((await target.getFirst<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n, expected, table);
    }
  });
});

describe('restore refusal while this device is live', () => {
  it('refuses with zero writes when an attempt is armed or active', async () => {
    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const text = await exportText(source);
    const { payload } = parseBackup(text);

    const target = await openMigratedDb();
    const ws = createSqliteWorkspace(target, { now: () => BASE_MS });
    const started = await ws.workspace.startAttempt();
    assert.equal(started.ok, true);
    const before = await dumpDatabase(target);
    const counted = instrument(target);

    const service = new BackupService(
      async () => counted,
      { shareBackupFile: async () => {}, pickBackupFile: async () => ({ name: 'b.json', text }) },
      { stopLocationUpdates: async () => assert.fail('must not stop updates'), invalidateDerivedCaches: () => assert.fail('no'), recomputeDerived: async () => assert.fail('no') },
      '0.1.0',
    );
    await expectBackupError(() => service.pickAndPreview(), 'live_state');
    await expectBackupError(() => restoreBackupPayload(counted, payload), 'live_state');
    await expectBackupError(
      () => service.confirmRestore({ fileName: 'b.json', preview: parseBackup(text).preview, payload }),
      'live_state',
    );
    assert.equal(counted.writes, 0);
    assert.deepEqual(await dumpDatabase(target), before);
    assert.equal((await ws.attempts.getOpenAttempt())?.lifecycle, 'armed');
    assert.equal(ws.platform.updating, true, 'live tracking left running');
  });

  it('refuses when only a route recording session is active', async () => {
    const source = await openMigratedDb();
    const { payload } = parseBackup(await exportText(source));
    const target = await openMigratedDb();
    const ws = createSqliteWorkspace(target, { now: () => BASE_MS, sessionId: 'rec-1' });
    await ws.workspace.startRouteRecording();
    const before = await dumpDatabase(target);
    await expectBackupError(() => assertNoLiveState(target), 'live_state');
    await expectBackupError(() => restoreBackupPayload(target, payload), 'live_state');
    assert.deepEqual(await dumpDatabase(target), before);
  });
});

describe('restored live state is terminalized, never resurrected', () => {
  it('preserves a true completed result and closes the rest as inspectable incomplete', async () => {
    const source = await openMigratedDb();
    await seedLiveHistory(source);
    const { payload } = parseBackup(await exportText(source));
    assert.equal(payload.attempts.filter((a) => a.lifecycle === 'armed' || a.lifecycle === 'active').length, 2);
    assert.equal(payload.tracking_sessions.filter((s) => s.is_active === 1).length, 3);

    const pure = terminalizeRestoredLiveState(payload);
    assert.deepEqual(
      pure.report.attempts.sort((a, b) => a.attemptId.localeCompare(b.attemptId)),
      [
        { attemptId: 'attempt-active-weak', outcome: 'incomplete' },
        { attemptId: 'attempt-armed-strong', outcome: 'completed' },
      ],
    );
    assert.deepEqual(terminalizeRestoredLiveState(payload), pure, 'deterministic');

    const target = await openMigratedDb();
    await restoreBackupPayload(target, payload);
    const attempts = new SqliteAttemptStore(async () => target);
    const strong = (await attempts.getAttempt('attempt-armed-strong'))!;
    assert.equal(strong.lifecycle, 'completed');
    assert.equal(strong.validity, 'valid');
    assert.equal(strong.originPlaceId, HOME.id);
    assert.equal(strong.destinationPlaceId, WORK.id);
    assert.ok(strong.startedAtMs != null && strong.finishedAtMs != null && strong.finishedAtMs > strong.startedAtMs);
    assert.equal(strong.startedLocalTimeSource, 'reconstructed');
    assert.equal(strong.reconciliationStatus, 'pending', 'derived path assignment is recomputed on startup');

    const weak = (await attempts.getAttempt('attempt-active-weak'))!;
    assert.equal(weak.lifecycle, 'ended', 'inspectable incomplete, not hidden abandoned');
    assert.equal(weak.validity, 'unranked');
    assert.equal(weak.hiddenIncomplete, false);
    assert.equal(weak.finishedAtMs, null);
    assert.ok(weak.startedAtMs != null, 'the real departure is kept as evidence');
    assert.equal(incompleteAttemptLabel(weak), 'DID NOT FINISH');

    assert.equal(await attempts.getOpenAttempt(), null);
    const sessions = new SqliteLocationSampleStore(async () => target);
    assert.equal(await sessions.getActiveSession(), null);
    assert.deepEqual(
      (await sessions.getSession('s-armed-strong')) && {
        isActive: (await sessions.getSession('s-armed-strong'))!.isActive,
        outcome: (await sessions.getSession('s-armed-strong'))!.captureOutcome,
        review: (await sessions.getSession('s-armed-strong'))!.reviewDisposition,
      },
      { isActive: false, outcome: 'finished', review: 'saved' },
    );
    const weakSession = (await sessions.getSession('s-active-weak'))!;
    assert.equal(weakSession.isActive, false);
    assert.equal(weakSession.captureOutcome, 'interrupted');
    assert.ok(weakSession.stoppedAtMs != null);
    const recording = (await sessions.getSession('s-route-active'))!;
    assert.equal(recording.isActive, false);
    assert.equal(recording.captureOutcome, 'interrupted');
    assert.equal(recording.reviewDisposition, 'pending');
    assert.equal((await sessions.findPendingRouteCreation())?.id, 's-route-active', 'stays reviewable');

    // Restoring the same file again produces the identical terminal state.
    const first = await dumpDatabase(target);
    await restoreBackupPayload(target, payload);
    assert.deepEqual(await dumpDatabase(target), first);
  });

  it('does not reactivate tracking, append samples or block a fresh START when the platform reports isUpdating()', async () => {
    const source = await openMigratedDb();
    await seedLiveHistory(source, { routeRecording: false });
    const { payload } = parseBackup(await exportText(source));

    const target = await openMigratedDb();
    const ws = createSqliteWorkspace(target, { now: () => BASE_MS + 9_000_000, attemptId: 'fresh-attempt', sessionId: 'fresh-session' });
    // Stale OS state left from before the restore.
    ws.platform.updating = true;

    const stopped: string[] = [];
    const service = new BackupService(
      async () => target,
      { shareBackupFile: async () => {}, pickBackupFile: async () => null },
      {
        stopLocationUpdates: async () => {
          stopped.push('stop');
          await ws.tracker.stopLocationUpdates();
        },
        invalidateDerivedCaches: () => stopped.push('invalidate'),
        recomputeDerived: async () => {
          stopped.push('recompute');
        },
      },
      '0.1.0',
    );
    const outcome = await service.confirmRestore({
      fileName: 'b.json',
      preview: parseBackup(await exportText(source)).preview,
      payload,
    });
    assert.deepEqual(stopped, ['stop', 'invalidate', 'recompute', 'invalidate']);
    assert.deepEqual(outcome.warnings, []);
    assert.equal(ws.platform.updating, false, 'leftover OS updates were stopped');

    // Even if the OS still claims to be updating (stop raced / was ignored), restored rows stay terminal.
    ws.platform.updating = true;
    const sessions = new SqliteLocationSampleStore(async () => target);
    const sampleCountBefore = await sessions.countSamples('s-armed-strong');
    const reconciled = await ws.attemptRuntime.reconcile();
    assert.ok(reconciled == null || (reconciled.lifecycle !== 'armed' && reconciled.lifecycle !== 'active'));
    assert.equal(await ws.attempts.getOpenAttempt(), null);
    assert.equal(await sessions.getActiveSession(), null);
    await ws.tracker.recover();
    assert.equal(await sessions.getActiveSession(), null);

    const trackingSessions = new TrackingSessionService(sessions);
    const written = await trackingSessions.recordActiveSessionFixes([
      { timestamp: BASE_MS + 9_000_100, coords: { latitude: 32.08, longitude: 34.78, accuracy: 5, speed: 1, heading: 0 } },
    ]);
    assert.equal(written, 0);
    assert.equal(
      await trackingSessions.recordFixes('s-armed-strong', [
        { timestamp: BASE_MS + 9_000_200, coords: { latitude: 32.08, longitude: 34.78, accuracy: 5, speed: 1, heading: 0 } },
      ]),
      0,
    );
    assert.equal(await sessions.countSamples('s-armed-strong'), sampleCountBefore);

    // A fresh START works and creates exactly one new open attempt.
    ws.platform.updating = false;
    const started = await ws.workspace.startAttempt();
    assert.equal(started.ok, true);
    assert.equal(ws.platform.startUpdatesCalls, 1);
    assert.equal((await ws.attempts.getOpenAttempt())?.id, 'fresh-attempt');
  });

  it('reports a failed leftover-updates stop as a warning without undoing the restore', async () => {
    const source = await openMigratedDb();
    await seedLiveHistory(source);
    const text = await exportText(source);
    const target = await openMigratedDb();
    const service = new BackupService(
      async () => target,
      { shareBackupFile: async () => {}, pickBackupFile: async () => null },
      {
        stopLocationUpdates: async () => {
          throw new Error('OS refused');
        },
        invalidateDerivedCaches: () => {},
        recomputeDerived: async () => {
          throw new Error('recompute boom');
        },
      },
      '0.1.0',
    );
    const pending = await service.previewText('b.json', text);
    const outcome = await service.confirmRestore(pending);
    assert.equal(outcome.warnings.length, 2);
    assert.match(outcome.warnings[0]!, /OS refused/);
    assert.equal((await target.getFirst<{ n: number }>('SELECT COUNT(*) AS n FROM attempt'))?.n, 2);
  });
});

describe('derived data after restore', () => {
  const pathSamples = (sessionId: string, east: number) =>
    traceAlongPath(
      northPath({ startLat: HOME.center.latitude, startLng: HOME.center.longitude, points: 51, stepMeters: 20 }).map(
        (point) => offsetLatLng(point.latitude, point.longitude, 0, east),
      ),
      { sessionId, startMs: BASE_MS, intervalMs: 1000, stepMeters: 10, count: 100 },
    );

  it('keeps archived discovered path variants archived through startup recomputation and repeated restores', async () => {
    const source = await openMigratedDb();
    const srcWs = createSqliteWorkspace(source, { now: () => 9_000 });
    for (const place of [HOME, WORK]) {
      await srcWs.places.createPlace(place);
    }
    for (const item of [
      { id: 'a', east: 50 },
      { id: 'b', east: 52 },
      { id: 'c', east: 48 },
    ]) {
      const samples = pathSamples(`session-${item.id}`, item.east);
      await seedSession(
        source,
        {
          id: `session-${item.id}`,
          startedAtMs: samples[0]!.recordedAtMs,
          stoppedAtMs: samples[samples.length - 1]!.recordedAtMs,
          purpose: 'attempt',
          captureOutcome: 'finished',
          reviewDisposition: 'saved',
        },
        samples,
      );
      await srcWs.attempts.saveAttempt(
        baseAttempt({
          id: `attempt-${item.id}`,
          sessionId: `session-${item.id}`,
          originPlaceId: HOME.id,
          destinationPlaceId: WORK.id,
          armedAtMs: samples[0]!.recordedAtMs - 5_000,
          startedAtMs: samples[0]!.recordedAtMs,
          finishedAtMs: samples[samples.length - 1]!.recordedAtMs,
          reconciliationStatus: 'pending',
          reconciliationVersion: 0,
        }),
      );
    }
    await srcWs.attemptRuntime.recomputeAllPathVariants();
    const discovered = (await srcWs.routes.listRoutes()).filter((route) => route.kind === 'discovered');
    assert.equal(discovered.length, 1);
    const archived = await srcWs.workspace.archivePathVariant(discovered[0]!.id);
    assert.equal(archived.ok, true);
    const text = await exportText(source);
    const original = (await srcWs.routes.listRoutes()).map((route) => ({ id: route.id, status: route.status, kind: route.kind }));

    const target = await openMigratedDb();
    const hooksLog: string[] = [];
    let ws = createSqliteWorkspace(target, { now: () => 9_000 });
    const service = new BackupService(
      async () => target,
      { shareBackupFile: async () => {}, pickBackupFile: async () => null },
      {
        stopLocationUpdates: async () => {},
        invalidateDerivedCaches: () => ws.workspace.invalidateDerivedCaches(),
        recomputeDerived: async () => {
          hooksLog.push('recompute');
          await ws.workspace.reconcilePendingAttempts();
          await ws.workspace.recomputePathVariants();
        },
      },
      '0.1.0',
    );

    for (let round = 0; round < 3; round += 1) {
      ws = createSqliteWorkspace(target, { now: () => 9_000 });
      const pending = await service.previewText('b.json', text);
      await service.confirmRestore(pending);
      // Normal startup stages after the restore as well.
      await ws.workspace.reconcilePendingAttempts();
      await ws.workspace.recomputePathVariants({ skipIfUnchanged: true });
      await ws.workspace.recomputePathVariants({ skipIfUnchanged: true });

      const routes = (await ws.routes.listRoutes()).map((route) => ({ id: route.id, status: route.status, kind: route.kind }));
      assert.deepEqual(routes, original, `round ${round}: no duplicate or reactivated variants`);
      assert.equal((await ws.places.listPlaces()).length, 2);
      const attempts = await ws.attempts.listAttempts();
      assert.equal(attempts.length, 3);
      assert.ok(attempts.every((attempt) => attempt.routeId == null), 'archived variant not reassigned');
      const loaded = await ws.workspace.loadJourney({
        originPlaceId: HOME.id,
        destinationPlaceId: WORK.id,
        transportationMode: 'scooter',
      });
      assert.equal(loaded?.summary.rankedAttemptCount, 3);
      assert.equal(loaded?.pathVariants.length, 0);
    }
    assert.equal(hooksLog.length, 3);
  });

  it('invalidates the in-memory Home and journey caches so restored history is what the UI loads', async () => {
    const target = await openMigratedDb();
    const ws = createSqliteWorkspace(target, { now: () => 9_000 });
    const emptyHome = await ws.workspace.loadHome();
    assert.equal(emptyHome.places.length, 0);

    const source = await openMigratedDb();
    await seedRepresentativeHistory(source);
    const { payload } = parseBackup(await exportText(source));
    await restoreBackupPayload(target, payload);
    ws.workspace.invalidateDerivedCaches();
    const home = await ws.workspace.loadHome();
    assert.equal(home.places.length, 3);
    assert.equal(home.activeTransportationMode, 'bike');
    assert.equal(home.hiddenIncompleteAttempts.length, 1, 'hidden incomplete stays hidden');
    assert.equal(home.incompleteAttempts.length, 0);
    assert.equal((await ws.attempts.getAttempt('attempt-complete'))?.resultAcknowledged, false);
  });
});

describe('coherent snapshot', () => {
  it('reads one consistent state while another connection changes the database mid-export', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlrng-backup-'));
    const file = path.join(dir, 'snapshot.sqlite');
    const readerDb = new DatabaseSync(file);
    const writerDb = new DatabaseSync(file);
    try {
      readerDb.exec('PRAGMA journal_mode = WAL');
      const readerSql = createNodeSqlExecutor(readerDb);
      await applyMigrations(readerSql, BASE_MS);
      await seedRepresentativeHistory(readerSql);

      let injected = 0;
      const interleaving: SqlExecutor = {
        ...readerSql,
        async getAll<T>(sql: string, params?: Parameters<SqlExecutor['getAll']>[1]) {
          const rows = await readerSql.getAll<T>(sql, params);
          if (injected === 0 && /FROM place\b/.test(sql)) {
            injected += 1;
            // The app keeps working while the export runs: new place, deleted attempt, edited setting.
            writerDb.exec(`
              INSERT INTO place (id, name, latitude, longitude, radius_meters, status, created_at_ms)
              VALUES ('place-new', 'New', 1, 1, 50, 'active', 99);
              DELETE FROM attempt_checkpoint_crossing;
              DELETE FROM attempt WHERE id = 'attempt-dnf';
              UPDATE app_setting SET value = 'walk' WHERE key = 'active_transportation_mode';
            `);
          }
          return rows;
        },
      };

      const exported = await exportBackup(interleaving, { nowMs: CREATED_AT_MS, appVersion: '0.1.0' });
      assert.equal(injected, 1, 'the concurrent write really happened mid-export');
      const snapshot = parseBackup(exported.text).payload;
      assert.deepEqual(snapshot.places.map((p) => p.id).sort(), ['place-home', 'place-park', 'place-work']);
      assert.equal(snapshot.attempts.length, 3);
      assert.ok(snapshot.attempts.some((a) => a.id === 'attempt-dnf'));
      assert.equal(snapshot.attempts.flatMap((a) => a.crossings).length, 2);
      assert.equal(snapshot.settings.active_transportation_mode, 'bike');

      const after = parseBackup(await exportText(readerSql)).payload;
      assert.ok(after.places.some((p) => p.id === 'place-new'));
      assert.equal(after.attempts.length, 2);
      assert.equal(after.settings.active_transportation_mode, 'walk');
    } finally {
      readerDb.close();
      writerDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('export safety and privacy copy', () => {
  it('leaves the database untouched when reading or sharing fails', async () => {
    const sql = await openMigratedDb();
    await seedRepresentativeHistory(sql);
    const before = await dumpDatabase(sql);

    const failingRead = instrument(sql, { failWhen: (statement) => /FROM attempt\b/.test(statement) });
    let shared = 0;
    const gateway: BackupFileGateway = {
      shareBackupFile: async () => {
        shared += 1;
      },
      pickBackupFile: async () => null,
    };
    const hooks = { stopLocationUpdates: async () => {}, invalidateDerivedCaches: () => {}, recomputeDerived: async () => {} };
    await assert.rejects(() => new BackupService(async () => failingRead, gateway, hooks, '0.1.0').exportBackup());
    assert.equal(shared, 0, 'nothing is shared when the snapshot fails');
    assert.equal(failingRead.writes, 0);
    assert.deepEqual(await dumpDatabase(sql), before);

    const counting = instrument(sql);
    const brokenShare: BackupFileGateway = {
      ...gateway,
      shareBackupFile: async () => {
        throw new Error('share sheet failed');
      },
    };
    await assert.rejects(() => new BackupService(async () => counting, brokenShare, hooks, '0.1.0').exportBackup(), /share sheet failed/);
    assert.equal(counting.writes, 0);
    assert.deepEqual(await dumpDatabase(sql), before);
  });

  it('hands the exact serialized text to the share gateway and reports counts', async () => {
    const sql = await openMigratedDb();
    await seedRepresentativeHistory(sql);
    let sharedName = '';
    let sharedText = '';
    const service = new BackupService(
      async () => sql,
      {
        shareBackupFile: async (name, text) => {
          sharedName = name;
          sharedText = text;
        },
        pickBackupFile: async () => null,
      },
      { stopLocationUpdates: async () => {}, invalidateDerivedCaches: () => {}, recomputeDerived: async () => {} },
      '0.1.0',
      () => CREATED_AT_MS,
    );
    const result = await service.exportBackup();
    assert.equal(sharedName, result.fileName);
    assert.equal(sharedText, await exportText(sql));
    assert.equal(result.counts.attempts, 3);
    assert.equal(parseBackup(sharedText).preview.counts.places, 3);
  });

  it('warns about precise location history and requires an explicit replace confirmation', () => {
    assert.match(BACKUP_PRIVACY_WARNING, /precise location history/i);
    assert.match(BACKUP_PRIVACY_WARNING, /nothing is uploaded automatically/i);
    assert.match(RESTORE_REPLACE_WARNING, /replaces everything/i);
    assert.equal(RESTORE_CONFIRM_LABEL, 'Replace local data with this backup');
  });

  it('builds a document whose counts always describe its payload', async () => {
    const sql = await openMigratedDb();
    await seedRepresentativeHistory(sql);
    const payload = await readBackupSnapshot(sql);
    const document = buildBackupDocument(payload, { createdAtMs: CREATED_AT_MS, source: SOURCE });
    assert.equal(document.counts.location_samples, payload.location_samples.length);
    assert.equal(document.counts.attempts, 3);
  });
});
