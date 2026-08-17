import { orderedCheckpoints, type RouteCheckpoint } from './course-layout';
import type { AttemptLifecycle, AttemptValidity } from './attempt';
import { createCourseMatchState, matchSampleToCourse, type CourseMatchState } from './course-matching';
import type { GeoZone, LatLng } from './geo';
import type { LocationSample } from './location-sample';

export const DEPARTURE_MIN_ADVANCE_METERS = 18;
export const DEPARTURE_WINDOW_MS = 5_000;
export const DEPARTURE_MIN_SAMPLES = 4;
export const START_PROGRESS_NOISE_METERS = 5;
export const START_PRE_START_MARGIN_METERS = 3;
export const START_RETURN_HYSTERESIS_METERS = 4;
export const FINISH_PROGRESS_TOLERANCE_METERS = 15;
export const ABANDON_OFF_COURSE_MS = 60_000;
export const MATERIAL_DEVIATION_MS = 25_000;

export type TimingCourse = {
  referencePath: LatLng[];
  startProgressMeters: number;
  finishProgressMeters: number;
  finishZone: GeoZone;
  checkpoints: RouteCheckpoint[];
};

export type AcceptedProgressSample = {
  recordedAtMs: number;
  progressMeters: number;
};

export type DerivedCrossing = {
  checkpointId: string;
  checkpointName: string;
  checkpointProgressMeters: number;
  crossedAtMs: number;
};

export type AttemptEngineState = {
  lifecycle: AttemptLifecycle;
  validity: AttemptValidity;
  match: CourseMatchState;
  accepted: AcceptedProgressSample[];
  sawPreStart: boolean;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  crossings: DerivedCrossing[];
  offCourseSinceMs: number | null;
  cumulativeOffCourseMs: number;
  lastSampleAtMs: number | null;
};

export function createAttemptEngineState(): AttemptEngineState {
  return {
    lifecycle: 'armed',
    validity: 'pending',
    match: createCourseMatchState(),
    accepted: [],
    sawPreStart: false,
    startedAtMs: null,
    finishedAtMs: null,
    crossings: [],
    offCourseSinceMs: null,
    cumulativeOffCourseMs: 0,
    lastSampleAtMs: null,
  };
}

export function startLineHasPreStartRegion(startProgressMeters: number): boolean {
  return startProgressMeters > START_PROGRESS_NOISE_METERS;
}

export function finishTriggerProgressMeters(course: TimingCourse): number {
  const tolerance = Math.max(
    FINISH_PROGRESS_TOLERANCE_METERS,
    Math.min(course.finishZone.radiusMeters, FINISH_PROGRESS_TOLERANCE_METERS * 2),
  );
  return Math.max(course.startProgressMeters, course.finishProgressMeters - tolerance);
}

export function interpolateCrossingTime(
  previous: AcceptedProgressSample,
  current: AcceptedProgressSample,
  lineProgressMeters: number,
): number {
  const span = current.progressMeters - previous.progressMeters;
  if (span === 0) {
    return current.recordedAtMs;
  }
  const t = (lineProgressMeters - previous.progressMeters) / span;
  const clamped = Math.min(1, Math.max(0, t));
  return previous.recordedAtMs + clamped * (current.recordedAtMs - previous.recordedAtMs);
}

export function ingestAttemptSample(
  state: AttemptEngineState,
  course: TimingCourse,
  sample: LocationSample,
): AttemptEngineState {
  if (state.lifecycle !== 'armed' && state.lifecycle !== 'active') {
    return state;
  }

  const match = matchSampleToCourse(
    course.referencePath,
    sample,
    state.match,
    course.startProgressMeters,
  );
  const next: AttemptEngineState = {
    ...state,
    match: match.accepted ? match.state : state.match,
    lastSampleAtMs: sample.recordedAtMs,
    crossings: [...state.crossings],
    accepted: [...state.accepted],
  };

  if (!match.accepted) {
    return applyOffCourse(
      next,
      state.lastSampleAtMs,
      sample.recordedAtMs,
      match.quality === 'off_course' || match.quality === 'out_of_window',
    );
  }

  next.offCourseSinceMs = null;
  next.accepted.push({
    recordedAtMs: sample.recordedAtMs,
    progressMeters: match.progressMeters ?? 0,
  });

  if (
    startLineHasPreStartRegion(course.startProgressMeters) &&
    (match.progressMeters ?? 0) < course.startProgressMeters - START_PRE_START_MARGIN_METERS
  ) {
    next.sawPreStart = true;
  }

  if (next.lifecycle === 'armed') {
    return maybePromoteFromArmed(next, course);
  }

  detectCheckpointCrossings(next, course);
  return maybeFinishOrAbandon(next, course);
}

