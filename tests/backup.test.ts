import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, isHiddenIncomplete, officialTimeMs, type Attempt } from '../src/domain/attempt';
import { attemptDepartureWallClock } from '../src/domain/attempt-local-time';
import { summarizeJourneyPool } from '../src/domain/journey-analysis';
import { sha256Hex } from '../src/domain/sha256';
import {
  planPathVariantRecompute,
  type JourneyAttemptTrace,
} from '../src/domain/path-variant-discovery';
import { applyMigrations } from '../src/persistence/migrations';
import {
  ACTIVE_TRANSPORTATION_MODE_KEY,
  PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY,
} from '../src/persistence/settings-store';
import {
  BACKUP_EXPORT_LABEL,
  BACKUP_FORMAT_VERSION,
  BACKUP_PRIVACY_NOTICE,
  BACKUP_REPLACE_CONFIRM_LABEL,
  BACKUP_RESTORE_LABEL,
  canonicalJson,
  INTEGRITY_BACKUP_MESSAGE,
  INVALID_BACKUP_MESSAGE,
  MALFORMED_BACKUP_MESSAGE,
  NEWER_BACKUP_MESSAGE,
  parseBackup,
  serializeBackupSnapshot,
  type BackupSnapshot,
} from '../src/persistence/backup-document';
import {
  BackupRestoreRefusedError,
  replaceDurableSnapshot,
} from '../src/persistence/backup-store';
import { SqliteAttemptStore } from '../src/persistence/sqlite-attempt-store';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import { SqlitePlaceStore } from '../src/persistence/sqlite-place-store';
import { SqliteRouteStore } from '../src/persistence/sqlite-route-store';
import { SqliteSettingsStore } from '../src/persistence/sqlite-settings-store';
import type { SqlExecutor } from '../src/persistence/sql-executor';
import { LocalBackupService } from '../src/product/local-backup';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';
import { RECONCILED_ATTEMPT, capturedLocalStart } from './helpers/attempts';
import { makePlace, completeJourneySamples } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, traceAlongPath } from './helpers/samples';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { createSqliteWorkspace } from './helpers/workspace';

const NOW = 1_800_000_000_000;
const MONDAY_UTC = Date.UTC(2024, 0, 1, 5, 0, 0);

function service(
  sql: SqlExecutor,
  hooks?: { stop?: () => Promise<void>; invalidate?: () => void; now?: () => number },
) {
  return new LocalBackupService(
    async () => sql,
    hooks?.stop ?? (async () => {}),
    hooks?.invalidate ?? (() => {}),
    hooks?.now ?? (() => NOW),
  );
}

async function openDb(): Promise<SqlExecutor> {
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, 1_700_000_000_000);
  return sql;
}

function resign(envelope: Record<string, unknown>): string {
  const records = envelope.records;
  return `${JSON.stringify(
    {
      ...envelope,
      integrity: { algorithm: 'sha256', payload_sha256: sha256Hex(canonicalJson(records)) },
    },
    null,
    2,
  )}\n`;
}

