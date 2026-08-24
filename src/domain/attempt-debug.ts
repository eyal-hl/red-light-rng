import { incompleteAttemptLabel, type Attempt, type IncompleteAttemptLabel } from './attempt';
import {
  DEPARTURE_MIN_ADVANCE_METERS,
  DEPARTURE_MIN_SAMPLES,
  DEPARTURE_WINDOW_MS,
  finishTriggerProgressMeters,
  inspectDeparture,
  progressIsInStartZone,
  qualifyingDepartureWasFound,
  replayAttemptTrace,
  startLineHasPreStartRegion,
  type AttemptEngineState,
  type TimingCourse,
} from './attempt-timing';
import {
  createCourseMatchState,
  matchSampleToCourse,
  type CourseMatchQuality,
  type CourseMatchResult,
} from './course-matching';
import { haversineMeters, pointInZone, type LatLng } from './geo';
import type { LocationSample } from './location-sample';

export type AttemptDebugSample = {
  sample: LocationSample;
  match: CourseMatchResult;
  inStartZone: boolean;
  inFinishZone: boolean;
};

export type AttemptDebugReport = {
  rawSampleCount: number;
  acceptedCount: number;
  rejectedByQuality: Record<Exclude<CourseMatchQuality, 'accepted'>, number>;
  firstRecordedAtMs: number | null;
  lastRecordedAtMs: number | null;
  acceptedProgressMinMeters: number | null;
  acceptedProgressMaxMeters: number | null;
  anyAcceptedInStartZone: boolean;
  sawPreStart: boolean;
  preStartRequired: boolean;
  qualifyingDepartureFound: boolean;
  departure: {
    windowMs: number;
    minSamples: number;
    minAdvanceMeters: number;
    windowSampleCount: number;
    advanceMeters: number | null;
  };
  reconstructedStartAtMs: number | null;
  finishTriggerReachedAfterStart: boolean;
  finishTriggerProgressMeters: number;
  engine: AttemptEngineState;
  samples: AttemptDebugSample[];
  recordedPath: LatLng[];
  officialStartPoint: LatLng | null;
  officialFinishPoint: LatLng | null;
  incompleteLabel: IncompleteAttemptLabel | null;
};

function emptyRejectedCounts(): Record<Exclude<CourseMatchQuality, 'accepted'>, number> {
  return {
    poor_accuracy: 0,
    off_course: 0,
    out_of_window: 0,
    unprojected: 0,
  };
}

function samplePoint(sample: LocationSample): LatLng {
  return { latitude: sample.latitude, longitude: sample.longitude };
}

function pointNearestTime(samples: AttemptDebugSample[], atMs: number | null): LatLng | null {
  if (atMs == null || samples.length === 0) {
    return null;
  }
  let nearest: AttemptDebugSample | null = null;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const entry of samples) {
    const delta = Math.abs(entry.sample.recordedAtMs - atMs);
    if (delta < nearestDelta) {
      nearest = entry;
      nearestDelta = delta;
    }
  }
  return nearest ? samplePoint(nearest.sample) : null;
}

export function inspectAttempt(course: TimingCourse, samples: LocationSample[]): AttemptDebugReport {
  let matchState = createCourseMatchState();
  const inspected: AttemptDebugSample[] = [];
  const rejectedByQuality = emptyRejectedCounts();
  let acceptedCount = 0;
  let acceptedProgressMinMeters: number | null = null;
  let acceptedProgressMaxMeters: number | null = null;
  let anyAcceptedInStartZone = false;

  for (const sample of samples) {
    const match = matchSampleToCourse(
      course.referencePath,
      sample,
      matchState,
      course.startProgressMeters,
    );
    if (match.accepted) {
      matchState = match.state;
      acceptedCount += 1;
      if (match.progressMeters != null) {
        acceptedProgressMinMeters =
          acceptedProgressMinMeters == null
            ? match.progressMeters
            : Math.min(acceptedProgressMinMeters, match.progressMeters);
        acceptedProgressMaxMeters =
          acceptedProgressMaxMeters == null
            ? match.progressMeters
            : Math.max(acceptedProgressMaxMeters, match.progressMeters);
        if (progressIsInStartZone(match.progressMeters, course)) {
          anyAcceptedInStartZone = true;
        }
      }
    } else if (match.quality !== 'accepted') {
      rejectedByQuality[match.quality] += 1;
    }

    const inStartZone =
      match.accepted && match.progressMeters != null
        ? progressIsInStartZone(match.progressMeters, course)
        : pointInZone(samplePoint(sample), course.startZone);
    const inFinishZone = pointInZone(samplePoint(sample), course.finishZone);
    inspected.push({ sample, match, inStartZone, inFinishZone });
  }

  const engine = replayAttemptTrace(course, samples);
  const departure = inspectDeparture(engine.accepted, course.startProgressMeters);
  const finishTrigger = finishTriggerProgressMeters(course);
  const finishTriggerReachedAfterStart =
    engine.startedAtMs != null &&
    engine.accepted.some(
      (sample) =>
        engine.startedAtMs != null &&
        sample.recordedAtMs >= engine.startedAtMs &&
        sample.progressMeters >= finishTrigger,
    );

  return {
    rawSampleCount: samples.length,
    acceptedCount,
    rejectedByQuality,
    firstRecordedAtMs: samples[0]?.recordedAtMs ?? null,
    lastRecordedAtMs: samples[samples.length - 1]?.recordedAtMs ?? null,
    acceptedProgressMinMeters,
    acceptedProgressMaxMeters,
    anyAcceptedInStartZone,
    sawPreStart: engine.sawPreStart,
    preStartRequired: startLineHasPreStartRegion(course.startProgressMeters),
    qualifyingDepartureFound: qualifyingDepartureWasFound(
      engine.accepted,
      course.startProgressMeters,
    ),
    departure: {
      windowMs: DEPARTURE_WINDOW_MS,
      minSamples: DEPARTURE_MIN_SAMPLES,
      minAdvanceMeters: DEPARTURE_MIN_ADVANCE_METERS,
      windowSampleCount: departure.windowSampleCount,
      advanceMeters: departure.advanceMeters,
    },
    reconstructedStartAtMs: engine.startedAtMs,
    finishTriggerReachedAfterStart,
    finishTriggerProgressMeters: finishTrigger,
    engine,
    samples: inspected,
    recordedPath: samples.map(samplePoint),
    officialStartPoint: pointNearestTime(inspected, engine.startedAtMs),
    officialFinishPoint: pointNearestTime(inspected, engine.finishedAtMs),
    incompleteLabel: null,
  };
}

export function inspectAttemptRecord(
  attempt: Pick<Attempt, 'lifecycle' | 'startedAtMs'>,
  course: TimingCourse,
  samples: LocationSample[],
): AttemptDebugReport {
  return {
    ...inspectAttempt(course, samples),
    incompleteLabel: incompleteAttemptLabel(attempt),
  };
}

export function nearestDebugSample(
  samples: AttemptDebugSample[],
  point: LatLng,
  maxMeters = 40,
): AttemptDebugSample | null {
  let nearest: AttemptDebugSample | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const entry of samples) {
    const distance = haversineMeters(samplePoint(entry.sample), point);
    if (distance < nearestDistance) {
      nearest = entry;
      nearestDistance = distance;
    }
  }
  return nearest && nearestDistance <= maxMeters ? nearest : null;
}
