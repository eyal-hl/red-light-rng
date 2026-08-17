import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { haversineMeters, pathDistanceMeters } from '../src/domain/geo';
import {
  MAX_EDITOR_SNAP_DISTANCE_METERS,
  pointAtProgress,
  projectOntoReferencePath,
  snapEditorTap,
  TAP_TOO_FAR_REASON,
} from '../src/domain/path-projection';
import { offsetLatLng } from './helpers/samples';
import { northPath, outAndBackPath } from './helpers/routes';

describe('path projection', () => {
  it('projects a tap onto the closest position on a reference path', () => {
    const path = northPath({ points: 6, stepMeters: 20 });
    const target = pointAtProgress(path, 50);
    const tap = offsetLatLng(target.latitude, target.longitude, 0, 8);
    const projection = projectOntoReferencePath(path, tap);
    assert.ok(projection);
    assert.ok(Math.abs(projection.progressMeters - 50) < 1);
    assert.ok(projection.snapDistanceMeters < 9);
    assert.ok(haversineMeters(projection.snapped, target) < 1);
  });

  it('picks the lower-progress candidate when a retracing path produces a near-tie', () => {
    const path = outAndBackPath(20, 5);
    const tap = pointAtProgress(path, 50);
    const projection = projectOntoReferencePath(path, tap);
    assert.ok(projection);
    assert.ok(projection.progressMeters < 80, `expected outbound progress, got ${projection.progressMeters}`);
    assert.ok(Math.abs(projection.progressMeters - 50) < 2);
  });

  it('rejects an off-route tap beyond the editor snap ceiling', () => {
    const path = northPath({ points: 6, stepMeters: 20 });
    const tap = offsetLatLng(path[0]!.latitude, path[0]!.longitude, 0, MAX_EDITOR_SNAP_DISTANCE_METERS + 20);
    const result = snapEditorTap(path, tap);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, TAP_TOO_FAR_REASON);
    }
  });

  it('snaps a finish center past the last reference point onto the path end', () => {
    const path = northPath({ points: 6, stepMeters: 20 });
    const last = path[path.length - 1]!;
    const pastFinish = offsetLatLng(last.latitude, last.longitude, 8, 0);
    const projection = projectOntoReferencePath(path, pastFinish);
    assert.ok(projection);
    const total = pathDistanceMeters(path);
    assert.ok(Math.abs(projection.progressMeters - total) < 1);
    assert.ok(haversineMeters(projection.snapped, last) < 1);
  });
});