async function seedHistory(sql: SqlExecutor) {
  const places = new SqlitePlaceStore(async () => sql);
  const sessions = new SqliteLocationSampleStore(async () => sql);
  const routes = new SqliteRouteStore(async () => sql);
  const attempts = new SqliteAttemptStore(async () => sql);
  const settings = new SqliteSettingsStore(async () => sql);
  const home = makePlace({ id: 'place-home', name: 'Home', createdAtMs: 1 });
  const work = makePlace({
    id: 'place-work',
    name: 'Work',
    createdAtMs: 2,
    center: offsetLatLng(home.center.latitude, home.center.longitude, 400, 0),
  });
  const archived = makePlace({
    id: 'place-old',
    name: 'Old cafe',
    createdAtMs: 3,
    status: 'archived',
    center: offsetLatLng(home.center.latitude, home.center.longitude, 40, 40),
  });
  await places.createPlace(home);
  await places.createPlace(work);
  await places.createPlace(archived);

  await sessions.createSession('session-route', 1_700_000_100_000, 'route_creation');
  await sessions.confirmBackgroundPermission('session-route');
  await sessions.appendSamples([
    {
      id: 'route-sample',
      sessionId: 'session-route',
      recordedAtMs: 1_700_000_100_500,
      latitude: home.center.latitude,
      longitude: home.center.longitude,
      horizontalAccuracyMeters: 5,
      speedMetersPerSecond: 1,
      headingDegrees: 10,
    },
  ]);
  await sessions.completeSession('session-route', {
    stoppedAtMs: 1_700_000_101_000,
    captureOutcome: 'finished',
    reviewDisposition: 'saved',
  });

  const referencePath = northPath({
    startLat: home.center.latitude,
    startLng: home.center.longitude,
    points: 4,
    stepMeters: 20,
  });
  const route = makeRoute({
    id: 'route-1',
    name: 'River route',
    sourceRecordingId: 'session-route',
    referencePath,
    status: 'active',
    kind: 'explicit',
    checkpoints: [{ id: 'checkpoint-1', name: 'Bridge', progressMeters: 20 }],
  });
  await routes.createRoute(route);

  await sessions.createSession('session-pb', 1_700_000_200_000, 'attempt');
  await sessions.appendSamples([
    {
      id: 'pb-sample',
      sessionId: 'session-pb',
      recordedAtMs: MONDAY_UTC + 30_000,
      latitude: work.center.latitude,
      longitude: work.center.longitude,
      horizontalAccuracyMeters: 6,
      speedMetersPerSecond: 4,
      headingDegrees: 20,
    },
  ]);
  await sessions.completeSession('session-pb', {
    stoppedAtMs: MONDAY_UTC + 60_000,
    captureOutcome: 'finished',
    reviewDisposition: 'saved',
  });
  const pb: Attempt = {
    id: 'attempt-pb',
    routeId: route.id,
    originPlaceId: home.id,
    destinationPlaceId: work.id,
    transportationMode: 'scooter',
    sessionId: 'session-pb',
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: MONDAY_UTC - 5_000,
    startedAtMs: MONDAY_UTC,
    finishedAtMs: MONDAY_UTC + 60_000,
    ...capturedLocalStart(180, 'Asia/Jerusalem'),
    resultAcknowledged: true,
    hiddenIncomplete: false,
    crossings: [
      {
        id: 'crossing-1',
        attemptId: 'attempt-pb',
        checkpointId: 'checkpoint-1',
        checkpointName: 'Bridge',
        checkpointProgressMeters: 20,
        crossedAtMs: MONDAY_UTC + 20_000,
      },
    ],
    ...RECONCILED_ATTEMPT,
  };
  await attempts.saveAttempt(pb);

  await sessions.createSession('session-hidden', 1_700_000_300_000, 'attempt');
  await sessions.completeSession('session-hidden', {
    stoppedAtMs: 1_700_000_301_000,
    captureOutcome: 'interrupted',
    reviewDisposition: 'saved',
  });
  await attempts.saveAttempt({
    id: 'attempt-hidden',
    routeId: null,
    originPlaceId: null,
    destinationPlaceId: null,
    transportationMode: 'scooter',
    sessionId: 'session-hidden',
    lifecycle: 'ended',
    validity: 'unranked',
    armedAtMs: 1_700_000_300_000,
    startedAtMs: null,
    finishedAtMs: null,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    hiddenIncomplete: true,
    crossings: [],
    ...RECONCILED_ATTEMPT,
  });

  await settings.setActiveTransportationMode('bike');
  await settings.setValue(PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY, 'cache-key');
  return { home, work, pb };
}

