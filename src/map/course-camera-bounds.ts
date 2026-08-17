import type { GeoZone, LatLng } from '../domain/geo';

export type CourseCameraPoint = {
  point: LatLng;
};

export const COURSE_CAMERA_PADDING = {
  top: 48,
  right: 48,
  bottom: 48,
  left: 48,
} as const;

/**
 * Initial course framing only. Preview snaps must not be included — a live
 * bounds input that changes on tap re-fits the camera and fights pan/zoom.
 */
export function courseCameraBounds(
  path: LatLng[],
  startZone?: GeoZone | null,
  finishZone?: GeoZone | null,
  checkpoints: CourseCameraPoint[] = [],
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
