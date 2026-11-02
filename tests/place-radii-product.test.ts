import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  liveMapPlaces,
  liveMapRadiusLegend,
  liveMapRadiusRole,
  livePlacesStructuralKey,
} from '../src/domain/attempt-live-map';
import { MAX_ZONE_RADIUS_METERS, MIN_ZONE_RADIUS_METERS } from '../src/domain/course-layout';
import {
  DEFAULT_PLACE_RADIUS_METERS,
  INVALID_PLACE_ARRIVAL_RADIUS_REASON,
  INVALID_PLACE_DEPARTURE_RADIUS_REASON,
  PLACE_ARRIVAL_RADIUS_HELP,
  PLACE_DEPARTURE_RADIUS_HELP,
  PLACE_RADIUS_OPEN_ATTEMPT_REASON,
  PLACE_RADIUS_PREVIEW_LEGEND,
  placeEditorPreviewZones,
  placeZone,
  validatePlaceInput,
  type Place,
} from '../src/domain/place';
import { inspectPlaceAttempt } from '../src/domain/place-debug';
import { ensurePlacesForRoute, seedPlacesFromRoutes } from '../src/domain/place-seeding';
import { applyMigrations, MIGRATIONS } from '../src/persistence/migrations';
import { SqlitePlaceStore } from '../src/persistence/sqlite-place-store';
import { CURRENT_SCHEMA_VERSION, LOCATION_SPIKE_SCHEMA } from '../src/persistence/schema';
import type { SqlExecutor } from '../src/persistence/sql-executor';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { completeJourneySamples, departureOnlySamples, makePlace } from './helpers/places';
import { makeRoute } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const HOME_CENTER = { latitude: 32.08, longitude: 34.78 };
const WORK_CENTER = offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 400, 0);

type Workspace = ReturnType<typeof createMemoryWorkspace>;

async function migratedSql(): Promise<SqlExecutor> {
  const sql = createMemorySqlExecutor();
  await sql.exec('PRAGMA foreign_keys = ON;');
  await applyMigrations(sql, 1_000);
  return sql;
}

type Backend = { name: string; create: () => Promise<Workspace> };

const BACKENDS: Backend[] = [
  { name: 'memory', create: async () => createMemoryWorkspace() },
  {
    name: 'sqlite',
    create: async () => createSqliteWorkspace(await migratedSql()) as unknown as Workspace,
  },
];

async function seedHomeWork(ws: Workspace) {
  const home = await ws.workspace.createPlace({
    name: 'Home',
    center: HOME_CENTER,
    departureRadiusMeters: 100,
    arrivalRadiusMeters: 30,
  });
  const work = await ws.workspace.createPlace({
    name: 'Work',
    center: WORK_CENTER,
    departureRadiusMeters: 45,
    arrivalRadiusMeters: 70,
  });
  assert.ok(home.ok && work.ok);
  if (!home.ok || !work.ok) {
    throw new Error('expected places');
  }
  return { home: home.place, work: work.place };
}

