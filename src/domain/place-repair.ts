import { haversineMeters } from './geo';
import { PLACE_REPAIR_DISTANCE_METERS, type Place } from './place';

const TRAILING_INTEGER_SUFFIX = / \d+$/;

export type PlaceRepairPlan = {
  canonicalIdByPlaceId: Map<string, string>;
  obsoletePlaceIds: string[];
};

/**
 * Trim, collapse internal whitespace, and lowercase for repair name comparison.
 */
export function normalizePlaceNameForRepair(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function basePlaceNameForRepair(normalizedName: string): string {
  return normalizedName.replace(TRAILING_INTEGER_SUFFIX, '');
}

/**
 * Names match when normalized strings are equal, or when a trailing ` <integer>`
 * suffix is a migration alias because a base-name sibling exists in the neighborhood.
 */
export function placeNamesMatchForRepair(
  a: Pick<Place, 'name'>,
  b: Pick<Place, 'name'>,
  neighborhood: readonly Pick<Place, 'name'>[],
): boolean {
  const normalizedA = normalizePlaceNameForRepair(a.name);
  const normalizedB = normalizePlaceNameForRepair(b.name);
  if (normalizedA === normalizedB) {
    return true;
  }
  const baseName = basePlaceNameForRepair(normalizedA);
  if (baseName.length === 0 || baseName !== basePlaceNameForRepair(normalizedB)) {
    return false;
  }
  return neighborhood.some((place) => normalizePlaceNameForRepair(place.name) === baseName);
}

export function selectCanonicalPlace(cluster: readonly Place[]): Place {
  const ranked = [...cluster].sort(compareCanonicalPlace);
  const canonical = ranked[0];
  if (!canonical) {
    throw new Error('A repair cluster must contain at least one Place.');
  }
  return canonical;
}

export function planPlaceDuplicateRepair(places: readonly Place[]): PlaceRepairPlan {
  const canonicalIdByPlaceId = new Map<string, string>();
  const obsoletePlaceIds: string[] = [];
  for (const cluster of clusterPlacesForRepair(places)) {
    const canonical = selectCanonicalPlace(cluster);
    for (const place of cluster) {
      canonicalIdByPlaceId.set(place.id, canonical.id);
      if (place.id !== canonical.id) {
        obsoletePlaceIds.push(place.id);
      }
    }
  }
  obsoletePlaceIds.sort((left, right) => left.localeCompare(right));
  return { canonicalIdByPlaceId, obsoletePlaceIds };
}

export function rewriteRepairedPlaceId(
  placeId: string | null,
  plan: PlaceRepairPlan,
): string | null {
  if (placeId == null) {
    return null;
  }
  return plan.canonicalIdByPlaceId.get(placeId) ?? placeId;
}

export function clusterPlacesForRepair(places: readonly Place[]): Place[][] {
  const clusters: Place[][] = places.map((place) => [place]);
  while (true) {
    const merge = chooseNextRepairMerge(clusters);
    if (!merge) {
      break;
    }
    const left = clusters[merge.leftIndex];
    const right = clusters[merge.rightIndex];
    if (!left || !right) {
      break;
    }
    const merged = [...left, ...right];
    clusters.splice(merge.rightIndex, 1);
    clusters.splice(merge.leftIndex, 1);
    clusters.push(merged);
  }
  return clusters;
}

function compareCanonicalPlace(a: Place, b: Place): number {
  const aActive = a.status === 'active' ? 0 : 1;
  const bActive = b.status === 'active' ? 0 : 1;
  if (aActive !== bActive) {
    return aActive - bActive;
  }
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.id.localeCompare(b.id);
}

function chooseNextRepairMerge(
  clusters: Place[][],
): { leftIndex: number; rightIndex: number } | null {
  let best: {
    leftIndex: number;
    rightIndex: number;
    distance: number;
    createdAtMs: number;
    idKey: string;
  } | null = null;

  for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
    const left = clusters[leftIndex];
    if (!left) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
      const right = clusters[rightIndex];
      if (!right || !repairClustersCanMerge(left, right)) {
        continue;
      }
      const union = [...left, ...right];
      const candidate = {
        leftIndex,
        rightIndex,
        distance: completeLinkageDistanceMeters(left, right),
        createdAtMs: Math.min(...union.map((place) => place.createdAtMs)),
        idKey: union
          .map((place) => place.id)
          .sort()
          .join('|'),
      };
      if (isBetterRepairMerge(candidate, best)) {
        best = candidate;
      }
    }
  }

  return best ? { leftIndex: best.leftIndex, rightIndex: best.rightIndex } : null;
}

function isBetterRepairMerge(
  candidate: { distance: number; createdAtMs: number; idKey: string },
  current: { distance: number; createdAtMs: number; idKey: string } | null,
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.distance !== current.distance) {
    return candidate.distance < current.distance;
  }
  if (candidate.createdAtMs !== current.createdAtMs) {
    return candidate.createdAtMs < current.createdAtMs;
  }
  return candidate.idKey < current.idKey;
}

function repairClustersCanMerge(left: Place[], right: Place[]): boolean {
  const union = [...left, ...right];
  for (let index = 0; index < union.length; index += 1) {
    const place = union[index];
    if (!place) {
      continue;
    }
    for (let otherIndex = index + 1; otherIndex < union.length; otherIndex += 1) {
      const other = union[otherIndex];
      if (!other) {
        continue;
      }
      if (haversineMeters(place.center, other.center) > PLACE_REPAIR_DISTANCE_METERS) {
        return false;
      }
      if (!placeNamesMatchForRepair(place, other, union)) {
        return false;
      }
    }
  }
  return true;
}

function completeLinkageDistanceMeters(left: Place[], right: Place[]): number {
  let maxDistance = 0;
  for (const a of left) {
    for (const b of right) {
      maxDistance = Math.max(maxDistance, haversineMeters(a.center, b.center));
    }
  }
  return maxDistance;
}