describe('sha256', () => {
  it('matches the Node crypto digest for a known string', () => {
    const message = 'abc';
    assert.equal(sha256Hex(message), createHash('sha256').update(message).digest('hex'));
    assert.equal(
      sha256Hex(message),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('local backup', () => {
  it('exports an empty database and restores it over existing rows', async () => {
    const source = await openDb();
    const exported = await service(source).exportBackup();
    const parsed = JSON.parse(exported.text) as { counts: { places: number; settings: number } };
    assert.equal(parsed.counts.places, 0);
    assert.equal(parsed.counts.settings, 1);

    const target = await openDb();
    const places = new SqlitePlaceStore(async () => target);
    await places.createPlace(makePlace({ id: 'place-noise', name: 'Noise' }));
    await service(target).restoreBackup(exported.text);
    assert.equal((await places.listPlaces()).length, 0);
    const mode = await new SqliteSettingsStore(async () => target).getActiveTransportationMode();
    assert.equal(mode, 'scooter');
  });

  it('round-trips durable history and recomputes the same official PB', async () => {
    const source = await openDb();
    const seeded = await seedHistory(source);
    const backup = service(source);
    const first = await backup.exportBackup();
    const second = await backup.exportBackup();
    assert.equal(first.text, second.text);
    assert.equal(JSON.parse(first.text).backup_format_version, BACKUP_FORMAT_VERSION);
    assert.doesNotMatch(first.text, /path_variant_recompute_fingerprint|background_permission/);
    assert.match(first.text, /hidden_incomplete/);
    assert.match(first.text, /started_utc_offset_minutes/);

    const document = JSON.parse(first.text) as {
      records: {
        attempts: { id: string; session_id: string; origin_place_id: string | null }[];
        location_samples: { session_id: string }[];
        tracking_sessions: { id: string }[];
        places: { id: string }[];
        routes: { source_recording_id: string; status: string; cluster_signature: string | null }[];
      };
    };
    const sessionIds = new Set(document.records.tracking_sessions.map((session) => session.id));
    const placeIds = new Set(document.records.places.map((place) => place.id));
    for (const sample of document.records.location_samples) {
      assert.equal(sessionIds.has(sample.session_id), true);
    }
    for (const attempt of document.records.attempts) {
      assert.equal(sessionIds.has(attempt.session_id), true);
      if (attempt.origin_place_id) {
        assert.equal(placeIds.has(attempt.origin_place_id), true);
      }
    }
    for (const route of document.records.routes) {
      assert.equal(sessionIds.has(route.source_recording_id), true);
    }

    const target = await openDb();
    await new SqlitePlaceStore(async () => target).createPlace(makePlace({ id: 'place-noise', name: 'Noise' }));
    const invalidated: string[] = [];
    await service(target, { invalidate: () => invalidated.push('cleared') }).restoreBackup(first.text);
    assert.deepEqual(invalidated, ['cleared']);
    await service(target).restoreBackup(first.text);

    const attempts = new SqliteAttemptStore(async () => target);
    const restored = await attempts.listAttempts();
    assert.equal(restored.length, 2);
    const pb = restored.find((attempt) => attempt.id === 'attempt-pb');
    const hidden = restored.find((attempt) => attempt.id === 'attempt-hidden');
    assert.ok(pb);
    assert.ok(hidden);
    assert.equal(pb.resultAcknowledged, true);
    assert.equal(pb.startedUtcOffsetMinutes, 180);
    assert.equal(pb.crossings.length, 1);
    assert.equal(isHiddenIncomplete(hidden), true);
    const clock = attemptDepartureWallClock(pb);
    assert.equal(clock?.weekday, 1);
    assert.equal(Math.floor((clock?.minutesSinceMidnight ?? 0) / 60), 8);
    assert.equal(officialTimeMs(pb), officialTimeMs(seeded.pb));

    const samples = await new SqliteLocationSampleStore(async () => target).countSamples('session-pb');
    assert.equal(samples, 1);
    const summary = summarizeJourneyPool(
      {
        originPlaceId: seeded.home.id,
        destinationPlaceId: seeded.work.id,
        transportationMode: 'scooter',
      },
      seeded.home,
      seeded.work,
      [{ attempt: pb, samples: [] }],
    );
    assert.equal(summary.rankedAttemptCount, 1);
    assert.equal(summary.pbAttemptId, 'attempt-pb');
    assert.equal(summary.pbTimeMs, 60_000);
    const mode = await new SqliteSettingsStore(async () => target).getActiveTransportationMode();
    assert.equal(mode, 'bike');
    const fingerprint = await new SqliteSettingsStore(async () => target).getValue(
      PATH_VARIANT_RECOMPUTE_FINGERPRINT_KEY,
    );
    assert.equal(fingerprint, null);
    const permission = await target.getFirst<{ background_permission_confirmed: number }>(
      'SELECT background_permission_confirmed FROM tracking_session WHERE id = ?',
      ['session-route'],
    );
    assert.equal(permission?.background_permission_confirmed, 0);
    const route = await new SqliteRouteStore(async () => target).getRoute('route-1');
    assert.equal(route?.name, 'River route');
    assert.equal(route?.checkpoints[0]?.name, 'Bridge');
    assert.equal(route?.referencePath.length, 4);
  });

  it('rejects a malformed, truncated, newer, or inconsistent file before changing data', async () => {
    const sql = await openDb();
    const seeded = await seedHistory(sql);
    const backup = service(sql);
    const exported = await backup.exportBackup();
    const placeCountBefore = (await new SqlitePlaceStore(async () => sql).listPlaces()).length;

    await assert.rejects(() => backup.restoreBackup(`${exported.text.slice(0, 40)}{`), new RegExp(MALFORMED_BACKUP_MESSAGE));
    await assert.rejects(() => backup.restoreBackup('{"backup_format_version":9}'), new RegExp(NEWER_BACKUP_MESSAGE));

    const tampered = JSON.parse(exported.text) as { integrity: { payload_sha256: string } };
    tampered.integrity.payload_sha256 = '0'.repeat(64);
    await assert.rejects(() => backup.restoreBackup(JSON.stringify(tampered)), new RegExp(INTEGRITY_BACKUP_MESSAGE));

    const broken = JSON.parse(exported.text) as {
      records: { attempts: { session_id: string }[] };
    };
    broken.records.attempts[0]!.session_id = 'missing-session';
    await assert.rejects(() => backup.restoreBackup(resign(broken)), new RegExp(INVALID_BACKUP_MESSAGE));

    const counted = JSON.parse(exported.text) as { counts: { places: number } };
    counted.counts.places += 1;
    await assert.rejects(() => backup.restoreBackup(JSON.stringify(counted)), new RegExp(INTEGRITY_BACKUP_MESSAGE));

    assert.equal((await new SqlitePlaceStore(async () => sql).listPlaces()).length, placeCountBefore);
    assert.equal((await new SqliteAttemptStore(async () => sql).getAttempt('attempt-pb'))?.id, seeded.pb.id);
  });

  it('rolls back a restore that fails before commit', async () => {
    const sql = await openDb();
    await new SqlitePlaceStore(async () => sql).createPlace(makePlace({ id: 'place-keep', name: 'Keep' }));
    const empty = parseBackup(
      serializeBackupSnapshot({
        createdAtMs: NOW,
        sourceSchemaVersion: 11,
        sourceAppVersion: '0.1.0',
        places: [],
        routes: [],
        sessions: [],
        samples: [],
        attempts: [],
        settings: [{ key: ACTIVE_TRANSPORTATION_MODE_KEY, value: 'scooter' }],
      }),
      NOW,
    );
    await assert.rejects(
      () => replaceDurableSnapshot(sql, empty.snapshot, { beforeCommit: () => Promise.reject(new Error('disk full')) }),
      /disk full/,
    );
    const kept = await new SqlitePlaceStore(async () => sql).getPlace('place-keep');
    assert.equal(kept?.name, 'Keep');
  });

  it('migrates a supported older backup and ignores unknown optional fields', async () => {
    const records = {
      places: [
        {
          id: 'place-home',
          name: 'Home',
          latitude: 32.08,
          longitude: 34.78,
          radius_meters: 30,
          status: 'active',
          created_at_ms: 1,
          future_note: 'ignored',
        },
      ],
      routes: [],
      tracking_sessions: [],
      location_samples: [],
      attempts: [],
    };
    const text = JSON.stringify({
      backup_format_version: 1,
      created_at_ms: 50,
      source_schema_version: 10,
      active_transportation_mode: 'bike',
      counts: { places: 1, routes: 0, attempts: 0, tracking_sessions: 0, location_samples: 0 },
      integrity: { algorithm: 'sha256', payload_sha256: sha256Hex(canonicalJson(records)) },
      records,
    });
    const sql = await openDb();
    const preview = await service(sql).restoreBackup(text);
    assert.equal(preview.backupFormatVersion, 1);
    assert.equal(preview.counts.places, 1);
    const place = await new SqlitePlaceStore(async () => sql).getPlace('place-home');
    assert.equal(place?.name, 'Home');
    assert.equal(await new SqliteSettingsStore(async () => sql).getActiveTransportationMode(), 'bike');
  });

  it('refuses restore while this device has a live attempt or session', async () => {
    const sql = await openDb();
    const sessions = new SqliteLocationSampleStore(async () => sql);
    await sessions.createSession('session-live', 1_700_000_000_000, 'attempt');
    let stops = 0;
    const text = serializeBackupSnapshot({
      createdAtMs: NOW,
      sourceSchemaVersion: 11,
      sourceAppVersion: '0.1.0',
      places: [],
      routes: [],
      sessions: [],
      samples: [],
      attempts: [],
      settings: [{ key: ACTIVE_TRANSPORTATION_MODE_KEY, value: 'scooter' }],
    });
    await assert.rejects(
      () => service(sql, { stop: async () => { stops += 1; } }).restoreBackup(text),
      BackupRestoreRefusedError,
    );
    assert.equal(stops, 0);
    assert.equal((await sessions.getActiveSession())?.id, 'session-live');
  });

  it('does not resurrect an armed backup when location updates are still running', async () => {
    const sql = await openDb();
    const { workspace, tracker, attemptRuntime, sessions, platform } = createSqliteWorkspace(sql, {
      now: () => NOW,
      createAttemptId: () => 'attempt-fresh',
      createSessionId: () => 'session-fresh',
    });
    platform.updating = true;
    const text = serializeBackupSnapshot(armedSnapshot());
    assert.match(text, /"lifecycle": "armed"/);
    await service(sql, {
      stop: () => tracker.stopLocationUpdates(),
      invalidate: () => workspace.invalidateDerivedViews(),
      now: () => NOW,
    }).restoreBackup(text);

    assert.equal(platform.updating, false);
    assert.equal(await attemptRuntime.getOpenAttempt(), null);
    const restored = await sessions.getSession('session-armed');
    assert.equal(restored?.isActive, false);
    assert.equal(await sessions.countSamples('session-armed'), 1);
    const attempt = await attemptRuntime.getAttempt('attempt-armed');
    assert.equal(attempt?.lifecycle, 'ended');
    assert.notEqual(attempt?.lifecycle, 'abandoned');

    platform.updating = true;
    await tracker.recover();
    await attemptRuntime.reconcile();
    const recorder = new TrackingSessionService(sessions, () => 'sample-extra');
    const written = await recorder.recordActiveSessionFixes([
      {
        timestamp: NOW + 5_000,
        coords: { latitude: 32.1, longitude: 34.8, accuracy: 5, speed: 1, heading: 1 },
      },
    ]);
    assert.equal(written, 0);
    assert.equal(await sessions.countSamples('session-armed'), 1);
    assert.equal(await attemptRuntime.getOpenAttempt(), null);
    const started = await attemptRuntime.start();
    assert.equal(started.ok, true);
    if (started.ok) {
      assert.equal(started.attempt.lifecycle, 'armed');
      assert.notEqual(started.attempt.sessionId, 'session-armed');
    }
  });

  it('keeps a finished pending route review and completes an open attempt that already has start and finish evidence', async () => {
    const home = makePlace({ id: 'place-home', name: 'Home' });
    const work = makePlace({
      id: 'place-work',
      name: 'Work',
      createdAtMs: 2,
      center: offsetLatLng(home.center.latitude, home.center.longitude, 300, 0),
    });
    const samples = completeJourneySamples({ origin: home, destination: work, sessionId: 'session-open' });
    const pending = finishedPendingSnapshot();
    const open = completedEvidenceSnapshot(home, work, samples);
    const sql = await openDb();
    await service(sql).restoreBackup(serializeBackupSnapshot(mergeSnapshots(pending, open)));
    const sessions = new SqliteLocationSampleStore(async () => sql);
    const pendingSession = await sessions.findPendingRouteCreation();
    assert.equal(pendingSession?.id, 'session-review');
    assert.equal(pendingSession?.isActive, false);
    const attempt = await new SqliteAttemptStore(async () => sql).getAttempt('attempt-open');
    assert.equal(attempt?.lifecycle, 'completed');
    assert.equal(attempt?.validity, 'valid');
    assert.equal(attempt?.originPlaceId, home.id);
    assert.equal(attempt?.destinationPlaceId, work.id);
    assert.ok(attempt?.startedAtMs != null && attempt.finishedAtMs != null);
    assert.equal((await sessions.getSession('session-open'))?.isActive, false);
  });

  it('keeps an archived discovered path variant archived after restore and recompute', async () => {
    const home = makePlace({ id: 'place-home', name: 'Home' });
    const work = makePlace({
      id: 'place-work',
      name: 'Work',
      createdAtMs: 2,
      center: offsetLatLng(home.center.latitude, home.center.longitude, 1000, 0),
    });
    const main = northPath({
      startLat: home.center.latitude,
      startLng: home.center.longitude,
      points: 51,
      stepMeters: 20,
    });
    const traces = [0, 6, 12].map((east, index) => {
      const sessionId = `session-${index}`;
      const samples = traceAlongPath(
        main.map((point) => offsetLatLng(point.latitude, point.longitude, 0, east)),
        { sessionId, startMs: 1_700_000_000_000 + index * 10_000, intervalMs: 1000, stepMeters: 10, count: 80 },
      );
      const startedAtMs = samples[0]!.recordedAtMs;
      const finishedAtMs = samples[samples.length - 1]!.recordedAtMs;
      const trace: JourneyAttemptTrace = {
        attempt: {
          id: `attempt-${index}`,
          routeId: null,
          originPlaceId: home.id,
          destinationPlaceId: work.id,
          transportationMode: 'scooter',
          sessionId,
          lifecycle: 'completed',
          validity: 'valid',
          armedAtMs: startedAtMs - 1_000,
          startedAtMs,
          finishedAtMs,
          ...capturedLocalStart(0, 'UTC'),
          resultAcknowledged: true,
          hiddenIncomplete: false,
          crossings: [],
          ...RECONCILED_ATTEMPT,
        },
        samples,
      };
      return trace;
    });
    const discovered = await planPathVariantRecompute({
      pool: { originPlaceId: home.id, destinationPlaceId: work.id, transportationMode: 'scooter' },
      origin: home,
      destination: work,
      traces,
      routes: [],
      nowMs: 9_000,
      createRouteId: () => 'route-discovered',
    });
    assert.equal(discovered.newRoutes.length, 1);
    const archived = { ...discovered.newRoutes[0]!, status: 'archived' as const, name: 'River route' };
    const assigned = traces.map((trace) => ({
      ...trace,
      attempt: { ...trace.attempt, routeId: archived.id },
    }));
    const snapshot: BackupSnapshot = {
      createdAtMs: NOW,
      sourceSchemaVersion: 11,
      sourceAppVersion: '0.1.0',
      places: [home, work],
      routes: [archived],
      sessions: assigned.map((trace) => ({
        id: trace.attempt.sessionId,
        startedAtMs: trace.attempt.armedAtMs,
        stoppedAtMs: trace.attempt.finishedAtMs,
        isActive: false,
        purpose: 'attempt' as const,
        captureOutcome: 'finished' as const,
        reviewDisposition: 'saved' as const,
        lastSampleAtMs: null,
        backgroundPermissionConfirmed: false,
      })),
      samples: assigned.flatMap((trace) => trace.samples),
      attempts: assigned.map((trace) => trace.attempt),
      settings: [{ key: ACTIVE_TRANSPORTATION_MODE_KEY, value: 'scooter' }],
    };
    const sql = await openDb();
    const { attemptRuntime, routes } = createSqliteWorkspace(sql, { now: () => NOW });
    await service(sql, { now: () => NOW }).restoreBackup(serializeBackupSnapshot(snapshot));
    await attemptRuntime.recomputeAllPathVariants({ skipIfUnchanged: false, yieldToIdle: async () => {} });
    const stored = await routes.listRoutes();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, 'route-discovered');
    assert.equal(stored[0]?.status, 'archived');
    assert.equal(stored[0]?.kind, 'discovered');
    assert.equal(stored[0]?.name, 'River route');
    assert.equal(stored[0]?.clusterSignature, archived.clusterSignature);
  });

  it('shows the privacy notice and replace confirmation in Settings', () => {
    const screen = readFileSync('src/ui/SettingsScreen.tsx', 'utf8');
    assert.match(screen, /BACKUP_PRIVACY_NOTICE/);
    assert.match(screen, /BACKUP_EXPORT_LABEL/);
    assert.match(screen, /BACKUP_RESTORE_LABEL/);
    assert.match(screen, /BACKUP_REPLACE_CONFIRM_LABEL/);
    assert.match(BACKUP_PRIVACY_NOTICE, /precise location history/);
    assert.match(BACKUP_PRIVACY_NOTICE, /does not upload/);
    assert.equal(BACKUP_EXPORT_LABEL, 'Export backup');
    assert.equal(BACKUP_RESTORE_LABEL, 'Restore backup');
    assert.equal(BACKUP_REPLACE_CONFIRM_LABEL, 'Replace local data with this backup');
    const app = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    assert.match(app, /backup\.restoreBackup\(restoreText\)/);
    assert.match(app, /recomputePathVariants/);
  });
});

function armedSnapshot(): BackupSnapshot {
  return {
    createdAtMs: 1_700_000_010_000,
    sourceSchemaVersion: 11,
    sourceAppVersion: '0.1.0',
    places: [],
    routes: [],
    sessions: [
      {
        id: 'session-armed',
        startedAtMs: 1_700_000_000_000,
        stoppedAtMs: null,
        isActive: true,
        purpose: 'attempt',
        captureOutcome: 'active',
        reviewDisposition: 'pending',
        lastSampleAtMs: null,
        backgroundPermissionConfirmed: true,
      },
    ],
    samples: [
      {
        id: 'sample-1',
        sessionId: 'session-armed',
        recordedAtMs: 1_700_000_000_500,
        latitude: 32.08,
        longitude: 34.78,
        horizontalAccuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: 10,
      },
    ],
    attempts: [
      {
        id: 'attempt-armed',
        routeId: null,
        originPlaceId: null,
        destinationPlaceId: null,
        transportationMode: 'scooter',
        sessionId: 'session-armed',
        lifecycle: 'armed',
        validity: 'pending',
        armedAtMs: 1_700_000_000_000,
        startedAtMs: null,
        finishedAtMs: null,
        ...EMPTY_ATTEMPT_LOCAL_START,
        resultAcknowledged: false,
        hiddenIncomplete: false,
        crossings: [],
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      },
    ],
    settings: [{ key: ACTIVE_TRANSPORTATION_MODE_KEY, value: 'scooter' }],
  };
}

function finishedPendingSnapshot(): BackupSnapshot {
  return {
    createdAtMs: NOW,
    sourceSchemaVersion: 11,
    sourceAppVersion: '0.1.0',
    places: [],
    routes: [],
    sessions: [
      {
        id: 'session-review',
        startedAtMs: 1_700_000_400_000,
        stoppedAtMs: 1_700_000_500_000,
        isActive: false,
        purpose: 'route_creation',
        captureOutcome: 'finished',
        reviewDisposition: 'pending',
        lastSampleAtMs: null,
        backgroundPermissionConfirmed: false,
      },
    ],
    samples: [
      {
        id: 'review-sample',
        sessionId: 'session-review',
        recordedAtMs: 1_700_000_450_000,
        latitude: 32.08,
        longitude: 34.78,
        horizontalAccuracyMeters: 5,
        speedMetersPerSecond: 1,
        headingDegrees: null,
      },
    ],
    attempts: [],
    settings: [{ key: ACTIVE_TRANSPORTATION_MODE_KEY, value: 'scooter' }],
  };
}

function completedEvidenceSnapshot(
  home: ReturnType<typeof makePlace>,
  work: ReturnType<typeof makePlace>,
  samples: BackupSnapshot['samples'],
): BackupSnapshot {
  return {
    createdAtMs: NOW,
    sourceSchemaVersion: 11,
    sourceAppVersion: '0.1.0',
    places: [home, work],
    routes: [],
    sessions: [
      {
        id: 'session-open',
        startedAtMs: samples[0]?.recordedAtMs ?? 1_700_000_000_000,
        stoppedAtMs: null,
        isActive: true,
        purpose: 'attempt',
        captureOutcome: 'active',
        reviewDisposition: 'pending',
        lastSampleAtMs: null,
        backgroundPermissionConfirmed: false,
      },
    ],
    samples,
    attempts: [
      {
        id: 'attempt-open',
        routeId: null,
        originPlaceId: null,
        destinationPlaceId: null,
        transportationMode: 'scooter',
        sessionId: 'session-open',
        lifecycle: 'armed',
        validity: 'pending',
        armedAtMs: (samples[0]?.recordedAtMs ?? 1_700_000_000_000) - 1_000,
        startedAtMs: null,
        finishedAtMs: null,
        ...EMPTY_ATTEMPT_LOCAL_START,
        resultAcknowledged: false,
        hiddenIncomplete: false,
        crossings: [],
        reconciliationStatus: 'pending',
        reconciliationVersion: 0,
      },
    ],
    settings: [{ key: ACTIVE_TRANSPORTATION_MODE_KEY, value: 'walk' }],
  };
}

function mergeSnapshots(left: BackupSnapshot, right: BackupSnapshot): BackupSnapshot {
  return {
    ...right,
    places: [...left.places, ...right.places],
    routes: [...left.routes, ...right.routes],
    sessions: [...left.sessions, ...right.sessions],
    samples: [...left.samples, ...right.samples],
    attempts: [...left.attempts, ...right.attempts],
    settings: right.settings,
  };
}