export function replayAttemptTrace(course: TimingCourse, samples: LocationSample[]): AttemptEngineState {
  return samples.reduce(
    (state, sample) => ingestAttemptSample(state, course, sample),
    createAttemptEngineState(),
  );
}

function applyOffCourse(
  state: AttemptEngineState,
  previousSampleAtMs: number | null,
  recordedAtMs: number,
  countsAsOffCourse: boolean,
): AttemptEngineState {
  if (!countsAsOffCourse || state.lifecycle !== 'active') {
    return state;
  }

  const next = { ...state };
  if (next.offCourseSinceMs == null) {
    next.offCourseSinceMs = recordedAtMs;
  }
  if (previousSampleAtMs != null) {
    next.cumulativeOffCourseMs += Math.max(0, recordedAtMs - previousSampleAtMs);
  }

  if (recordedAtMs - next.offCourseSinceMs >= ABANDON_OFF_COURSE_MS) {
    next.lifecycle = 'abandoned';
    next.validity = 'unranked';
  } else if (next.cumulativeOffCourseMs >= MATERIAL_DEVIATION_MS) {
    next.validity = 'unranked';
  }
  return next;
}

function maybePromoteFromArmed(state: AttemptEngineState, course: TimingCourse): AttemptEngineState {
  const departure = detectQualifyingDeparture(state.accepted, course.startProgressMeters);
  if (!departure) {
    return state;
  }
  if (startLineHasPreStartRegion(course.startProgressMeters) && !state.sawPreStart) {
    return state;
  }

  const startedAtMs = reconstructStartedAt(state.accepted, course.startProgressMeters, departure);
  const next: AttemptEngineState = {
    ...state,
    lifecycle: 'active',
    startedAtMs,
  };
  detectCheckpointCrossings(next, course);
  return maybeFinishOrAbandon(next, course);
}

function detectQualifyingDeparture(
  accepted: AcceptedProgressSample[],
  startProgressMeters: number,
): AcceptedProgressSample[] | null {
  const latest = accepted[accepted.length - 1];
  if (!latest) {
    return null;
  }
  const window = accepted.filter((sample) => sample.recordedAtMs >= latest.recordedAtMs - DEPARTURE_WINDOW_MS);
  const first = window[0];
  if (!first || window.length < DEPARTURE_MIN_SAMPLES) {
    return null;
  }
  const advance = latest.progressMeters - first.progressMeters;
  if (advance < DEPARTURE_MIN_ADVANCE_METERS) {
    return null;
  }
  if (latest.progressMeters + START_PROGRESS_NOISE_METERS < startProgressMeters) {
    return null;
  }
  return window;
}

function reconstructStartedAt(
  accepted: AcceptedProgressSample[],
  startProgressMeters: number,
  departureWindow: AcceptedProgressSample[],
): number {
  if (!startLineHasPreStartRegion(startProgressMeters)) {
    return reconstructDepartureAnchoredStart(departureWindow);
  }

  const hysteresis = startProgressMeters - START_RETURN_HYSTERESIS_METERS;
  let latestCrossingAt: number | null = null;
  for (let index = 1; index < accepted.length; index += 1) {
    const previous = accepted[index - 1];
    const current = accepted[index];
    if (!previous || !current) {
      continue;
    }
    if (previous.progressMeters < startProgressMeters && current.progressMeters >= startProgressMeters) {
      latestCrossingAt = interpolateCrossingTime(previous, current, startProgressMeters);
    }
    if (latestCrossingAt != null && current.progressMeters < hysteresis) {
      latestCrossingAt = null;
    }
  }

  if (latestCrossingAt != null) {
    return latestCrossingAt;
  }
  return reconstructDepartureAnchoredStart(departureWindow);
}

