import type { LatLng } from '../domain/geo';
import type { Route } from '../domain/route';

export const PATH_VARIANT_COLORS = [
  '#4fc3f7',
  '#ffb74d',
  '#ce93d8',
  '#80cbc4',
  '#ef9a9a',
  '#aed581',
  '#90caf9',
  '#ffcc80',
] as const;

export const FALLBACK_MAX_PATH_VERTICES = 96;

export type PathVariantDisplayStyle = {
  color: string;
};

export type PathVariantMapLine = {
  id: string;
  name: string;
  path: LatLng[];
  color: string;
};

export function isRenderableReferencePath(path: LatLng[] | null | undefined): boolean {
  if (!path || path.length < 2) {
    return false;
  }
  let valid = 0;
  for (const point of path) {
    if (point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) {
      valid += 1;
      if (valid >= 2) {
        return true;
      }
    }
  }
  return false;
}

export function sanitizeReferencePath(path: LatLng[]): LatLng[] {
  return path.filter(
    (point) => point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude),
  );
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function preferredColorIndex(routeId: string): number {
  return hashString(routeId) % PATH_VARIANT_COLORS.length;
}

function compareRouteIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function pathVariantDisplayStyles(
  routeIds: readonly string[],
): ReadonlyMap<string, PathVariantDisplayStyle> {
  const unique = [...new Set(routeIds)].sort(compareRouteIds);
  const assignedIndex = new Map<string, number>();
  const used = new Set<number>();

  for (const routeId of unique) {
    const preferred = preferredColorIndex(routeId);
    if (!used.has(preferred)) {
      used.add(preferred);
      assignedIndex.set(routeId, preferred);
    }
  }

  for (const routeId of unique) {
    if (assignedIndex.has(routeId)) {
      continue;
    }
    if (used.size >= PATH_VARIANT_COLORS.length) {
      assignedIndex.set(routeId, preferredColorIndex(routeId));
      continue;
    }
    let index = preferredColorIndex(routeId);
    for (let step = 0; step < PATH_VARIANT_COLORS.length; step += 1) {
      const candidate = (index + step) % PATH_VARIANT_COLORS.length;
      if (!used.has(candidate)) {
        index = candidate;
        break;
      }
    }
    used.add(index);
    assignedIndex.set(routeId, index);
  }

  const styles = new Map<string, PathVariantDisplayStyle>();
  for (const routeId of unique) {
    styles.set(routeId, { color: PATH_VARIANT_COLORS[assignedIndex.get(routeId)!]! });
  }
  return styles;
}

export function pathVariantDisplayStyle(
  routeId: string,
  siblingRouteIds: readonly string[] = [routeId],
): PathVariantDisplayStyle {
  const ids = siblingRouteIds.includes(routeId) ? siblingRouteIds : [routeId, ...siblingRouteIds];
  return pathVariantDisplayStyles(ids).get(routeId)!;
}

export function pathVariantsToMapLines(
  variants: readonly { route: Pick<Route, 'id' | 'name' | 'referencePath'> }[],
): PathVariantMapLine[] {
  const styles = pathVariantDisplayStyles(variants.map((item) => item.route.id));
  const lines: PathVariantMapLine[] = [];
  for (const item of variants) {
    const path = sanitizeReferencePath(item.route.referencePath);
    if (path.length < 2) {
      continue;
    }
    const style = styles.get(item.route.id) ?? pathVariantDisplayStyle(item.route.id);
    lines.push({
      id: item.route.id,
      name: item.route.name,
      path,
      color: style.color,
    });
  }
  return lines;
}

export function subsamplePath(path: LatLng[], maxPoints: number): LatLng[] {
  if (maxPoints < 2 || path.length <= maxPoints) {
    return path;
  }
  const sampled: LatLng[] = [];
  const lastIndex = path.length - 1;
  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round((index / (maxPoints - 1)) * lastIndex);
    sampled.push(path[sourceIndex]!);
  }
  return sampled;
}

export function boundFallbackPathVertices(
  paths: readonly LatLng[][],
  maxTotalVertices: number = FALLBACK_MAX_PATH_VERTICES,
): LatLng[][] {
  const renderable = paths.map((path) => (path.length >= 2 ? path : []));
  const counts = renderable.filter((path) => path.length >= 2).length;
  if (counts === 0) {
    return renderable;
  }
  const total = renderable.reduce((sum, path) => sum + path.length, 0);
  if (total <= maxTotalVertices) {
    return renderable;
  }
  const budget = Math.max(2, Math.floor(maxTotalVertices / counts));
  return renderable.map((path) => (path.length >= 2 ? subsamplePath(path, budget) : path));
}

export function pathVariantCameraPoints(lines: readonly PathVariantMapLine[]): { point: LatLng }[] {
  const points: { point: LatLng }[] = [];
  for (const line of lines) {
    for (const point of line.path) {
      points.push({ point });
    }
  }
  return points;
}
