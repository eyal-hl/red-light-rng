import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pathDistanceMeters } from '../src/domain/geo';
import { deriveRouteGeometry, MIN_START_FINISH_SEPARATION_METERS } from '../src/domain/route-derivation';
import { movingTrace, offsetLatLng, sample } from './helpers/samples';

describe('deriveRouteGeometry', () => {
  it('builds a reference path and distance from a moving trace instead of summing raw jitter', () => {
    const samples = movingTrace({ points: 16, stepMeters: 15 });
    const redLight = samples[8];
    assert.ok(redLight);
    for (let index = 0; index < 20; index += 1) {
      const jitter = offsetLatLng(redLight.latitude, redLight.longitude, (index % 5) - 2, ((index * 3) % 5) - 2);
      samples.splice(
        9 + index,
        0,
        sample({
          id: `jitter-${index}`,
          recordedAtMs: redLight.recordedAtMs + 50 + index * 50,
          latitude: jitter.latitude,
          longitude: jitter.longitude,
          speedMetersPerSecond: 0,
          horizontalAccuracyMeters: 8,
        }),
      );
    }

    const derived = deriveRouteGeometry(samples);
    assert.equal(derived.saveable, true);
    assert.ok(derived.distanceMeters > 100);
    assert.ok(derived.distanceMeters < 280);

    const naive = pathDistanceMeters(samples.map((item) => ({ latitude: item.latitude, longitude: item.longitude })));
    assert.ok(naive > derived.distanceMeters);
    assert.ok(derived.startZone);
    assert.ok(derived.finishZone);
  });

  it('drops poor-accuracy fixes from the reference path', () => {
    const clean = movingTrace({ points: 12, stepMeters: 20 });
    const noisy = clean.flatMap((item, index) => [
      item,
      sample({
        id: `poor-${index}`,
        recordedAtMs: item.recordedAtMs + 1,
        latitude: item.latitude + 0.01,
        longitude: item.longitude,
        horizontalAccuracyMeters: 80,
        speedMetersPerSecond: 4,
      }),
    ]);

    const derived = deriveRouteGeometry(noisy);
    assert.equal(derived.saveable, true);
    assert.ok(derived.referencePath.length < noisy.length);
    assert.ok(derived.referencePath.every((point) => Math.abs(point.latitude - 32.08) < 0.005));
  });

  it('places start and finish zones on sustained-movement boundaries, not the first and last raw fixes', () => {
    const indoor = offsetLatLng(32.08, 34.78, 0, 45);
    const samples = [];
    for (let index = 0; index < 8; index += 1) {
      samples.push(
        sample({
          id: `lead-${index}`,
          recordedAtMs: 1_000 + index * 1000,
          latitude: indoor.latitude,
          longitude: indoor.longitude,
          speedMetersPerSecond: 0,
        }),
      );
    }
    samples.push(...movingTrace({ startMs: 10_000, points: 12, stepMeters: 15 }));
    const lastMoving = samples[samples.length - 1];
    assert.ok(lastMoving);
    const parking = offsetLatLng(lastMoving.latitude, lastMoving.longitude, 0, 40);
    for (let index = 0; index < 8; index += 1) {
      samples.push(
        sample({
          id: `tail-${index}`,
          recordedAtMs: lastMoving.recordedAtMs + 1000 + index * 1000,
          latitude: parking.latitude,
          longitude: parking.longitude,
          speedMetersPerSecond: 0,
        }),
      );
    }

    const derived = deriveRouteGeometry(samples);
    assert.equal(derived.saveable, true);
    assert.ok(derived.startZone);
    assert.ok(derived.finishZone);
    assert.notEqual(derived.startZone.center.longitude, samples[0]?.longitude);
    assert.notEqual(derived.finishZone.center.longitude, samples[samples.length - 1]?.longitude);
    assert.ok(
      pathDistanceMeters([derived.startZone.center, derived.finishZone.center]) >=
        MIN_START_FINISH_SEPARATION_METERS,
    );
  });

  it('rejects an all-stationary degenerate trace', () => {
    const samples = Array.from({ length: 30 }, (_, index) =>
      sample({
        id: `still-${index}`,
        recordedAtMs: 1000 + index * 1000,
        latitude: 32.08 + index * 0.000001,
        longitude: 34.78,
        speedMetersPerSecond: 0,
        horizontalAccuracyMeters: 6,
      }),
    );
    const derived = deriveRouteGeometry(samples);
    assert.equal(derived.saveable, false);
    assert.equal(derived.referencePath.length, 0);
  });

  it('rejects an all-poor-accuracy degenerate trace', () => {
    const samples = movingTrace({ points: 20, stepMeters: 15 }).map((item, index) =>
      sample({
        ...item,
        id: `poor-${index}`,
        horizontalAccuracyMeters: 90,
      }),
    );
    const derived = deriveRouteGeometry(samples);
    assert.equal(derived.saveable, false);
  });
});
