import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  analyzeFocusAttempt,
  deriveCurrentLayoutAttempt,
  timingCourseFromRoute,
  type AttemptTrace,
} from '../src/domain/attempt-analysis';
import type { Attempt } from '../src/domain/attempt';
import type { TimingCourse } from '../src/domain/attempt-timing';
import { haversineMeters, pathDistanceMeters } from '../src/domain/geo';
import type { LocationSample } from '../src/domain/location-sample';
import {
  analyzeAttemptMovementTimeline,
  type ClassifiedMovementInterval,
  type MovementFix,
} from '../src/domain/movement-analysis';
import { pointAtProgress } from '../src/domain/path-projection';
import {
  displayedWaitDurationSumMs,
  deriveWaitEvents,
  formatWaitEventDuration,
  formatWaitEventLocation,
  MIN_USER_VISIBLE_WAIT_MS,
  WAIT_EVENT_MERGE_MAX_GAP_MS,
  WAIT_EVENT_MERGE_MAX_PROGRESS_METERS,
  waitEventIdNearPoint,
  type WaitEvent,
} from '../src/domain/wait-events';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample, traceAlongPath } from './helpers/samples';

function longPath() {
  return northPath({ points: 41, stepMeters: 20 });
}

function courseFromPath(path = longPath(), overrides: Partial<TimingCourse> = {}): TimingCourse {
  return timingCourseFromRoute(
    makeRoute({
      referencePath: path,
      checkpoints: overrides.checkpoints ?? [],
      ...overrides,
    }),
  );
}

function makeAttempt(overrides: Partial<Attempt> & Pick<Attempt, 'id' | 'sessionId'>): Attempt {
  return {
    routeId: 'route-1',
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 5_000,
    finishedAtMs: 200_000,
    resultAcknowledged: true,
    crossings: [],
    ...overrides,
  };
}

function alongPath(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    startProgressMeters?: number;
    stepMeters?: number;
    intervalMs?: number;
    count: number;
    speedMetersPerSecond?: number | null;
    horizontalAccuracyMeters?: number | null;
  },
): LocationSample[] {
  return traceAlongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    startProgressMeters: options.startProgressMeters ?? 0,
    stepMeters: options.stepMeters ?? 4,
    intervalMs: options.intervalMs ?? 1000,
    count: options.count,
  }).map((item, index) =>
    sample({
      ...item,
      id: `${options.sessionId}-${index}`,
      speedMetersPerSecond:
        options.speedMetersPerSecond === undefined ? item.speedMetersPerSecond : options.speedMetersPerSecond,
      horizontalAccuracyMeters:
        options.horizontalAccuracyMeters === undefined
          ? item.horizontalAccuracyMeters
          : options.horizontalAccuracyMeters,
    }),
  );
}

function coveringTrace(
  path: { latitude: number; longitude: number }[],
  options: { sessionId: string; startMs: number; startProgressMeters?: number },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const startProgress = options.startProgressMeters ?? 0;
  const stepMeters = 5;
  const count = Math.ceil((length - startProgress) / stepMeters) + 12;
  return alongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    startProgressMeters: startProgress,
    stepMeters,
    intervalMs: 1000,
    count,
  });
}

function commuteWithBoundedWaits(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    waits: { progressMeters: number; durationMs: number; interior?: LocationSample[] }[];
  },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const stepMeters = 4;
  const intervalMs = 1000;
  const samples: LocationSample[] = [];
  let timeMs = options.startMs;
  let progress = 0;
  let waitIndex = 0;
  let id = 0;
  const remainingWaits = [...options.waits].sort((a, b) => a.progressMeters - b.progressMeters);

  while (progress <= length) {
    const point = pointAtProgress(path, Math.min(progress, length));
    samples.push(
      sample({
        id: `${options.sessionId}-${id}`,
        sessionId: options.sessionId,
        recordedAtMs: timeMs,
        latitude: point.latitude,
        longitude: point.longitude,
        speedMetersPerSecond: 4,
        horizontalAccuracyMeters: 6,
      }),
    );
    id += 1;
    const nextWait = remainingWaits[waitIndex];
    if (nextWait && progress + stepMeters > nextWait.progressMeters) {
      const stop = pointAtProgress(path, nextWait.progressMeters);
      if (nextWait.interior) {
        for (const interior of nextWait.interior) {
          samples.push(
            sample({
              ...interior,
              id: `${options.sessionId}-int-${id}`,
              sessionId: options.sessionId,
              recordedAtMs: timeMs + (interior.recordedAtMs || 0),
            }),
          );
          id += 1;
        }
      }
      timeMs += nextWait.durationMs;
      samples.push(
        sample({
          id: `${options.sessionId}-${id}`,
          sessionId: options.sessionId,
          recordedAtMs: timeMs,
          latitude: stop.latitude,
          longitude: stop.longitude,
          speedMetersPerSecond: 0,
          horizontalAccuracyMeters: 6,
        }),
      );
      id += 1;
      waitIndex += 1;
    }
    progress += stepMeters;
    timeMs += intervalMs;
  }
  return samples;
}

