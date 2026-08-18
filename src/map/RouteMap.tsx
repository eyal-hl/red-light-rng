import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { Component, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { GeoZone, LatLng } from '../domain/geo';
import { COURSE_CAMERA_PADDING, courseCameraBounds } from './course-camera-bounds';
import { FallbackRoutePreview } from './FallbackRoutePreview';
import { OPENFREEMAP_LIBERTY_STYLE_URL, OPENFREEMAP_LIBERTY_TEXT_FONT } from './openfreemap-style';

export type RouteMapCheckpoint = {
  id: string;
  name: string;
  point: LatLng;
};

export type RouteMapWaitMarker = {
  id: string;
  point: LatLng;
  label: string;
};

export type RouteMapProps = {
  path: LatLng[];
  startZone?: GeoZone | null;
  finishZone?: GeoZone | null;
  checkpoints?: RouteMapCheckpoint[];
  waitMarkers?: RouteMapWaitMarker[];
  previewPoint?: LatLng | null;
  selectedMarkerId?: string | null;
  onMapPress?: (point: LatLng) => void;
  onWaitMarkerPress?: (waitId: string) => void;
  style?: StyleProp<ViewStyle>;
};

type FeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { kind: string; selected: string; waitId: string; label: string };
    geometry:
      | { type: 'LineString'; coordinates: number[][] }
      | { type: 'Polygon'; coordinates: number[][][] }
      | { type: 'Point'; coordinates: number[] };
  }[];
};

function circlePolygon(center: LatLng, radiusMeters: number, steps = 32): number[][] {
  const latMeters = 111_320;
  const lngMeters = 111_320 * Math.cos((center.latitude * Math.PI) / 180);
  const coordinates: number[][] = [];
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    coordinates.push([
      center.longitude + (radiusMeters * Math.cos(angle)) / lngMeters,
      center.latitude + (radiusMeters * Math.sin(angle)) / latMeters,
    ]);
  }
  return coordinates;
}

function emptyProperties(kind: string, selected = false): FeatureCollection['features'][number]['properties'] {
  return { kind, selected: selected ? 'yes' : 'no', waitId: '', label: '' };
}

