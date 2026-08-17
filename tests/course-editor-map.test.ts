import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('course editor map gestures', () => {
  it('keeps RouteMap outside the editor ScrollView', () => {
    const source = readFileSync('src/ui/CourseEditorScreen.tsx', 'utf8');
    const mapIndex = source.indexOf('<RouteMap');
    assert.ok(mapIndex >= 0, 'CourseEditorScreen must render RouteMap');
    const scrollStart = source.indexOf('<ScrollView');
    const scrollEnd = source.lastIndexOf('</ScrollView>');
    if (scrollStart >= 0 && scrollEnd > scrollStart) {
      assert.equal(
        mapIndex > scrollStart && mapIndex < scrollEnd,
        false,
        'RouteMap must not be nested in ScrollView; parent scrolling fights pan/pinch',
      );
    }
  });

  it('exposes MOVE START and MOVE FINISH on the marker cards', () => {
    const source = readFileSync('src/ui/CourseEditorScreen.tsx', 'utf8');
    assert.match(source, /MOVE START/);
    assert.match(source, /MOVE FINISH/);
    assert.match(source, /beginMoveMarker/);
    assert.match(source, /PLACE HERE/);
  });

  it('lets the user edit auto-start and auto-finish radiuses on the marker cards', () => {
    const source = readFileSync('src/ui/CourseEditorScreen.tsx', 'utf8');
    assert.match(source, /Auto-start radius/);
    assert.match(source, /Auto-finish radius/);
    assert.match(source, /setStartZoneRadiusMeters/);
    assert.match(source, /setFinishZoneRadiusMeters/);
    assert.match(source, /keyboardType="number-pad"/);
  });

  it('initializes the camera from course bounds and does not re-fit on preview', () => {
    const source = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const cameraStart = source.indexOf('<Camera');
    assert.ok(cameraStart >= 0, 'RouteMap must render Camera');
    const cameraEnd = source.indexOf('/>', cameraStart);
    const cameraJsx = source.slice(cameraStart, cameraEnd + 2);
    assert.match(cameraJsx, /initialViewState/);
    const withoutInitial = cameraJsx.replace(/initialViewState=\{\{[\s\S]*?\}\}/, '');
    assert.doesNotMatch(withoutInitial, /\bbounds=/);
    assert.doesNotMatch(withoutInitial, /\bduration=/);
    assert.match(source, /courseCameraBounds\(\s*path,\s*startZone,\s*finishZone,\s*checkpoints\s*\)/);
    assert.doesNotMatch(source, /courseCameraBounds\([^)]*previewPoint/);
  });

  it('draws start and finish detection zones on the map and fallback preview', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    assert.match(map, /start-zone/);
    assert.match(map, /finish-zone/);
    assert.match(map, /startZone.radiusMeters/);
    assert.match(fallback, /Auto-start detection zone/);
    assert.match(fallback, /Auto-finish detection zone/);
  });
});
