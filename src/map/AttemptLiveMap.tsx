import { Camera, GeoJSONSource, Layer, Map, type CameraRef } from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  classifyCurrentPosition,
  createLiveMapVisibility,
  fallbackLiveMapLayout,
  formatLiveMapCaption,
  initialViewportBounds,
  INITIAL_LIVE_MAP_CAMERA,
  inZonePlaceId,
  liveMapInteractivity,
  placeCirclePolygon,
  reduceLiveMapCamera,
  resolveLiveMapDisplay,
  type AttemptLiveMapData,
  type AttemptLiveMapPlace,
  type CurrentPositionMarker,
} from '../domain/attempt-live-map';
import type { PlaceStartZoneStatus } from '../domain/place-timing';
import { COURSE_CAMERA_PADDING } from './course-camera-bounds';
import { OPENFREEMAP_LIBERTY_STYLE_URL, OPENFREEMAP_LIBERTY_TEXT_FONT } from './openfreemap-style';
import { MapErrorBoundary } from './RouteMap';

type AttemptLiveMapProps = {
  lifecycle: 'armed' | 'active';
  liveMap: AttemptLiveMapData;
  startZoneStatus: PlaceStartZoneStatus;
};

/** Foreground-only flag. Reads AppState; never touches tracking or the runtime. */
function useForegroundAppState(): string {
  const [state, setState] = useState<string>(AppState.currentState);
  useEffect(() => {
    const visibility = createLiveMapVisibility({
      getState: () => AppState.currentState,
      subscribe: (listener) => {
        const subscription = AppState.addEventListener('change', listener);
        return () => subscription.remove();
      },
    });
    const sync = visibility.subscribe((visible) => setState(visible ? 'active' : 'background'));
    return () => {
      sync();
      visibility.dispose();
    };
  }, []);
  return state;
}

function placesGeoJson(places: AttemptLiveMapPlace[], inZoneId: string | null) {
  const features: unknown[] = [];
  for (const place of places) {
    const inZone = place.id === inZoneId ? 'yes' : 'no';
    features.push(
      {
        type: 'Feature',
        properties: { kind: 'radius', inZone, name: place.name },
        geometry: { type: 'Polygon', coordinates: [placeCirclePolygon(place.center, place.radiusMeters)] },
      },
      {
        type: 'Feature',
        properties: { kind: 'center', inZone, name: place.name },
        geometry: { type: 'Point', coordinates: [place.center.longitude, place.center.latitude] },
      },
    );
  }
  return { type: 'FeatureCollection' as const, features } as never;
}

function markerGeoJson(marker: CurrentPositionMarker) {
  const features =
    marker.point == null
      ? []
      : [
          {
            type: 'Feature',
            properties: { kind: marker.kind },
            geometry: { type: 'Point', coordinates: [marker.point.longitude, marker.point.latitude] },
          },
        ];
  return { type: 'FeatureCollection' as const, features } as never;
}