describe('Place radius validation and defaults', () => {
  it('keeps the 8-250 m bounds for both radii, with distinct messages', () => {
    assert.equal(MIN_ZONE_RADIUS_METERS, 8);
    assert.equal(MAX_ZONE_RADIUS_METERS, 250);
    const ok = { name: 'Home', departureRadiusMeters: 8, arrivalRadiusMeters: 250 };
    assert.equal(validatePlaceInput(ok).valid, true);
    assert.equal(
      validatePlaceInput({ ...ok, departureRadiusMeters: 7.9 }).reason,
      INVALID_PLACE_DEPARTURE_RADIUS_REASON,
    );
    assert.equal(
      validatePlaceInput({ ...ok, departureRadiusMeters: 251 }).reason,
      INVALID_PLACE_DEPARTURE_RADIUS_REASON,
    );
    assert.equal(
      validatePlaceInput({ ...ok, arrivalRadiusMeters: 7 }).reason,
      INVALID_PLACE_ARRIVAL_RADIUS_REASON,
    );
    assert.equal(
      validatePlaceInput({ ...ok, arrivalRadiusMeters: Number.NaN }).reason,
      INVALID_PLACE_ARRIVAL_RADIUS_REASON,
    );
    assert.match(INVALID_PLACE_DEPARTURE_RADIUS_REASON, /Departure radius must be between 8 and 250 m/);
    assert.match(INVALID_PLACE_ARRIVAL_RADIUS_REASON, /Arrival radius must be between 8 and 250 m/);
  });

  for (const backend of BACKENDS) {
    it(`[${backend.name}] rejects out-of-range radii on create and save without writing`, async () => {
      const ws = await backend.create();
      const bad = await ws.workspace.createPlace({
        name: 'Home',
        center: HOME_CENTER,
        departureRadiusMeters: 100,
        arrivalRadiusMeters: 3,
      });
      assert.deepEqual(bad, { ok: false, reason: INVALID_PLACE_ARRIVAL_RADIUS_REASON });
      assert.deepEqual(await ws.workspace.listPlaces(), []);
      const { home } = await seedHomeWork(ws);
      const badSave = await ws.workspace.savePlace({ ...home, departureRadiusMeters: 999 });
      assert.deepEqual(badSave, { ok: false, reason: INVALID_PLACE_DEPARTURE_RADIUS_REASON });
      assert.deepEqual(await ws.workspace.getPlace(home.id), home);
    });
  }

  it('new Place editor drafts default both radii to the current default radius', () => {
    const app = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    assert.match(app, /departureRadiusMeters: DEFAULT_PLACE_RADIUS_METERS,\s+arrivalRadiusMeters: DEFAULT_PLACE_RADIUS_METERS/);
    assert.equal(DEFAULT_PLACE_RADIUS_METERS, 30);
  });
});

describe('Place persistence: memory and SQLite stores agree', () => {
  it('saves, reloads and edits Home 100/30 and a different Work pair exactly', async () => {
    const [memory, sqlite] = await Promise.all(BACKENDS.map((backend) => backend.create()));
    const seeded = [];
    for (const ws of [memory!, sqlite!]) {
      const { home, work } = await seedHomeWork(ws);
      seeded.push({ ws, home, work });
    }
    for (const { ws, home, work } of seeded) {
      assert.deepEqual([home.departureRadiusMeters, home.arrivalRadiusMeters], [100, 30]);
      assert.deepEqual([work.departureRadiusMeters, work.arrivalRadiusMeters], [45, 70]);
      const edited = await ws.workspace.savePlace({ ...home, arrivalRadiusMeters: 35 });
      assert.ok(edited.ok);
    }
    const listed = await Promise.all(seeded.map(({ ws }) => ws.workspace.listPlaces()));
    const compact = (places: Place[]) =>
      places.map((place) => [place.name, place.departureRadiusMeters, place.arrivalRadiusMeters, place.status]);
    assert.deepEqual(compact(listed[0]!), compact(listed[1]!));
    assert.deepEqual(compact(listed[1]!), [
      ['Home', 100, 35, 'active'],
      ['Work', 45, 70, 'active'],
    ]);
  });

  it('archiving and renaming a Place keeps both radii and identity', async () => {
    for (const backend of BACKENDS) {
      const ws = await backend.create();
      const { home } = await seedHomeWork(ws);
      const renamed = await ws.workspace.savePlace({ ...home, name: 'Home base' });
      assert.ok(renamed.ok);
      await ws.workspace.archivePlace(home.id);
      const after = (await ws.workspace.getPlace(home.id))!;
      assert.equal(after.id, home.id);
      assert.equal(after.status, 'archived');
      assert.equal(after.name, 'Home base');
      assert.deepEqual([after.departureRadiusMeters, after.arrivalRadiusMeters], [100, 30]);
    }
  });

  it('route-to-Place seeding gives new Places equal radii and never overwrites an existing Place radii', () => {
    const route = makeRoute({ id: 'r1', name: 'Home -> Work', start: HOME_CENTER, finish: WORK_CENTER });
    const seeded = seedPlacesFromRoutes([route]);
    for (const place of seeded.places) {
      assert.equal(place.departureRadiusMeters, place.arrivalRadiusMeters);
    }
    const existingHome = makePlace({
      id: 'home',
      name: 'Home',
      center: HOME_CENTER,
      departureRadiusMeters: 100,
      arrivalRadiusMeters: 30,
    });
    const reused = ensurePlacesForRoute([existingHome], route, { createPlaceId: (index) => `new-${index}` });
    assert.equal(reused.assignment.startPlaceId, 'home');
    assert.equal(reused.placesToCreate.length, 1);
    assert.equal(reused.placesToCreate[0]!.arrivalRadiusMeters, reused.placesToCreate[0]!.departureRadiusMeters);
    assert.deepEqual([existingHome.departureRadiusMeters, existingHome.arrivalRadiusMeters], [100, 30]);
  });
});

