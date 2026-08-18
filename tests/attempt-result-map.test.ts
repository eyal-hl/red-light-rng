import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { OPENFREEMAP_LIBERTY_TEXT_FONT } from '../src/map/openfreemap-style';

describe('attempt result wait map', () => {
  it('keeps RouteMap outside the attempt-result ScrollView', () => {
    const source = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    const mapIndex = source.indexOf('<RouteMap');
    assert.ok(mapIndex >= 0, 'AttemptResultScreen must render RouteMap');
    const scrollStart = source.indexOf('<ScrollView');
    const scrollEnd = source.lastIndexOf('</ScrollView>');
    assert.ok(scrollStart >= 0);
    assert.equal(
      mapIndex > scrollStart && mapIndex < scrollEnd,
      false,
      'RouteMap must not be nested in ScrollView; parent scrolling fights pan/pinch',
    );
  });

  it('links wait list rows and map markers in both directions without mutating attempt data', () => {
    const source = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    assert.match(source, /onSelectWait=\{selectWait\}/);
    assert.match(source, /onWaitMarkerPress=\{selectWait\}/);
    assert.match(source, /waitEventIdNearPoint/);
    assert.match(source, /selectedWaitId=\{selectedWaitId\}/);
    assert.doesNotMatch(source, /workspace\.|acknowledgeAttemptResult|saveAttempt/);
  });

  it('renders wait duration labels on distinguishable markers', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    assert.match(map, /wait-point/);
    assert.match(map, /wait-label/);
    assert.match(map, /text-field/);
    assert.match(map, /onWaitMarkerPress/);
    assert.match(fallback, /Waiting stop/);
  });

  it('uses OpenFreeMap Liberty glyph fonts for wait duration labels', () => {
    assert.deepEqual(OPENFREEMAP_LIBERTY_TEXT_FONT, ['Noto Sans Regular']);
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const labelStart = map.indexOf('id="wait-label"');
    assert.ok(labelStart >= 0, 'RouteMap must render a wait-label symbol layer');
    const labelEnd = map.indexOf('/>', labelStart);
    assert.ok(labelEnd > labelStart);
    const waitLabel = map.slice(labelStart, labelEnd);
    assert.match(waitLabel, /'text-field':\s*\['get',\s*'label'\]/);
    assert.match(waitLabel, /'text-font':\s*OPENFREEMAP_LIBERTY_TEXT_FONT/);
    assert.doesNotMatch(waitLabel, /Open Sans|Arial Unicode/);
  });

  it('leaves Android attempt-detail back navigation on the existing history action', () => {
    const source = readFileSync('src/ui/system-back.ts', 'utf8');
    assert.match(source, /case 'attempt-detail':\s*return 'leaveAttemptDetailToHistory'/);
    assert.doesNotMatch(source, /selectedWaitId/);
  });
});
