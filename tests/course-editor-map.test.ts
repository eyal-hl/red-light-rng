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
    assert.match(source, /courseCameraBounds\(/);
    assert.doesNotMatch(source, /courseCameraBounds\([\s\S]*previewPoint/);
  });
});
