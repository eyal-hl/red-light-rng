import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatElapsed, formatOrdinal, formatRankAmong, formatSignedDelta, recordingElapsedMs, reviewDurationMs } from '../src/domain/duration';
import { formatSampleLine } from '../src/domain/format-sample';
import { resolveGpsHealth, STALE_FIX_THRESHOLD_MS } from '../src/domain/session';
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
  it('distinguishes tracking, interrupted, and idle from persisted capture outcome', () => {
    assert.equal(resolveTrackingStatus({ isActive: true, captureOutcome: 'active' }), 'tracking');
    assert.equal(resolveTrackingStatus({ isActive: false, captureOutcome: 'interrupted' }), 'interrupted');
    assert.equal(resolveTrackingStatus({ isActive: false, captureOutcome: 'finished' }), 'idle');
    assert.equal(resolveTrackingStatus({ isActive: false, captureOutcome: null }), 'idle');
  });
});

describe('recording and review durations', () => {
  it('derives elapsed recording time from persisted started_at_ms', () => {
    assert.equal(recordingElapsedMs(1_000, 4_000), 3_000);
    assert.equal(formatElapsed(3_000), '0:03');
    assert.equal(formatElapsed(62_000), '1:02');
    assert.equal(formatSignedDelta(-4_000), '-0:04');
    assert.equal(formatSignedDelta(19_000), '+0:19');
    assert.equal(formatSignedDelta(0), '0:00');
    assert.equal(formatOrdinal(1), '1st');
    assert.equal(formatOrdinal(2), '2nd');
    assert.equal(formatOrdinal(3), '3rd');
    assert.equal(formatOrdinal(4), '4th');
    assert.equal(formatOrdinal(11), '11th');
    assert.equal(formatRankAmong(4, 31), '4th fastest of 31');
  });

  it('uses stop time for a finished recording and last sample time for an interrupted one', () => {
    assert.equal(
      reviewDurationMs({
        captureOutcome: 'finished',
        startedAtMs: 1_000,
        stoppedAtMs: 5_000,
        lastSampleAtMs: 3_000,
      }),
      4_000,
    );
    assert.equal(
      reviewDurationMs({
        captureOutcome: 'interrupted',
        startedAtMs: 1_000,
        stoppedAtMs: 80_000,
        lastSampleAtMs: 4_000,
      }),
      3_000,
    );
  });
});

describe('resolveGpsHealth', () => {
  it('keeps pre-first-fix distinct from stale samples', () => {
    assert.equal(resolveGpsHealth(null, STALE_FIX_THRESHOLD_MS + 1), 'waiting_for_first_fix');
    assert.equal(resolveGpsHealth(1, 1 + STALE_FIX_THRESHOLD_MS), 'stale');
    assert.equal(resolveGpsHealth(1, 2), 'healthy');
  });
});
