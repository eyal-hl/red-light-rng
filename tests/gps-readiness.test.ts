import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { MAX_SAMPLE_ACCURACY_METERS } from '../src/domain/course-matching';
import {
  deriveGpsReadiness,
  formatGpsReadinessLabel,
  isAttemptCaptureAvailable,
  presentArmedAttemptStatus,
  type AttemptCaptureHealth,
} from '../src/domain/gps-readiness';
import { replayPlaceTrace } from '../src/domain/place-timing';
import { STALE_FIX_THRESHOLD_MS } from '../src/domain/session';
import { makePlace, sampleAt } from './helpers/places';
import { offsetLatLng } from './helpers/samples';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 300, 0),
  createdAtMs: 2,
});
const PLACES = [HOME, WORK];
const HEALTHY: AttemptCaptureHealth = {
  sessionActive: true,
  osUpdating: true,
  servicesEnabled: true,
  foregroundPermissionGranted: true,
  lastError: null,
};

function present(
  samples: Parameters<typeof replayPlaceTrace>[1],
  capture: AttemptCaptureHealth = HEALTHY,
  nowMs?: number,
) {
  const armedAtMs = samples[0]?.recordedAtMs ?? 1_000;
  const engine = replayPlaceTrace(PLACES, samples, {
    armedAtMs,
    nowMs: nowMs ?? samples[samples.length - 1]?.recordedAtMs ?? armedAtMs,
  });
  return {
    engine,
    ...presentArmedAttemptStatus(PLACES, samples, engine, capture),
  };
}

describe('attempt GPS readiness', () => {
  it('is WAITING when newly armed with no sample yet', () => {
    const result = present([]);
    assert.equal(result.gpsReadiness.state, 'waiting');
    assert.equal(formatGpsReadinessLabel(result.gpsReadiness), 'GPS WAITING');
    assert.equal(result.startZoneStatus.status, 'locating');
  });

  it('is GOOD for an accurate attempt-stream sample', () => {
    const sample = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000, accuracyMeters: 12 });
    const result = present([sample]);
    assert.equal(result.gpsReadiness.state, 'good');
    assert.equal(result.gpsReadiness.horizontalAccuracyMeters, 12);
    assert.equal(formatGpsReadinessLabel(result.gpsReadiness), 'GPS GOOD · ±12 m');
    assert.equal(result.startZoneStatus.status, 'inside');
    assert.equal(result.startZoneStatus.placeName, 'Home');
  });

  it('is POOR for a poor-accuracy attempt-stream sample', () => {
    const sample = sampleAt(HOME.center, {
      sessionId: 's',
      recordedAtMs: 1_000,
      accuracyMeters: MAX_SAMPLE_ACCURACY_METERS + 1,
    });
    const result = present([sample]);
    assert.equal(result.gpsReadiness.state, 'poor');
    assert.equal(formatGpsReadinessLabel(result.gpsReadiness), `GPS POOR · ±${MAX_SAMPLE_ACCURACY_METERS + 1} m`);
    assert.equal(result.startZoneStatus.status, 'locating');
    assert.equal(result.engine.rejectedPoorAccuracy, 1);
    assert.equal(result.engine.startedAtMs, null);
  });

  it('treats null accuracy as usable, matching journey timing', () => {
    const sample = {
      ...sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000 }),
      horizontalAccuracyMeters: null,
    };
    const result = present([sample]);
    assert.equal(result.gpsReadiness.state, 'good');
    assert.equal(result.gpsReadiness.horizontalAccuracyMeters, null);
    assert.equal(formatGpsReadinessLabel(result.gpsReadiness), 'GPS GOOD');
    assert.equal(result.startZoneStatus.status, 'inside');
  });

  it('uses the shared quality gate rather than a copied threshold', () => {
    const accepted = sampleAt(HOME.center, {
      sessionId: 's',
      recordedAtMs: 1_000,
      accuracyMeters: MAX_SAMPLE_ACCURACY_METERS,
    });
    const rejected = sampleAt(HOME.center, {
      sessionId: 's',
      recordedAtMs: 2_000,
      accuracyMeters: MAX_SAMPLE_ACCURACY_METERS + 0.01,
    });
    assert.equal(present([accepted]).gpsReadiness.state, 'good');
    assert.equal(present([rejected]).gpsReadiness.state, 'poor');
  });

  it('follows the newest delivered fix', () => {
    const good = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000, accuracyMeters: 8 });
    const poor = sampleAt(HOME.center, {
      sessionId: 's',
      recordedAtMs: 2_000,
      accuracyMeters: MAX_SAMPLE_ACCURACY_METERS + 20,
    });
    const recovered = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 3_000, accuracyMeters: 9 });
    assert.equal(present([good, poor]).gpsReadiness.state, 'poor');
    assert.equal(present([good, poor]).startZoneStatus.status, 'locating');
    assert.equal(present([good, poor, recovered]).gpsReadiness.state, 'good');
    assert.equal(present([good, poor, recovered]).startZoneStatus.status, 'inside');
  });

  it('keeps GOOD GPS distinct from start-zone membership', () => {
    const outside = sampleAt(offsetLatLng(HOME.center.latitude, HOME.center.longitude, 120, 0), {
      sessionId: 's',
      recordedAtMs: 1_000,
      accuracyMeters: 8,
    });
    const result = present([outside]);
    assert.equal(result.gpsReadiness.state, 'good');
    assert.equal(result.startZoneStatus.status, 'outside');
    assert.equal(result.startZoneStatus.placeName, null);
  });

  it('does not claim IN/OUT place status while WAITING or POOR', () => {
    assert.equal(present([]).startZoneStatus.status, 'locating');
    const poorInside = sampleAt(HOME.center, {
      sessionId: 's',
      recordedAtMs: 1_000,
      accuracyMeters: 80,
    });
    assert.equal(present([poorInside]).startZoneStatus.status, 'locating');
    const goodInside = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000, accuracyMeters: 8 });
    const unavailable = present([goodInside], { ...HEALTHY, osUpdating: false });
    assert.equal(unavailable.gpsReadiness.state, 'waiting');
    assert.equal(unavailable.startZoneStatus.status, 'locating');
    assert.equal(unavailable.engine.startZone.status, 'inside');
  });

  it('stays GOOD after more than 120 seconds with no new callback while capture stays healthy', () => {
    const good = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000, accuracyMeters: 8 });
    const later = present([good], HEALTHY, 1_000 + 3 * 60_000);
    assert.equal(later.gpsReadiness.state, 'good');
    assert.equal(later.startZoneStatus.status, 'inside');
    assert.equal(later.startZoneStatus.placeName, 'Home');
    assert.equal(later.engine.lifecycle, 'armed');
    assert.equal(later.engine.startedAtMs, null);
  });

  it('ignores capture-health flags that are still healthy even if gpsHealth would be stale', () => {
    const good = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000, accuracyMeters: 8 });
    const readiness = deriveGpsReadiness([good], true);
    assert.equal(readiness.state, 'good');
    assert.ok(3 * 60_000 > STALE_FIX_THRESHOLD_MS);
  });

  it('returns WAITING on explicit capture unavailability without changing official timing', () => {
    const good = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000, accuracyMeters: 8 });
    const cases: AttemptCaptureHealth[] = [
      { ...HEALTHY, servicesEnabled: false },
      { ...HEALTHY, foregroundPermissionGranted: false },
      { ...HEALTHY, osUpdating: false },
      { ...HEALTHY, sessionActive: false },
      { ...HEALTHY, lastError: 'Location updates failed.' },
    ];
    for (const capture of cases) {
      const result = present([good], capture);
      assert.equal(result.gpsReadiness.state, 'waiting', JSON.stringify(capture));
      assert.equal(result.startZoneStatus.status, 'locating');
      assert.equal(result.engine.lifecycle, 'armed');
      assert.equal(result.engine.startedAtMs, null);
      assert.equal(result.engine.startZone.status, 'inside');
    }
  });

  it('does not treat a background-permission warning as capture failure', () => {
    assert.equal(isAttemptCaptureAvailable(HEALTHY), true);
  });
});

