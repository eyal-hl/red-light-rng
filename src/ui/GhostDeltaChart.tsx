import { useMemo, useState } from 'react';
import { PanResponder, Text, View, type GestureResponderEvent } from 'react-native';

import { formatElapsed, formatSignedDelta } from '../domain/duration';
import { formatDistance } from '../domain/geo';
import {
  flattenGhostChartVertices,
  ghostChartCopy,
  ghostChartLayoutForSize,
  ghostChartPlotWidthPx,
  ghostChartYRange,
  prepareGhostChartSeries,
  projectGhostChartPoint,
  selectGhostChartPoint,
  type GhostChartLayout,
  type GhostChartPrepared,
  type GhostChartSelection,
  type GhostChartVertex,
} from '../domain/ghost-chart';
import { type GhostComparison } from '../domain/ghost-comparison';
import { styles } from './styles';

const FASTER_COLOR = '#7dcea0';
const SLOWER_COLOR = '#f07178';
const ZERO_COLOR = '#c5c8ce';
const NEUTRAL_COLOR = '#f5f5f5';

type GhostDeltaChartProps = {
  comparison: GhostComparison;
  isCurrentPb: boolean;
  selection: GhostChartSelection | null;
  onSelect: (selection: GhostChartSelection | null) => void;
};

function formatChartSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds === 0) {
    return '0s';
  }
  return `${seconds > 0 ? '+' : ''}${seconds}s`;
}

function deltaTextStyle(deltaMs: number | null) {
  if (deltaMs == null || deltaMs === 0) {
    return styles.deltaNeutral;
  }
  return deltaMs < 0 ? styles.deltaFaster : styles.deltaSlower;
}

function segmentColor(fromDeltaMs: number, toDeltaMs: number): string {
  if (fromDeltaMs < 0 && toDeltaMs < 0) {
    return FASTER_COLOR;
  }
  if (fromDeltaMs > 0 && toDeltaMs > 0) {
    return SLOWER_COLOR;
  }
  if (fromDeltaMs === 0 && toDeltaMs === 0) {
    return ZERO_COLOR;
  }
  if (fromDeltaMs <= 0 && toDeltaMs <= 0) {
    return FASTER_COLOR;
  }
  if (fromDeltaMs >= 0 && toDeltaMs >= 0) {
    return SLOWER_COLOR;
  }
  return NEUTRAL_COLOR;
}

function ChartHairline({
  x1,
  y1,
  x2,
  y2,
  color,
  thickness = 2,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness?: number;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length < 0.4) {
    return (
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: x1 - thickness / 2,
          top: y1 - thickness / 2,
          width: thickness,
          height: thickness,
          borderRadius: thickness / 2,
          backgroundColor: color,
        }}
      />
    );
  }
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (x1 + x2) / 2 - length / 2,
        top: (y1 + y2) / 2 - thickness / 2,
        width: length,
        height: thickness,
        backgroundColor: color,
        transform: [{ rotate: `${angleDeg}deg` }],
      }}
    />
  );
}

function splitZeroCrossing(
  from: GhostChartVertex,
  to: GhostChartVertex,
): { from: GhostChartVertex; to: GhostChartVertex; color: string }[] {
  if ((from.deltaMs <= 0 && to.deltaMs <= 0) || (from.deltaMs >= 0 && to.deltaMs >= 0)) {
    return [{ from, to, color: segmentColor(from.deltaMs, to.deltaMs) }];
  }
  const span = to.deltaMs - from.deltaMs;
  const t = span === 0 ? 0.5 : Math.min(1, Math.max(0, -from.deltaMs / span));
  const mid: GhostChartVertex = {
    progressMeters: from.progressMeters + t * (to.progressMeters - from.progressMeters),
    deltaMs: 0,
    currentElapsedMs: from.currentElapsedMs + t * (to.currentElapsedMs - from.currentElapsedMs),
    referenceElapsedMs: from.referenceElapsedMs + t * (to.referenceElapsedMs - from.referenceElapsedMs),
    coordinate: from.coordinate,
    knotKind: 'sample',
    source: from.source,
  };
  return [
    { from, to: mid, color: segmentColor(from.deltaMs, 0) },
    { from: mid, to, color: segmentColor(0, to.deltaMs) },
  ];
}