function reconstructDepartureAnchoredStart(window: AcceptedProgressSample[]): number {
  const first = window[0];
  if (!first) {
    return 0;
  }
  const band = START_PROGRESS_NOISE_METERS;
  let lastAtStartIndex = -1;
  for (let index = 0; index < window.length; index += 1) {
    const sample = window[index];
    if (sample && sample.progressMeters <= band) {
      lastAtStartIndex = index;
    }
  }
  const next = window[lastAtStartIndex + 1];
  const atStart = window[lastAtStartIndex];
  if (lastAtStartIndex >= 0 && atStart && next) {
    return interpolateCrossingTime(atStart, next, Math.min(band, next.progressMeters));
  }
  return first.recordedAtMs;
}

function detectCheckpointCrossings(state: AttemptEngineState, course: TimingCourse): void {
  if (state.startedAtMs == null) {
    return;
  }
  const previous = state.accepted[state.accepted.length - 2];
  const current = state.accepted[state.accepted.length - 1];
  if (!previous || !current) {
    return;
  }

  for (const checkpoint of orderedCheckpoints(course.checkpoints)) {
    if (checkpoint.progressMeters <= course.startProgressMeters) {
      continue;
    }
    if (checkpoint.progressMeters >= course.finishProgressMeters) {
      continue;
    }
    if (state.crossings.some((crossing) => crossing.checkpointId === checkpoint.id)) {
      continue;
    }
    if (previous.progressMeters < checkpoint.progressMeters && current.progressMeters >= checkpoint.progressMeters) {
      state.crossings.push({
        checkpointId: checkpoint.id,
        checkpointName: checkpoint.name,
        checkpointProgressMeters: checkpoint.progressMeters,
        crossedAtMs: interpolateCrossingTime(previous, current, checkpoint.progressMeters),
      });
    }
  }
}

function maybeFinishOrAbandon(state: AttemptEngineState, course: TimingCourse): AttemptEngineState {
  if (state.lifecycle !== 'active' || state.startedAtMs == null) {
    return state;
  }

  const current = state.accepted[state.accepted.length - 1];
  if (!current) {
    return state;
  }

  const trigger = finishTriggerProgressMeters(course);
  if (current.progressMeters >= trigger) {
    const finishedAtMs = reconstructFinishedAt(state.accepted, course, trigger);
    if (finishedAtMs >= state.startedAtMs) {
      return {
        ...state,
        lifecycle: 'completed',
        finishedAtMs,
        validity: state.cumulativeOffCourseMs >= MATERIAL_DEVIATION_MS ? 'unranked' : 'valid',
      };
    }
  }

  if (state.offCourseSinceMs != null && current.recordedAtMs - state.offCourseSinceMs >= ABANDON_OFF_COURSE_MS) {
    return {
      ...state,
      lifecycle: 'abandoned',
      validity: 'unranked',
    };
  }

  return state;
}

function reconstructFinishedAt(
  accepted: AcceptedProgressSample[],
  course: TimingCourse,
  triggerProgressMeters: number,
): number {
  const finishLine = course.finishProgressMeters;
  let triggerTime: number | null = null;
  let finishTime: number | null = null;
  for (let index = 1; index < accepted.length; index += 1) {
    const previous = accepted[index - 1];
    const current = accepted[index];
    if (!previous || !current) {
      continue;
    }
    if (triggerTime == null && previous.progressMeters < triggerProgressMeters && current.progressMeters >= triggerProgressMeters) {
      triggerTime = interpolateCrossingTime(previous, current, triggerProgressMeters);
    }
    if (previous.progressMeters < finishLine && current.progressMeters >= finishLine) {
      finishTime = interpolateCrossingTime(previous, current, finishLine);
    }
  }
  return finishTime ?? triggerTime ?? accepted[accepted.length - 1]?.recordedAtMs ?? 0;
}
