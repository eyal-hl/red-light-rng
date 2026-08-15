import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toLocationSample, type RawLocationFix } from '../src/domain/location-sample';

function fix(overrides: Partial<RawLocationFix> = {}, coords: Partial<RawLocationFix['coords']> = {}): RawLocationFix {
  return {
    timestamp: 1_700_000_000_000,
    ...overrides,
    coords: {
      latitude: 32.0853,
      longitude: 34.7818,
      accuracy: 8,
      speed: 4.2,
      heading: 187,
      ...coords,
    },
  };
}

describe('toLocationSample', () => {
  it('maps a complete GPS fix into the shared sample shape', () => {
    const sample = toLocationSample('session-1', 'sample-1', fix());
    assert.deepEqual(sample, {
      id: 'sample-1',
      sessionId: 'session-1',
      recordedAtMs: 1_700_000_000_000,
      latitude: 32.0853,
      longitude: 34.7818,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 4.2,
      headingDegrees: 187,
    });
  });

  it('treats negative speed and heading as missing platform values', () => {
    const sample = toLocationSample('session-1', 'sample-1', fix({}, { speed: -1, heading: -1, accuracy: -1 }));
    assert.equal(sample?.speedMetersPerSecond, null);
    assert.equal(sample?.headingDegrees, null);
    assert.equal(sample?.horizontalAccuracyMeters, null);
  });

  it('rejects invalid coordinates instead of storing them', () => {
    assert.equal(toLocationSample('s', '1', fix({}, { latitude: 91 })), null);
    assert.equal(toLocationSample('s', '1', fix({}, { longitude: 181 })), null);
    assert.equal(toLocationSample('s', '1', fix({ timestamp: Number.NaN })), null);
  });
});
