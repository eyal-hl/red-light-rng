import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  anchorOutsideCameraBounds,
  nextAttemptMapViewMode,
  shouldFollowActiveAttemptCamera,
  shouldRefitAttemptCamera,
  shouldSnapActiveAttemptCamera,
  type AttemptLiveMapModel,
  type AttemptMapViewMode,
} from '../domain/attempt-live-map';
import type { LatLng } from '../domain/geo';
import { courseCameraBounds } from '../map/course-camera-bounds';
import type { LiveMapPlaceMarker, LiveMapUserMarker } from '../map/live-map-markers';
import { RouteMap } from '../map/RouteMap';

const EMPTY_PATH: LatLng[] = [];
const EMPTY_FRAME = courseCameraBounds([]);
const EMPTY_FRAME_POINTS: LatLng[] = [
  { longitude: EMPTY_FRAME[0], latitude: EMPTY_FRAME[1] },
  { longitude: EMPTY_FRAME[2], latitude: EMPTY_FRAME[3] },
];

type AttemptLiveMapProps = {
  model: AttemptLiveMapModel;
};

type FitRequest = {
  token: number;
  bounds: [number, number, number, number];
};

function useStableValue<T>(key: string, value: T): T {
  const [stored, setStored] = useState({ key, value });
  if (stored.key !== key) {
    setStored({ key, value });
    return value;
  }
  return stored.value;
}

export function AttemptLiveMap({ model }: AttemptLiveMapProps) {
  const framedPoints = model.viewportPoints.length > 0 ? model.viewportPoints : EMPTY_FRAME_POINTS;
  const viewportKey = framedPoints
    .map((point) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`)
    .join('|');
  const [initialBounds] = useState(() => courseCameraBounds(model.viewportPoints));
  const [initialHadAnchor] = useState(model.anchor != null);
  const [explored, setExplored] = useState(false);
  const [caughtUp, setCaughtUp] = useState(false);
  const [followedBounds, setFollowedBounds] = useState<[number, number, number, number] | null>(null);
  const [wasInteractive, setWasInteractive] = useState(model.interactive);
  const [fitRequest, setFitRequest] = useState<FitRequest | null>(null);
  const viewMode: AttemptMapViewMode = model.interactive && explored ? 'manual' : 'auto';
  const framePoints = useStableValue(viewportKey, framedPoints);
  const fitTarget = useMemo(() => courseCameraBounds(framePoints), [framePoints]);
  const framedBounds = followedBounds ?? initialBounds;

  const catchUp = shouldRefitAttemptCamera({
    mode: viewMode,
    hasAnchor: model.anchor != null,
    initialHadAnchor,
    caughtUp,
  });
  const snapPassive = shouldSnapActiveAttemptCamera({
    interactive: model.interactive,
    wasInteractive,
  });
  const followActive = shouldFollowActiveAttemptCamera({
    interactive: model.interactive,
    hasAnchor: model.anchor != null,
    anchorOutsideFrame: anchorOutsideCameraBounds(model.anchor, framedBounds),
  });
  if (snapPassive || catchUp || followActive) {
    if (snapPassive) {
      setWasInteractive(false);
      setExplored(false);
    }
    if (catchUp) {
      setCaughtUp(true);
    }
    setFollowedBounds(fitTarget);
    setFitRequest({ token: (fitRequest?.token ?? 0) + 1, bounds: fitTarget });
  } else if (wasInteractive !== model.interactive) {
    setWasInteractive(model.interactive);
  }

  const placeKey = model.places
    .map((place) =>
      [
        place.id,
        place.name,
        place.center.latitude,
        place.center.longitude,
        place.radiusMeters,
        place.emphasized ? '1' : '0',
      ].join(':'),
    )
    .join('|');
  const placeMarkers = useStableValue<LiveMapPlaceMarker[]>(
    placeKey,
    model.places.map((place) => ({
      id: place.id,
      name: place.name,
      center: place.center,
      radiusMeters: place.radiusMeters,
      emphasized: place.emphasized,
    })),
  );
  const userKey =
    model.marker.confidence === 'hidden'
      ? 'hidden'
      : [
          model.marker.confidence,
          model.marker.point.latitude,
          model.marker.point.longitude,
          model.marker.horizontalAccuracyMeters ?? '',
          model.marker.label,
        ].join(':');
  const userMarker = useStableValue<LiveMapUserMarker | null>(
    userKey,
    model.marker.confidence === 'hidden'
      ? null
      : {
          point: model.marker.point,
          confidence: model.marker.confidence,
          horizontalAccuracyMeters: model.marker.horizontalAccuracyMeters,
          label: model.marker.label,
        },
  );

  const onUserViewportChange = useCallback(
    (userInteraction: boolean) => {
      setExplored((current) => {
        const next = nextAttemptMapViewMode({
          mode: current ? 'manual' : 'auto',
          interactive: model.interactive,
          userInteraction,
          recenterRequested: false,
        });
        return next === 'manual';
      });
    },
    [model.interactive],
  );

  return (
    <View style={liveStyles.frame} accessibilityLabel="Attempt location map">
      <RouteMap
        path={EMPTY_PATH}
        placeMarkers={placeMarkers}
        userMarker={userMarker}
        cameraBounds={initialBounds}
        fitBoundsTarget={fitRequest?.bounds ?? null}
        fitBoundsToken={fitRequest?.token ?? 0}
        framePoints={framePoints}
        cameraGesturesEnabled={model.interactive}
        compassEnabled={model.interactive}
        onUserViewportChange={onUserViewportChange}
        style={liveStyles.map}
      />
      {model.interactive && viewMode === 'manual' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Recenter map"
          onPress={() => {
            setExplored(false);
            setFollowedBounds(fitTarget);
            setFitRequest((current) => ({
              token: (current?.token ?? 0) + 1,
              bounds: fitTarget,
            }));
          }}
          style={liveStyles.recenter}
        >
          <Text style={liveStyles.recenterText}>RECENTER</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const liveStyles = StyleSheet.create({
  frame: {
    flex: 1,
    minHeight: 180,
  },
  map: {
    flex: 1,
    minHeight: 180,
  },
  recenter: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: '#1c2430',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3c4450',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  recenterText: {
    color: '#f5f5f5',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
});
