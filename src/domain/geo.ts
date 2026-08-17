export type LatLng = {
  latitude: number;
  longitude: number;
};

export type GeoZone = {
  center: LatLng;
  radiusMeters: number;
};

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function geoZoneExtentPoints(zone: GeoZone): LatLng[] {
  const latMeters = 111_320;
  const lngMeters = Math.max(1e-6, latMeters * Math.cos(toRadians(zone.center.latitude)));
  const dLat = zone.radiusMeters / latMeters;
  const dLng = zone.radiusMeters / lngMeters;
  return [
    { latitude: zone.center.latitude + dLat, longitude: zone.center.longitude },
    { latitude: zone.center.latitude - dLat, longitude: zone.center.longitude },
    { latitude: zone.center.latitude, longitude: zone.center.longitude + dLng },
    { latitude: zone.center.latitude, longitude: zone.center.longitude - dLng },
  ];
}

export function pathDistanceMeters(path: LatLng[]): number {
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (previous && current) {
      total += haversineMeters(previous, current);
    }
  }
  return total;
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}
