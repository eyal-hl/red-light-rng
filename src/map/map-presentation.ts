import type { LatLng } from '../domain/geo';

/** Maximum non-selected rejected debug markers after Phase C thinning. */
export const REJECTED_DEBUG_MARKER_BUDGET = 64;

/**
 * Maximum fallback recorded-trace point Views when the fallback still uses
 * per-sample dots instead of a polyline primitive.
 */
export const FALLBACK_RECORDED_TRACE_POINT_BUDGET = 96;

export type MapPresentationDebugSample = {
  id: string;
  point: LatLng;
  accepted: boolean;
};

export type PrepareMapPresentationInput = {
  debugSamples: readonly MapPresentationDebugSample[];
  recordedPath: readonly LatLng[];
  selectedSampleId?: string | null;
};

export type PreparedMapPresentation = {
  debugMarkers: MapPresentationDebugSample[];
  fallbackRecordedTracePoints: LatLng[];
  selectedSampleId: string | null;
};

export type MapPresentationCounts = {
  rawDebugSampleCount: number;
  rawRecordedPathCount: number;
  acceptedDebugMarkerCount: number;
  nonSelectedAcceptedDebugMarkerCount: number;
  rejectedDebugMarkerCount: number;
  selectedDebugMarkerCount: number;
  fallbackRecordedTracePointCount: number;
  rejectedDebugMarkerBudget: number;
  fallbackRecordedTracePointBudget: number;
};

function copyPoint(point: LatLng): LatLng {
  return { latitude: point.latitude, longitude: point.longitude };
}

function copySample(sample: MapPresentationDebugSample): MapPresentationDebugSample {
  return {
    id: sample.id,
    point: copyPoint(sample.point),
    accepted: sample.accepted,
  };
}

/**
 * Pure presentation prep for MapLibre debug circles and fallback recorded-trace
 * Views. Phase A is identity so current dense-overlay behavior stays visible for
 * QA reproduction. Phase C applies the centralized budgets without mutating raw
 * telemetry arrays.
 */
export function prepareMapPresentation(input: PrepareMapPresentationInput): PreparedMapPresentation {
  return {
    debugMarkers: input.debugSamples.map(copySample),
    fallbackRecordedTracePoints: input.recordedPath.map(copyPoint),
    selectedSampleId: input.selectedSampleId ?? null,
  };
}

export function mapPresentationCounts(
  input: PrepareMapPresentationInput,
  presentation: PreparedMapPresentation = prepareMapPresentation(input),
): MapPresentationCounts {
  const selectedSampleId = presentation.selectedSampleId;
  const accepted = presentation.debugMarkers.filter((sample) => sample.accepted);
  return {
    rawDebugSampleCount: input.debugSamples.length,
    rawRecordedPathCount: input.recordedPath.length,
    acceptedDebugMarkerCount: accepted.length,
    nonSelectedAcceptedDebugMarkerCount: accepted.filter((sample) => sample.id !== selectedSampleId).length,
    rejectedDebugMarkerCount: presentation.debugMarkers.filter((sample) => !sample.accepted).length,
    selectedDebugMarkerCount: presentation.debugMarkers.filter((sample) => sample.id === selectedSampleId)
      .length,
    fallbackRecordedTracePointCount: presentation.fallbackRecordedTracePoints.length,
    rejectedDebugMarkerBudget: REJECTED_DEBUG_MARKER_BUDGET,
    fallbackRecordedTracePointBudget: FALLBACK_RECORDED_TRACE_POINT_BUDGET,
  };
}

export function formatMapIntegrityReport(counts: MapPresentationCounts): string {
  return [
    `MAP_INTEGRITY rawDebugSampleCount=${counts.rawDebugSampleCount}`,
    `MAP_INTEGRITY rawRecordedPathCount=${counts.rawRecordedPathCount}`,
    `MAP_INTEGRITY acceptedDebugMarkerCount=${counts.acceptedDebugMarkerCount}`,
    `MAP_INTEGRITY nonSelectedAcceptedDebugMarkerCount=${counts.nonSelectedAcceptedDebugMarkerCount}`,
    `MAP_INTEGRITY rejectedDebugMarkerCount=${counts.rejectedDebugMarkerCount}`,
    `MAP_INTEGRITY selectedDebugMarkerCount=${counts.selectedDebugMarkerCount}`,
    `MAP_INTEGRITY fallbackRecordedTracePointCount=${counts.fallbackRecordedTracePointCount}`,
    `MAP_INTEGRITY rejectedDebugMarkerBudget=${counts.rejectedDebugMarkerBudget}`,
    `MAP_INTEGRITY fallbackRecordedTracePointBudget=${counts.fallbackRecordedTracePointBudget}`,
  ].join('\n');
}
