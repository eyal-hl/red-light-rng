import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryLocationSampleStore } from '../src/persistence/memory-location-sample-store';
import { mapLocationSampleRow } from '../src/persistence/schema';

describe('MemoryLocationSampleStore', () => {
  it('persists samples across a start/stop cycle and keeps them after the session ends', async () => {
    const store = new MemoryLocationSampleStore();
    await store.createSession('session-1', 1000);
    await store.appendSamples([
      {
        id: 'p1',
        sessionId: 'session-1',
        recordedAtMs: 1100,
        latitude: 32.08,
        longitude: 34.78,
        horizontalAccuracyMeters: 5,
        speedMetersPerSecond: 3,
        headingDegrees: 90,
      },
    ]);
    await store.stopSession('session-1', 2000);

    assert.equal(await store.getActiveSessionId(), null);
    assert.equal(await store.getLatestSessionId(), 'session-1');
    assert.equal(await store.countSamples('session-1'), 1);
    const samples = await store.listSamples('session-1');
    assert.equal(samples[0]?.id, 'p1');
  });

  it('closes a previous active session when a new one starts', async () => {
    const store = new MemoryLocationSampleStore();
    await store.createSession('session-1', 1000);
    await store.createSession('session-2', 2000);
    assert.equal(await store.getActiveSessionId(), 'session-2');
    assert.equal(await store.getLatestSessionId(), 'session-2');
  });
});

describe('mapLocationSampleRow', () => {
  it('maps SQLite row names onto the shared sample type', () => {
    const sample = mapLocationSampleRow({
      id: 'p1',
      session_id: 's1',
      recorded_at_ms: 42,
      latitude: 1,
      longitude: 2,
      horizontal_accuracy_meters: 3,
      speed_meters_per_second: 4,
      heading_degrees: 5,
    });
    assert.deepEqual(sample, {
      id: 'p1',
      sessionId: 's1',
      recordedAtMs: 42,
      latitude: 1,
      longitude: 2,
      horizontalAccuracyMeters: 3,
      speedMetersPerSecond: 4,
      headingDegrees: 5,
    });
  });
});
