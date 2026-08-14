import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RawLocationFix } from '../src/domain/location-sample';
import { MemoryLocationSampleStore } from '../src/persistence/memory-location-sample-store';
import { TrackingSessionService } from '../src/tracking/tracking-session-service';

const SAMPLE_FIX: RawLocationFix = {
  timestamp: 1_700_000_000_500,
  coords: {
    latitude: 32.08,
    longitude: 34.78,
    accuracy: 6,
    speed: 2,
    heading: 10,
  },
};

function createSessions() {
  const store = new MemoryLocationSampleStore();
  let nextId = 0;
  const sessions = new TrackingSessionService(store, () => `id-${++nextId}`);
  return { store, sessions };
}

describe('TrackingSessionService', () => {
  it('records incoming fixes onto the active session', async () => {
    const { store, sessions } = createSessions();
    const sessionId = await sessions.startSession(1000);

    const written = await sessions.recordActiveSessionFixes([SAMPLE_FIX]);
    assert.equal(written, 1);
    assert.equal(await store.countSamples(sessionId), 1);
  });

  it('drops trailing OS deliveries after the session has stopped', async () => {
    const { store, sessions } = createSessions();
    const sessionId = await sessions.startSession(1000);
    await sessions.recordActiveSessionFixes([SAMPLE_FIX]);
    await sessions.stopSession(sessionId, 2000);

    const lateFix: RawLocationFix = {
      ...SAMPLE_FIX,
      timestamp: 1_700_000_002_000,
    };
    assert.equal(await sessions.recordActiveSessionFixes([lateFix]), 0);
    assert.equal(await sessions.recordFixes(sessionId, [lateFix]), 0);
    assert.equal(await store.countSamples(sessionId), 1);
    assert.equal(store.peekSession(sessionId)?.isActive, false);
    assert.equal(store.peekSession(sessionId)?.stoppedAtMs, 2000);
  });

  it('does not re-attribute late fixes to the latest stopped session', async () => {
    const { store, sessions } = createSessions();
    const sessionId = await sessions.startSession(1000);
    await sessions.stopSession(sessionId, 2000);

    assert.equal(await store.getActiveSessionId(), null);
    assert.equal(await store.getLatestSessionId(), sessionId);
    assert.equal(await sessions.recordActiveSessionFixes([SAMPLE_FIX]), 0);
    assert.equal(await store.countSamples(sessionId), 0);
  });
});
