import type { Attempt } from '../../src/domain/attempt';
import type { LocationSample } from '../../src/domain/location-sample';
import type { Place } from '../../src/domain/place';
import { applyMigrations } from '../../src/persistence/migrations';
import { SqliteAttemptStore } from '../../src/persistence/sqlite-attempt-store';
import { SqlitePlaceStore } from '../../src/persistence/sqlite-place-store';
import { SqliteRouteStore } from '../../src/persistence/sqlite-route-store';
import type { SqlExecutor } from '../../src/persistence/sql-executor';
import { createMemorySqlExecutor } from './node-sql-executor';
import { completeJourneySamples, dwellSamples, makePlace } from './places';
import { makeRoute, northPath } from './routes';
import { offsetLatLng } from './samples';

export const HOME = makePlace({ id: 'place-home', name: 'Home', createdAtMs: 1_000 });
export const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 1000, 0),
  createdAtMs: 2_000,
});
export const PARK: Place = makePlace({
  id: 'place-park',
  name: 'Park',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 0, 2500),
  radiusMeters: 55,
  status: 'archived',
  createdAtMs: 3_000,
});

export const BASE_MS = 1_700_000_000_000;
/** 2023-11-14T22:30:00Z: Tuesday in UTC, already Wednesday 01:30 at UTC+3. */
export const OFFSET_PLUS_180_START_MS = Date.UTC(2023, 10, 14, 22, 30, 0);

export async function openMigratedDb(): Promise<SqlExecutor> {
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, BASE_MS);
  return sql;
}

export type SeedSession = {
  id: string;
  startedAtMs: number;
  stoppedAtMs: number | null;
  isActive?: boolean;
  purpose: 'attempt' | 'route_creation' | 'legacy';
  captureOutcome: string;
  reviewDisposition: string;
  backgroundPermissionConfirmed?: boolean;
};

export async function seedSession(
  sql: SqlExecutor,
  session: SeedSession,
  samples: LocationSample[] = [],
): Promise<void> {
  await sql.run(
    `INSERT INTO tracking_session (
       id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition,
       background_permission_confirmed
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      session.startedAtMs,
      session.stoppedAtMs,
      session.isActive ? 1 : 0,
      session.purpose,
      session.captureOutcome,
      session.reviewDisposition,
      session.backgroundPermissionConfirmed ? 1 : 0,
    ],
  );
  for (const sample of samples) {
    await sql.run(
      `INSERT INTO location_sample (
         id, session_id, recorded_at_ms, latitude, longitude,
         horizontal_accuracy_meters, speed_meters_per_second, heading_degrees
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sample.id,
        sample.sessionId,
        sample.recordedAtMs,
        sample.latitude,
        sample.longitude,
        sample.horizontalAccuracyMeters,
        sample.speedMetersPerSecond,
        sample.headingDegrees,
      ],
    );
  }
}

export function baseAttempt(overrides: Partial<Attempt> & Pick<Attempt, 'id' | 'sessionId'>): Attempt {
  return {
    routeId: null,
    originPlaceId: null,
    destinationPlaceId: null,
    transportationMode: 'scooter',
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: BASE_MS,
    startedAtMs: null,
    finishedAtMs: null,
    startedUtcOffsetMinutes: null,
    startedTimezoneId: null,
    startedLocalTimeSource: null,
    resultAcknowledged: true,
    hiddenIncomplete: false,
    crossings: [],
    reconciliationStatus: 'reconciled',
    reconciliationVersion: 1,
    ...overrides,
  };
}

/** Every table row, in rowid order, for exact before/after database comparison. */
export async function dumpDatabase(sql: SqlExecutor): Promise<Record<string, unknown[]>> {
  const tables = await sql.getAll<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const dump: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    dump[name] = (await sql.getAll<Record<string, unknown>>(`SELECT * FROM ${name} ORDER BY rowid`)).map(
      (row) => ({ ...row }),
    );
  }
  return dump;
}

/**
 * A representative history with every durable record kind and every named attempt field populated.
 * No open attempt or active session, so it can be restored anywhere.
 */
