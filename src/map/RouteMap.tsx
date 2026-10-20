import { Camera, GeoJSONSource, Layer, Map, type CameraRef } from '@maplibre/maplibre-react-native';
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { GeoZone, LatLng } from '../domain/geo';
import { COURSE_CAMERA_PADDING, courseCameraBounds } from './course-camera-bounds';
import { FallbackRoutePreview } from './FallbackRoutePreview';
import type { LiveMapPlaceMarker, LiveMapUserMarker } from './live-map-markers';
import {
  prepareMapPresentation,
  type MapPresentationDebugSample,
} from './map-presentation';
import { OPENFREEMAP_LIBERTY_STYLE_URL, OPENFREEMAP_LIBERTY_TEXT_FONT } from './openfreemap-style';
import {
  isRenderableReferencePath,
  pathVariantCameraPoints,
  type PathVariantMapLine,
} from './path-variant-display';

export type RouteMapCheckpoint = {
  id: string;
  name: string;
  point: LatLng;
};

export type RouteMapWaitMarkerTone = 'wait' | 'more' | 'less';

export type RouteMapWaitMarker = {
  id: string;
  point: LatLng;
  label: string;
  tone?: RouteMapWaitMarkerTone;
};

export type RouteMapDebugSample = MapPresentationDebugSample;

export type RouteMapPathVariant = PathVariantMapLine;

export type RouteMapProps = {
  path: LatLng[];
  pathVariants?: RouteMapPathVariant[];
  startZone?: GeoZone | null;
  finishZone?: GeoZone | null;
  checkpoints?: RouteMapCheckpoint[];
  waitMarkers?: RouteMapWaitMarker[];
  previewPoint?: LatLng | null;
  selectedMarkerId?: string | null;
  recordedPath?: LatLng[];
  debugSamples?: RouteMapDebugSample[];
  selectedSampleId?: string | null;
  officialStartPoint?: LatLng | null;
  officialFinishPoint?: LatLng | null;
  onMapPress?: (point: LatLng) => void;
  onWaitMarkerPress?: (waitId: string) => void;
  cameraGesturesEnabled?: boolean;
  compassEnabled?: boolean;
  placeMarkers?: LiveMapPlaceMarker[];
  userMarker?: LiveMapUserMarker | null;
  /** Initial camera. When omitted, the map frames the route geometry once. */
  cameraBounds?: [number, number, number, number] | null;
  /** Latest frame used only when `fitBoundsToken` changes. */
  fitBoundsTarget?: [number, number, number, number] | null;
  fitBoundsToken?: number;
  /** Fallback preview frame. Empty means the fallback fits every drawn point. */
  framePoints?: LatLng[];
  onUserViewportChange?: (userInteraction: boolean) => void;
  style?: StyleProp<ViewStyle>;
};

type FeatureCollection = {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    properties: {
      kind: string;
      selected: string;
      waitId: string;
      label: string;
      tone: string;
      sampleId: string;
      accepted: string;
      color: string;
      routeId: string;
    };
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
  return {
    kind,
    selected: selected ? 'yes' : 'no',
    waitId: '',
    label: '',
    tone: 'wait',
    sampleId: '',
    accepted: 'no',
    color: '#4fc3f7',
    routeId: '',
  };
}

const WAIT_MARKER_RADIUS = 8;
const WAIT_MARKER_SELECTED_RADIUS = 11;
const PREVIEW_MARKER_RADIUS = 13;