function windowOf(samples: LocationSample[]): { startedAtMs: number; finishedAtMs: number } {
  const first = samples[0];
  const last = samples[samples.length - 1];
  assert.ok(first && last);
  return { startedAtMs: first.recordedAtMs, finishedAtMs: last.recordedAtMs };
}

function eventsFromSamples(course: TimingCourse, samples: LocationSample[]): {
  events: WaitEvent[];
  waitingMs: number;
  intervals: ClassifiedMovementInterval[];
} {
  const bounds = windowOf(samples);
  const timeline = analyzeAttemptMovementTimeline({
    course,
    samples,
    startedAtMs: bounds.startedAtMs,
    finishedAtMs: bounds.finishedAtMs,
  });
  return {
    events: deriveWaitEvents({
      intervals: timeline.intervals,
      startedAtMs: bounds.startedAtMs,
      referencePath: course.referencePath,
    }),
    waitingMs: timeline.breakdown.waitingMs,
    intervals: timeline.intervals,
  };
}

function syntheticFix(
  path: { latitude: number; longitude: number }[],
  recordedAtMs: number,
  progressMeters: number | null,
  matched: boolean,
): MovementFix {
  const point = progressMeters == null ? path[0]! : pointAtProgress(path, progressMeters);
  return {
    recordedAtMs,
    latitude: point.latitude,
    longitude: point.longitude,
    horizontalAccuracyMeters: 6,
    speedMetersPerSecond: 0,
    progressMeters,
    matched,
  };
}

function waitingInterval(
  path: { latitude: number; longitude: number }[],
  startMs: number,
  endMs: number,
  progressMeters: number | null,
  matched = true,
): ClassifiedMovementInterval {
  const startFix = syntheticFix(path, startMs, progressMeters, matched && progressMeters != null);
  const endFix = syntheticFix(path, endMs, progressMeters, matched && progressMeters != null);
  return {
    label: 'waiting',
    startMs,
    endMs,
    durationMs: endMs - startMs,
    startFix,
    endFix,
  };
}

