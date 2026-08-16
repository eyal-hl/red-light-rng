import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ActiveSessionExistsError } from '../src/domain/session';
import { MemoryLocationSampleStore } from '../src/persistence/memory-location-sample-store';
import { applyMigrations } from '../src/persistence/migrations';
import { mapLocationSampleRow } from '../src/persistence/schema';
import { SqliteLocationSampleStore } from '../src/persistence/sqlite-location-sample-store';
import type { LocationSampleStore } from '../src/persistence/location-sample-store';
import { createMemorySqlExecutor } from './helpers/node-sql-executor';

const SAMPLE = {
  id: 'p1',
  sessionId: 'session-1',
  recordedAtMs: 1100,
  latitude: 32.08,
  longitude: 34.78,
  horizontalAccuracyMeters: 5,
  speedMetersPerSecond: 3,
  headingDegrees: 90,
};

async function createSqliteStore() {
  const sql = createMemorySqlExecutor();
  await applyMigrations(sql, 1);
  return new SqliteLocationSampleStore(async () => sql);
}

function storeCases(): Array<{ name: string; create: () => Promise<LocationSampleStore> }> {
  return [
    { name: 'memory', create: async () => new MemoryLocationSampleStore() },
    { name: 'sqlite', create: createSqliteStore },
  ];
}

describe('LocationSampleStore', () => {
  for (const { name, create } of storeCases()) {
    describe(name, () => {
      it('persists samples across a start/stop cycle and keeps them after the session ends', async () => {
        const store = await create();
        await store.createSession('session-1', 1000);
        await store.appendSamples([SAMPLE]);
        await store.completeSession('session-1', {
          stoppedAtMs: 2000,
          captureOutcome: 'finished',
          reviewDisposition: 'pending',
        });

        assert.equal(await store.getActiveSessionId(), null);
        assert.equal(await store.getLatestSessionId(), 'session-1');
        assert.equal(await store.countSamples('session-1'), 1);
        const session = await store.getSession('session-1');
        assert.equal(session?.captureOutcome, 'finished');
        assert.equal(session?.reviewDisposition, 'pending');
        assert.equal(session?.lastSampleAtMs, 1100);
        assert.equal((await store.listSamples('session-1'))[0]?.id, 'p1');
      });

      it('persists a confirmed background permission across a reload of the same store', async () => {
        const store = await create();
        await store.createSession('session-1', 1000);
        assert.equal((await store.getSession('session-1'))?.backgroundPermissionConfirmed, false);

        await store.confirmBackgroundPermission('session-1');
        assert.equal((await store.getSession('session-1'))?.backgroundPermissionConfirmed, true);
      });

      it('refuses to create a second active session and does not truncate the first', async () => {
        const store = await create();
        await store.createSession('session-1', 1000);
        await store.appendSamples([SAMPLE]);

        await assert.rejects(
          () => store.createSession('session-2', 2000),
          (error: unknown) => {
            assert.ok(error instanceof ActiveSessionExistsError);
            assert.equal(error.existingSessionId, 'session-1');
            return true;
          },
        );

        assert.equal(await store.getActiveSessionId(), 'session-1');
        assert.equal(await store.countSamples('session-1'), 1);
        assert.equal(await store.getSession('session-2'), null);
      });

      it('does not append samples after the session is no longer active', async () => {
        const store = await create();
        await store.createSession('session-1', 1000);
        await store.completeSession('session-1', {
          stoppedAtMs: 2000,
          captureOutcome: 'interrupted',
          reviewDisposition: 'pending',
        });
        await store.appendSamples([SAMPLE]);
        assert.equal(await store.countSamples('session-1'), 0);
      });
    });
  }
});

describe('mapLocationSampleRow', () => {
  it('maps SQLite row names onto the shared sample type', () => {
    const mapped = mapLocationSampleRow({
      id: 'p1',
      session_id: 's1',
      recorded_at_ms: 42,
      latitude: 1,
      longitude: 2,
      horizontal_accuracy_meters: 3,
      speed_meters_per_second: 4,
      heading_degrees: 5,
    });
    assert.deepEqual(mapped, {
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
