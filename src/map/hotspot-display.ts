import type { DelayHotspot } from '../domain/delay-hotspots';
import type { RouteMapWaitMarker } from './RouteMap';

/** One map pin per recurring hotspot; the label is waited/encountered attempts. */
export function delayHotspotMapMarkers(hotspots: readonly DelayHotspot[]): RouteMapWaitMarker[] {
  return hotspots.map((hotspot) => ({
    id: hotspot.id,
    point: hotspot.coordinate,
    label: `${hotspot.waitedAttempts}/${hotspot.encounteredAttempts}`,
    tone: 'wait' as const,
  }));
}