describe('GPS readiness source boundaries', () => {
  it('reuses the shared accuracy predicate and does not copy a numeric threshold or stale clock', () => {
    const readiness = readFileSync('src/domain/gps-readiness.ts', 'utf8');
    assert.match(readiness, /isAccuracyAccepted/);
    assert.doesNotMatch(readiness, /45/);
    assert.doesNotMatch(readiness, /resolveGpsHealth|STALE_FIX_THRESHOLD|getCurrentPosition|startTracking/);
  });

  it('shows WAITING / POOR / GOOD on the armed attempt surface beside start-zone status', () => {
    const screen = readFileSync('src/ui/AttemptScreen.tsx', 'utf8');
    assert.match(screen, /formatGpsReadinessLabel/);
    assert.match(screen, /GPS readiness:/);
    assert.match(screen, /Start zone:/);
    assert.doesNotMatch(screen, /MAX_SAMPLE_ACCURACY|isAccuracyAccepted/);
  });

  it('does not add a Home pre-START watcher or a second tracking session', () => {
    const home = readFileSync('src/ui/HomeScreen.tsx', 'utf8');
    const app = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const runtime = readFileSync('src/product/attempt-runtime.ts', 'utf8');
    assert.doesNotMatch(home, /gpsReadiness|GPS WAITING|GPS GOOD|GPS POOR|getCurrentPosition|startTracking/);
    assert.match(app, /processActiveAttemptWithStartZoneStatus/);
    assert.match(app, /gpsReadiness=\{gpsReadiness\}/);
    assert.match(app, /pathVariants=\{journeyPathVariants\}/);
    assert.doesNotMatch(runtime, /getCurrentPosition/);
    assert.match(runtime, /presentArmedAttemptStatus/);
    assert.match(runtime, /planPathVariantRecompute/);
  });
});