function toGeoJson(
  path: LatLng[],
  startZone?: GeoZone | null,
  finishZone?: GeoZone | null,
  checkpoints: RouteMapCheckpoint[] = [],
  selectedMarkerId?: string | null,
  pathVariants: PathVariantMapLine[] = [],
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
  for (const variant of pathVariants) {
    if (!isRenderableReferencePath(variant.path)) {
      continue;
    }
    features.push({
      type: 'Feature',
      properties: {
        ...emptyProperties('path-variant'),
        color: variant.color,
        routeId: variant.id,
      },
      geometry: {
        type: 'LineString',
        coordinates: variant.path.map((point) => [point.longitude, point.latitude]),
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
  return { type: 'FeatureCollection', features };
}

function toPlaceMarkerGeoJson(placeMarkers: LiveMapPlaceMarker[]): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  for (const place of placeMarkers) {
    const selected = place.emphasized;
    features.push({
      type: 'Feature',
      properties: { ...emptyProperties('place-zone', selected), label: place.name },
      geometry: {
        type: 'Polygon',
        coordinates: [circlePolygon(place.center, place.radiusMeters)],
      },
    });
    features.push({
      type: 'Feature',
      properties: { ...emptyProperties('place-point', selected), label: place.name },
      geometry: { type: 'Point', coordinates: [place.center.longitude, place.center.latitude] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function toUserMarkerGeoJson(userMarker?: LiveMapUserMarker | null): FeatureCollection {
  if (!userMarker) {
    return { type: 'FeatureCollection', features: [] };
  }
  const tone = userMarker.confidence;
  const features: FeatureCollection['features'] = [];
  if (userMarker.horizontalAccuracyMeters != null && userMarker.horizontalAccuracyMeters > 0) {
    features.push({
      type: 'Feature',
      properties: { ...emptyProperties('user-accuracy'), tone, label: userMarker.label },
      geometry: {
        type: 'Polygon',
        coordinates: [circlePolygon(userMarker.point, userMarker.horizontalAccuracyMeters)],
      },
    });
  }
  features.push({
    type: 'Feature',
    properties: { ...emptyProperties('user-point'), tone, label: userMarker.label },
    geometry: { type: 'Point', coordinates: [userMarker.point.longitude, userMarker.point.latitude] },
  });
  return { type: 'FeatureCollection', features };
}

function toPreviewGeoJson(previewPoint?: LatLng | null): FeatureCollection {
  if (!previewPoint) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: emptyProperties('preview'),
        geometry: { type: 'Point', coordinates: [previewPoint.longitude, previewPoint.latitude] },
      },
    ],
  };
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
        tone: marker.tone ?? 'wait',
        sampleId: '',
        accepted: 'no',
        color: '#4fc3f7',
        routeId: '',
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [marker.point.longitude, marker.point.latitude],
      },
    })),
  };
}

function toRecordedPathGeoJson(recordedPath: LatLng[]): FeatureCollection {
  if (recordedPath.length < 2) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: emptyProperties('recorded-path'),
        geometry: {
          type: 'LineString',
          coordinates: recordedPath.map((point) => [point.longitude, point.latitude]),
        },
      },
    ],
  };
}

function toDebugSampleGeoJson(
  debugSamples: RouteMapDebugSample[],
  selectedSampleId?: string | null,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: debugSamples.map((sample) => ({
      type: 'Feature' as const,
      properties: {
        kind: 'debug-sample',
        selected: selectedSampleId === sample.id ? 'yes' : 'no',
        waitId: '',
        label: '',
        tone: 'wait',
        sampleId: sample.id,
        accepted: sample.accepted ? 'yes' : 'no',
        color: '#4fc3f7',
        routeId: '',
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [sample.point.longitude, sample.point.latitude],
      },
    })),
  };
}

