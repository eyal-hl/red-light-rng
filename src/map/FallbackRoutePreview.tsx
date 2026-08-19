import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { geoZoneExtentPoints, type GeoZone, type LatLng } from '../domain/geo';

type FallbackCheckpoint = {
  id: string;
  name: string;
  point: LatLng;
};

type FallbackWaitMarker = {
  id: string;
  point: LatLng;
  tone?: 'wait' | 'more' | 'less';
};

type FallbackRoutePreviewProps = {
  path: LatLng[];
  startZone?: GeoZone | null;
  finishZone?: GeoZone | null;
  checkpoints?: FallbackCheckpoint[];
  waitMarkers?: FallbackWaitMarker[];
  selectedMarkerId?: string | null;
  previewPoint?: LatLng | null;
};

type Point = { x: number; y: number };

function project(
  path: LatLng[],
  startZone?: GeoZone | null,
  finishZone?: GeoZone | null,
  checkpoints: FallbackCheckpoint[] = [],
  waitMarkers: FallbackWaitMarker[] = [],
  previewPoint?: LatLng | null,
): {
  points: Point[];
  start: Point | null;
  finish: Point | null;
  startDiameterPercent: number;
  finishDiameterPercent: number;
  checkpointPoints: Point[];
  waitPoints: { id: string; point: Point; tone?: 'wait' | 'more' | 'less' }[];
  preview: Point | null;
} {
  const coords = [...path];
  if (startZone) {
    coords.push(startZone.center, ...geoZoneExtentPoints(startZone));
  }
  if (finishZone) {
    coords.push(finishZone.center, ...geoZoneExtentPoints(finishZone));
  }
  for (const checkpoint of checkpoints) {
    coords.push(checkpoint.point);
  }
  for (const wait of waitMarkers) {
    coords.push(wait.point);
  }
  if (previewPoint) {
    coords.push(previewPoint);
  }
  if (coords.length === 0) {
    return {
      points: [],
      start: null,
      finish: null,
      startDiameterPercent: 0,
      finishDiameterPercent: 0,
      checkpointPoints: [],
      waitPoints: [],
      preview: null,
    };
  }

  const lats = coords.map((item) => item.latitude);
  const lngs = coords.map((item) => item.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latSpan = Math.max(maxLat - minLat, 0.0001);
  const lngSpan = Math.max(maxLng - minLng, 0.0001);

  const toPoint = (coord: LatLng): Point => ({
    x: ((coord.longitude - minLng) / lngSpan) * 100,
    y: (1 - (coord.latitude - minLat) / latSpan) * 100,
  });

  const diameterPercent = (zone: GeoZone | null | undefined): number => {
    if (!zone || !Number.isFinite(zone.radiusMeters) || zone.radiusMeters <= 0) {
      return 0;
    }
    const dLat = zone.radiusMeters / 111_320;
    return Math.max(4, Math.min(80, ((dLat * 2) / latSpan) * 100));
  };

  return {
    points: path.map(toPoint),
    start: startZone ? toPoint(startZone.center) : null,
    finish: finishZone ? toPoint(finishZone.center) : null,
    startDiameterPercent: diameterPercent(startZone),
    finishDiameterPercent: diameterPercent(finishZone),
    checkpointPoints: checkpoints.map((checkpoint) => toPoint(checkpoint.point)),
    waitPoints: waitMarkers.map((wait) => ({ id: wait.id, point: toPoint(wait.point), tone: wait.tone })),
    preview: previewPoint ? toPoint(previewPoint) : null,
  };
}

export function FallbackRoutePreview({
  path,
  startZone,
  finishZone,
  checkpoints = [],
  waitMarkers = [],
  selectedMarkerId = null,
  previewPoint = null,
}: FallbackRoutePreviewProps) {
  const projected = useMemo(
    () => project(path, startZone, finishZone, checkpoints, waitMarkers, previewPoint),
    [checkpoints, finishZone, path, previewPoint, startZone, waitMarkers],
  );

  return (
    <View style={styles.frame} accessibilityLabel="Local route preview without map tiles">
      {projected.points.map((point, index) => (
        <View
          key={`${point.x}-${point.y}-${index}`}
          style={[styles.dot, { left: `${point.x}%`, top: `${point.y}%` }]}
        />
      ))}
      {projected.start ? (
        <>
          {projected.startDiameterPercent > 0 ? (
            <View
              accessibilityLabel="Auto-start detection zone"
              style={[
                styles.zone,
                styles.startZone,
                {
                  left: `${projected.start.x}%`,
                  top: `${projected.start.y}%`,
                  width: `${projected.startDiameterPercent}%`,
                  height: `${projected.startDiameterPercent}%`,
                  marginLeft: `${-projected.startDiameterPercent / 2}%`,
                  marginTop: `${-projected.startDiameterPercent / 2}%`,
                },
              ]}
            />
          ) : null}
          <View style={[styles.start, { left: `${projected.start.x}%`, top: `${projected.start.y}%` }]} />
        </>
      ) : null}
      {projected.checkpointPoints.map((point, index) => (
        <View
          key={`checkpoint-${point.x}-${point.y}-${index}`}
          style={[styles.checkpoint, { left: `${point.x}%`, top: `${point.y}%` }]}
        />
      ))}
      {projected.waitPoints.map((wait) => (
        <View
          key={`wait-${wait.id}`}
          accessibilityLabel={
            wait.tone === 'more'
              ? 'Waited more than PB'
              : wait.tone === 'less'
                ? 'Waited less than PB'
                : 'Waiting stop'
          }
          style={[
            styles.wait,
            wait.tone === 'more' ? styles.waitMore : null,
            wait.tone === 'less' ? styles.waitLess : null,
            selectedMarkerId === wait.id ? styles.waitSelected : null,
            { left: `${wait.point.x}%`, top: `${wait.point.y}%` },
          ]}
        />
      ))}
      {projected.preview ? (
        <View style={[styles.preview, { left: `${projected.preview.x}%`, top: `${projected.preview.y}%` }]} />
      ) : null}
      {projected.finish ? (
        <>
          {projected.finishDiameterPercent > 0 ? (
            <View
              accessibilityLabel="Auto-finish detection zone"
              style={[
                styles.zone,
                styles.finishZone,
                {
                  left: `${projected.finish.x}%`,
                  top: `${projected.finish.y}%`,
                  width: `${projected.finishDiameterPercent}%`,
                  height: `${projected.finishDiameterPercent}%`,
                  marginLeft: `${-projected.finishDiameterPercent / 2}%`,
                  marginTop: `${-projected.finishDiameterPercent / 2}%`,
                },
              ]}
            />
          ) : null}
          <View
            style={[styles.finish, { left: `${projected.finish.x}%`, top: `${projected.finish.y}%` }]}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    flex: 1,
    backgroundColor: '#1c2430',
    borderRadius: 12,
    overflow: 'hidden',
    minHeight: 220,
  },
  dot: {
    position: 'absolute',
    width: 6,
    height: 6,
    marginLeft: -3,
    marginTop: -3,
    borderRadius: 3,
    backgroundColor: '#4fc3f7',
  },
  start: {
    position: 'absolute',
    width: 14,
    height: 14,
    marginLeft: -7,
    marginTop: -7,
    borderRadius: 7,
    backgroundColor: '#2e7d4f',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  checkpoint: {
    position: 'absolute',
    width: 12,
    height: 12,
    marginLeft: -6,
    marginTop: -6,
    borderRadius: 6,
    backgroundColor: '#f0c040',
    borderWidth: 2,
    borderColor: '#111111',
  },
  wait: {
    position: 'absolute',
    width: 14,
    height: 14,
    marginLeft: -7,
    marginTop: -7,
    borderRadius: 7,
    backgroundColor: '#ff7043',
    borderWidth: 2,
    borderColor: '#111111',
  },
  waitMore: {
    backgroundColor: '#f07178',
  },
  waitLess: {
    backgroundColor: '#7dcea0',
  },
  waitSelected: {
    width: 18,
    height: 18,
    marginLeft: -9,
    marginTop: -9,
    borderRadius: 9,
  },
  zone: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 2,
  },
  startZone: {
    backgroundColor: 'rgba(46, 125, 79, 0.18)',
    borderColor: '#2e7d4f',
  },
  finishZone: {
    backgroundColor: 'rgba(138, 47, 47, 0.18)',
    borderColor: '#8a2f2f',
  },
  preview: {
    position: 'absolute',
    width: 14,
    height: 14,
    marginLeft: -7,
    marginTop: -7,
    borderRadius: 7,
    backgroundColor: '#7ee0ff',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  finish: {
    position: 'absolute',
    width: 16,
    height: 16,
    marginLeft: -8,
    marginTop: -8,
    borderRadius: 4,
    backgroundColor: '#f5f5f5',
    borderWidth: 3,
    borderColor: '#8a2f2f',
  },
});
