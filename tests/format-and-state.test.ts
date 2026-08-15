import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatSampleLine } from '../src/domain/format-sample';
import { resolveTrackingStatus } from '../src/domain/tracking-state';

describe('formatSampleLine', () => {
  it('renders inspectable timestamp, coordinates, accuracy, speed, and heading', () => {
    const line = formatSampleLine({
      id: 'p1',
      sessionId: 's1',
      recordedAtMs: Date.UTC(2026, 7, 14, 12, 0, 0),
      latitude: 32.085312,
      longitude: 34.781812,
      horizontalAccuracyMeters: 8.25,
      speedMetersPerSecond: 4.2,
      headingDegrees: 187.4,
    });
    assert.match(line, /2026-08-14T12:00:00.000Z/);
    assert.match(line, /32\.085312, 34\.781812/);
    assert.match(line, /±8\.3m/);
    assert.match(line, /4\.2m\/s/);
    assert.match(line, /187°/);
  });
});

describe('resolveTrackingStatus', () => {
  it('is tracking when either the OS or an active session says so', () => {
    assert.equal(resolveTrackingStatus({ osUpdating: true, activeSessionId: null }), 'tracking');
    assert.equal(resolveTrackingStatus({ osUpdating: false, activeSessionId: 's1' }), 'tracking');
    assert.equal(resolveTrackingStatus({ osUpdating: false, activeSessionId: null }), 'idle');
  });
});