function LiveMapSurface({
  lifecycle,
  liveMap,
  startZoneStatus,
  marker,
  onTilesFailed,
}: AttemptLiveMapProps & { marker: CurrentPositionMarker; onTilesFailed: () => void }) {
  const interactivity = liveMapInteractivity(lifecycle);
  const cameraRef = useRef<CameraRef>(null);
  const [camera, dispatch] = useReducer(reduceLiveMapCamera, INITIAL_LIVE_MAP_CAMERA);
  const [initialBounds] = useState(() => initialViewportBounds(marker.point, liveMap.places));
  const inZoneId = inZonePlaceId(startZoneStatus, liveMap.places);
  const placeData = useMemo(() => placesGeoJson(liveMap.places, inZoneId), [inZoneId, liveMap.places]);
  const markerData = useMemo(() => markerGeoJson(marker), [marker]);
  const latitude = marker.point?.latitude ?? null;
  const longitude = marker.point?.longitude ?? null;

  useEffect(() => {
    dispatch({
      type: 'view',
      position: latitude != null && longitude != null ? { latitude, longitude } : null,
      places: liveMap.places,
      lifecycle,
    });
  }, [latitude, longitude, liveMap.places, lifecycle]);

  useEffect(() => {
    if (camera.fitSeq === 0 || !camera.fitBounds) {
      return;
    }
    try {
      cameraRef.current?.fitBounds(camera.fitBounds, { padding: COURSE_CAMERA_PADDING, duration: 0 });
    } catch {
      // A camera failure must never affect run control.
    }
  }, [camera.fitSeq, camera.fitBounds]);

  return (
    <View style={styles.fill} pointerEvents={interactivity.capturesTouches ? 'auto' : 'none'}>
      <Map
        mapStyle={OPENFREEMAP_LIBERTY_STYLE_URL}
        style={StyleSheet.absoluteFill}
        attribution
        logo={false}
        compass={false}
        dragPan={interactivity.dragPan}
        touchZoom={interactivity.touchZoom}
        doubleTapZoom={interactivity.doubleTapZoom}
        doubleTapHoldZoom={interactivity.doubleTapHoldZoom}
        touchRotate={interactivity.touchRotate}
        touchPitch={interactivity.touchPitch}
        onDidFailLoadingMap={onTilesFailed}
        onRegionWillChange={(event) => {
          if (interactivity.dragPan && event.nativeEvent.userInteraction) {
            dispatch({ type: 'user-gesture' });
          }
        }}
      >
        <Camera
          ref={cameraRef}
          initialViewState={initialBounds ? { bounds: initialBounds, padding: COURSE_CAMERA_PADDING } : { zoom: 14 }}
        />
        <GeoJSONSource id="live-places" data={placeData}>
          <Layer
            id="live-place-fill"
            type="fill"
            filter={['==', ['get', 'kind'], 'radius']}
            paint={{
              'fill-color': ['case', ['==', ['get', 'inZone'], 'yes'], '#2e7d4f', '#4fc3f7'],
              'fill-opacity': ['case', ['==', ['get', 'inZone'], 'yes'], 0.3, 0.14],
            }}
          />
          <Layer
            id="live-place-outline"
            type="line"
            filter={['==', ['get', 'kind'], 'radius']}
            paint={{
              'line-color': ['case', ['==', ['get', 'inZone'], 'yes'], '#7dcea0', '#4fc3f7'],
              'line-width': 2,
            }}
          />
          <Layer
            id="live-place-center"
            type="circle"
            filter={['==', ['get', 'kind'], 'center']}
            paint={{ 'circle-radius': 4, 'circle-color': '#f5f5f5', 'circle-stroke-width': 1, 'circle-stroke-color': '#111111' }}
          />
          <Layer
            id="live-place-label"
            type="symbol"
            filter={['==', ['get', 'kind'], 'center']}
            layout={{
              'text-field': ['get', 'name'],
              'text-font': ['literal', OPENFREEMAP_LIBERTY_TEXT_FONT],
              'text-size': 12,
              'text-offset': [0, 0.9],
              'text-anchor': 'top',
              'text-allow-overlap': false,
            }}
            paint={{ 'text-color': '#ffffff', 'text-halo-color': '#111111', 'text-halo-width': 1.2 }}
          />
        </GeoJSONSource>
        {marker.point ? (
          <GeoJSONSource id="live-position" data={markerData}>
            <Layer
              id="live-position-dot"
              type="circle"
              paint={{
                'circle-radius': ['case', ['==', ['get', 'kind'], 'fresh'], 8, 7],
                'circle-color': ['case', ['==', ['get', 'kind'], 'fresh'], '#2f80ed', '#9aa0a6'],
                'circle-opacity': ['case', ['==', ['get', 'kind'], 'fresh'], 1, 0.55],
                'circle-stroke-width': 2,
                'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'fresh'], '#ffffff', '#c5c8ce'],
                'circle-stroke-opacity': ['case', ['==', ['get', 'kind'], 'fresh'], 1, 0.6],
              }}
            />
          </GeoJSONSource>
        ) : null}
      </Map>
      {interactivity.recenterControl ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Recenter map"
          onPress={() =>
            dispatch({
              type: 'recenter',
              position: latitude != null && longitude != null ? { latitude, longitude } : null,
              places: liveMap.places,
            })
          }
          style={styles.recenter}
        >
          <Text style={styles.recenterText}>Recenter</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function LiveMapFallback({
  liveMap,
  marker,
  startZoneStatus,
}: {
  liveMap: AttemptLiveMapData;
  marker: CurrentPositionMarker;
  startZoneStatus: PlaceStartZoneStatus;
}) {
  const layout = fallbackLiveMapLayout(
    initialViewportBounds(marker.point, liveMap.places),
    liveMap.places,
    marker.point,
  );
  const inZoneId = inZonePlaceId(startZoneStatus, liveMap.places);
  return (
    <View style={styles.fill}>
      <View style={styles.fallbackCanvas}>
        {layout.places.map((place) => (
          <View
            key={place.id}
            style={[
              styles.fallbackPlace,
              {
                left: `${place.xPercent}%`,
                top: `${place.yPercent}%`,
                width: `${place.diameterPercent}%`,
                aspectRatio: 1,
                transform: [{ translateX: -10 }, { translateY: -10 }],
              },
              place.id === inZoneId ? styles.fallbackPlaceInZone : null,
            ]}
          >
            <Text style={styles.fallbackPlaceName} numberOfLines={1}>
              {place.name}
            </Text>
          </View>
        ))}
        {layout.marker ? (
          <View
            style={[
              styles.fallbackDot,
              marker.kind === 'fresh' ? styles.fallbackDotFresh : styles.fallbackDotMuted,
              { left: `${layout.marker.xPercent}%`, top: `${layout.marker.yPercent}%` },
            ]}
          />
        ) : null}
      </View>
      <Text style={styles.note}>Map tiles unavailable. Showing saved places only.</Text>
    </View>
  );
}

/**
 * Passive/armed attempt map. Fed only by the engine's own snapshot; owns no
 * location source. Any renderer or tile failure degrades to a local schematic
 * and never affects the surrounding run controls.
 */
export function AttemptLiveMap(props: AttemptLiveMapProps) {
  const { lifecycle, liveMap, startZoneStatus } = props;
  const appState = useForegroundAppState();
  const [tilesFailed, setTilesFailed] = useState(false);
  const marker = useMemo(
    () => classifyCurrentPosition(liveMap.latestFix, liveMap.observedAtMs),
    [liveMap.latestFix, liveMap.observedAtMs],
  );
  const mode = resolveLiveMapDisplay({ appState, rendererFailed: false, tilesFailed });
  const caption = formatLiveMapCaption(marker);
  const showCanvas = marker.point != null || liveMap.places.length > 0;
  const fallback = <LiveMapFallback liveMap={liveMap} marker={marker} startZoneStatus={startZoneStatus} />;

  return (
    <View
      accessibilityLabel={`Attempt map. ${caption}`}
      style={[styles.frame, lifecycle === 'armed' ? styles.frameArmed : styles.framePassive]}
    >
      {mode === 'hidden' ? (
        <Text style={styles.note}>Map paused while the app is in the background.</Text>
      ) : !showCanvas ? (
        <Text style={styles.note}>{caption}. No saved places to show.</Text>
      ) : mode === 'fallback' ? (
        fallback
      ) : (
        <MapErrorBoundary fallback={fallback}>
          <LiveMapSurface {...props} marker={marker} onTilesFailed={() => setTilesFailed(true)} />
        </MapErrorBoundary>
      )}
      {mode !== 'hidden' && showCanvas ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1c2430',
    marginBottom: 16,
    justifyContent: 'center',
  },
  frameArmed: { height: 280 },
  framePassive: { height: 170 },
  fill: { flex: 1 },
  caption: {
    position: 'absolute',
    left: 8,
    bottom: 22,
    right: 8,
    color: '#ffffff',
    fontSize: 12,
    textShadowColor: '#111111',
    textShadowRadius: 3,
  },
  note: { color: '#c5c8ce', fontSize: 12, padding: 12 },
  recenter: {
    position: 'absolute',
    top: 8,
    right: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(17, 17, 17, 0.8)',
  },
  recenterText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  fallbackCanvas: { flex: 1, margin: 12, borderRadius: 8, backgroundColor: '#26303d' },
  fallbackPlace: {
    position: 'absolute',
    borderRadius: 999,
    borderWidth: 2,
    borderColor: '#4fc3f7',
    backgroundColor: 'rgba(79, 195, 247, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 20,
  },
  fallbackPlaceInZone: { borderColor: '#7dcea0', backgroundColor: 'rgba(46, 125, 79, 0.3)' },
  fallbackPlaceName: { color: '#ffffff', fontSize: 10, position: 'absolute', top: '100%' },
  fallbackDot: { position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7, marginTop: -7, borderWidth: 2 },
  fallbackDotFresh: { backgroundColor: '#2f80ed', borderColor: '#ffffff' },
  fallbackDotMuted: { backgroundColor: 'rgba(154, 160, 166, 0.55)', borderColor: '#c5c8ce' },
});