function toGeoJson(
  path: LatLng[],
  startZone?: GeoZone | null,
  finishZone?: GeoZone | null,
  checkpoints: RouteMapCheckpoint[] = [],
  previewPoint?: LatLng | null,
  selectedMarkerId?: string | null,
): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  if (path.length >= 2) {
    features.push({
      type: 'Feature',
      properties: emptyProperties('path'),
      geometry: {
        type: 'LineString',
        coordinates: path.map((point) => [point.longitude, point.latitude]),
      },
    });
  }
  if (startZone) {
    features.push({
      type: 'Feature',
      properties: emptyProperties('start-zone'),
      geometry: { type: 'Polygon', coordinates: [circlePolygon(startZone.center, startZone.radiusMeters)] },
    });
    features.push({
      type: 'Feature',
      properties: emptyProperties('start', selectedMarkerId === 'start'),
      geometry: { type: 'Point', coordinates: [startZone.center.longitude, startZone.center.latitude] },
    });
  }
  if (finishZone) {
    features.push({
      type: 'Feature',
      properties: emptyProperties('finish-zone'),
      geometry: { type: 'Polygon', coordinates: [circlePolygon(finishZone.center, finishZone.radiusMeters)] },
    });
    features.push({
      type: 'Feature',
      properties: emptyProperties('finish', selectedMarkerId === 'finish'),
      geometry: { type: 'Point', coordinates: [finishZone.center.longitude, finishZone.center.latitude] },
    });
  }
  for (const checkpoint of checkpoints) {
    features.push({
      type: 'Feature',
      properties: emptyProperties('checkpoint', selectedMarkerId === checkpoint.id),
      geometry: { type: 'Point', coordinates: [checkpoint.point.longitude, checkpoint.point.latitude] },
    });
  }
  if (previewPoint) {
    features.push({
      type: 'Feature',
      properties: emptyProperties('preview'),
      geometry: { type: 'Point', coordinates: [previewPoint.longitude, previewPoint.latitude] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function toWaitGeoJson(
  waitMarkers: RouteMapWaitMarker[],
  selectedMarkerId?: string | null,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: waitMarkers.map((marker) => ({
      type: 'Feature' as const,
      properties: {
        kind: 'wait',
        selected: selectedMarkerId === marker.id ? 'yes' : 'no',
        waitId: marker.id,
        label: marker.label,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [marker.point.longitude, marker.point.latitude],
      },
    })),
  };
}

class MapErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.setState({ failed: true });
  }

  render() {
    if (this.state.failed) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function MapLibreRouteMap({
  path,
  startZone,
  finishZone,
  checkpoints = [],
  waitMarkers = [],
  previewPoint,
  selectedMarkerId,
  onMapPress,
  onWaitMarkerPress,
  onBasemapFailed,
}: RouteMapProps & { onBasemapFailed: () => void }) {
  const data = useMemo(
    () => toGeoJson(path, startZone, finishZone, checkpoints, previewPoint, selectedMarkerId),
    [checkpoints, finishZone, path, previewPoint, selectedMarkerId, startZone],
  );
  const waitData = useMemo(
    () => toWaitGeoJson(waitMarkers, selectedMarkerId),
    [selectedMarkerId, waitMarkers],
  );
  const cameraPoints = useMemo(
    () => [...checkpoints, ...waitMarkers.map((marker) => ({ point: marker.point }))],
    [checkpoints, waitMarkers],
  );
  const initialBounds = useMemo(
    () => courseCameraBounds(path, startZone, finishZone, cameraPoints),
    [cameraPoints, finishZone, path, startZone],
  );

  const selectWaitFromFeatures = (
    features: { properties?: { waitId?: unknown } | null }[] | undefined,
  ) => {
    if (!onWaitMarkerPress || !features) {
      return false;
    }
    for (const feature of features) {
      const waitId = feature.properties?.waitId;
      if (typeof waitId === 'string' && waitId.length > 0) {
        onWaitMarkerPress(waitId);
        return true;
      }
    }
    return false;
  };

  return (
    <Map
      mapStyle={OPENFREEMAP_LIBERTY_STYLE_URL}
      style={StyleSheet.absoluteFill}
      attribution
      logo
      dragPan
      touchZoom
      onDidFailLoadingMap={onBasemapFailed}
      onPress={(event) => {
        const nativeEvent = event.nativeEvent as {
          lngLat?: unknown;
          features?: { properties?: { waitId?: unknown } | null }[];
        };
        if (selectWaitFromFeatures(nativeEvent.features)) {
          return;
        }
        if (!onMapPress) {
          return;
        }
        const lngLat = nativeEvent.lngLat;
        if (!Array.isArray(lngLat) || lngLat.length < 2) {
          return;
        }
        const longitude = lngLat[0];
        const latitude = lngLat[1];
        if (typeof longitude !== 'number' || typeof latitude !== 'number') {
          return;
        }
        onMapPress({ latitude, longitude });
      }}
    >
      <Camera
        initialViewState={{
          bounds: initialBounds,
          padding: COURSE_CAMERA_PADDING,
        }}
      />
      <GeoJSONSource id="route-geometry" data={data}>
        <Layer
          id="start-zone-fill"
          type="fill"
          filter={['==', ['get', 'kind'], 'start-zone']}
          paint={{ 'fill-color': '#2e7d4f', 'fill-opacity': 0.22 }}
        />
        <Layer
          id="finish-zone-fill"
          type="fill"
          filter={['==', ['get', 'kind'], 'finish-zone']}
          paint={{ 'fill-color': '#8a2f2f', 'fill-opacity': 0.22 }}
        />
        <Layer
          id="route-line"
          type="line"
          filter={['==', ['get', 'kind'], 'path']}
          paint={{ 'line-color': '#4fc3f7', 'line-width': 4, 'line-opacity': 0.95 }}
        />
        <Layer
          id="start-point"
          type="circle"
          filter={['==', ['get', 'kind'], 'start']}
          paint={{
            'circle-radius': ['case', ['==', ['get', 'selected'], 'yes'], 9, 7],
            'circle-color': '#2e7d4f',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          }}
        />
        <Layer
          id="finish-point"
          type="circle"
          filter={['==', ['get', 'kind'], 'finish']}
          paint={{
            'circle-radius': ['case', ['==', ['get', 'selected'], 'yes'], 9, 7],
            'circle-color': '#f5f5f5',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#8a2f2f',
          }}
        />
        <Layer
          id="checkpoint-point"
          type="circle"
          filter={['==', ['get', 'kind'], 'checkpoint']}
          paint={{
            'circle-radius': ['case', ['==', ['get', 'selected'], 'yes'], 8, 6],
            'circle-color': '#f0c040',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#111111',
          }}
        />
        <Layer
          id="preview-point"
          type="circle"
          filter={['==', ['get', 'kind'], 'preview']}
          paint={{
            'circle-radius': 8,
            'circle-color': '#7ee0ff',
            'circle-stroke-width': 3,
            'circle-stroke-color': '#ffffff',
          }}
        />
      </GeoJSONSource>
      {waitMarkers.length > 0 ? (
        <GeoJSONSource
          id="wait-events"
          data={waitData}
          onPress={(event) => {
            selectWaitFromFeatures(event.nativeEvent.features);
          }}
        >
          <Layer
            id="wait-point"
            type="circle"
            filter={['==', ['get', 'kind'], 'wait']}
            paint={{
              'circle-radius': ['case', ['==', ['get', 'selected'], 'yes'], 11, 8],
              'circle-color': ['case', ['==', ['get', 'selected'], 'yes'], '#ffb74d', '#ff7043'],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#111111',
            }}
          />
          <Layer
            id="wait-label"
            type="symbol"
            filter={['==', ['get', 'kind'], 'wait']}
            layout={{
              'text-field': ['get', 'label'],
              'text-font': OPENFREEMAP_LIBERTY_TEXT_FONT,
              'text-size': 12,
              'text-offset': [0, 1.15],
              'text-anchor': 'top',
              'text-allow-overlap': true,
            }}
            paint={{
              'text-color': '#fff3e0',
              'text-halo-color': '#111111',
              'text-halo-width': 1.2,
            }}
          />
        </GeoJSONSource>
      ) : null}
    </Map>
  );
}

export function RouteMap({
  path,
  startZone,
  finishZone,
  checkpoints = [],
  waitMarkers = [],
  previewPoint = null,
  selectedMarkerId = null,
  onMapPress,
  onWaitMarkerPress,
  style,
}: RouteMapProps) {
  const [useFallback, setUseFallback] = useState(false);
  const fallback = (
    <View style={styles.fallbackWrap}>
      <FallbackRoutePreview
        path={path}
        startZone={startZone}
        finishZone={finishZone}
        checkpoints={checkpoints}
        waitMarkers={waitMarkers}
        selectedMarkerId={selectedMarkerId}
        previewPoint={previewPoint}
      />
      <Text style={styles.fallbackNote}>Map tiles unavailable. Showing local path only.</Text>
      {onMapPress && !onWaitMarkerPress ? (
        <Text style={styles.fallbackNote}>Tap-to-place is unavailable without the street map.</Text>
      ) : null}
      <Text style={styles.attribution}>© OpenStreetMap contributors</Text>
    </View>
  );

  return (
    <View style={[styles.frame, style]}>
      {useFallback ? (
        fallback
      ) : (
        <MapErrorBoundary fallback={fallback}>
          <MapLibreRouteMap
            path={path}
            startZone={startZone}
            finishZone={finishZone}
            checkpoints={checkpoints}
            waitMarkers={waitMarkers}
            previewPoint={previewPoint}
            selectedMarkerId={selectedMarkerId}
            onMapPress={onMapPress}
            onWaitMarkerPress={onWaitMarkerPress}
            onBasemapFailed={() => setUseFallback(true)}
          />
        </MapErrorBoundary>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    minHeight: 240,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1c2430',
  },
  fallbackWrap: {
    flex: 1,
    minHeight: 240,
  },
  fallbackNote: {
    color: '#c5c8ce',
    fontSize: 12,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  attribution: {
    color: '#9aa0a6',
    fontSize: 11,
    paddingHorizontal: 12,
    paddingBottom: 8,
    paddingTop: 4,
  },
});