function toOfficialPointGeoJson(
  officialStartPoint?: LatLng | null,
  officialFinishPoint?: LatLng | null,
): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  if (officialStartPoint) {
    features.push({
      type: 'Feature',
      properties: emptyProperties('official-start'),
      geometry: {
        type: 'Point',
        coordinates: [officialStartPoint.longitude, officialStartPoint.latitude],
      },
    });
  }
  if (officialFinishPoint) {
    features.push({
      type: 'Feature',
      properties: emptyProperties('official-finish'),
      geometry: {
        type: 'Point',
        coordinates: [officialFinishPoint.longitude, officialFinishPoint.latitude],
      },
    });
  }
  return { type: 'FeatureCollection', features };
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
  pathVariants = [],
  startZone,
  finishZone,
  checkpoints = [],
  waitMarkers = [],
  previewPoint,
  selectedMarkerId,
  recordedPath = [],
  debugSamples = [],
  selectedSampleId = null,
  officialStartPoint = null,
  officialFinishPoint = null,
  onMapPress,
  onWaitMarkerPress,
  cameraGesturesEnabled = true,
  compassEnabled = true,
  placeMarkers = [],
  userMarker = null,
  cameraBounds = null,
  fitBoundsTarget = null,
  fitBoundsToken = 0,
  onUserViewportChange,
  onBasemapFailed,
}: RouteMapProps & { onBasemapFailed: () => void }) {
  const data = useMemo(
    () => toGeoJson(path, startZone, finishZone, checkpoints, selectedMarkerId, pathVariants),
    [checkpoints, finishZone, path, pathVariants, selectedMarkerId, startZone],
  );
  const waitData = useMemo(
    () => toWaitGeoJson(waitMarkers, selectedMarkerId),
    [selectedMarkerId, waitMarkers],
  );
  const previewData = useMemo(() => toPreviewGeoJson(previewPoint), [previewPoint]);
  const recordedData = useMemo(() => toRecordedPathGeoJson(recordedPath), [recordedPath]);
  const presentation = useMemo(
    () => prepareMapPresentation({ debugSamples, recordedPath, selectedSampleId }),
    [debugSamples, recordedPath, selectedSampleId],
  );
  const debugData = useMemo(
    () => toDebugSampleGeoJson(presentation.debugMarkers, selectedSampleId),
    [presentation.debugMarkers, selectedSampleId],
  );
  const officialData = useMemo(
    () => toOfficialPointGeoJson(officialStartPoint, officialFinishPoint),
    [officialFinishPoint, officialStartPoint],
  );
  const placeData = useMemo(() => toPlaceMarkerGeoJson(placeMarkers), [placeMarkers]);
  const userData = useMemo(() => toUserMarkerGeoJson(userMarker), [userMarker]);
  const cameraPoints = useMemo(
    () => [
      ...checkpoints,
      ...pathVariantCameraPoints(pathVariants),
      ...waitMarkers.map((marker) => ({ point: marker.point })),
      ...recordedPath.map((point) => ({ point })),
      ...debugSamples.map((sample) => ({ point: sample.point })),
      ...(officialStartPoint ? [{ point: officialStartPoint }] : []),
      ...(officialFinishPoint ? [{ point: officialFinishPoint }] : []),
    ],
    [checkpoints, debugSamples, officialFinishPoint, officialStartPoint, pathVariants, recordedPath, waitMarkers],
  );
  const derivedBounds = useMemo(
    () => courseCameraBounds(path, startZone, finishZone, cameraPoints),
    [cameraPoints, finishZone, path, startZone],
  );
  const initialBounds = cameraBounds ?? derivedBounds;
  const cameraRef = useRef<CameraRef>(null);
  const styleFitToken = useRef(0);
  useEffect(() => {
    if (!fitBoundsToken || !fitBoundsTarget || !cameraRef.current) {
      return;
    }
    cameraRef.current.fitBounds(fitBoundsTarget, { duration: 0, padding: COURSE_CAMERA_PADDING });
  }, [fitBoundsTarget, fitBoundsToken]);

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
      compass={compassEnabled}
      dragPan={cameraGesturesEnabled}
      touchZoom={cameraGesturesEnabled}
      doubleTapZoom={cameraGesturesEnabled}
      doubleTapHoldZoom={cameraGesturesEnabled}
      touchRotate={cameraGesturesEnabled}
      touchPitch={cameraGesturesEnabled}
      onDidFailLoadingMap={onBasemapFailed}
      onDidFinishLoadingMap={() => {
        if (!fitBoundsToken || !fitBoundsTarget || !cameraRef.current) {
          return;
        }
        if (styleFitToken.current === fitBoundsToken) {
          return;
        }
        styleFitToken.current = fitBoundsToken;
        cameraRef.current.fitBounds(fitBoundsTarget, { duration: 0, padding: COURSE_CAMERA_PADDING });
      }}
      onRegionDidChange={
        onUserViewportChange
          ? (event) => {
              onUserViewportChange(event.nativeEvent.userInteraction);
            }
          : undefined
      }
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
        ref={cameraRef}
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
          id="path-variant-line"
          type="line"
          filter={['==', ['get', 'kind'], 'path-variant']}
          paint={{
            'line-color': ['get', 'color'],
            'line-width': 4,
            'line-opacity': 0.92,
          }}
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
              'circle-radius': [
                'case',
                ['==', ['get', 'selected'], 'yes'],
                WAIT_MARKER_SELECTED_RADIUS,
                WAIT_MARKER_RADIUS,
              ],
              'circle-color': [
                'case',
                ['==', ['get', 'tone'], 'more'],
                ['case', ['==', ['get', 'selected'], 'yes'], '#ef9a9a', '#f07178'],
                ['==', ['get', 'tone'], 'less'],
                ['case', ['==', ['get', 'selected'], 'yes'], '#a5d6a7', '#7dcea0'],
                ['case', ['==', ['get', 'selected'], 'yes'], '#ffb74d', '#ff7043'],
              ],
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
              // Android treats string-first arrays as expressions; wrap the font stack.
              'text-font': ['literal', OPENFREEMAP_LIBERTY_TEXT_FONT],
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
      {recordedPath.length >= 2 ? (
        <GeoJSONSource id="recorded-path" data={recordedData}>
          <Layer
            id="recorded-path-line"
            type="line"
            filter={['==', ['get', 'kind'], 'recorded-path']}
            paint={{ 'line-color': '#ffb74d', 'line-width': 3, 'line-opacity': 0.9 }}
          />
        </GeoJSONSource>
      ) : null}
      {presentation.debugMarkers.length > 0 ? (
        <GeoJSONSource id="debug-samples" data={debugData}>
          <Layer
            id="debug-sample-point"
            type="circle"
            filter={['==', ['get', 'kind'], 'debug-sample']}
            paint={{
              'circle-radius': ['case', ['==', ['get', 'selected'], 'yes'], 10, 4],
              'circle-color': [
                'case',
                ['==', ['get', 'accepted'], 'yes'],
                '#7dcea0',
                '#f07178',
              ],
              'circle-stroke-width': ['case', ['==', ['get', 'selected'], 'yes'], 3, 1],
              'circle-stroke-color': ['case', ['==', ['get', 'selected'], 'yes'], '#111111', '#5c2a2e'],
            }}
          />
        </GeoJSONSource>
      ) : null}
      {officialStartPoint || officialFinishPoint ? (
        <GeoJSONSource id="official-points" data={officialData}>
          <Layer
            id="official-start-point"
            type="circle"
            filter={['==', ['get', 'kind'], 'official-start']}
            paint={{
              'circle-radius': 8,
              'circle-color': '#66bb6a',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            }}
          />
          <Layer
            id="official-finish-point"
            type="circle"
            filter={['==', ['get', 'kind'], 'official-finish']}
            paint={{
              'circle-radius': 8,
              'circle-color': '#ef9a9a',
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            }}
          />
        </GeoJSONSource>
      ) : null}
      {placeMarkers.length > 0 ? (
        <GeoJSONSource id="attempt-places" data={placeData}>
          <Layer
            id="place-zone-fill"
            type="fill"
            filter={['==', ['get', 'kind'], 'place-zone']}
            paint={{
              'fill-color': ['case', ['==', ['get', 'selected'], 'yes'], '#2e7d4f', '#8aa0b8'],
              'fill-opacity': ['case', ['==', ['get', 'selected'], 'yes'], 0.2, 0.12],
            }}
          />
          <Layer
            id="place-zone-line"
            type="line"
            filter={['==', ['get', 'kind'], 'place-zone']}
            paint={{
              'line-color': ['case', ['==', ['get', 'selected'], 'yes'], '#7dcea0', '#9db0c4'],
              'line-width': 1.5,
              'line-opacity': 0.85,
            }}
          />
          <Layer
            id="place-point"
            type="circle"
            filter={['==', ['get', 'kind'], 'place-point']}
            paint={{
              'circle-radius': 6,
              'circle-color': ['case', ['==', ['get', 'selected'], 'yes'], '#7dcea0', '#d7dee8'],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#111111',
            }}
          />
          <Layer
            id="place-label"
            type="symbol"
            filter={['==', ['get', 'kind'], 'place-point']}
            layout={{
              'text-field': ['get', 'label'],
              'text-font': ['literal', OPENFREEMAP_LIBERTY_TEXT_FONT],
              'text-size': 12,
              'text-offset': [0, 1.05],
              'text-anchor': 'top',
              'text-allow-overlap': true,
            }}
            paint={{
              'text-color': '#f5f5f5',
              'text-halo-color': '#111111',
              'text-halo-width': 1.2,
            }}
          />
        </GeoJSONSource>
      ) : null}
      {userMarker ? (
        <GeoJSONSource id="attempt-user" data={userData}>
          <Layer
            id="user-accuracy"
            type="fill"
            filter={['==', ['get', 'kind'], 'user-accuracy']}
            paint={{
              'fill-color': ['case', ['==', ['get', 'tone'], 'last-known'], '#8b939a', '#7ee0ff'],
              'fill-opacity': 0.16,
            }}
          />
          <Layer
            id="user-point"
            type="circle"
            filter={['==', ['get', 'kind'], 'user-point']}
            paint={{
              'circle-radius': ['case', ['==', ['get', 'tone'], 'last-known'], 6, 7],
              'circle-color': ['case', ['==', ['get', 'tone'], 'last-known'], '#8b939a', '#7ee0ff'],
              'circle-opacity': ['case', ['==', ['get', 'tone'], 'last-known'], 0.7, 1],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            }}
          />
          <Layer
            id="user-label"
            type="symbol"
            filter={['==', ['get', 'kind'], 'user-point']}
            layout={{
              'text-field': ['get', 'label'],
              'text-font': ['literal', OPENFREEMAP_LIBERTY_TEXT_FONT],
              'text-size': 12,
              'text-offset': [0, -1.35],
              'text-anchor': 'bottom',
              'text-allow-overlap': true,
            }}
            paint={{
              'text-color': ['case', ['==', ['get', 'tone'], 'last-known'], '#c5c8ce', '#d7f6ff'],
              'text-halo-color': '#111111',
              'text-halo-width': 1.2,
            }}
          />
        </GeoJSONSource>
      ) : null}
      {previewPoint ? (
        <GeoJSONSource id="ghost-preview" data={previewData}>
          <Layer
            id="preview-point"
            type="circle"
            filter={['==', ['get', 'kind'], 'preview']}
            paint={{
              'circle-radius': PREVIEW_MARKER_RADIUS,
              'circle-color': 'rgba(0, 0, 0, 0)',
              'circle-stroke-width': 3,
              'circle-stroke-color': '#7ee0ff',
            }}
          />
        </GeoJSONSource>
      ) : null}
    </Map>
  );
}

