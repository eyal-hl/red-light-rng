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
    assert.match(
      screen,
      /debug\?\.place\.samples\.find\(\(entry\) => entry\.sample\.id === selectedSampleId\) \?\? debug\?\.place\.samples\[0\] \?\? null/,
    );
  });

  it('reports dense accepted-sample overlay counts for a ~400 sample fixture', () => {
    const fixture = denseAcceptedFixture();
    const input = {
      debugSamples: fixture.debugSamples,
      recordedPath: fixture.recordedPath,
      selectedSampleId: fixture.debugSamples[0]?.id ?? null,
    };
    const snapshot = cloneJson(input);
    const presentation = prepareMapPresentation(input);
    const counts = mapPresentationCounts(input, presentation);
    const report = formatMapIntegrityReport(counts);
    console.log(report);

    assert.equal(counts.rawDebugSampleCount, DENSE_ACCEPTED_COUNT);
    assert.equal(counts.rawRecordedPathCount, DENSE_ACCEPTED_COUNT);
    assert.equal(
      counts.acceptedDebugMarkerCount,
      DENSE_ACCEPTED_COUNT,
      `${report}\ncurrent MapLibre debug circles are 1:1 with accepted samples`,
    );
    assert.equal(counts.nonSelectedAcceptedDebugMarkerCount, DENSE_ACCEPTED_COUNT - 1);
    assert.equal(counts.rejectedDebugMarkerCount, 0);
    assert.equal(counts.selectedDebugMarkerCount, 1);
    assert.equal(
      counts.fallbackRecordedTracePointCount,
      DENSE_ACCEPTED_COUNT,
      `${report}\ncurrent fallback recorded-trace Views are 1:1 with raw samples`,
    );
    assert.equal(presentation.debugMarkers.length, DENSE_ACCEPTED_COUNT);
    assert.deepEqual(
      presentation.debugMarkers.map((sample) => sample.id),
      fixture.debugSamples.map((sample) => sample.id),
    );
    assert.deepEqual(input, snapshot, 'presentation thinning must not mutate raw telemetry arrays');
  });

  it('keeps every rejected sample visible when current identity presentation is used', () => {
    const recordedPath = northPath({ points: 40, stepMeters: 10 });
    const rejected = Array.from({ length: 20 }, (_, index) => {
      const point = offsetLatLng(recordedPath[0]!.latitude, recordedPath[0]!.longitude, 0, 30 + index * 4);
      return { id: `rejected-${index}`, point, accepted: false };
    });
    const debugSamples = [
      ...recordedPath.map((point, index) => ({ id: `accepted-${index}`, point, accepted: true })),
      ...rejected,
    ];
    const presentation = prepareMapPresentation({ debugSamples, recordedPath, selectedSampleId: null });
    const counts = mapPresentationCounts({ debugSamples, recordedPath, selectedSampleId: null }, presentation);
    assert.equal(counts.acceptedDebugMarkerCount, recordedPath.length);
    assert.equal(counts.rejectedDebugMarkerCount, rejected.length);
    assert.equal(presentation.debugMarkers[0]?.id, debugSamples[0]?.id);
    assert.equal(presentation.debugMarkers[presentation.debugMarkers.length - 1]?.id, rejected[rejected.length - 1]?.id);
    assert.deepEqual(
      presentation.debugMarkers.filter((sample) => !sample.accepted).map((sample) => sample.id),
      rejected.map((sample) => sample.id),
    );
  });

  it('currently prepares a large rejected set without applying the centralized budget', () => {
    const recordedPath = northPath({ points: 8, stepMeters: 15 });
    const rejected = Array.from({ length: 200 }, (_, index) => {
      const point = offsetLatLng(recordedPath[0]!.latitude, recordedPath[0]!.longitude, index, 40);
      return { id: `rejected-${index}`, point, accepted: false };
    });
    const selectedId = rejected[17]?.id ?? null;
    const presentation = prepareMapPresentation({
      debugSamples: rejected,
      recordedPath,
      selectedSampleId: selectedId,
    });
    const counts = mapPresentationCounts(
      { debugSamples: rejected, recordedPath, selectedSampleId: selectedId },
      presentation,
    );
    console.log(formatMapIntegrityReport(counts));
    assert.ok(counts.rejectedDebugMarkerCount > REJECTED_DEBUG_MARKER_BUDGET);
    assert.equal(counts.rejectedDebugMarkerCount, 200);
    assert.equal(counts.selectedDebugMarkerCount, 1);
    assert.equal(presentation.debugMarkers.find((sample) => sample.id === selectedId)?.id, selectedId);
    assert.equal(presentation.debugMarkers[0]?.id, rejected[0]?.id);
    assert.equal(presentation.debugMarkers[presentation.debugMarkers.length - 1]?.id, rejected[rejected.length - 1]?.id);
  });

  it('keeps debug-sample white stroke styling that produces the overlapping ribbon', () => {
    const map = readFileSync('src/map/RouteMap.tsx', 'utf8');
    const fallback = readFileSync('src/map/FallbackRoutePreview.tsx', 'utf8');
    const debugLayerStart = map.indexOf('id="debug-sample-point"');
    assert.ok(debugLayerStart >= 0, 'RouteMap must render debug-sample-point');
    const debugLayer = map.slice(debugLayerStart, map.indexOf('/>', debugLayerStart));
    assert.match(debugLayer, /'circle-radius': \['case', \['==', \['get', 'selected'\], 'yes'\], 7, 4\]/);
    assert.match(debugLayer, /'circle-stroke-width': \['case', \['==', \['get', 'selected'\], 'yes'\], 3, 1\]/);
    assert.match(debugLayer, /'circle-stroke-color': '#ffffff'/);
    assert.match(debugLayer, /#7dcea0/);
    assert.match(fallback, /recordedDot:/);
    assert.match(fallback, /debugSample:/);
    assert.match(fallback, /borderColor: '#ffffff'/);
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
