import type { LocationSample } from './location-sample';
import { projectOntoReferencePathNearProgress } from './path-projection';
import type { LatLng } from './geo';

export const CORRIDOR_WIDTH_METERS = 35;
export const MAX_SAMPLE_ACCURACY_METERS = 45;
export const MATCH_FORWARD_WINDOW_METERS = 90;
export const MATCH_BACKWARD_WINDOW_METERS = 25;
export const INITIAL_ANCHOR_FORWARD_METERS = 70;
export const INITIAL_ANCHOR_BACKWARD_METERS = 50;

export type CourseMatchState = {
  lastAcceptedProgressMeters: number | null;
  lastAcceptedAtMs: number | null;
};

export type CourseMatchQuality =
  | 'accepted'
  | 'poor_accuracy'
  | 'off_course'
  | 'out_of_window'
  | 'unprojected';

export type CourseMatchResult = {
  state: CourseMatchState;
  accepted: boolean;
  progressMeters: number | null;
  distanceFromPathMeters: number | null;
  advancing: boolean;
  quality: CourseMatchQuality;
};

export function createCourseMatchState(): CourseMatchState {
  return {
    lastAcceptedProgressMeters: null,
    lastAcceptedAtMs: null,
  };
}

export function matchSampleToCourse(
  path: LatLng[],
  sample: LocationSample,
  state: CourseMatchState,
  startProgressMeters: number,
): CourseMatchResult {
  if (
    sample.horizontalAccuracyMeters != null &&
    sample.horizontalAccuracyMeters > MAX_SAMPLE_ACCURACY_METERS
  ) {
    return {
      state,
      accepted: false,
      progressMeters: null,
      distanceFromPathMeters: null,
      advancing: false,
      quality: 'poor_accuracy',
    };
  }

  const centerProgressMeters = state.lastAcceptedProgressMeters ?? startProgressMeters;
  const projection = projectOntoReferencePathNearProgress(path, sample, {
    centerProgressMeters,
    forwardWindowMeters:
      state.lastAcceptedProgressMeters != null ? MATCH_FORWARD_WINDOW_METERS : INITIAL_ANCHOR_FORWARD_METERS,
    backwardWindowMeters:
      state.lastAcceptedProgressMeters != null ? MATCH_BACKWARD_WINDOW_METERS : INITIAL_ANCHOR_BACKWARD_METERS,
  });

  if (!projection) {
    return {
      state,
      accepted: false,
      progressMeters: null,
      distanceFromPathMeters: null,
      advancing: false,
      quality: 'out_of_window',
    };
  }

  if (projection.snapDistanceMeters > CORRIDOR_WIDTH_METERS) {
    return {
      state,
      accepted: false,
      progressMeters: projection.progressMeters,
      distanceFromPathMeters: projection.snapDistanceMeters,
      advancing: false,
      quality: 'off_course',
    };
  }

  const advancing =
    state.lastAcceptedProgressMeters == null ||
    projection.progressMeters >= state.lastAcceptedProgressMeters - MATCH_BACKWARD_WINDOW_METERS;

  return {
    state: {
      lastAcceptedProgressMeters: projection.progressMeters,
      lastAcceptedAtMs: sample.recordedAtMs,
    },
    accepted: true,
    progressMeters: projection.progressMeters,
    distanceFromPathMeters: projection.snapDistanceMeters,
    advancing,
    quality: 'accepted',
  };
}