describe('editing radii while a run is open', () => {
  for (const backend of BACKENDS) {
    it(`[${backend.name}] blocks a radius change while ARMED, leaving Place and attempt unchanged`, async () => {
      const ws = await backend.create();
      const { home, work } = await seedHomeWork(ws);
      const started = await ws.workspace.startAttempt();
      assert.ok(started.ok);
      const attemptBefore = await ws.workspace.getOpenAttempt();
      assert.equal(attemptBefore?.lifecycle, 'armed');
      const placesBefore = await ws.workspace.listPlaces();

      for (const change of [
        { departureRadiusMeters: 120 },
        { arrivalRadiusMeters: 31 },
        { departureRadiusMeters: 9, arrivalRadiusMeters: 9 },
      ]) {
        const blocked = await ws.workspace.savePlace({ ...home, ...change });
        assert.deepEqual(blocked, { ok: false, reason: PLACE_RADIUS_OPEN_ATTEMPT_REASON });
      }
      // Any place, not only one the run references.
      assert.deepEqual(await ws.workspace.savePlace({ ...work, arrivalRadiusMeters: 71 }), {
        ok: false,
        reason: PLACE_RADIUS_OPEN_ATTEMPT_REASON,
      });
      assert.deepEqual(await ws.workspace.listPlaces(), placesBefore);
      assert.deepEqual(await ws.workspace.getOpenAttempt(), attemptBefore);
      assert.match(PLACE_RADIUS_OPEN_ATTEMPT_REASON, /Finish or cancel the current run/);

      // Non-radius edits still save during an open attempt.
      const renamed = await ws.workspace.savePlace({ ...home, name: 'Home sweet home' });
      assert.ok(renamed.ok);
      const sameRadii = await ws.workspace.savePlace({ ...work, name: 'Office', departureRadiusMeters: 45, arrivalRadiusMeters: 70 });
      assert.ok(sameRadii.ok);

      // Succeeds once the run is no longer open.
      await ws.workspace.cancelAttempt();
      assert.equal(await ws.workspace.getOpenAttempt(), null);
      const saved = await ws.workspace.savePlace({ ...home, name: 'Home sweet home', departureRadiusMeters: 120, arrivalRadiusMeters: 31 });
      assert.ok(saved.ok);
      assert.deepEqual(
        (await ws.workspace.getPlace(home.id)) && [
          (await ws.workspace.getPlace(home.id))!.departureRadiusMeters,
          (await ws.workspace.getPlace(home.id))!.arrivalRadiusMeters,
        ],
        [120, 31],
      );
    });

    it(`[${backend.name}] blocks a radius change while ACTIVE and allows it after the run ends`, async () => {
      const ws = await backend.create();
      const { home, work } = await seedHomeWork(ws);
      const started = await ws.workspace.startAttempt();
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      await ws.sessions.appendSamples(
        departureOnlySamples({
          origin: home,
          sessionId: started.attempt.sessionId,
          extraMeters: 40,
          startMs: 1_700_000_000_000,
        }),
      );
      const processed = await ws.workspace.processActiveAttempt();
      assert.equal(processed?.lifecycle, 'active');
      const before = await ws.workspace.getOpenAttempt();

      const blocked = await ws.workspace.savePlace({ ...work, departureRadiusMeters: 60 });
      assert.deepEqual(blocked, { ok: false, reason: PLACE_RADIUS_OPEN_ATTEMPT_REASON });
      assert.deepEqual(await ws.workspace.getOpenAttempt(), before);
      assert.equal((await ws.workspace.getPlace(work.id))!.departureRadiusMeters, 45);

      await ws.workspace.cancelAttempt();
      const saved = await ws.workspace.savePlace({ ...work, departureRadiusMeters: 60 });
      assert.ok(saved.ok);
    });
  }
});