export function RouteMap({
  path,
  pathVariants = [],
  startZone,
  finishZone,
  checkpoints = [],
  waitMarkers = [],
  previewPoint = null,
  selectedMarkerId = null,
  recordedPath = [],
  debugSamples = [],
  selectedSampleId = null,
  officialStartPoint = null,
  officialFinishPoint = null,
  onMapPress,
  onWaitMarkerPress,
  cameraGesturesEnabled = true,
  compassEnabled = true,
  placeMarkers = [],
  userMarker = null,
  cameraBounds = null,
  fitBoundsTarget = null,
  fitBoundsToken = 0,
  framePoints = [],
  onUserViewportChange,
  style,
}: RouteMapProps) {
  const [useFallback, setUseFallback] = useState(false);
  const fallback = (
    <View style={styles.fallbackWrap}>
      <FallbackRoutePreview
        path={path}
        pathVariants={pathVariants}
        startZone={startZone}
        finishZone={finishZone}
        checkpoints={checkpoints}
        waitMarkers={waitMarkers}
        selectedMarkerId={selectedMarkerId}
        previewPoint={previewPoint}
        recordedPath={recordedPath}
        debugSamples={debugSamples}
        selectedSampleId={selectedSampleId}
        officialStartPoint={officialStartPoint}
        officialFinishPoint={officialFinishPoint}
        placeMarkers={placeMarkers}
        userMarker={userMarker}
        framePoints={framePoints}
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
            pathVariants={pathVariants}
            startZone={startZone}
            finishZone={finishZone}
            checkpoints={checkpoints}
            waitMarkers={waitMarkers}
            previewPoint={previewPoint}
            selectedMarkerId={selectedMarkerId}
            recordedPath={recordedPath}
            debugSamples={debugSamples}
            selectedSampleId={selectedSampleId}
            officialStartPoint={officialStartPoint}
            officialFinishPoint={officialFinishPoint}
            onMapPress={onMapPress}
            onWaitMarkerPress={onWaitMarkerPress}
            cameraGesturesEnabled={cameraGesturesEnabled}
            compassEnabled={compassEnabled}
            placeMarkers={placeMarkers}
            userMarker={userMarker}
            cameraBounds={cameraBounds}
            fitBoundsTarget={fitBoundsTarget}
            fitBoundsToken={fitBoundsToken}
            onUserViewportChange={onUserViewportChange}
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
