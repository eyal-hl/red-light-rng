import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  openAttemptBlocksPlaceDeletion,
  PLACE_LIVE_ATTEMPT_REASON,
  placePermanentDeletionMessage,
} from '../src/domain/place';
import { applyMigrations } from '../src/persistence/migrations';
import { completeJourneySamples, departureOnlySamples, seedPlacesForRoute } from './helpers/places';
import { makeRoute } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';
import { createMemoryWorkspace, createSqliteWorkspace } from './helpers/workspace';

const HOME_CENTER = { latitude: 32.08, longitude: 34.78 };

async function createSeparatedPlaces(workspace: ReturnType<typeof createMemoryWorkspace>['workspace']) {
  const home = await workspace.createPlace({
    name: 'Home',
    center: HOME_CENTER,
    radiusMeters: 30,
  });
  const work = await workspace.createPlace({
    name: 'Work',
    center: offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 300, 0),
    radiusMeters: 30,
  });
  const oldHome = await workspace.createPlace({
    name: 'Home',
    center: offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 0, 400),
    radiusMeters: 30,
  });
  assert.equal(home.ok && work.ok && oldHome.ok, true);
  if (!home.ok || !work.ok || !oldHome.ok) {
    throw new Error('expected Home, Work, and Old Home');
  }
  return { home: home.place, work: work.place, oldHome: oldHome.place };
}

async function completeBetween(
  workspace: ReturnType<typeof createMemoryWorkspace>['workspace'],
  sessions: ReturnType<typeof createMemoryWorkspace>['sessions'],
  origin: { id: string; center: { latitude: number; longitude: number }; radiusMeters: number },
  destination: { id: string; center: { latitude: number; longitude: number }; radiusMeters: number },
) {
  const started = await workspace.startAttempt();
  assert.equal(started.ok, true);
  if (!started.ok) {
    throw new Error('expected armed attempt');
  }
  await sessions.appendSamples(
    completeJourneySamples({
      origin,
      destination,
      sessionId: started.attempt.sessionId,
    }),
  );
  const completed = await workspace.processActiveAttempt();
  assert.equal(completed?.lifecycle, 'completed');
  assert.equal(completed?.originPlaceId, origin.id);
  assert.equal(completed?.destinationPlaceId, destination.id);
  return completed!;
}