function ChartMarker({
  point,
  color,
  selected = false,
}: {
  point: { x: number; y: number };
  color: string;
  selected?: boolean;
}) {
  const size = selected ? 12 : 8;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: point.x - size / 2,
        top: point.y - size / 2,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderWidth: selected ? 2 : 1,
        borderColor: '#111111',
      }}
    />
  );
}

function ChartPlot({
  comparison,
  selection,
  onSelect,
}: {
  comparison: GhostComparison;
  selection: GhostChartSelection | null;
  onSelect: (selection: GhostChartSelection | null) => void;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const layout = size.width > 0 ? ghostChartLayoutForSize(size.width, size.height) : null;
  const prepared = useMemo(
    () =>
      layout
        ? prepareGhostChartSeries(comparison, { widthPx: ghostChartPlotWidthPx(layout) })
        : null,
    [comparison, layout],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (event: GestureResponderEvent) => {
          if (!prepared || !layout) {
            return;
          }
          onSelect(
            selectGhostChartPoint(
              prepared,
              layout,
              event.nativeEvent.locationX,
              event.nativeEvent.locationY,
            ),
          );
        },
        onPanResponderMove: (event: GestureResponderEvent) => {
          if (!prepared || !layout) {
            return;
          }
          const next = selectGhostChartPoint(
            prepared,
            layout,
            event.nativeEvent.locationX,
            event.nativeEvent.locationY,
          );
          if (next) {
            onSelect(next);
          }
        },
      }),
    [layout, onSelect, prepared],
  );

  const yRange = prepared ? ghostChartYRange(prepared) : { minDeltaMs: -5_000, maxDeltaMs: 5_000 };
  const zeroPoint =
    prepared && layout ? projectGhostChartPoint(prepared, layout, prepared.startProgressMeters, 0) : null;
  const selectedPoint =
    prepared && layout && selection
      ? projectGhostChartPoint(prepared, layout, selection.progressMeters, selection.deltaMs)
      : null;
  const vertices = prepared ? flattenGhostChartVertices(prepared) : [];
  const startVertex = vertices.find((vertex) => vertex.knotKind === 'start') ?? vertices[0];
  const finishVertex =
    [...vertices].reverse().find((vertex) => vertex.knotKind === 'finish-trigger') ??
    vertices[vertices.length - 1];

  return (
    <View
      style={styles.ghostChartPlot}
      onLayout={(event) => {
        const next = event.nativeEvent.layout;
        setSize((current) =>
          current.width === next.width && current.height === next.height
            ? current
            : { width: next.width, height: next.height },
        );
      }}
      {...panResponder.panHandlers}
    >
      {prepared && layout && zeroPoint ? (
        <View pointerEvents="none" style={styles.ghostChartPlotInner}>
          <View
            style={[
              styles.ghostChartZeroLine,
              {
                top: zeroPoint.y,
                left: layout.plotLeftPx,
                width: layout.plotRightPx - layout.plotLeftPx,
              },
            ]}
          />
          <ChartPolylines prepared={prepared} layout={layout} />
          {startVertex ? (
            <ChartMarker
              point={projectGhostChartPoint(prepared, layout, startVertex.progressMeters, startVertex.deltaMs)}
              color={ZERO_COLOR}
            />
          ) : null}
          {finishVertex ? (
            <ChartMarker
              point={projectGhostChartPoint(
                prepared,
                layout,
                finishVertex.progressMeters,
                finishVertex.deltaMs,
              )}
              color={segmentColor(finishVertex.deltaMs, finishVertex.deltaMs)}
            />
          ) : null}
          {selectedPoint ? (
            <View>
              <View
                style={[
                  styles.ghostChartCrosshair,
                  {
                    left: selectedPoint.x,
                    top: layout.plotTopPx,
                    height: layout.plotBottomPx - layout.plotTopPx,
                  },
                ]}
              />
              <ChartMarker point={selectedPoint} color={NEUTRAL_COLOR} selected />
            </View>
          ) : null}
          <View style={[styles.ghostChartYLabel, { top: layout.plotTopPx }]}>
            <Text style={styles.ghostChartAxisText}>{formatChartSeconds(yRange.maxDeltaMs)}</Text>
          </View>
          <View style={[styles.ghostChartYLabel, { top: zeroPoint.y - 8 }]}>
            <Text style={styles.ghostChartAxisText}>0s</Text>
          </View>
          <View style={[styles.ghostChartYLabel, { top: layout.plotBottomPx - 12 }]}>
            <Text style={styles.ghostChartAxisText}>{formatChartSeconds(yRange.minDeltaMs)}</Text>
          </View>
          <View style={[styles.ghostChartXLabel, { left: layout.plotLeftPx, top: layout.plotBottomPx + 4 }]}>
            <Text style={styles.ghostChartAxisText}>Start</Text>
          </View>
          <View
            style={[
              styles.ghostChartXLabelRight,
              { right: layout.widthPx - layout.plotRightPx, top: layout.plotBottomPx + 4 },
            ]}
          >
            <Text style={styles.ghostChartAxisText}>Finish</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ChartPolylines({
  prepared,
  layout,
}: {
  prepared: GhostChartPrepared;
  layout: GhostChartLayout;
}) {
  return (
    <View>
      {prepared.polylines.map((polyline, polylineIndex) =>
        polyline.vertices.slice(1).flatMap((to, segmentIndex) => {
          const from = polyline.vertices[segmentIndex];
          if (!from) {
            return [];
          }
          return splitZeroCrossing(from, to).map((piece, pieceIndex) => {
            const start = projectGhostChartPoint(prepared, layout, piece.from.progressMeters, piece.from.deltaMs);
            const end = projectGhostChartPoint(prepared, layout, piece.to.progressMeters, piece.to.deltaMs);
            return (
              <ChartHairline
                key={`${polylineIndex}-${segmentIndex}-${pieceIndex}`}
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                color={piece.color}
                thickness={2.5}
              />
            );
          });
        }),
      )}
    </View>
  );
}

export function GhostDeltaChart({ comparison, isCurrentPb, selection, onSelect }: GhostDeltaChartProps) {
  const copy = ghostChartCopy({
    available: comparison.available,
    unavailableReason: comparison.unavailableReason,
    isCurrentPb,
  });
  const hasUnavailable = comparison.knots.some((knot) => knot.coverage === 'unavailable');

  if (!comparison.available) {
    return (
      <View
        accessibilityLabel={`${copy.sectionLabel} unavailable`}
        style={styles.ghostChartSection}
      >
        <Text style={styles.sectionLabel}>{copy.sectionLabel}</Text>
        <Text style={styles.mutedText}>{copy.unavailableMessage}</Text>
      </View>
    );
  }

  return (
    <View accessibilityLabel={`${copy.sectionLabel} delta chart`} style={styles.ghostChartSection}>
      <Text style={styles.sectionLabel}>{copy.sectionLabel}</Text>
      <View style={styles.statRow}>
        <Text style={styles.statLabel}>{copy.deltaLabel}</Text>
        <Text style={deltaTextStyle(comparison.finishTriggerDeltaMs)}>
          {comparison.finishTriggerDeltaMs == null ? '—' : formatSignedDelta(comparison.finishTriggerDeltaMs)}
        </Text>
      </View>
      <ChartPlot comparison={comparison} selection={selection} onSelect={onSelect} />
      {!selection ? (
        <Text style={styles.mutedText}>
          {comparison.finishTriggerDeltaMs == null
            ? 'Drag the chart to inspect delta along the route.'
            : `Finish ${formatSignedDelta(comparison.finishTriggerDeltaMs)}. Drag to inspect.`}
        </Text>
      ) : (
        <View>
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>{formatDistance(Math.max(0, selection.progressMeters))}</Text>
            <Text style={deltaTextStyle(selection.deltaMs)}>{formatSignedDelta(selection.deltaMs)}</Text>
          </View>
          <Text style={styles.mutedText}>
            This run {formatElapsed(selection.currentElapsedMs)} · Reference{' '}
            {formatElapsed(selection.referenceElapsedMs)}
          </Text>
        </View>
      )}
      {hasUnavailable ? (
        <Text style={styles.mutedText}>Some spans lack trustworthy telemetry and are shown as gaps.</Text>
      ) : null}
    </View>
  );
}
