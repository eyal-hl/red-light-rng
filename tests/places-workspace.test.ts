import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLACE_ARMED_MAX_DURATION_MS, PLACE_ACTIVE_MAX_DURATION_MS } from '../src/domain/place-timing';
import { PATH_ANALYTICS_UNAVAILABLE_MESSAGE } from '../src/domain/journey-analysis';
import { DEFAULT_PLACE_RADIUS_METERS } from '../src/domain/place';
import { completeJourneySamples, departureOnlySamples } from './helpers/places';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

describe('places workspace', () => {
  it('creates, renames, recenters, resizes, archives referenced places, and deletes unused ones', async () => {
    const { workspace, places } = createMemoryWorkspace();
    const created = await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: DEFAULT_PLACE_RADIUS_METERS,
    });
    assert.equal(created.ok, true);
    if (!created.ok) {
      return;
    }
    const renamed = await workspace.savePlace({
      ...created.place,
      name: 'Home base',
      radiusMeters: 40,
      center: offsetLatLng(32.08, 34.78, 4, 0),
    });
    assert.equal(renamed.ok, true);
    if (renamed.ok) {
      assert.equal(renamed.place.name, 'Home base');
      assert.equal(renamed.place.radiusMeters, 40);
    }

    const unused = await workspace.createPlace({
      name: 'Cafe',
      center: offsetLatLng(32.08, 34.78, 0, 400),
      radiusMeters: 25,
    });
    assert.equal(unused.ok, true);
    if (!unused.ok) {
      return;
    }
    const deleted = await workspace.removePlace(unused.place.id);
    assert.equal(deleted.ok, true);
    if (deleted.ok) {
      assert.equal(deleted.action, 'deleted');
    }
    assert.equal(await places.getPlace(unused.place.id), null);

    const work = await workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(32.08, 34.78, 300, 0),
      radiusMeters: 30,
    });
    assert.equal(work.ok, true);
    if (!work.ok) {
      return;
    }
    const armed = await workspace.startAttempt();
    assert.equal(armed.ok, true);
    if (armed.ok) {
      assert.equal(armed.attempt.routeId, null);
    }
    assert.equal((await places.listPlaces()).some((place) => place.name === 'Home base'), true);
    assert.equal((await places.listPlaces()).some((place) => place.name === 'Work'), true);
  });

  it('archives a place used by history and ignores it for live detection', async () => {
    const { workspace, sessions, places } = createMemoryWorkspace();
    const home = await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: 30,
    });
    const work = await workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(32.08, 34.78, 300, 0),
      radiusMeters: 30,
    });
    assert.equal(home.ok && work.ok, true);
    if (!home.ok || !work.ok) {
      return;
    }
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    await sessions.appendSamples(
      completeJourneySamples({ origin: home.place, destination: work.place, sessionId: 'id-1' }),
    );
    const completed = await workspace.processActiveAttempt();
    assert.equal(completed?.lifecycle, 'completed');
    const archived = await workspace.removePlace(home.place.id);
    assert.equal(archived.ok, true);
    if (archived.ok) {
      assert.equal(archived.action, 'archived');
    }
    assert.equal((await places.getPlace(home.place.id))?.status, 'archived');
    assert.equal((await workspace.getAttempt(completed!.id))?.originPlaceId, home.place.id);

    const again = await workspace.startAttempt();
    assert.equal(again.ok, true);
    await sessions.appendSamples([
      {
        id: 'inside-archived',
        sessionId: 'id-2',
        recordedAtMs: 1_700_000_100_000,
        latitude: home.place.center.latitude,
        longitude: home.place.center.longitude,
        horizontalAccuracyMeters: 5,
        speedMetersPerSecond: 0,
        headingDegrees: 0,
      },
    ]);
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.attempt?.lifecycle, 'armed');
    assert.notEqual(processed.startZoneStatus.placeId, home.place.id);
  });

  it('uses one global START, persisted mode, and never fails a journey as the wrong route', async () => {
    const { workspace, sessions, settings } = createMemoryWorkspace();
    await settings.setActiveTransportationMode('walk');
    const home = await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: 30,
    });
    const work = await workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(32.08, 34.78, 280, 0),
      radiusMeters: 30,
    });
    if (!home.ok || !work.ok) {
      return;
    }
    const snapshot = await workspace.loadHome();
    assert.equal(snapshot.canStartAttempt, true);
    assert.equal(snapshot.activeTransportationMode, 'walk');
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    assert.equal(started.attempt.routeId, null);
    assert.equal(started.attempt.transportationMode, 'walk');

    await sessions.appendSamples(
      completeJourneySamples({
        origin: home.place,
        destination: work.place,
        sessionId: started.attempt.sessionId,
        eastJitterMeters: 80,
        speedMps: 1.4,
      }),
    );
    const completed = await workspace.processActiveAttempt();
    assert.equal(completed?.lifecycle, 'completed');
    assert.equal(completed?.validity, 'valid');
    assert.equal(completed?.originPlaceId, home.place.id);
    assert.equal(completed?.destinationPlaceId, work.place.id);
    assert.equal(completed?.transportationMode, 'walk');
    assert.notEqual(completed?.lifecycle, 'abandoned');

    const corrected = await workspace.setAttemptTransportationMode(completed!.id, 'scooter');
    assert.equal(corrected?.transportationMode, 'scooter');
    const homeAfter = await workspace.loadHome();
    assert.equal(homeAfter.journeys.length, 1);
    assert.equal(homeAfter.journeys[0]?.transportationMode, 'scooter');
    assert.equal(homeAfter.journeys[0]?.rankedAttemptCount, 1);

    const analysis = await workspace.analyzeJourney(
      {
        originPlaceId: home.place.id,
        destinationPlaceId: work.place.id,
        transportationMode: 'scooter',
      },
      completed!.id,
    );
    assert.equal(analysis?.focus?.pathUnavailable, true);
    assert.equal(analysis?.focus?.officialTimeMs != null, true);
    assert.match(PATH_ANALYTICS_UNAVAILABLE_MESSAGE, /unavailable/);
  });

  it('caps armed attempts at 30 minutes as DID NOT START', async () => {
    let now = 1_700_000_000_000;
    const { workspace } = createMemoryWorkspace({ now: () => now });
    await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: 30,
    });
    const armed = await workspace.startAttempt();
    assert.equal(armed.ok, true);
    now += PLACE_ARMED_MAX_DURATION_MS;
    const timedOut = await workspace.processActiveAttempt();
    assert.equal(timedOut?.lifecycle, 'ended');
    assert.equal(timedOut?.startedAtMs, null);
    const debug = await workspace.inspectAttempt(timedOut!.id);
    assert.equal(debug?.place.incompleteLabel, 'DID NOT START');
    assert.equal(debug?.place.armedTimeout, true);
  });

  it('caps active attempts at 2 hours as DID NOT FINISH', async () => {
    let now = 1_700_000_000_000;
    const { workspace, sessions } = createMemoryWorkspace({ now: () => now, attemptId: 'attempt-2' });
    const origin = await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: 30,
    });
    const dest = await workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(32.08, 34.78, 300, 0),
      radiusMeters: 30,
    });
    if (!origin.ok || !dest.ok) {
      return;
    }
    await workspace.startAttempt();
    await sessions.appendSamples(
      departureOnlySamples({ origin: origin.place, sessionId: 'id-1', extraMeters: 40 }),
    );
    const active = await workspace.processActiveAttempt();
    assert.equal(active?.lifecycle, 'active');
    now = (active?.startedAtMs ?? now) + PLACE_ACTIVE_MAX_DURATION_MS;
    const dnf = await workspace.processActiveAttempt();
    assert.equal(dnf?.lifecycle, 'ended');
    assert.ok(dnf?.startedAtMs != null);
    const dnfDebug = await workspace.inspectAttempt(dnf!.id);
    assert.equal(dnfDebug?.place.incompleteLabel, 'DID NOT FINISH');
  });

  it('still discards on Cancel', async () => {
    const { workspace, sessions, platform } = createMemoryWorkspace({ attemptId: 'attempt-3' });
    await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: 30,
    });
    await workspace.startAttempt();
    await sessions.appendSamples(
      departureOnlySamples({
        origin: { center: { latitude: 32.08, longitude: 34.78 }, radiusMeters: 30 },
        sessionId: 'id-1',
      }),
    );
    const cancelled = await workspace.cancelAttempt();
    assert.equal(cancelled?.lifecycle, 'cancelled');
    assert.equal(cancelled?.resultAcknowledged, true);
    assert.equal(platform.updating, false);
    assert.equal(await workspace.getAttemptResult(), null);
  });
});
