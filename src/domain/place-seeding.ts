import { haversineMeters, type LatLng } from './geo';
import {
  PLACE_SEED_CENTER_TOLERANCE_METERS,
  PLACE_SEED_RADIUS_TOLERANCE_METERS,
  type Place,
} from './place';
import type { Route } from './route';

export type RoutePlaceAssignment = {
  routeId: string;
  startPlaceId: string;
  finishPlaceId: string;
};

export type PlaceSeedResult = {
  places: Place[];
  assignments: RoutePlaceAssignment[];
};

type SeedEndpoint = {
  routeId: string;
  routeCreatedAtMs: number;
  kind: 'start' | 'finish';
  name: string;
  center: LatLng;
  radiusMeters: number;
};

export function placeNamesFromRouteName(routeName: string): { start: string; finish: string } {
  const trimmed = routeName.trim();
  const parts = trimmed.split(/\s*(?:→|->)\s*/);
  const start = parts[0]?.trim() ?? '';
  const finish = parts[1]?.trim() ?? '';
  if (parts.length >= 2 && start && finish) {
    return { start, finish };
  }
  const label = trimmed.length > 0 ? trimmed : 'Place';
  return { start: `${label} start`, finish: `${label} finish` };
}

export function endpointsMatchForSeed(
  a: { center: LatLng; radiusMeters: number },
  b: { center: LatLng; radiusMeters: number },
): boolean {
  if (haversineMeters(a.center, b.center) > PLACE_SEED_CENTER_TOLERANCE_METERS) {
    return false;
  }
  return Math.abs(a.radiusMeters - b.radiusMeters) <= PLACE_SEED_RADIUS_TOLERANCE_METERS;
}

function endpointSortKey(endpoint: SeedEndpoint): string {
  return [
    String(endpoint.routeCreatedAtMs).padStart(16, '0'),
    endpoint.routeId,
    endpoint.kind === 'start' ? '0' : '1',
  ].join('|');
}

function matchingExistingPlace(places: Place[], endpoint: SeedEndpoint): Place | null {
  const matches = places.filter((place) =>
    endpointsMatchForSeed(place, { center: endpoint.center, radiusMeters: endpoint.radiusMeters }),
  );
  if (matches.length === 0) {
    return null;
  }
  return [...matches].sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) {
      return a.createdAtMs - b.createdAtMs;
    }
    return a.id.localeCompare(b.id);
  })[0] ?? null;
}

export function ensurePlacesForRoute(
  existingPlaces: Place[],
  route: Route,
  options?: { createPlaceId?: (index: number) => string; nowMs?: number },
): { placesToCreate: Place[]; assignment: RoutePlaceAssignment } {
  const createPlaceId =
    options?.createPlaceId ?? ((index) => `place-${String(existingPlaces.length + index + 1).padStart(3, '0')}`);
  const nowMs = options?.nowMs ?? route.createdAtMs;
  const names = placeNamesFromRouteName(route.name);
  const endpoints: SeedEndpoint[] = [
    {
      routeId: route.id,
      routeCreatedAtMs: route.createdAtMs,
      kind: 'start',
      name: names.start,
      center: route.startZone.center,
      radiusMeters: route.startZone.radiusMeters,
    },
    {
      routeId: route.id,
      routeCreatedAtMs: route.createdAtMs,
      kind: 'finish',
      name: names.finish,
      center: route.finishZone.center,
      radiusMeters: route.finishZone.radiusMeters,
    },
  ];
  const known = [...existingPlaces];
  const created: Place[] = [];
  let startPlaceId = '';
  let finishPlaceId = '';
  for (const endpoint of endpoints) {
    const existing = matchingExistingPlace(known, endpoint);
    const place =
      existing ??
      ({
        id: createPlaceId(known.length),
        name: endpoint.name,
        center: { latitude: endpoint.center.latitude, longitude: endpoint.center.longitude },
        radiusMeters: endpoint.radiusMeters,
        status: 'active',
        createdAtMs: nowMs + known.length,
      } satisfies Place);
    if (!existing) {
      known.push(place);
      created.push(place);
    }
    if (endpoint.kind === 'start') {
      startPlaceId = place.id;
    } else {
      finishPlaceId = place.id;
    }
  }
  return {
    placesToCreate: created,
    assignment: { routeId: route.id, startPlaceId, finishPlaceId },
  };
}

export function seedPlacesFromRoutes(
  routes: Route[],
  options?: { createPlaceId?: (index: number) => string; nowMs?: number },
): PlaceSeedResult {
  const createPlaceId = options?.createPlaceId ?? ((index) => `place-seed-${String(index + 1).padStart(3, '0')}`);
  const nowMs = options?.nowMs ?? 0;
  const orderedRoutes = [...routes].sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) {
      return a.createdAtMs - b.createdAtMs;
    }
    return a.id.localeCompare(b.id);
  });

  const endpoints: SeedEndpoint[] = [];
  for (const route of orderedRoutes) {
    const names = placeNamesFromRouteName(route.name);
    endpoints.push({
      routeId: route.id,
      routeCreatedAtMs: route.createdAtMs,
      kind: 'start',
      name: names.start,
      center: route.startZone.center,
      radiusMeters: route.startZone.radiusMeters,
    });
    endpoints.push({
      routeId: route.id,
      routeCreatedAtMs: route.createdAtMs,
      kind: 'finish',
      name: names.finish,
      center: route.finishZone.center,
      radiusMeters: route.finishZone.radiusMeters,
    });
  }
  endpoints.sort((a, b) => endpointSortKey(a).localeCompare(endpointSortKey(b)));

  const places: Place[] = [];
  const assignmentByRoute = new Map<string, { startPlaceId?: string; finishPlaceId?: string }>();

  for (const endpoint of endpoints) {
    const existing = matchingExistingPlace(places, endpoint);
    const place =
      existing ??
      ({
        id: createPlaceId(places.length),
        name: endpoint.name,
        center: { latitude: endpoint.center.latitude, longitude: endpoint.center.longitude },
        radiusMeters: endpoint.radiusMeters,
        status: 'active',
        createdAtMs: nowMs + places.length,
      } satisfies Place);
    if (!existing) {
      places.push(place);
    }
    const current = assignmentByRoute.get(endpoint.routeId) ?? {};
    if (endpoint.kind === 'start') {
      current.startPlaceId = place.id;
    } else {
      current.finishPlaceId = place.id;
    }
    assignmentByRoute.set(endpoint.routeId, current);
  }

  const assignments: RoutePlaceAssignment[] = [];
  for (const route of orderedRoutes) {
    const assignment = assignmentByRoute.get(route.id);
    if (!assignment?.startPlaceId || !assignment.finishPlaceId) {
      continue;
    }
    assignments.push({
      routeId: route.id,
      startPlaceId: assignment.startPlaceId,
      finishPlaceId: assignment.finishPlaceId,
    });
  }

  return { places, assignments };
}
