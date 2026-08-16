import { Camera, GeoJSONSource, Layer, Map } from '@maplibre/maplibre-react-native';
import { Component, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { GeoZone, LatLng } from '../domain/geo';
import { FallbackRoutePreview } from './FallbackRoutePreview';
import { OPENFREEMAP_LIBERTY_STYLE_URL } from './openfreemap-style';

export type RouteMapCheckpoint = {
  id: string;
  name: string;
  point: LatLng;
};

export type RouteMapProps = {
  path: LatLng[];
  startZone?: GeoZone | null;
  finishZone?: GeoZone | null;
  checkpoints?: RouteMapCheckpoint[];
  previewPoint?: LatLng | null;
  selectedMarkerId?: string | null;
  onMapPress?: (point: LatLng) => void;
  style?: StyleProp<ViewStyle>;
};

type FeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: { kind: string; selected: string };
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
      properties: { kind: 'path', selected: 'no' },
      geometry: {
        type: 'LineString',
        coordinates: path.map((point) => [point.longitude, point.latitude]),
      },
    });
  }
  if (startZone) {
    features.push({
      type: 'Feature',
      properties: { kind: 'start-zone', selected: 'no' },
      geometry: { type: 'Polygon', coordinates: [circlePolygon(startZone.center, startZone.radiusMeters)] },
    });
    features.push({
      type: 'Feature',
      properties: { kind: 'start', selected: selectedMarkerId === 'start' ? 'yes' : 'no' },
      geometry: { type: 'Point', coordinates: [startZone.center.longitude, startZone.center.latitude] },
    });
  }
  if (finishZone) {
    features.push({
      type: 'Feature',
      properties: { kind: 'finish-zone', selected: 'no' },
      geometry: { type: 'Polygon', coordinates: [circlePolygon(finishZone.center, finishZone.radiusMeters)] },
    });
    features.push({
      type: 'Feature',
      properties: { kind: 'finish', selected: selectedMarkerId === 'finish' ? 'yes' : 'no' },
      geometry: { type: 'Point', coordinates: [finishZone.center.longitude, finishZone.center.latitude] },
    });
  }
  for (const checkpoint of checkpoints) {
    features.push({
      type: 'Feature',
      properties: { kind: 'checkpoint', selected: selectedMarkerId === checkpoint.id ? 'yes' : 'no' },
      geometry: { type: 'Point', coordinates: [checkpoint.point.longitude, checkpoint.point.latitude] },
    });
  }
  if (previewPoint) {
    features.push({
      type: 'Feature',
      properties: { kind: 'preview', selected: 'no' },
      geometry: { type: 'Point', coordinates: [previewPoint.longitude, previewPoint.latitude] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function boundsFor(
  path: LatLng[],
  startZone?: GeoZone | null,
  finishZone?: GeoZone | null,
  checkpoints: RouteMapCheckpoint[] = [],
  previewPoint?: LatLng | null,
): [number, number, number, number] {
  const coords = [...path];
  if (startZone) {
    coords.push(startZone.center);
  }
  if (finishZone) {
    coords.push(finishZone.center);
  }
  for (const checkpoint of checkpoints) {
    coords.push(checkpoint.point);
  }
  if (previewPoint) {
    coords.push(previewPoint);
  }
  if (coords.length === 0) {
    return [34.75, 32.05, 34.82, 32.12];
  }
  const lats = coords.map((item) => item.latitude);
  const lngs = coords.map((item) => item.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latPad = Math.max((maxLat - minLat) * 0.15, 0.001);
  const lngPad = Math.max((maxLng - minLng) * 0.15, 0.001);
  return [minLng - lngPad, minLat - latPad, maxLng + lngPad, maxLat + latPad];
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
  previewPoint,
  selectedMarkerId,
  onMapPress,
  onBasemapFailed,
}: RouteMapProps & { onBasemapFailed: () => void }) {
  const data = useMemo(
    () => toGeoJson(path, startZone, finishZone, checkpoints, previewPoint, selectedMarkerId),
    [checkpoints, finishZone, path, previewPoint, selectedMarkerId, startZone],
  );
  const bounds = useMemo(
    () => boundsFor(path, startZone, finishZone, checkpoints, previewPoint),
    [checkpoints, finishZone, path, previewPoint, startZone],
  );

  return (
    <Map
      mapStyle={OPENFREEMAP_LIBERTY_STYLE_URL}
      style={StyleSheet.absoluteFill}
      attribution
      logo
      onDidFailLoadingMap={onBasemapFailed}
      onPress={(event) => {
        if (!onMapPress) {
          return;
        }
        const lngLat = event.nativeEvent.lngLat;
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
          bounds,
          padding: { top: 48, right: 48, bottom: 48, left: 48 },
        }}
        bounds={bounds}
        padding={{ top: 48, right: 48, bottom: 48, left: 48 }}
        duration={0}
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
    </Map>
  );
}

export function RouteMap({
  path,
  startZone,
  finishZone,
  checkpoints = [],
  previewPoint = null,
  selectedMarkerId = null,
  onMapPress,
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
        previewPoint={previewPoint}
      />
      <Text style={styles.fallbackNote}>Map tiles unavailable. Showing local path only.</Text>
      {onMapPress ? (
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
            previewPoint={previewPoint}
            selectedMarkerId={selectedMarkerId}
            onMapPress={onMapPress}
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