describe('completed attempts are not rewritten by editing radii', () => {
  for (const backend of BACKENDS) {
    it(`[${backend.name}] keeps the stored official times, validity and identity of past runs`, async () => {
      const ws = await backend.create();
      const { home, work } = await seedHomeWork(ws);
      const started = await ws.workspace.startAttempt();
      assert.ok(started.ok);
      if (!started.ok) {
        return;
      }
      await ws.sessions.appendSamples(
        completeJourneySamples({
          origin: home,
          destination: work,
          sessionId: started.attempt.sessionId,
          speedMps: 7,
        }),
      );
      const completed = await ws.workspace.processActiveAttempt();
      assert.equal(completed?.lifecycle, 'completed');
      const stored = (await ws.attempts.getAttempt(completed!.id))!;
      assert.ok(stored.startedAtMs != null && stored.finishedAtMs != null);

      // Edit both radii of both places (no open attempt now).
      assert.ok((await ws.workspace.savePlace({ ...home, departureRadiusMeters: 20, arrivalRadiusMeters: 200 })).ok);
      assert.ok((await ws.workspace.savePlace({ ...work, departureRadiusMeters: 200, arrivalRadiusMeters: 9 })).ok);
      // Re-processing with no open attempt replays nothing, so the stored result stays as it was.
      await ws.workspace.processActiveAttempt();

      const after = (await ws.attempts.getAttempt(completed!.id))!;
      assert.deepEqual(after, stored);
      assert.equal(after.originPlaceId, home.id);
      assert.equal(after.destinationPlaceId, work.id);
    });
  }
});

