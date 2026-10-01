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

function evenlySpacedIndices(count: number, budget: number): number[] {
  if (count <= 0 || budget <= 0) {
    return [];
  }
  if (count <= budget) {
    return Array.from({ length: count }, (_, index) => index);
  }
  if (budget === 1) {
    return [0];
  }
  const lastIndex = count - 1;
  const lastSlot = budget - 1;
  const indices: number[] = [];
  for (let slot = 0; slot < budget; slot += 1) {
    indices.push(Math.floor((slot * lastIndex) / lastSlot));
  }
  return indices;
}

function rejectedMarkerOffsets(count: number, selectedOffset: number | null): number[] {
  const spaced = evenlySpacedIndices(count, REJECTED_DEBUG_MARKER_BUDGET);
  if (
    selectedOffset == null ||
    selectedOffset < 0 ||
    selectedOffset >= count ||
    spaced.includes(selectedOffset)
  ) {
    return spaced;
  }
  if (spaced.length < 3) {
    const withSelected = [...spaced, selectedOffset];
    withSelected.sort((left, right) => left - right);
    return withSelected;
  }
  let replaceAt = 1;
  let bestDistance = Math.abs(spaced[1]! - selectedOffset);
  for (let position = 2; position < spaced.length - 1; position += 1) {
    const distance = Math.abs(spaced[position]! - selectedOffset);
    if (distance < bestDistance) {
      bestDistance = distance;
      replaceAt = position;
    }
  }
  const kept = [...spaced];
  kept[replaceAt] = selectedOffset;
  kept.sort((left, right) => left - right);
  return kept;
}

/**
 * Pure presentation prep for MapLibre debug circles and fallback recorded-trace
 * Views. Omits non-selected accepted samples, thins rejected markers to the
 * centralized budget while always retaining an explicit selection, and thins
 * fallback recorded-trace dots. Raw telemetry arrays are copied, never mutated.
 */
export function prepareMapPresentation(input: PrepareMapPresentationInput): PreparedMapPresentation {
  const selectedSampleId = input.selectedSampleId ?? null;
  const rejectedPositions: number[] = [];
  input.debugSamples.forEach((sample, index) => {
    if (!sample.accepted) {
      rejectedPositions.push(index);
    }
  });
  const selectedRejectedOffset =
    selectedSampleId == null
      ? -1
      : rejectedPositions.findIndex((index) => input.debugSamples[index]?.id === selectedSampleId);
  const keptRejectedPositions = new Set(
    rejectedMarkerOffsets(
      rejectedPositions.length,
      selectedRejectedOffset >= 0 ? selectedRejectedOffset : null,
    ).map((offset) => rejectedPositions[offset]!),
  );

  const debugMarkers: MapPresentationDebugSample[] = [];
  input.debugSamples.forEach((sample, index) => {
    if (sample.accepted) {
      if (selectedSampleId != null && sample.id === selectedSampleId) {
        debugMarkers.push(copySample(sample));
      }
      return;
    }
    if (keptRejectedPositions.has(index)) {
      debugMarkers.push(copySample(sample));
    }
  });

  const traceIndices = evenlySpacedIndices(input.recordedPath.length, FALLBACK_RECORDED_TRACE_POINT_BUDGET);
  return {
    debugMarkers,
    fallbackRecordedTracePoints: traceIndices.map((index) => copyPoint(input.recordedPath[index]!)),
    selectedSampleId,
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