export async function seedRepresentativeHistory(sql: SqlExecutor): Promise<void> {
  const places = new SqlitePlaceStore(async () => sql);
  const routes = new SqliteRouteStore(async () => sql);
  const attempts = new SqliteAttemptStore(async () => sql);
  for (const place of [HOME, WORK, PARK]) {
    await places.createPlace(place);
  }

  const completeSamples = completeJourneySamples({
    origin: HOME,
    destination: WORK,
    sessionId: 's-complete',
    startMs: BASE_MS,
  });
  const lastComplete = completeSamples[completeSamples.length - 1]!.recordedAtMs;
  await seedSession(
    sql,
    {
      id: 's-complete',
      startedAtMs: BASE_MS - 3_000,
      stoppedAtMs: lastComplete,
      purpose: 'attempt',
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
      backgroundPermissionConfirmed: true,
    },
    completeSamples,
  );

  const tzSamples = completeJourneySamples({
    origin: HOME,
    destination: WORK,
    sessionId: 's-tz',
    startMs: OFFSET_PLUS_180_START_MS,
  });
  await seedSession(
    sql,
    {
      id: 's-tz',
      startedAtMs: OFFSET_PLUS_180_START_MS - 3_000,
      stoppedAtMs: tzSamples[tzSamples.length - 1]!.recordedAtMs,
      purpose: 'attempt',
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
    },
    tzSamples,
  );

  const dnfSamples = dwellSamples(HOME.center, {
    sessionId: 's-dnf',
    startMs: BASE_MS + 500_000,
    count: 6,
  });
  await seedSession(
    sql,
    {
      id: 's-dnf',
      startedAtMs: BASE_MS + 499_000,
      stoppedAtMs: BASE_MS + 510_000,
      purpose: 'attempt',
      captureOutcome: 'interrupted',
      reviewDisposition: 'saved',
    },
    dnfSamples,
  );

  const sourceSamples = northPath({ startLat: HOME.center.latitude, startLng: HOME.center.longitude, points: 6 }).map(
    (point, index): LocationSample => ({
      id: `s-source-${index}`,
      sessionId: 's-source',
      recordedAtMs: BASE_MS + 700_000 + index * 1000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: index === 2 ? null : 7.5,
      speedMetersPerSecond: index === 3 ? null : 3.25,
      headingDegrees: index === 1 ? null : 90.5,
    }),
  );
  await seedSession(
    sql,
    {
      id: 's-source',
      startedAtMs: BASE_MS + 699_000,
      stoppedAtMs: BASE_MS + 710_000,
      purpose: 'route_creation',
      captureOutcome: 'finished',
      reviewDisposition: 'saved',
      backgroundPermissionConfirmed: true,
    },
    sourceSamples,
  );
  await seedSession(sql, {
    id: 's-pending',
    startedAtMs: BASE_MS + 800_000,
    stoppedAtMs: BASE_MS + 805_000,
    purpose: 'route_creation',
    captureOutcome: 'interrupted',
    reviewDisposition: 'pending',
  });
  await seedSession(sql, {
    id: 's-legacy',
    startedAtMs: 5,
    stoppedAtMs: 6,
    purpose: 'legacy',
    captureOutcome: 'unknown',
    reviewDisposition: 'discarded',
  });

  await routes.createRoute(
    makeRoute({
      id: 'route-explicit',
      name: 'Main road',
      transportationMode: 'bike',
      sourceRecordingId: 's-source',
      checkpoints: [
        { id: 'cp-1', name: 'Bridge', progressMeters: 40 },
        { id: 'cp-0', name: 'Corner', progressMeters: 20 },
      ],
      createdAtMs: BASE_MS + 711_000,
    }),
  );
  await routes.createRoute(
    makeRoute({
      id: 'route-discovered',
      name: 'Discovered path',
      transportationMode: 'scooter',
      sourceRecordingId: 's-complete',
      referencePath: northPath({ startLat: HOME.center.latitude, startLng: HOME.center.longitude, points: 4, stepMeters: 30 }),
      kind: 'discovered',
      status: 'archived',
      clusterSignature: 'cluster-signature-1',
      classificationVersion: 3,
      createdAtMs: BASE_MS + 712_000,
    }),
  );

  await attempts.saveAttempt(
    baseAttempt({
      id: 'attempt-complete',
      sessionId: 's-complete',
      routeId: 'route-explicit',
      originPlaceId: HOME.id,
      destinationPlaceId: WORK.id,
      armedAtMs: BASE_MS - 2_000,
      startedAtMs: BASE_MS + 2_000,
      finishedAtMs: lastComplete - 3_000,
      startedUtcOffsetMinutes: 120,
      startedTimezoneId: 'Asia/Jerusalem',
      startedLocalTimeSource: 'reconstructed',
      resultAcknowledged: false,
      crossings: [
        {
          id: 'attempt-complete:cp-0',
          attemptId: 'attempt-complete',
          checkpointId: 'cp-0',
          checkpointName: 'Corner',
          checkpointProgressMeters: 20,
          crossedAtMs: BASE_MS + 9_000,
        },
        {
          id: 'attempt-complete:cp-1',
          attemptId: 'attempt-complete',
          checkpointId: 'cp-1',
          checkpointName: 'Bridge',
          checkpointProgressMeters: 40,
          crossedAtMs: BASE_MS + 15_000,
        },
      ],
    }),
  );
  await attempts.saveAttempt(
    baseAttempt({
      id: 'attempt-tz',
      sessionId: 's-tz',
      originPlaceId: HOME.id,
      destinationPlaceId: WORK.id,
      transportationMode: 'bike',
      armedAtMs: OFFSET_PLUS_180_START_MS - 2_000,
      startedAtMs: OFFSET_PLUS_180_START_MS + 2_000,
      finishedAtMs: tzSamples[tzSamples.length - 1]!.recordedAtMs - 3_000,
      startedUtcOffsetMinutes: 180,
      startedTimezoneId: 'Europe/Moscow',
      startedLocalTimeSource: 'captured',
      reconciliationStatus: 'failed',
      reconciliationVersion: 0,
    }),
  );
  await attempts.saveAttempt(
    baseAttempt({
      id: 'attempt-dnf',
      sessionId: 's-dnf',
      lifecycle: 'ended',
      validity: 'unranked',
      originPlaceId: HOME.id,
      armedAtMs: BASE_MS + 499_000,
      startedAtMs: BASE_MS + 500_500,
      startedUtcOffsetMinutes: -300,
      startedTimezoneId: 'America/New_York',
      startedLocalTimeSource: 'captured',
      resultAcknowledged: true,
      hiddenIncomplete: true,
    }),
  );

  await sql.run(`UPDATE app_setting SET value = 'bike' WHERE key = 'active_transportation_mode'`);
  await sql.run(
    `INSERT INTO app_setting (key, value) VALUES ('path_variant_recompute_fingerprint', 'cached-fingerprint')`,
  );
}