describe('SQLite migration 12: separate departure and arrival radii', () => {
  it('maps every existing Place radius to both new columns without wiping history', async () => {
    const sql = createMemorySqlExecutor();
    await sql.exec('PRAGMA foreign_keys = ON;');
    await sql.exec(LOCATION_SPIKE_SCHEMA);
    await sql.exec('PRAGMA user_version = 0');
    for (const migration of MIGRATIONS.filter((item) => item.version <= 11)) {
      await migration.up(sql, 1_000);
    }
    await sql.exec('PRAGMA user_version = 11');
    const before = await sql.getAll<{ name: string }>('PRAGMA table_info(place)');
    assert.equal(before.some((column) => column.name === 'departure_radius_meters'), false);

    const rows: [string, string, number, number, string, number][] = [
      ['home', 'Home', 32.08, 30, 'active', 1],
      ['work', 'Work', 32.09, 17.5, 'active', 2],
      ['old-gym', 'Gym', 32.1, 250, 'archived', 3],
    ];
    for (const [id, name, lat, radius, status, createdAt] of rows) {
      await sql.run(
        `INSERT INTO place (id, name, latitude, longitude, radius_meters, status, created_at_ms)
         VALUES (?, ?, ?, 34.78, ?, ?, ?)`,
        [id, name, lat, radius, status, createdAt],
      );
    }
    await sql.run(
      `INSERT INTO tracking_session (id, started_at_ms, stopped_at_ms, is_active, purpose, capture_outcome, review_disposition)
       VALUES ('sess', 10, 20, 0, 'attempt', 'finished', 'saved')`,
    );
    await sql.run(
      `INSERT INTO location_sample (id, session_id, recorded_at_ms, latitude, longitude, horizontal_accuracy_meters, speed_meters_per_second, heading_degrees)
       VALUES ('p1', 'sess', 12, 32.08, 34.78, 5, 1, 0)`,
    );
    await sql.run(
      `INSERT INTO attempt (id, route_id, origin_place_id, destination_place_id, transportation_mode, session_id,
                            lifecycle, validity, armed_at_ms, started_at_ms, finished_at_ms, result_acknowledged,
                            reconciliation_status, reconciliation_version)
       VALUES ('a1', NULL, 'home', 'work', 'scooter', 'sess', 'completed', 'valid', 9, 11.5, 19.25, 1, 'reconciled', 1)`,
    );

    await applyMigrations(sql, 5_000);

    const version = await sql.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, CURRENT_SCHEMA_VERSION);
    assert.ok(CURRENT_SCHEMA_VERSION >= 12, 'radii migration 12 is applied by every later schema');
    const places = await sql.getAll<{
      id: string;
      radius_meters: number;
      departure_radius_meters: number;
      arrival_radius_meters: number;
      status: string;
    }>('SELECT id, radius_meters, departure_radius_meters, arrival_radius_meters, status FROM place ORDER BY id');
    assert.deepEqual(
      places.map((place) => [place.id, place.departure_radius_meters, place.arrival_radius_meters, place.status]),
      [
        ['home', 30, 30, 'active'],
        ['old-gym', 250, 250, 'archived'],
        ['work', 17.5, 17.5, 'active'],
      ],
    );
    const store = new SqlitePlaceStore(async () => sql);
    const home = (await store.getPlace('home'))!;
    assert.deepEqual([home.departureRadiusMeters, home.arrivalRadiusMeters], [30, 30]);

    // History survives untouched.
    const attempt = await sql.getFirst<{ started_at_ms: number; finished_at_ms: number; origin_place_id: string }>(
      `SELECT started_at_ms, finished_at_ms, origin_place_id FROM attempt WHERE id = 'a1'`,
    );
    assert.deepEqual({ ...attempt }, { started_at_ms: 11.5, finished_at_ms: 19.25, origin_place_id: 'home' });
    assert.equal((await sql.getFirst<{ n: number }>('SELECT COUNT(*) AS n FROM location_sample'))!.n, 1);

    // Editing through the store writes both columns and mirrors the legacy one.
    await store.savePlace({ ...home, departureRadiusMeters: 100, arrivalRadiusMeters: 30 });
    const row = await sql.getFirst<{ radius_meters: number; departure_radius_meters: number; arrival_radius_meters: number }>(
      `SELECT radius_meters, departure_radius_meters, arrival_radius_meters FROM place WHERE id = 'home'`,
    );
    assert.deepEqual({ ...row }, { radius_meters: 100, departure_radius_meters: 100, arrival_radius_meters: 30 });

    // Idempotent on re-open.
    await applyMigrations(sql, 6_000);
    assert.deepEqual((await store.getPlace('home'))!.arrivalRadiusMeters, 30);
  });
});

