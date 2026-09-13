import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_SAMPLE_ACCURACY_METERS } from '../src/domain/course-matching';
import { STALE_FIX_THRESHOLD_MS } from '../src/domain/session';
import { departureOnlySamples, sampleAt } from './helpers/places';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

const HOME_CENTER = { latitude: 32.08, longitude: 34.78 };

async function seedHomeAndWork() {
  const now = { value: 1_700_000_000_000 };
  const ctx = createMemoryWorkspace({ now: () => now.value });
  const home = await ctx.workspace.createPlace({
    name: 'Home',
    center: HOME_CENTER,
    radiusMeters: 30,
  });
  const work = await ctx.workspace.createPlace({
    name: 'Work',
    center: offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 300, 0),
    radiusMeters: 30,
  });
  assert.equal(home.ok && work.ok, true);
  if (!home.ok || !work.ok) {
    throw new Error('expected places');
  }
  return { ...ctx, now, home: home.place, work: work.place };
}

describe('armed GPS readiness runtime', () => {
  it('lets START arm with no prior fix and shows WAITING from the attempt stream only', async () => {
    const { workspace, platform, tracker } = await seedHomeAndWork();
    const home = await workspace.loadHome();
    assert.equal(home.canStartAttempt, true);
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    assert.equal(started.attempt.lifecycle, 'armed');
    assert.equal(started.attempt.startedAtMs, null);
    assert.equal(platform.startUpdatesCalls, 1);
    assert.equal(platform.getCurrentPositionCalls, 0);

    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.attempt?.id, started.attempt.id);
    assert.equal(processed.gpsReadiness.state, 'waiting');
    assert.equal(processed.startZoneStatus.status, 'locating');
    assert.equal(platform.startUpdatesCalls, 1);
    assert.equal(platform.getCurrentPositionCalls, 0);
    assert.equal((await tracker.getState()).status, 'tracking');
  });

  it('turns an accurate attempt-stream sample into GOOD without starting official time', async () => {
    const { workspace, sessions, platform } = await seedHomeAndWork();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await sessions.appendSamples([
      sampleAt(HOME_CENTER, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: 1_700_000_000_000,
        accuracyMeters: 12,
      }),
    ]);
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.gpsReadiness.state, 'good');
    assert.equal(processed.gpsReadiness.horizontalAccuracyMeters, 12);
    assert.equal(processed.startZoneStatus.status, 'inside');
    assert.equal(processed.startZoneStatus.placeName, 'Home');
    assert.equal(processed.attempt?.lifecycle, 'armed');
    assert.equal(processed.attempt?.startedAtMs, null);
    assert.equal(platform.startUpdatesCalls, 1);
    assert.equal(platform.getCurrentPositionCalls, 0);
  });

  it('reports GOOD GPS while outside every saved place', async () => {
    const { workspace, sessions } = await seedHomeAndWork();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await sessions.appendSamples([
      sampleAt(offsetLatLng(HOME_CENTER.latitude, HOME_CENTER.longitude, 120, 0), {
        sessionId: started.attempt.sessionId,
        recordedAtMs: 1_700_000_000_000,
        accuracyMeters: 8,
      }),
    ]);
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.gpsReadiness.state, 'good');
    assert.equal(processed.startZoneStatus.status, 'outside');
    assert.equal(processed.attempt?.lifecycle, 'armed');
  });

  it('keeps GOOD after 3 minutes of stationary silence even when route-recording gpsHealth is stale', async () => {
    const { workspace, sessions, tracker, now } = await seedHomeAndWork();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const sampleTime = now.value;
    await sessions.appendSamples([
      sampleAt(HOME_CENTER, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: sampleTime,
        accuracyMeters: 8,
      }),
    ]);
    now.value = sampleTime + 3 * 60_000;
    assert.ok(now.value - sampleTime > STALE_FIX_THRESHOLD_MS);
    const tracking = await tracker.getState();
    assert.equal(tracking.gpsHealth, 'stale');
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.gpsReadiness.state, 'good');
    assert.equal(processed.startZoneStatus.status, 'inside');
    assert.equal(processed.startZoneStatus.placeName, 'Home');
    assert.equal(processed.attempt?.lifecycle, 'armed');
    assert.equal(processed.attempt?.startedAtMs, null);
  });

  it('returns WAITING on explicit capture failure and does not claim place IN/OUT', async () => {
    const { workspace, sessions, platform } = await seedHomeAndWork();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await sessions.appendSamples([
      sampleAt(HOME_CENTER, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: 1_700_000_000_000,
        accuracyMeters: 8,
      }),
    ]);
    const good = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(good.gpsReadiness.state, 'good');
    assert.equal(good.startZoneStatus.status, 'inside');

    platform.updating = false;
    const stopped = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(stopped.gpsReadiness.state, 'waiting');
    assert.equal(stopped.startZoneStatus.status, 'locating');
    assert.equal(stopped.attempt?.lifecycle, 'armed');
    assert.equal(stopped.attempt?.startedAtMs, null);

    platform.updating = true;
    platform.servicesEnabled = false;
    const servicesOff = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(servicesOff.gpsReadiness.state, 'waiting');
    assert.equal(servicesOff.attempt?.lifecycle, 'armed');

    platform.servicesEnabled = true;
    platform.foregroundGranted = false;
    const permissionLost = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(permissionLost.gpsReadiness.state, 'waiting');
    assert.equal(permissionLost.attempt?.lifecycle, 'armed');
  });

  it('does not create a second tracking session or current-position request for readiness', async () => {
    const { workspace, sessions, platform } = await seedHomeAndWork();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await sessions.appendSamples([
      sampleAt(HOME_CENTER, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: 1_700_000_000_000,
        accuracyMeters: MAX_SAMPLE_ACCURACY_METERS,
      }),
      sampleAt(HOME_CENTER, {
        sessionId: started.attempt.sessionId,
        recordedAtMs: 1_700_000_001_000,
        id: 'poor',
        accuracyMeters: MAX_SAMPLE_ACCURACY_METERS + 1,
      }),
    ]);
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.gpsReadiness.state, 'poor');
    assert.equal(processed.startZoneStatus.status, 'locating');
    assert.equal(processed.attempt?.lifecycle, 'armed');
    assert.equal(processed.attempt?.startedAtMs, null);
    assert.equal(platform.startUpdatesCalls, 1);
    assert.equal(platform.getCurrentPositionCalls, 0);
  });

  it('does not change official start detection when readiness is displayed', async () => {
    const { workspace, sessions, home } = await seedHomeAndWork();
    const started = await workspace.startAttempt();
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await sessions.appendSamples(
      departureOnlySamples({
        origin: home,
        sessionId: started.attempt.sessionId,
        extraMeters: 40,
      }),
    );
    const processed = await workspace.processActiveAttemptWithStartZoneStatus();
    assert.equal(processed.attempt?.lifecycle, 'active');
    assert.ok(processed.attempt?.startedAtMs != null);
    assert.equal(processed.attempt?.originPlaceId, home.id);
  });
});