describe('place permanent deletion', () => {
  it('states how many associated runs a permanent delete will remove', () => {
    assert.match(placePermanentDeletionMessage('Cafe', 0), /No run history/);
    assert.match(placePermanentDeletionMessage('Home', 1), /1 associated run/);
    assert.match(placePermanentDeletionMessage('Work', 16), /16 associated runs/);
  });

  it('blocks deleting an active place while a run is armed or active', () => {
    const home = { id: 'home', status: 'active' as const };
    const archived = { id: 'old-home', status: 'archived' as const };
    const armed = {
      originPlaceId: null,
      destinationPlaceId: null,
      lifecycle: 'armed',
    };
    const active = {
      originPlaceId: 'home',
      destinationPlaceId: null,
      lifecycle: 'active',
    };
    assert.equal(openAttemptBlocksPlaceDeletion(armed, home), true);
    assert.equal(openAttemptBlocksPlaceDeletion(armed, archived), false);
    assert.equal(openAttemptBlocksPlaceDeletion(active, archived), false);
    assert.equal(
      openAttemptBlocksPlaceDeletion({ ...active, originPlaceId: 'old-home' }, archived),
      true,
    );
    assert.equal(openAttemptBlocksPlaceDeletion(null, home), false);
  });

  it('exposes Delete permanently on the Places list and editor for active and archived rows', () => {
    const list = readFileSync('src/ui/PlacesScreen.tsx', 'utf8');
    const editor = readFileSync('src/ui/PlaceEditorScreen.tsx', 'utf8');
    assert.match(list, /DELETE PERMANENTLY/);
    assert.match(list, /onDeletePermanently/);
    assert.match(editor, /DELETE PERMANENTLY/);
    assert.match(editor, /onDeletePermanently/);
    assert.match(editor, /ARCHIVE/);
  });

  it('deletes an archived referenced Place, its attempts, and only that journey pool', async () => {
    const { workspace, sessions, places } = createMemoryWorkspace();
    const { home, work, oldHome } = await createSeparatedPlaces(workspace);

    const canonical = await completeBetween(workspace, sessions, home, work);
    const reverse = await completeBetween(workspace, sessions, work, home);
    const duplicate = await completeBetween(workspace, sessions, oldHome, work);
    const archived = await workspace.archivePlace(oldHome.id);
    assert.equal(archived.ok, true);

    const before = await workspace.loadHome();
    assert.equal(before.journeys.length, 3);

    const deleted = await workspace.deletePlacePermanently(oldHome.id);
    assert.equal(deleted.ok, true);
    if (deleted.ok && deleted.action === 'deleted') {
      assert.equal(deleted.deletedAttemptCount, 1);
    }
    assert.equal(await places.getPlace(oldHome.id), null);
    assert.equal(await workspace.getAttempt(duplicate.id), null);
    assert.equal((await workspace.getAttempt(canonical.id))?.id, canonical.id);
    assert.equal((await workspace.getAttempt(reverse.id))?.id, reverse.id);
    assert.equal(await sessions.getSession(duplicate.sessionId), null);
    assert.ok(await sessions.getSession(canonical.sessionId));

    const after = await workspace.loadHome();
    assert.deepEqual(
      after.journeys.map((journey) => `${journey.originName} → ${journey.destinationName}`).sort(),
      ['Home → Work', 'Work → Home'],
    );
    assert.equal(after.journeys.some((journey) => journey.originPlaceId === oldHome.id), false);
  });

  it('deletes an active referenced Place after confirmation when no live attempt uses it', async () => {
    const { workspace, sessions, places } = createMemoryWorkspace();
    const { home, work } = await createSeparatedPlaces(workspace);
    const completed = await completeBetween(workspace, sessions, home, work);
    const deleted = await workspace.deletePlacePermanently(home.id);
    assert.equal(deleted.ok, true);
    if (deleted.ok && deleted.action === 'deleted') {
      assert.equal(deleted.deletedAttemptCount, 1);
    }
    assert.equal(await places.getPlace(home.id), null);
    assert.equal(await places.getPlace(work.id) != null, true);
    assert.equal(await workspace.getAttempt(completed.id), null);
    const after = await workspace.loadHome();
    assert.equal(after.journeys.length, 0);
  });

  it('blocks deleting a Place referenced by an armed or active attempt', async () => {
    const { workspace, sessions, places } = createMemoryWorkspace();
    const { home, work, oldHome } = await createSeparatedPlaces(workspace);
    await workspace.archivePlace(oldHome.id);
    const armed = await workspace.startAttempt();
    assert.equal(armed.ok, true);

    const blockedHome = await workspace.deletePlacePermanently(home.id);
    assert.equal(blockedHome.ok, false);
    if (!blockedHome.ok) {
      assert.equal(blockedHome.reason, PLACE_LIVE_ATTEMPT_REASON);
    }
    assert.equal((await places.getPlace(home.id))?.id, home.id);

    const blockedWork = await workspace.deletePlacePermanently(work.id);
    assert.equal(blockedWork.ok, false);

    if (armed.ok) {
      await sessions.appendSamples(
        departureOnlySamples({
          origin: home,
          sessionId: armed.attempt.sessionId,
          extraMeters: 40,
        }),
      );
    }
    const active = await workspace.processActiveAttempt();
    assert.equal(active?.lifecycle, 'active');
    const blockedActive = await workspace.deletePlacePermanently(home.id);
    assert.equal(blockedActive.ok, false);
    if (!blockedActive.ok) {
      assert.equal(blockedActive.reason, PLACE_LIVE_ATTEMPT_REASON);
    }

    const archivedOk = await workspace.deletePlacePermanently(oldHome.id);
    assert.equal(archivedOk.ok, true);
    assert.equal(await places.getPlace(oldHome.id), null);

    const cancelled = await workspace.cancelAttempt();
    assert.equal(cancelled?.lifecycle, 'cancelled');
    const deletedHome = await workspace.deletePlacePermanently(home.id);
    assert.equal(deletedHome.ok, true);
  });

  it('keeps unrelated history and reuses the remaining Place on a later path-variant save', async () => {
    const { workspace, sessions, places } = createMemoryWorkspace();
    const { home, work, oldHome } = await createSeparatedPlaces(workspace);
    await completeBetween(workspace, sessions, home, work);
    await completeBetween(workspace, sessions, oldHome, work);
    const deleted = await workspace.deletePlacePermanently(oldHome.id);
    assert.equal(deleted.ok, true);

    await seedPlacesForRoute(
      places,
      makeRoute({
        id: 'park-route',
        name: 'Park Route',
        startZone: { center: home.center, radiusMeters: 10 },
        finishZone: { center: work.center, radiusMeters: 40 },
      }),
    );
    const listed = await places.listPlaces();
    assert.equal(listed.length, 2);
    assert.equal(listed.some((place) => place.id === home.id), true);
    assert.equal(listed.some((place) => place.id === work.id), true);
    const homeAfter = await workspace.loadHome();
    assert.equal(homeAfter.journeys.length, 1);
    assert.equal(homeAfter.journeys[0]?.originPlaceId, home.id);
    assert.equal(homeAfter.journeys[0]?.destinationPlaceId, work.id);
    assert.equal(homeAfter.journeys[0]?.rankedAttemptCount, 1);
  });

  it('survives sqlite restart after permanently deleting a referenced Place', async () => {
    const sql = createMemorySqlExecutor();
    await applyMigrations(sql, 1);
    let seq = 0;
    const first = createSqliteWorkspace(sql, {
      createSessionId: () => `sql-id-${++seq}`,
      createAttemptId: () => `sql-attempt-${++seq}`,
      createPlaceId: () => `sql-place-${++seq}`,
    });
    const { home, work, oldHome } = await createSeparatedPlaces(first.workspace);
    await completeBetween(first.workspace, first.sessions, home, work);
    const duplicate = await completeBetween(first.workspace, first.sessions, oldHome, work);
    await first.workspace.archivePlace(oldHome.id);
    const deleted = await first.workspace.deletePlacePermanently(oldHome.id);
    assert.equal(deleted.ok, true);

    const reloaded = createSqliteWorkspace(sql, {
      createSessionId: () => `sql-id-${++seq}`,
      createAttemptId: () => `sql-attempt-${++seq}`,
    });
    assert.equal(await reloaded.places.getPlace(oldHome.id), null);
    assert.equal(await reloaded.attempts.getAttempt(duplicate.id), null);
    const snapshot = await reloaded.workspace.loadHome();
    assert.equal(snapshot.journeys.length, 1);
    assert.equal(snapshot.journeys[0]?.originPlaceId, home.id);
    assert.equal(snapshot.journeys[0]?.destinationPlaceId, work.id);
    assert.equal(snapshot.journeys[0]?.rankedAttemptCount, 1);
    const remainingSamples = await reloaded.sessions.countSamples(
      snapshot.journeys[0] ? (await reloaded.attempts.listAttempts())[0]!.sessionId : '',
    );
    assert.ok(remainingSamples > 0);
  });
});
