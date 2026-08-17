import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { courseCameraBounds } from '../src/map/course-camera-bounds';
import { offsetLatLng } from './helpers/samples';
import { northPath } from './helpers/routes';

describe('course camera bounds', () => {
  it('does not import MapLibre or take a preview snap', () => {
    const source = readFileSync('src/map/course-camera-bounds.ts', 'utf8');
    assert.doesNotMatch(source, /@maplibre\/maplibre-react-native|maplibre/);
    assert.doesNotMatch(source, /previewPoint/);
  });

  it('frames the saved course without a preview snap', () => {
    const path = northPath(5);
    const startZone = { center: path[0]!, radiusMeters: 25 };
    const finishZone = { center: path[path.length - 1]!, radiusMeters: 25 };
    const checkpoints = [{ point: path[2]! }];
    const courseBounds = courseCameraBounds(path, startZone, finishZone, checkpoints);
    const farPreview = offsetLatLng(path[0]!.latitude, path[0]!.longitude, 8000, 8000);
    const withFarMarker = courseCameraBounds(path, startZone, finishZone, [
      ...checkpoints,
      { point: farPreview },
    ]);

    assert.deepEqual(
      courseCameraBounds(path, startZone, finishZone, checkpoints),
      courseBounds,
    );
    assert.notDeepEqual(
      withFarMarker,
      courseBounds,
      'a far extra point must change bounds, proving preview omission is load-bearing',
    );
  });

  it('expands framing when start or finish detection radiuses grow', () => {
    const path = northPath(5);
    const compact = courseCameraBounds(
      path,
      { center: path[0]!, radiusMeters: 25 },
      { center: path[path.length - 1]!, radiusMeters: 25 },
    );
    const wideStart = courseCameraBounds(
      path,
      { center: path[0]!, radiusMeters: 200 },
      { center: path[path.length - 1]!, radiusMeters: 25 },
    );
    assert.notDeepEqual(wideStart, compact);
    assert.ok(wideStart[1] < compact[1] || wideStart[3] > compact[3]);
  });
});
