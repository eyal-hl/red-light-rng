import {
  createCourseMatchState,
  matchSampleToCourse,
} from './course-matching';
import { haversineMeters } from './geo';
import type { LocationSample } from './location-sample';
import type { Place } from './place';
import type { Route, TransportationMode } from './route';
import type { TimingCourse } from './attempt-timing';

export const PATH_VARIANT_ACCEPT_RATIO = 0.5;
export const PATH_VARIANT_PROGRESS_COVERAGE_RATIO = 0.5;

export function routeEndpointsMatchJourney(
  route: Pick<Route, 'startZone' | 'finishZone' | 'transportationMode'>,
  origin: Pick<Place, 'center' | 'radiusMeters'>,
  destination: Pick<Place, 'center' | 'radiusMeters'>,
  transportationMode: TransportationMode,
): boolean {
  if (route.transportationMode !== transportationMode) {
    return false;
  }
  const startDistance = haversineMeters(route.startZone.center, origin.center);
  const finishDistance = haversineMeters(route.finishZone.center, destination.center);
  return (
    startDistance <= origin.radiusMeters + route.startZone.radiusMeters &&
    finishDistance <= destination.radiusMeters + route.finishZone.radiusMeters
  );
}

function courseFromRoute(route: Route): TimingCourse {
  return {
    referencePath: route.referencePath,
    startProgressMeters: route.startProgressMeters,
    finishProgressMeters: route.finishProgressMeters,
    startZone: route.startZone,
    finishZone: route.finishZone,
    checkpoints: route.checkpoints,
  };
}

export function isCompatiblePathVariant(
  route: Route,
  samples: LocationSample[],
  window: { startedAtMs: number; finishedAtMs: number },
): boolean {
  const course = courseFromRoute(route);
  const inWindow = samples.filter(
    (sample) => sample.recordedAtMs >= window.startedAtMs && sample.recordedAtMs <= window.finishedAtMs,
  );
  let state = createCourseMatchState();
  let considered = 0;
  let accepted = 0;
  let minProgress = Number.POSITIVE_INFINITY;
  let maxProgress = Number.NEGATIVE_INFINITY;
  for (const sample of inWindow) {
    const match = matchSampleToCourse(
      course.referencePath,
      sample,
      state,
      course.startProgressMeters,
    );
    if (match.quality === 'poor_accuracy') {
      continue;
    }
    considered += 1;
    if (match.accepted) {
      accepted += 1;
      state = match.state;
      if (match.progressMeters != null) {
        minProgress = Math.min(minProgress, match.progressMeters);
        maxProgress = Math.max(maxProgress, match.progressMeters);
      }
    }
  }
  if (considered === 0 || accepted / considered < PATH_VARIANT_ACCEPT_RATIO) {
    return false;
  }
  const courseLength = Math.max(1, course.finishProgressMeters - course.startProgressMeters);
  return maxProgress - minProgress >= PATH_VARIANT_PROGRESS_COVERAGE_RATIO * courseLength;
}

export function findCompatiblePathVariant(
  routes: Route[],
  origin: Place,
  destination: Place,
  transportationMode: TransportationMode,
  samples: LocationSample[],
  window: { startedAtMs: number; finishedAtMs: number },
): Route | null {
  const candidates = routes
    .filter((route) => routeEndpointsMatchJourney(route, origin, destination, transportationMode))
    .sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) {
        return a.createdAtMs - b.createdAtMs;
      }
      return a.id.localeCompare(b.id);
    });
  for (const route of candidates) {
    if (isCompatiblePathVariant(route, samples, window)) {
      return route;
    }
  }
  return null;
}
