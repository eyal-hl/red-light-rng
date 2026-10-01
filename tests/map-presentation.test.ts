import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  FALLBACK_RECORDED_TRACE_POINT_BUDGET,
  REJECTED_DEBUG_MARKER_BUDGET,
  formatMapIntegrityReport,
  mapPresentationCounts,
  prepareMapPresentation,
  type MapPresentationDebugSample,
} from '../src/map/map-presentation';
import { northPath } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';

const DENSE_ACCEPTED_COUNT = 402;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function denseAcceptedFixture(count = DENSE_ACCEPTED_COUNT): {
  recordedPath: ReturnType<typeof northPath>;
  debugSamples: MapPresentationDebugSample[];
} {
  const recordedPath = northPath({ points: count, stepMeters: 8 });
  return {
    recordedPath,
    debugSamples: recordedPath.map((point, index) => ({
      id: `accepted-${index}`,
      point,
      accepted: true,
    })),
  };
}

describe('map presentation integrity', () => {
  it('does not import MapLibre and exposes centralized presentation budgets', () => {
    const source = readFileSync('src/map/map-presentation.ts', 'utf8');
    assert.doesNotMatch(source, /@maplibre\/maplibre-react-native|maplibre|react-native/);
    assert.equal(REJECTED_DEBUG_MARKER_BUDGET, 64);
    assert.equal(FALLBACK_RECORDED_TRACE_POINT_BUDGET, 96);
  });

  it('RouteMap and FallbackRoutePreview share prepareMapPresentation', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    const screen = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    assert.match(map, /prepareMapPresentation/);
    assert.match(map, /presentation\.debugMarkers/);
    assert.match(map, /toRecordedPathGeoJson\(recordedPath\)/);
    assert.match(fallback, /prepareMapPresentation/);
    assert.match(fallback, /presentation\.fallbackRecordedTracePoints/);
    assert.match(fallback, /presentation\.debugMarkers/);
    assert.match(screen, /debugSamples=\{debugSamples\}/);
    assert.match(screen, /recordedPath=\{debug\?\.place\.recordedPath/);
    assert.match(screen, /debug\?\.place\.samples\[0\]/);
    const routeMapStart = screen.indexOf('<RouteMap');
    const routeMap = screen.slice(routeMapStart, screen.indexOf('/>', routeMapStart));
    assert.match(routeMap, /selectedSampleId=\{selectedSampleId\}/);
    assert.doesNotMatch(routeMap, /samples\[0\]/);
    assert.match(map, /toDebugSampleGeoJson\(presentation\.debugMarkers/);
    assert.match(map, /toRecordedPathGeoJson\(recordedPath\)/);
  });

  it('omits accepted debug circles until one sample is explicitly selected', () => {
    const fixture = denseAcceptedFixture();
    const unselected = {
      debugSamples: fixture.debugSamples,
      recordedPath: fixture.recordedPath,
      selectedSampleId: null,
    };
    const unselectedSnapshot = cloneJson(unselected);
    const hidden = prepareMapPresentation(unselected);
    const hiddenCounts = mapPresentationCounts(unselected, hidden);
    const hiddenReport = formatMapIntegrityReport(hiddenCounts);
    console.log(hiddenReport);
    assert.equal(hiddenCounts.rawDebugSampleCount, DENSE_ACCEPTED_COUNT);
    assert.equal(hiddenCounts.rawRecordedPathCount, DENSE_ACCEPTED_COUNT);
    assert.equal(hiddenCounts.acceptedDebugMarkerCount, 0, hiddenReport);
    assert.equal(hiddenCounts.nonSelectedAcceptedDebugMarkerCount, 0, hiddenReport);
    assert.equal(hiddenCounts.selectedDebugMarkerCount, 0);
    assert.equal(hidden.debugMarkers.length, 0);
    assert.equal(hiddenCounts.fallbackRecordedTracePointCount, FALLBACK_RECORDED_TRACE_POINT_BUDGET);
    assert.deepEqual(hidden.fallbackRecordedTracePoints[0], fixture.recordedPath[0]);
    assert.deepEqual(
      hidden.fallbackRecordedTracePoints[hidden.fallbackRecordedTracePoints.length - 1],
      fixture.recordedPath[fixture.recordedPath.length - 1],
    );
    assert.deepEqual(unselected, unselectedSnapshot, 'presentation thinning must not mutate raw telemetry arrays');

    const selected = fixture.debugSamples[200]!;
    const explicit = {
      debugSamples: fixture.debugSamples,
      recordedPath: fixture.recordedPath,
      selectedSampleId: selected.id,
    };
    const explicitSnapshot = cloneJson(explicit);
    const shown = prepareMapPresentation(explicit);
    const shownAgain = prepareMapPresentation(explicit);
    const shownCounts = mapPresentationCounts(explicit, shown);
    console.log(formatMapIntegrityReport(shownCounts));
    assert.equal(shownCounts.acceptedDebugMarkerCount, 1);
    assert.equal(shownCounts.nonSelectedAcceptedDebugMarkerCount, 0);
    assert.equal(shownCounts.selectedDebugMarkerCount, 1);
    assert.equal(shown.debugMarkers.length, 1);
    assert.equal(shown.debugMarkers[0]?.id, selected.id);
    assert.deepEqual(shown.debugMarkers[0]?.point, selected.point);
    assert.notEqual(shown.debugMarkers[0]?.point, selected.point);
    assert.deepEqual(
      shown.debugMarkers.map((sample) => sample.id),
      shownAgain.debugMarkers.map((sample) => sample.id),
    );
    assert.deepEqual(explicit, explicitSnapshot);
    shown.debugMarkers[0]!.point.latitude += 1;
    assert.deepEqual(explicit, explicitSnapshot);
  });

  it('keeps every rejected sample visible when the set is within budget', () => {
    const recordedPath = northPath({ points: 40, stepMeters: 10 });
    const rejected = Array.from({ length: 20 }, (_, index) => {
      const point = offsetLatLng(recordedPath[0]!.latitude, recordedPath[0]!.longitude, 0, 30 + index * 4);
      return { id: `rejected-${index}`, point, accepted: false };
    });
    const debugSamples = [
      ...recordedPath.map((point, index) => ({ id: `accepted-${index}`, point, accepted: true })),
      ...rejected,
    ];
    const input = { debugSamples, recordedPath, selectedSampleId: null };
    const snapshot = cloneJson(input);
    const presentation = prepareMapPresentation(input);
    const counts = mapPresentationCounts(input, presentation);
    assert.equal(counts.acceptedDebugMarkerCount, 0);
    assert.equal(counts.rejectedDebugMarkerCount, rejected.length);
    assert.deepEqual(
      presentation.debugMarkers.filter((sample) => !sample.accepted).map((sample) => sample.id),
      rejected.map((sample) => sample.id),
    );
    assert.deepEqual(input, snapshot);
  });

  it('bounds a large rejected set and still keeps an explicit selection plus first and last', () => {
    const recordedPath = northPath({ points: 8, stepMeters: 15 });
    const rejected = Array.from({ length: 200 }, (_, index) => {
      const point = offsetLatLng(recordedPath[0]!.latitude, recordedPath[0]!.longitude, index, 40);
      return { id: `rejected-${index}`, point, accepted: false };
    });
    const unselected = prepareMapPresentation({
      debugSamples: rejected,
      recordedPath,
      selectedSampleId: null,
    });
    const unselectedCounts = mapPresentationCounts(
      { debugSamples: rejected, recordedPath, selectedSampleId: null },
      unselected,
    );
    console.log(formatMapIntegrityReport(unselectedCounts));
    assert.equal(unselectedCounts.rejectedDebugMarkerCount, REJECTED_DEBUG_MARKER_BUDGET);
    assert.equal(unselected.debugMarkers[0]?.id, rejected[0]?.id);
    assert.equal(unselected.debugMarkers[unselected.debugMarkers.length - 1]?.id, rejected[rejected.length - 1]?.id);
    const omitted = rejected.find((sample) => !unselected.debugMarkers.some((marker) => marker.id === sample.id));
    assert.ok(omitted, 'thinning must omit at least one rejected sample above the budget');

    const snapshot = cloneJson(rejected);
    const pathSnapshot = cloneJson(recordedPath);
    const presentation = prepareMapPresentation({
      debugSamples: rejected,
      recordedPath,
      selectedSampleId: omitted.id,
    });
    const repeated = prepareMapPresentation({
      debugSamples: rejected,
      recordedPath,
      selectedSampleId: omitted.id,
    });
    const counts = mapPresentationCounts(
      { debugSamples: rejected, recordedPath, selectedSampleId: omitted.id },
      presentation,
    );
    const nonSelectedRejected = presentation.debugMarkers.filter(
      (sample) => !sample.accepted && sample.id !== omitted.id,
    );
    assert.equal(counts.rejectedDebugMarkerCount, REJECTED_DEBUG_MARKER_BUDGET);
    assert.ok(nonSelectedRejected.length <= REJECTED_DEBUG_MARKER_BUDGET);
    assert.equal(counts.selectedDebugMarkerCount, 1);
    assert.equal(presentation.debugMarkers.find((sample) => sample.id === omitted.id)?.id, omitted.id);
    assert.equal(presentation.debugMarkers[0]?.id, rejected[0]?.id);
    assert.equal(presentation.debugMarkers[presentation.debugMarkers.length - 1]?.id, rejected[rejected.length - 1]?.id);
    assert.deepEqual(
      presentation.debugMarkers.map((sample) => sample.id),
      repeated.debugMarkers.map((sample) => sample.id),
    );
    assert.deepEqual(rejected, snapshot);
    assert.deepEqual(recordedPath, pathSnapshot);
    assert.equal(recordedPath.length, 8);
    assert.ok(presentation.fallbackRecordedTracePoints.length <= FALLBACK_RECORDED_TRACE_POINT_BUDGET);
  });

  it('uses a dark rejected stroke so adjacent debug markers do not form a white ribbon', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    const debugLayerStart = map.indexOf('id="debug-sample-point"');
    assert.ok(debugLayerStart >= 0, 'RouteMap must render debug-sample-point');
    const debugLayer = map.slice(debugLayerStart, map.indexOf('/>', debugLayerStart));
    assert.match(debugLayer, /'circle-radius': \['case', \['==', \['get', 'selected'\], 'yes'\], 10, 4\]/);
    assert.match(debugLayer, /'circle-stroke-width': \['case', \['==', \['get', 'selected'\], 'yes'\], 3, 1\]/);
    assert.match(debugLayer, /'#111111', '#5c2a2e'/);
    assert.doesNotMatch(debugLayer, /#ffffff/);
    assert.match(debugLayer, /#7dcea0/);
    const officialStart = map.slice(map.indexOf('id="official-start-point"'), map.indexOf('id="official-finish-point"'));
    assert.match(officialStart, /'circle-radius': 8/);
    assert.match(officialStart, /#66bb6a/);
    assert.match(officialStart, /#ffffff/);
    const styles = fallback.slice(fallback.indexOf('StyleSheet.create'));
    const debugSampleStyle = styles.slice(styles.indexOf('debugSample:'), styles.indexOf('debugAccepted:'));
    assert.match(debugSampleStyle, /borderColor: '#5c2a2e'/);
    assert.doesNotMatch(debugSampleStyle, /#ffffff/);
    const selectedStyle = styles.slice(styles.indexOf('debugSelected:'), styles.indexOf('officialStart:'));
    assert.match(selectedStyle, /borderColor: '#111111'/);
    assert.match(selectedStyle, /borderWidth: 3/);
    assert.match(fallback, /recordedDot:/);
  });

  it('preserves recorded-path line, wait pin, and ghost preview layer order', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    const recordedLine = map.indexOf('id="recorded-path-line"');
    const debugPoint = map.indexOf('id="debug-sample-point"');
    const waitPoint = map.indexOf('id="wait-point"');
    const previewPoint = map.indexOf('id="preview-point"');
    const waitSource = map.indexOf('id="wait-events"');
    const previewSource = map.indexOf('id="ghost-preview"');
    assert.ok(recordedLine >= 0);
    assert.ok(debugPoint > recordedLine);
    assert.ok(waitPoint >= 0 && previewPoint > waitPoint);
    assert.ok(previewSource > waitSource);
    const waitRender = fallback.indexOf('projected.waitPoints.map');
    const previewRender = fallback.indexOf('projected.preview ?');
    assert.ok(previewRender > waitRender);
  });
});