describe('wait events', () => {
  it('creates one event from a clean 30 s wait', () => {
    const course = courseFromPath();
    const samples = commuteWithBoundedWaits(course.referencePath, {
      sessionId: 'one',
      startMs: 5_000,
      waits: [{ progressMeters: 80, durationMs: 30_000 }],
    });
    const { events, waitingMs } = eventsFromSamples(course, samples);
    assert.equal(events.length, 1);
    assert.ok((events[0]?.durationMs ?? 0) >= 29_000);
    assert.equal(events[0]?.locationState, 'located');
    assert.ok(events[0]?.progressMeters != null);
    assert.ok(Math.abs((events[0]?.progressMeters ?? 0) - 80) < 8);
    assert.ok(displayedWaitDurationSumMs(events) <= waitingMs);
  });

  it('creates two events in route order for physically separate waits', () => {
    const course = courseFromPath();
    const samples = commuteWithBoundedWaits(course.referencePath, {
      sessionId: 'two',
      startMs: 5_000,
      waits: [
        { progressMeters: 80, durationMs: 20_000 },
        { progressMeters: 240, durationMs: 15_000 },
      ],
    });
    const { events } = eventsFromSamples(course, samples);
    assert.equal(events.length, 2);
    assert.ok((events[0]?.progressMeters ?? 0) < (events[1]?.progressMeters ?? 0));
    assert.ok((events[0]?.durationMs ?? 0) >= 19_000);
    assert.ok((events[1]?.durationMs ?? 0) >= 14_000);
  });

  it('merges fragmented waiting at the same location without absorbing unknown duration', () => {
    const path = longPath();
    const startedAtMs = 10_000;
    const first = waitingInterval(path, 10_000, 14_000, 80);
    const second = waitingInterval(path, 16_000, 20_000, 80);
    const events = deriveWaitEvents({
      intervals: [
        first,
        {
          label: 'unknown',
          startMs: 14_000,
          endMs: 16_000,
          durationMs: 2_000,
          startFix: first.endFix,
          endFix: second.startFix,
        },
        second,
      ],
      startedAtMs,
      referencePath: path,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.durationMs, 8_000);
    assert.notEqual(events[0]?.durationMs, 10_000);
  });

  it('keeps waits separated by more than 5 s as separate events', () => {
    const path = longPath();
    const gap = WAIT_EVENT_MERGE_MAX_GAP_MS + 1;
    const events = deriveWaitEvents({
      intervals: [
        waitingInterval(path, 10_000, 14_000, 80),
        waitingInterval(path, 14_000 + gap, 18_000 + gap, 80),
      ],
      startedAtMs: 10_000,
      referencePath: path,
    });
    assert.equal(events.length, 2);
  });

  it('keeps waits separated by <= 5 s but more than 15 m of route progress separate', () => {
    const path = longPath();
    const events = deriveWaitEvents({
      intervals: [
        waitingInterval(path, 10_000, 14_000, 80),
        waitingInterval(path, 16_000, 20_000, 80 + WAIT_EVENT_MERGE_MAX_PROGRESS_METERS + 5),
      ],
      startedAtMs: 10_000,
      referencePath: path,
    });
    assert.equal(events.length, 2);
  });

  it('does not create a marker or list item for a 2.9 s waiting fragment', () => {
    const path = longPath();
    const events = deriveWaitEvents({
      intervals: [waitingInterval(path, 10_000, 10_000 + MIN_USER_VISIBLE_WAIT_MS - 100, 80)],
      startedAtMs: 10_000,
      referencePath: path,
    });
    assert.equal(events.length, 0);
  });

  it('creates a list item for a 3.0 s waiting fragment', () => {
    const path = longPath();
    const events = deriveWaitEvents({
      intervals: [waitingInterval(path, 10_000, 10_000 + MIN_USER_VISIBLE_WAIT_MS, 80)],
      startedAtMs: 10_000,
      referencePath: path,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.durationMs, MIN_USER_VISIBLE_WAIT_MS);
    assert.equal(events[0]?.locationState, 'located');
  });

  it('never lets displayed event durations sum above aggregate waiting time', () => {
    const course = courseFromPath();
    const samples = commuteWithBoundedWaits(course.referencePath, {
      sessionId: 'sum',
      startMs: 5_000,
      waits: [
        { progressMeters: 60, durationMs: 12_000 },
        { progressMeters: 180, durationMs: 9_000 },
        { progressMeters: 300, durationMs: 2_900 },
      ],
    });
    const { events, waitingMs, intervals } = eventsFromSamples(course, samples);
    assert.ok(displayedWaitDurationSumMs(events) <= waitingMs);
    const waitingIntervalMs = intervals
      .filter((interval) => interval.label === 'waiting')
      .reduce((sum, interval) => sum + interval.durationMs, 0);
    assert.equal(waitingIntervalMs, waitingMs);
  });

  it('locates a bounded-gap wait with no usable interior samples from the supporting flanks', () => {
    const course = courseFromPath();
    const path = course.referencePath;
    const point = pointAtProgress(path, 80);
    const left = sample({
      id: 'gap-left',
      sessionId: 'gap',
      recordedAtMs: 20_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const right = sample({
      id: 'gap-right',
      sessionId: 'gap',
      recordedAtMs: left.recordedAtMs + 90_000,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontalAccuracyMeters: 9,
      speedMetersPerSecond: 0,
    });
    const { events, intervals } = eventsFromSamples(course, [left, right]);
    const waiting = intervals.filter((interval) => interval.label === 'waiting');
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.startFix?.matched, true);
    assert.equal(waiting[0]?.endFix?.matched, true);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.locationState, 'located');
    assert.ok(Math.abs((events[0]?.progressMeters ?? 0) - 80) < 8);
    const expected = pointAtProgress(path, events[0]!.progressMeters!);
    assert.ok(haversineMeters(events[0]!.coordinate!, expected) < 1);
  });

  it('does not let poor-accuracy interior samples move the marker off the flank progress', () => {
    const course = courseFromPath();
    const path = course.referencePath;
    const flank = pointAtProgress(path, 80);
    const outlier = pointAtProgress(path, 200);
    const left = sample({
      id: 'poor-left',
      sessionId: 'poor',
      recordedAtMs: 20_000,
      latitude: flank.latitude,
      longitude: flank.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const interiors: LocationSample[] = [];
    for (let index = 1; index < 90; index += 1) {
      interiors.push(
        sample({
          id: `poor-int-${index}`,
          sessionId: 'poor',
          recordedAtMs: 20_000 + index * 1_000,
          latitude: outlier.latitude,
          longitude: outlier.longitude,
          horizontalAccuracyMeters: 60,
          speedMetersPerSecond: 0,
        }),
      );
    }
    const right = sample({
      id: 'poor-right',
      sessionId: 'poor',
      recordedAtMs: 110_000,
      latitude: flank.latitude,
      longitude: flank.longitude,
      horizontalAccuracyMeters: 8,
      speedMetersPerSecond: 0,
    });
    const { events } = eventsFromSamples(course, [left, ...interiors, right]);
    assert.equal(events.length, 1);
    assert.ok(Math.abs((events[0]?.progressMeters ?? 0) - 80) < 8);
    assert.ok(Math.abs((events[0]?.progressMeters ?? 0) - 200) > 50);
  });

  it('keeps a wait with unmatched flank progress in the list without a fake marker', () => {
    const path = longPath();
    const events = deriveWaitEvents({
      intervals: [waitingInterval(path, 10_000, 20_000, 80, false)],
      startedAtMs: 10_000,
      referencePath: path,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.locationState, 'unavailable');
    assert.equal(events[0]?.coordinate, null);
    assert.equal(events[0]?.progressMeters, null);
    assert.equal(formatWaitEventLocation(events[0]!), 'Location unavailable');
  });

  it('maps route-progress location onto current route geometry', () => {
    const path = longPath();
    const events = deriveWaitEvents({
      intervals: [waitingInterval(path, 10_000, 20_000, 120)],
      startedAtMs: 10_000,
      referencePath: path,
    });
    assert.equal(events.length, 1);
    const expected = pointAtProgress(path, 120);
    assert.ok(events[0]?.coordinate);
    assert.ok(haversineMeters(events[0]!.coordinate!, expected) < 0.5);
  });

  it('rederives wait events when the current layout start and finish change', () => {
    const path = longPath();
    const original = courseFromPath(path);
    const clipped = courseFromPath(path, {
      startProgressMeters: 200,
      finishProgressMeters: 500,
      startZone: {
        center: pointAtProgress(path, 200),
        radiusMeters: original.startZone.radiusMeters,
      },
      finishZone: {
        center: pointAtProgress(path, 500),
        radiusMeters: original.finishZone.radiusMeters,
      },
    });
    const attempt = makeAttempt({ id: 'layout', sessionId: 'layout' });
    const samples = commuteWithBoundedWaits(path, {
      sessionId: 'layout',
      startMs: 1_000,
      waits: [
        { progressMeters: 80, durationMs: 20_000 },
        { progressMeters: 320, durationMs: 18_000 },
      ],
    });
    const full = deriveCurrentLayoutAttempt(original, attempt, samples);
    const trimmed = deriveCurrentLayoutAttempt(clipped, attempt, samples);
    assert.equal(full.eligible, true);
    assert.equal(trimmed.eligible, true);
    assert.ok(full.waitEvents.length >= 2);
    assert.ok(trimmed.waitEvents.length >= 1);
    assert.ok(trimmed.waitEvents.length < full.waitEvents.length);
    assert.ok((trimmed.waitEvents[0]?.progressMeters ?? 0) > 200);
  });

  it('reproduces the same waiting events after a second reconstruction', () => {
    const course = courseFromPath();
    const attempt = makeAttempt({ id: 'reload', sessionId: 'reload' });
    const samples = commuteWithBoundedWaits(course.referencePath, {
      sessionId: 'reload',
      startMs: 5_000,
      waits: [{ progressMeters: 140, durationMs: 25_000 }],
    });
    const first = deriveCurrentLayoutAttempt(course, attempt, samples);
    const second = deriveCurrentLayoutAttempt(course, attempt, samples);
    assert.deepEqual(first.waitEvents, second.waitEvents);
    assert.deepEqual(first.movement, second.movement);
  });

  it('does not change competitive PB, rank, Gold, or Sum of Best', () => {
    const course = courseFromPath();
    const fast = makeAttempt({ id: 'fast', sessionId: 'fast', armedAtMs: 1_000 });
    const slow = makeAttempt({ id: 'slow', sessionId: 'slow', armedAtMs: 2_000 });
    const traces: AttemptTrace[] = [
      {
        attempt: fast,
        samples: coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 1_000 }),
      },
      {
        attempt: slow,
        samples: commuteWithBoundedWaits(course.referencePath, {
          sessionId: 'slow',
          startMs: 2_000,
          waits: [{ progressMeters: 120, durationMs: 40_000 }],
        }),
      },
    ];
    const focus = analyzeFocusAttempt(course, traces, 'slow');
    assert.ok(focus);
    assert.equal(focus.isPb, false);
    assert.equal(focus.rank, 2);
    assert.equal(focus.summary.pbAttemptId, 'fast');
    assert.equal(focus.summary.rankedAttemptCount, 2);
    assert.ok(focus.sumOfBestMs != null);
    assert.equal(
      focus.sumOfBestMs,
      focus.segments.reduce((sum, segment) => sum + (segment.goldDurationMs ?? 0), 0),
    );
    assert.ok(focus.focus.waitEvents.length >= 1);
    assert.equal(focus.focus.officialTimeMs, focus.focus.movement?.officialTimeMs);
  });

  it('selects the nearest located wait for a map tap and ignores unavailable events', () => {
    const path = longPath();
    const events = deriveWaitEvents({
      intervals: [
        waitingInterval(path, 10_000, 20_000, 80),
        waitingInterval(path, 30_000, 40_000, null, false),
      ],
      startedAtMs: 10_000,
      referencePath: path,
    });
    const located = events.find((event) => event.locationState === 'located');
    assert.ok(located?.coordinate);
    assert.equal(waitEventIdNearPoint(events, located.coordinate), located.id);
    assert.equal(waitEventIdNearPoint(events, offsetLatLng(located.coordinate.latitude, located.coordinate.longitude, 200, 0)), null);
  });

  it('formats compact stop durations and route-progress labels', () => {
    assert.equal(formatWaitEventDuration(42_000), '42s');
    assert.equal(formatWaitEventDuration(3_000), '3s');
    const path = longPath();
    const [located] = deriveWaitEvents({
      intervals: [waitingInterval(path, 0, 4_000, 3_100)],
      startedAtMs: 0,
      referencePath: path,
    });
    assert.equal(formatWaitEventLocation(located!), '3.1 km into route');
  });

  it('exposes classified intervals from movement analysis rather than a second detector', () => {
    const course = courseFromPath();
    const samples = commuteWithBoundedWaits(course.referencePath, {
      sessionId: 'timeline',
      startMs: 5_000,
      waits: [{ progressMeters: 80, durationMs: 30_000 }],
    });
    const bounds = windowOf(samples);
    const timeline = analyzeAttemptMovementTimeline({
      course,
      samples,
      ...bounds,
    });
    const waiting = timeline.intervals.filter((interval) => interval.label === 'waiting');
    assert.ok(waiting.length >= 1);
    assert.ok(waiting.every((interval) => interval.startFix != null && interval.endFix != null));
    const events = deriveWaitEvents({
      intervals: timeline.intervals,
      startedAtMs: bounds.startedAtMs,
      referencePath: course.referencePath,
    });
    assert.equal(
      displayedWaitDurationSumMs(events) <= timeline.breakdown.waitingMs,
      true,
    );
    const source = readFileSync('src/domain/wait-events.ts', 'utf8');
    assert.doesNotMatch(source, /analyzeAttemptMovement|classifyInterval|locateUsableFixes/);
    assert.match(source, /ClassifiedMovementInterval/);
  });

  it('imports no Expo, native, or MapLibre code', () => {
    const source = readFileSync('src/domain/wait-events.ts', 'utf8');
    assert.doesNotMatch(
      source,
      /expo-location|expo-task-manager|expo-sqlite|react-native|@maplibre\/maplibre-react-native|maplibre/,
    );
  });
});
