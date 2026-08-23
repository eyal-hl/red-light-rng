import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { OPENFREEMAP_LIBERTY_TEXT_FONT } from '../src/map/openfreemap-style';

describe('attempt result wait map', () => {
  it('scrolls header, map, and ghost chart as one attempt-result page', () => {
    const source = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    const mapIndex = source.indexOf('<RouteMap');
    const headerIndex = source.indexOf('styles.attemptResultHeader');
    const chartIndex = source.indexOf('<GhostDeltaChart');
    const scrollStart = source.indexOf('<ScrollView');
    const scrollEnd = source.lastIndexOf('</ScrollView>');
    assert.ok(mapIndex >= 0, 'AttemptResultScreen must render RouteMap');
    assert.ok(headerIndex >= 0, 'AttemptResultScreen must render the competitive header');
    assert.ok(chartIndex >= 0, 'AttemptResultScreen must render GhostDeltaChart');
    assert.ok(scrollStart >= 0);
    assert.ok(
      headerIndex > scrollStart && headerIndex < scrollEnd,
      'competitive header must scroll with the rest of attempt detail',
    );
    assert.ok(
      mapIndex > scrollStart && mapIndex < scrollEnd,
      'RouteMap must scroll with the rest of attempt detail instead of pinning a nested results viewport',
    );
    assert.ok(
      chartIndex > scrollStart && chartIndex < scrollEnd,
      'GhostDeltaChart must scroll with the rest of attempt detail',
    );
    assert.ok(headerIndex < mapIndex && mapIndex < chartIndex, 'header, map, and chart must stay in page order');
    const waitingIndex = source.indexOf('<WaitingVsPbBlock');
    assert.ok(waitingIndex >= 0, 'AttemptResultScreen must render WaitingVsPbBlock');
    assert.ok(
      waitingIndex > chartIndex && waitingIndex < scrollEnd,
      'Waiting vs PB must remain in the same scrolling page after the chart',
    );
    assert.match(source, /scrollEnabled=\{pageScrollEnabled\}/);
    assert.match(source, /onScrubChange=\{\(active\) => setPageScrollEnabled\(!active\)\}/);
    assert.match(source, /cameraGesturesEnabled=\{false\}/);
    assert.match(source, /nestedScrollEnabled/);
  });

  it('links wait list rows and map markers in both directions without mutating attempt data', () => {
    const source = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    assert.match(source, /onSelectWait=\{selectWait\}/);
    assert.match(source, /onWaitMarkerPress/);
    assert.match(source, /waitEventIdNearPoint/);
    assert.match(source, /waitComparisonLocationIdNearPoint/);
    assert.match(source, /selectedWaitId=\{selectedWaitId\}/);
    assert.match(source, /WAITING VS PB/);
    assert.match(source, /WaitingVsPbBlock/);
    assert.match(source, /GhostDeltaChart/);
    assert.match(source, /previewPoint=\{ghostMapPoint\}/);
    assert.match(source, /waitMarkers=\{waitMarkers\}/);
    assert.match(source, /setGhostSelection\(null\)/);
    assert.match(source, /pointAtProgress/);
    assert.doesNotMatch(source, /workspace\.|acknowledgeAttemptResult|saveAttempt/);
    assert.doesNotMatch(source, /elapsedOnIncreasingFlanks|knotsNearProgress/);
  });

  it('renders wait duration labels on distinguishable markers', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    assert.match(map, /wait-point/);
    assert.match(map, /wait-label/);
    assert.match(map, /text-field/);
    assert.match(map, /onWaitMarkerPress/);
    assert.match(map, /tone/);
    assert.match(map, /#f07178/);
    assert.match(map, /#7dcea0/);
    assert.match(fallback, /Waiting stop/);
    assert.match(fallback, /Waited more than PB/);
    assert.match(fallback, /Waited less than PB/);
    assert.match(fallback, /Selected route location/);
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
    assert.match(waitLabel, /'text-font':\s*\[\s*'literal',\s*OPENFREEMAP_LIBERTY_TEXT_FONT\s*\]/);
    assert.doesNotMatch(waitLabel, /'text-font':\s*OPENFREEMAP_LIBERTY_TEXT_FONT\s*,/);
    assert.doesNotMatch(waitLabel, /Open Sans|Arial Unicode/);
  });

  it('leaves Android attempt-detail back navigation on the existing history action', () => {
    const source = readFileSync('src/ui/system-back.ts', 'utf8');
    assert.match(source, /case 'attempt-detail':\s*return 'leaveAttemptDetailToHistory'/);
    assert.doesNotMatch(source, /selectedWaitId/);
  });

  it('paints ghost preview above wait pins as a larger hollow ring', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    const waitPoint = map.indexOf('id="wait-point"');
    const previewPoint = map.indexOf('id="preview-point"');
    const waitSource = map.indexOf('id="wait-events"');
    const previewSource = map.indexOf('id="ghost-preview"');
    assert.ok(waitPoint >= 0, 'RouteMap must render wait-point');
    assert.ok(previewPoint >= 0, 'RouteMap must render preview-point');
    assert.ok(waitSource >= 0, 'RouteMap must keep the wait-events source');
    assert.ok(previewSource >= 0, 'ghost preview must use its own source');
    assert.ok(
      previewPoint > waitPoint,
      'preview-point must paint after wait-point so an on-route wait cannot cover ghost selection',
    );
    assert.ok(
      previewSource > waitSource,
      'ghost-preview source must come after wait-events so MapLibre draws it on top',
    );
    const previewLayer = map.slice(previewPoint, map.indexOf('/>', previewPoint));
    assert.match(previewLayer, /PREVIEW_MARKER_RADIUS/);
    assert.match(previewLayer, /rgba\(0, 0, 0, 0\)/);
    assert.match(previewLayer, /#7ee0ff/);
    const waitRadius = Number(map.match(/const WAIT_MARKER_RADIUS = (\d+);/)?.[1]);
    const waitSelectedRadius = Number(map.match(/const WAIT_MARKER_SELECTED_RADIUS = (\d+);/)?.[1]);
    const previewRadius = Number(map.match(/const PREVIEW_MARKER_RADIUS = (\d+);/)?.[1]);
    assert.equal(waitRadius, 8);
    assert.equal(waitSelectedRadius, 11);
    assert.ok(
      previewRadius > waitSelectedRadius,
      'ghost ring must be larger than a selected wait pin so both remain visible at the same coordinate',
    );

    const waitRender = fallback.indexOf('projected.waitPoints.map');
    const previewRender = fallback.indexOf('projected.preview ?');
    assert.ok(waitRender >= 0);
    assert.ok(previewRender > waitRender, 'fallback preview must paint after wait pins');
    const previewStyleStart = fallback.indexOf('preview: {');
    const previewStyle = fallback.slice(previewStyleStart, fallback.indexOf('},', previewStyleStart));
    assert.match(previewStyle, /width: 26/);
    assert.match(previewStyle, /backgroundColor: 'transparent'/);
    assert.match(previewStyle, /zIndex: 3/);
    const waitStyleStart = fallback.indexOf('wait: {');
    const waitStyle = fallback.slice(waitStyleStart, fallback.indexOf('},', waitStyleStart));
    assert.match(waitStyle, /width: 14/);
    assert.match(waitStyle, /zIndex: 2/);
  });

  it('keeps the ghost chart inside the page ScrollView and scrubs via shared helpers', () => {
    const screen = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    const chart = readFileSync('src/ui/GhostDeltaChart.tsx', 'utf8');
    const chartIndex = screen.indexOf('<GhostDeltaChart');
    const scrollStart = screen.indexOf('<ScrollView');
    const scrollEnd = screen.lastIndexOf('</ScrollView>');
    assert.ok(chartIndex >= 0, 'AttemptResultScreen must render GhostDeltaChart');
    assert.ok(
      chartIndex > scrollStart && chartIndex < scrollEnd,
      'GhostDeltaChart must live in the page ScrollView so results are not trapped in a tiny nested pane',
    );
    assert.match(chart, /prepareGhostChartSeries/);
    assert.match(chart, /selectGhostChartPoint/);
    assert.match(chart, /ghostChartCopy/);
    assert.match(chart, /onScrubChange/);
    assert.match(chart, /onPanResponderRelease/);
    assert.doesNotMatch(chart, /elapsedOnIncreasingFlanks/);
    assert.doesNotMatch(chart, /compareAttemptGhost/);
    assert.doesNotMatch(chart, /uniqueFirst|one-value-per|first knot in/);
    assert.match(screen, /waitMarkers=\{waitMarkers\}/);
    assert.match(screen, /previewPoint=\{ghostMapPoint\}/);
  });
});