describe('maps, labels and explanations', () => {
  const home = makePlace({ id: 'home', name: 'Home', departureRadiusMeters: 100, arrivalRadiusMeters: 30 });
  const work = makePlace({
    id: 'work',
    name: 'Work',
    center: WORK_CENTER,
    departureRadiusMeters: 45,
    arrivalRadiusMeters: 70,
  });

  it('armed live map draws departure radii; the active destination map draws arrival radii', () => {
    assert.equal(liveMapRadiusRole('armed'), 'departure');
    assert.equal(liveMapRadiusRole('active'), 'arrival');
    const armed = liveMapPlaces([home, work], liveMapRadiusRole('armed'));
    const active = liveMapPlaces([home, work], liveMapRadiusRole('active'));
    assert.deepEqual(armed.map((item) => item.radiusMeters), [100, 45]);
    assert.deepEqual(active.map((item) => item.radiusMeters), [30, 70]);
    assert.notEqual(livePlacesStructuralKey(armed, null), livePlacesStructuralKey(active, null));
    assert.match(liveMapRadiusLegend('departure'), /departure radius.*clock starts/);
    assert.match(liveMapRadiusLegend('arrival'), /arrival radius.*clock stops/);
  });

  it('equal radii render identically in both roles', () => {
    const equal = makePlace({ id: 'e', name: 'E', radiusMeters: 40 } as never);
    assert.deepEqual(
      liveMapPlaces([equal], 'departure').map((item) => item.radiusMeters),
      liveMapPlaces([equal], 'arrival').map((item) => item.radiusMeters),
    );
  });

  it('the Place editor previews both rings with a legend and names the effect of each radius', () => {
    const zones = placeEditorPreviewZones(home);
    assert.equal(zones.startZone.radiusMeters, 100);
    assert.equal(zones.finishZone.radiusMeters, 30);
    assert.deepEqual(zones.startZone.center, zones.finishZone.center);
    assert.deepEqual(placeZone(work, 'arrival').radiusMeters, 70);
    assert.equal(PLACE_DEPARTURE_RADIUS_HELP, 'Departure: clock starts on outward crossing');
    assert.equal(PLACE_ARRIVAL_RADIUS_HELP, 'Arrival: clock stops on inward crossing');
    assert.match(PLACE_RADIUS_PREVIEW_LEGEND, /departure.*arrival/i);

    const editor = readFileSync('src/ui/PlaceEditorScreen.tsx', 'utf8');
    assert.match(editor, /label="Departure radius"/);
    assert.match(editor, /label="Arrival radius"/);
    assert.match(editor, /help=\{PLACE_DEPARTURE_RADIUS_HELP\}/);
    assert.match(editor, /help=\{PLACE_ARRIVAL_RADIUS_HELP\}/);
    assert.match(editor, /startZone=\{startZone\}/);
    assert.match(editor, /finishZone=\{finishZone\}/);
    assert.doesNotMatch(editor, /accessibilityLabel="Place radius"/);
    const places = readFileSync('src/ui/PlacesScreen.tsx', 'utf8');
    assert.match(places, /Departure .*departureRadiusMeters.*Arrival .*arrivalRadiusMeters/s);
  });

  it('the live map component renders the radius legend', () => {
    const map = readFileSync('src/map/AttemptLiveMap.tsx', 'utf8');
    assert.match(map, /liveMapRadiusLegend\(liveMap\.places\[0\]!\.radiusRole\)/);
    const runtime = readFileSync('src/product/attempt-runtime.ts', 'utf8');
    assert.match(runtime, /liveMapPlaces\(places, liveMapRadiusRole\(next\.lifecycle\)\)/);
  });

  it('the debug report separates departure and arrival radii', () => {
    const samples = completeJourneySamples({ origin: home, destination: work, sessionId: 's', speedMps: 7 });
    const report = inspectPlaceAttempt([home, work], samples, {
      armedAtMs: samples[0]!.recordedAtMs,
      nowMs: samples[samples.length - 1]!.recordedAtMs,
    });
    const homeRow = report.places.find((item) => item.placeId === 'home')!;
    assert.deepEqual([homeRow.departureRadiusMeters, homeRow.arrivalRadiusMeters], [100, 30]);
    const workWatch = report.destinations.find((item) => item.placeId === 'work')!;
    assert.equal(workWatch.requiredEligibleMeters, 70 + 10);
    assert.equal(report.requiredRadialMeters, 100 + 18);
    assert.equal(report.pinnedDestinationPlaceId, 'work');
  });
});
