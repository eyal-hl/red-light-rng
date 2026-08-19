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
import { pathDistanceMeters } from '../src/domain/geo';
import type { LocationSample } from '../src/domain/location-sample';
import {
  MIN_DISPLAYABLE_COVERAGE_RATIO,
  MOVEMENT_ANALYSIS_VERSION,
  type MovementBreakdown,
} from '../src/domain/movement-analysis';
import { pointAtProgress } from '../src/domain/path-projection';
import {
  compareAttemptWaiting,
  compareWaitingBehavior,
  formatWaitComparisonDelta,
  MAX_DISPLAY_WAIT_COMPARISON_LOCATIONS,
  MIN_DISPLAY_WAIT_COMPARISON_ABS_MS,
  WAIT_COMPARISON_LOCATION_RADIUS_METERS,
  waitComparisonLocationIdNearPoint,
  type WaitComparison,
  type WaitComparisonAttempt,
} from '../src/domain/wait-comparison';
import { WAIT_EVENT_MERGE_MAX_PROGRESS_METERS, type WaitEvent } from '../src/domain/wait-events';
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

function coveringTrace(
  path: { latitude: number; longitude: number }[],
  options: { sessionId: string; startMs: number; startProgressMeters?: number },
): LocationSample[] {
  const length = pathDistanceMeters(path);
  const startProgress = options.startProgressMeters ?? 0;
  const stepMeters = 5;
  const count = Math.ceil((length - startProgress) / stepMeters) + 12;
  return traceAlongPath(path, {
    sessionId: options.sessionId,
    startMs: options.startMs,
    startProgressMeters: startProgress,
    stepMeters,
    intervalMs: 1000,
    count,
  }).map((item, index) =>
    sample({
      ...item,
      id: `${options.sessionId}-${index}`,
    }),
  );
}

function commuteWithBoundedWaits(
  path: { latitude: number; longitude: number }[],
  options: {
    sessionId: string;
    startMs: number;
    waits: { progressMeters: number; durationMs: number }[];
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

function locatedWait(
  id: string,
  progressMeters: number,
  durationMs: number,
  startMs = 0,
): WaitEvent {
  return {
    id,
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    progressMeters,
    coordinate: pointAtProgress(longPath(), progressMeters),
    locationState: 'located',
  };
}

function unlocatedWait(id: string, durationMs: number, startMs = 0): WaitEvent {
  return {
    id,
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    progressMeters: null,
    coordinate: null,
    locationState: 'unavailable',
  };
}

function eventSum(events: WaitEvent[]): number {
  return events.reduce((sum, event) => sum + event.durationMs, 0);
}

function compareEvents(
  currentEvents: WaitEvent[],
  referenceEvents: WaitEvent[],
  extras: { currentWaitingMs?: number; referenceWaitingMs?: number } = {},
): WaitComparison {
  return compareWaitingBehavior({
    currentWaitingMs: extras.currentWaitingMs ?? eventSum(currentEvents),
    referenceWaitingMs: extras.referenceWaitingMs ?? eventSum(referenceEvents),
    currentEvents,
    referenceEvents,
    comparisonAttemptId: 'reference',
    referencePath: longPath(),
  });
}

function assertExactHeadline(comparison: WaitComparison, currentWaitingMs: number, referenceWaitingMs: number) {
  assert.equal(comparison.waitingDeltaMs, currentWaitingMs - referenceWaitingMs);
  assert.equal(comparison.currentWaitingMs, currentWaitingMs);
  assert.equal(comparison.referenceWaitingMs, referenceWaitingMs);
  assert.equal(
    comparison.waitingDeltaMs,
    comparison.locations.reduce((sum, entry) => sum + entry.deltaMs, 0) +
      (comparison.remainder.currentUnlocatedWaitEventMs - comparison.remainder.referenceUnlocatedWaitEventMs) +
      (comparison.remainder.currentSubEventWaitingMs - comparison.remainder.referenceSubEventWaitingMs),
  );
}

function assertSpanAndUniqueMembers(comparison: WaitComparison) {
  const currentSeen = new Set<string>();
  const referenceSeen = new Set<string>();
  for (const entry of comparison.locations) {
    assert.ok(entry.memberSpanMeters <= WAIT_COMPARISON_LOCATION_RADIUS_METERS + 1e-9);
    for (const id of entry.currentEventIds) {
      assert.equal(currentSeen.has(id), false, `current wait ${id} attributed twice`);
      currentSeen.add(id);
    }
    for (const id of entry.referenceEventIds) {
      assert.equal(referenceSeen.has(id), false, `reference wait ${id} attributed twice`);
      referenceSeen.add(id);
    }
  }
}

function movementBreakdown(waitingMs: number, movingMs = 80_000, unknownMs = 0): MovementBreakdown {
  const officialTimeMs = waitingMs + movingMs + unknownMs;
  const classifiedMs = movingMs + waitingMs;
  const coverageRatio = officialTimeMs > 0 ? classifiedMs / officialTimeMs : 0;
  let trust: MovementBreakdown['trust'] = 'unavailable';
  if (officialTimeMs > 0 && coverageRatio >= MIN_DISPLAYABLE_COVERAGE_RATIO) {
    trust = unknownMs <= 1 ? 'complete' : 'partial';
  }
  return {
    analysisVersion: MOVEMENT_ANALYSIS_VERSION,
    officialTimeMs,
    movingMs,
    waitingMs,
    unknownMs,
    classifiedMs,
    coverageRatio,
    trust,
  };
}

function comparisonAttempt(
  id: string,
  events: WaitEvent[],
  waitingMs: number,
  extras: Partial<WaitComparisonAttempt> & { unknownMs?: number; movingMs?: number } = {},
): WaitComparisonAttempt {
  return {
    attemptId: id,
    eligible: extras.eligible ?? true,
    movement:
      extras.movement === undefined
        ? movementBreakdown(waitingMs, extras.movingMs ?? 80_000, extras.unknownMs ?? 0)
        : extras.movement,
    waitEvents: events,
  };
}

function derivedPair(
  course: TimingCourse,
  currentWaits: { progressMeters: number; durationMs: number }[],
  referenceWaits: { progressMeters: number; durationMs: number }[],
) {
  const currentAttempt = makeAttempt({ id: 'current', sessionId: 'current', armedAtMs: 2_000 });
  const referenceAttempt = makeAttempt({ id: 'reference', sessionId: 'reference', armedAtMs: 1_000 });
  const currentSamples = commuteWithBoundedWaits(course.referencePath, {
    sessionId: 'current',
    startMs: 20_000,
    waits: currentWaits,
  });
  const referenceSamples = commuteWithBoundedWaits(course.referencePath, {
    sessionId: 'reference',
    startMs: 5_000,
    waits: referenceWaits,
  });
  const current = deriveCurrentLayoutAttempt(course, currentAttempt, currentSamples);
  const reference = deriveCurrentLayoutAttempt(course, referenceAttempt, referenceSamples);
  assert.equal(current.eligible, true);
  assert.equal(reference.eligible, true);
  assert.ok(current.movement && reference.movement);
  return { current, reference, currentSamples, referenceSamples };
}

describe('wait comparison', () => {
  it('uses a 40 m cross-attempt radius rather than the 15 m same-attempt merge constant', () => {
    assert.equal(WAIT_COMPARISON_LOCATION_RADIUS_METERS, 40);
    assert.notEqual(WAIT_COMPARISON_LOCATION_RADIUS_METERS, WAIT_EVENT_MERGE_MAX_PROGRESS_METERS);
    const source = readFileSync('src/domain/wait-comparison.ts', 'utf8');
    assert.doesNotMatch(source, /WAIT_EVENT_MERGE_MAX_PROGRESS_METERS/);
    assert.doesNotMatch(source, /Math\.floor\([^)]*\/\s*40/);
    assert.doesNotMatch(source, /progressMeters\s*\/\s*WAIT_COMPARISON_LOCATION_RADIUS_METERS/);
  });

  it('reconciles identical current and reference waits to zero', () => {
    const events = [
      locatedWait('a', 200, 20_000, 1_000),
      locatedWait('b', 500, 12_000, 40_000),
    ];
    const comparison = compareEvents(events, events);
    assert.equal(comparison.available, true);
    assertExactHeadline(comparison, 32_000, 32_000);
    assert.equal(comparison.waitingDeltaMs, 0);
    assert.ok(comparison.locations.length >= 2);
    assert.ok(comparison.locations.every((entry) => entry.deltaMs === 0));
    assertSpanAndUniqueMembers(comparison);
  });

  it('reports a positive delta when the current attempt waits longer at the same place', () => {
    const comparison = compareEvents(
      [locatedWait('now', 200, 50_000)],
      [locatedWait('pb', 200, 20_000)],
    );
    assert.equal(comparison.locations.length, 1);
    assert.equal(comparison.locations[0]?.matchState, 'matched');
    assert.equal(comparison.locations[0]?.deltaMs, 30_000);
    assertExactHeadline(comparison, 50_000, 20_000);
  });

  it('reports a negative delta when the current attempt waits less at the same place', () => {
    const comparison = compareEvents(
      [locatedWait('now', 200, 10_000)],
      [locatedWait('pb', 200, 40_000)],
    );
    assert.equal(comparison.locations[0]?.deltaMs, -30_000);
    assertExactHeadline(comparison, 10_000, 40_000);
  });

  it('keeps a current-only wait as a positive unmatched entry', () => {
    const comparison = compareEvents([locatedWait('now', 200, 18_000)], []);
    assert.equal(comparison.locations.length, 1);
    assert.equal(comparison.locations[0]?.matchState, 'current-only');
    assert.equal(comparison.locations[0]?.deltaMs, 18_000);
  });

  it('keeps a reference-only wait as a negative unmatched entry', () => {
    const comparison = compareEvents([], [locatedWait('pb', 200, 22_000)]);
    assert.equal(comparison.locations[0]?.matchState, 'reference-only');
    assert.equal(comparison.locations[0]?.deltaMs, -22_000);
  });

  it('aggregates an 18–25 m same-stop offset into one location entry', () => {
    const comparison = compareEvents(
      [locatedWait('now', 400, 90_000)],
      [locatedWait('pb', 418, 40_000)],
    );
    assert.equal(comparison.locations.length, 1);
    assert.equal(comparison.locations[0]?.deltaMs, 50_000);
    assert.ok(comparison.locations[0]!.memberSpanMeters <= 25);
  });

  it('keeps an 18–25 m pair together when it straddles a 40 m absolute-progress boundary', () => {
    const first = compareEvents([locatedWait('now-380', 380, 90_000)], [locatedWait('pb-400', 400, 40_000)]);
    const second = compareEvents([locatedWait('now-395', 395, 90_000)], [locatedWait('pb-415', 415, 40_000)]);
    assert.equal(first.locations.length, 1);
    assert.equal(second.locations.length, 1);
    assert.equal(first.locations[0]?.deltaMs, 50_000);
    assert.equal(second.locations[0]?.deltaMs, 50_000);
    assert.ok(first.locations[0]!.memberSpanMeters <= WAIT_COMPARISON_LOCATION_RADIUS_METERS);
    assert.ok(second.locations[0]!.memberSpanMeters <= WAIT_COMPARISON_LOCATION_RADIUS_METERS);
  });

  it('does not let an upstream wait consume the span budget and false-split a closer 18–25 m pair', () => {
    const comparison = compareEvents(
      [locatedWait('now-up', 350, 25_000, 1_000), locatedWait('now-down', 380, 90_000, 40_000)],
      [locatedWait('pb-up', 350, 25_000, 1_000), locatedWait('pb-down', 400, 40_000, 40_000)],
    );
    assert.equal(comparison.locations.length, 2);
    const upstream = comparison.locations.find((entry) => Math.abs(entry.progressMeters - 350) <= 5);
    const downstream = comparison.locations.find((entry) => entry.progressMeters > 360);
    assert.ok(upstream);
    assert.ok(downstream);
    assert.equal(upstream.deltaMs, 0);
    assert.equal(downstream.deltaMs, 50_000);
    assert.equal(downstream.matchState, 'matched');
    assert.ok(!comparison.locations.some((entry) => entry.deltaMs === 90_000));
    assert.ok(!comparison.locations.some((entry) => entry.deltaMs === -40_000));
    assertSpanAndUniqueMembers(comparison);
  });

  it('does not cross-match waits at >= 80 m, including a clearly separated 100 m fixture', () => {
    const eighty = compareEvents(
      [locatedWait('now', 200, 20_000)],
      [locatedWait('pb', 280, 20_000)],
    );
    const hundred = compareEvents(
      [locatedWait('now-100', 200, 20_000)],
      [locatedWait('pb-100', 300, 15_000)],
    );
    assert.equal(eighty.locations.length, 2);
    assert.equal(hundred.locations.length, 2);
    assert.equal(eighty.locations[0]?.matchState, 'current-only');
    assert.equal(eighty.locations[1]?.matchState, 'reference-only');
    assert.equal(hundred.locations[0]?.deltaMs, 20_000);
    assert.equal(hundred.locations[1]?.deltaMs, -15_000);
  });

  it('does not single-link 400 / 440 / 480 into one location spanning more than 40 m', () => {
    const bothSides = compareEvents(
      [
        locatedWait('c400', 400, 20_000, 1),
        locatedWait('c440', 440, 20_000, 2),
        locatedWait('c480', 480, 20_000, 3),
      ],
      [
        locatedWait('r400', 400, 20_000, 1),
        locatedWait('r440', 440, 20_000, 2),
        locatedWait('r480', 480, 20_000, 3),
      ],
    );
    assert.ok(bothSides.locations.length >= 2);
    assert.ok(bothSides.locations.every((entry) => entry.memberSpanMeters <= 40 + 1e-9));
    assert.equal(
      bothSides.locations.some((entry) => entry.memberSpanMeters > 40),
      false,
    );

    const staggered = compareEvents(
      [locatedWait('c400', 400, 90_000), locatedWait('c480', 480, 20_000, 50_000)],
      [locatedWait('r440', 440, 40_000)],
    );
    assert.ok(staggered.locations.length >= 2);
    assert.ok(staggered.locations.every((entry) => entry.memberSpanMeters <= 40 + 1e-9));
    assert.equal(
      staggered.locations.reduce((sum, entry) => sum + entry.currentWaitingMs, 0),
      110_000,
    );
  });

  it('nets one 90 s wait against two ~20 m-apart reference waits into one location', () => {
    const comparison = compareEvents(
      [locatedWait('now', 400, 90_000)],
      [locatedWait('pb-a', 395, 40_000, 1_000), locatedWait('pb-b', 415, 40_000, 50_000)],
    );
    assert.equal(comparison.locations.length, 1);
    assert.equal(comparison.locations[0]?.deltaMs, 10_000);
    assert.equal(comparison.locations[0]?.currentEventIds.length, 1);
    assert.equal(comparison.locations[0]?.referenceEventIds.length, 2);
    assert.ok(comparison.locations[0]!.memberSpanMeters <= 20 + 1e-9);
  });

  it('keeps grouping stable when wait event arrays are not in route order', () => {
    const current = [locatedWait('late', 400, 30_000, 80_000), locatedWait('early', 120, 10_000, 5_000)];
    const reference = [locatedWait('early', 120, 10_000, 5_000), locatedWait('late', 418, 12_000, 90_000)];
    const comparison = compareEvents(current, reference);
    assert.equal(comparison.locations.length, 2);
    assert.ok(comparison.locations[0]!.progressMeters < comparison.locations[1]!.progressMeters);
    assert.equal(comparison.locations[0]?.deltaMs, 0);
    assert.equal(comparison.locations[1]?.deltaMs, 18_000);
  });

  it('chooses equal-distance merges deterministically and yields identical output on reload', () => {
    const current = [locatedWait('a', 0, 10_000, 1), locatedWait('c', 100, 10_000, 3)];
    const reference = [locatedWait('b', 20, 8_000, 2), locatedWait('d', 120, 8_000, 4)];
    const first = compareEvents(current, reference);
    const second = compareEvents([...current].reverse(), [...reference].reverse());
    assert.deepEqual(first.locations, second.locations);
    assert.equal(first.locations.length, 2);
    assert.equal(first.locations[0]?.progressMeters, 10);
    assert.equal(first.locations[1]?.progressMeters, 110);
  });

  it('tie-breaks equal-distance merges by union min, then max, then numeric member identity', () => {
    const early = compareEvents(
      [locatedWait('c-nine', 0, 10_000, 9), locatedWait('c-later', 200, 10_000, 30)],
      [locatedWait('r-near', 20, 10_000, 100), locatedWait('r-later', 220, 10_000, 40)],
    );
    const lateStart = compareEvents(
      [locatedWait('c-ten', 0, 10_000, 10), locatedWait('c-later', 200, 10_000, 30)],
      [locatedWait('r-near', 20, 10_000, 100), locatedWait('r-later', 220, 10_000, 40)],
    );
    assert.equal(early.locations.length, 2);
    assert.equal(lateStart.locations.length, 2);
    assert.notEqual(early.locations[0]?.id, lateStart.locations[0]?.id);
    const again = compareEvents(
      [locatedWait('c-nine', 0, 10_000, 9), locatedWait('c-later', 200, 10_000, 30)],
      [locatedWait('r-near', 20, 10_000, 100), locatedWait('r-later', 220, 10_000, 40)],
    );
    assert.deepEqual(early.locations.map((entry) => entry.id), again.locations.map((entry) => entry.id));
  });

  it('hides tiny location deltas from the compact UI while keeping exact remainder metadata', () => {
    const comparison = compareEvents(
      [locatedWait('tiny', 200, MIN_DISPLAY_WAIT_COMPARISON_ABS_MS - 500, 1), locatedWait('big', 500, 28_000, 2)],
      [locatedWait('big', 500, 10_000, 2)],
      {
        currentWaitingMs: MIN_DISPLAY_WAIT_COMPARISON_ABS_MS - 500 + 28_000 + 1_200,
        referenceWaitingMs: 10_000,
      },
    );
    const tiny = comparison.locations.find((entry) => entry.progressMeters === 200);
    const big = comparison.locations.find((entry) => entry.progressMeters === 500);
    assert.ok(tiny && big);
    assert.ok(Math.abs(tiny.deltaMs) < MIN_DISPLAY_WAIT_COMPARISON_ABS_MS);
    assert.equal(big.deltaMs, 18_000);
    assert.equal(comparison.displayedLocations.length, 1);
    assert.equal(comparison.displayedLocations[0]?.id, big.id);
    assert.equal(comparison.remainder.hiddenLocationDeltaSumMs, tiny.deltaMs);
    assert.equal(comparison.remainder.displayedLocationDeltaSumMs, big.deltaMs);
    assert.ok(comparison.remainder.currentSubEventWaitingMs >= 1_200);
    assert.ok(comparison.displayedLocations.length <= MAX_DISPLAY_WAIT_COMPARISON_LOCATIONS);
    assertExactHeadline(
      comparison,
      MIN_DISPLAY_WAIT_COMPARISON_ABS_MS - 500 + 28_000 + 1_200,
      10_000,
    );
  });

  it('counts location-unavailable waits in remainder without inventing a map location', () => {
    const comparison = compareEvents(
      [locatedWait('mapped', 200, 12_000), unlocatedWait('ghost', 9_000, 80_000)],
      [locatedWait('mapped', 200, 12_000)],
    );
    assert.equal(comparison.locations.length, 1);
    assert.equal(comparison.locations[0]?.deltaMs, 0);
    assert.equal(comparison.remainder.currentUnlocatedWaitEventMs, 9_000);
    assert.equal(comparison.waitingDeltaMs, 9_000);
    assert.equal(comparison.locations.some((entry) => entry.coordinate == null && entry.currentEventIds.includes('ghost')), false);
  });

  it('does not let unknown time contribute to waiting delta', () => {
    const current = comparisonAttempt('now', [locatedWait('a', 200, 20_000)], 20_000, { unknownMs: 8_000 });
    const reference = comparisonAttempt('pb', [locatedWait('a', 200, 10_000)], 10_000, { unknownMs: 30_000 });
    const comparison = compareAttemptWaiting({
      current,
      reference,
      referencePath: longPath(),
    });
    assert.equal(comparison.available, true);
    assert.equal(comparison.waitingDeltaMs, 10_000);
    assert.equal(comparison.locations[0]?.deltaMs, 10_000);
    assert.equal(current.movement?.unknownMs, 8_000);
    assert.ok((current.movement?.unknownMs ?? 0) > 0);
  });

  it('is unavailable when either side fails movement-displayability rules', () => {
    const displayable = comparisonAttempt('now', [locatedWait('a', 200, 20_000)], 20_000);
    const hidden = comparisonAttempt('pb', [locatedWait('a', 200, 10_000)], 10_000, {
      movingMs: 1_000,
      unknownMs: 200_000,
    });
    assert.ok((hidden.movement?.coverageRatio ?? 1) < MIN_DISPLAYABLE_COVERAGE_RATIO);
    const missingCurrent = compareAttemptWaiting({
      current: hidden,
      reference: displayable,
      referencePath: longPath(),
    });
    const missingReference = compareAttemptWaiting({
      current: displayable,
      reference: hidden,
      referencePath: longPath(),
    });
    assert.equal(missingCurrent.available, false);
    assert.equal(missingCurrent.unavailableReason, 'current_movement_not_displayable');
    assert.equal(missingCurrent.waitingDeltaMs, 0);
    assert.equal(missingReference.available, false);
    assert.equal(missingReference.unavailableReason, 'reference_movement_not_displayable');
  });

  it('is unavailable without a comparison target and for ineligible attempts', () => {
    const current = comparisonAttempt('now', [locatedWait('a', 200, 20_000)], 20_000);
    const none = compareAttemptWaiting({ current, reference: null, referencePath: longPath() });
    assert.equal(none.available, false);
    assert.equal(none.unavailableReason, 'missing_comparison_target');
    const ineligible = compareAttemptWaiting({
      current: { ...current, eligible: false },
      reference: comparisonAttempt('pb', [locatedWait('a', 200, 10_000)], 10_000),
      referencePath: longPath(),
    });
    assert.equal(ineligible.unavailableReason, 'current_not_eligible');
  });

  it('self-compares to exactly zero as an identity invariant', () => {
    const events = [locatedWait('a', 180, 15_000), locatedWait('b', 520, 9_000, 40_000), unlocatedWait('u', 4_000, 90_000)];
    const attempt = comparisonAttempt('self', events, eventSum(events) + 700);
    const comparison = compareAttemptWaiting({
      current: attempt,
      reference: attempt,
      referencePath: longPath(),
    });
    assert.equal(comparison.available, true);
    assert.equal(comparison.waitingDeltaMs, 0);
    assert.ok(comparison.locations.every((entry) => entry.deltaMs === 0));
    assertExactHeadline(comparison, eventSum(events) + 700, eventSum(events) + 700);
  });

  it('formats compact signed second deltas', () => {
    assert.equal(formatWaitComparisonDelta(34_000), '+34s');
    assert.equal(formatWaitComparisonDelta(-9_400), '-9s');
    assert.equal(formatWaitComparisonDelta(0), '0s');
  });

  it('selects a nearby comparison location for a map tap', () => {
    const comparison = compareEvents([locatedWait('now', 200, 12_000)], [locatedWait('pb', 200, 8_000)]);
    const located = comparison.locations[0];
    assert.ok(located?.coordinate);
    assert.equal(waitComparisonLocationIdNearPoint(comparison.locations, located.coordinate), located.id);
    assert.equal(
      waitComparisonLocationIdNearPoint(
        comparison.locations,
        offsetLatLng(located.coordinate.latitude, located.coordinate.longitude, 200, 0),
      ),
      null,
    );
  });
});

describe('wait comparison derived progress', () => {
  it('keeps a derived 18–25 m bucket-boundary pair as one location entry', () => {
    const course = courseFromPath();
    const { current, reference } = derivedPair(
      course,
      [{ progressMeters: 380, durationMs: 90_000 }],
      [{ progressMeters: 400, durationMs: 40_000 }],
    );
    const currentProgress = current.waitEvents[0]?.progressMeters;
    const referenceProgress = reference.waitEvents[0]?.progressMeters;
    assert.ok(currentProgress != null && referenceProgress != null);
    const offset = Math.abs(currentProgress - referenceProgress);
    assert.ok(offset >= 18 && offset <= 25, `expected 18–25 m derived offset, got ${offset}`);
    const straddlesBoundary =
      Math.floor(currentProgress / 40) !== Math.floor(referenceProgress / 40);
    assert.equal(straddlesBoundary, true);
    const comparison = compareAttemptWaiting({
      current,
      reference,
      referencePath: course.referencePath,
    });
    assert.equal(comparison.available, true);
    assert.equal(comparison.locations.length, 1);
    assert.equal(comparison.locations[0]?.matchState, 'matched');
    assert.ok((comparison.locations[0]?.deltaMs ?? 0) > 30_000);
    assertExactHeadline(comparison, current.movement!.waitingMs, reference.movement!.waitingMs);
  });

  it('keeps a derived 395 vs 415 pair together', () => {
    const course = courseFromPath();
    const { current, reference } = derivedPair(
      course,
      [{ progressMeters: 395, durationMs: 90_000 }],
      [{ progressMeters: 415, durationMs: 40_000 }],
    );
    const offset = Math.abs((current.waitEvents[0]?.progressMeters ?? 0) - (reference.waitEvents[0]?.progressMeters ?? 0));
    assert.ok(offset >= 18 && offset <= 25, `expected 18–25 m derived offset, got ${offset}`);
    const comparison = compareAttemptWaiting({
      current,
      reference,
      referencePath: course.referencePath,
    });
    assert.equal(comparison.locations.length, 1);
    assert.ok(comparison.locations[0]!.memberSpanMeters <= WAIT_COMPARISON_LOCATION_RADIUS_METERS);
  });

  it('keeps a derived 20 m downstream pair together when another wait sits ~30–40 m upstream', () => {
    const course = courseFromPath();
    const { current, reference } = derivedPair(
      course,
      [
        { progressMeters: 350, durationMs: 25_000 },
        { progressMeters: 380, durationMs: 90_000 },
      ],
      [
        { progressMeters: 350, durationMs: 25_000 },
        { progressMeters: 400, durationMs: 40_000 },
      ],
    );
    assert.ok(current.waitEvents.length >= 2);
    assert.ok(reference.waitEvents.length >= 2);
    const currentDown = current.waitEvents[1]?.progressMeters ?? 0;
    const referenceDown = reference.waitEvents[1]?.progressMeters ?? 0;
    const downstreamOffset = Math.abs(currentDown - referenceDown);
    assert.ok(downstreamOffset >= 18 && downstreamOffset <= 25, `downstream offset ${downstreamOffset}`);
    const comparison = compareAttemptWaiting({
      current,
      reference,
      referencePath: course.referencePath,
    });
    assert.equal(comparison.locations.length, 2);
    const upstream = comparison.locations[0];
    const downstream = comparison.locations[1];
    assert.ok(upstream && downstream);
    assert.ok(Math.abs(upstream.deltaMs) < 5_000);
    assert.ok(downstream.deltaMs > 30_000);
    assert.equal(downstream.matchState, 'matched');
    assert.ok(Math.abs(upstream.deltaMs) !== 90_000 && downstream.deltaMs !== -40_000);
    assertSpanAndUniqueMembers(comparison);
    assertExactHeadline(comparison, current.movement!.waitingMs, reference.movement!.waitingMs);
  });

  it('does not collapse derived waits near 400, 440, and 480 into one location', () => {
    const course = courseFromPath();
    const { current, reference } = derivedPair(
      course,
      [
        { progressMeters: 400, durationMs: 20_000 },
        { progressMeters: 440, durationMs: 20_000 },
        { progressMeters: 480, durationMs: 20_000 },
      ],
      [
        { progressMeters: 400, durationMs: 20_000 },
        { progressMeters: 440, durationMs: 20_000 },
        { progressMeters: 480, durationMs: 20_000 },
      ],
    );
    const progresses = current.waitEvents
      .map((event) => event.progressMeters)
      .filter((value): value is number => value != null);
    assert.ok(progresses.length >= 3);
    const span = Math.max(...progresses) - Math.min(...progresses);
    assert.ok(span > 40);
    const comparison = compareAttemptWaiting({
      current,
      reference,
      referencePath: course.referencePath,
    });
    assert.ok(comparison.locations.length >= 2);
    assert.ok(comparison.locations.every((entry) => entry.memberSpanMeters <= WAIT_COMPARISON_LOCATION_RADIUS_METERS + 1e-6));
  });

  it('does not cross-match a clearly separated 100 m derived pair', () => {
    const course = courseFromPath();
    const { current, reference } = derivedPair(
      course,
      [{ progressMeters: 200, durationMs: 20_000 }],
      [{ progressMeters: 300, durationMs: 18_000 }],
    );
    const offset = Math.abs((current.waitEvents[0]?.progressMeters ?? 0) - (reference.waitEvents[0]?.progressMeters ?? 0));
    assert.ok(offset >= 90, `expected ~100 m derived offset, got ${offset}`);
    const comparison = compareAttemptWaiting({
      current,
      reference,
      referencePath: course.referencePath,
    });
    assert.equal(comparison.locations.length, 2);
    assert.equal(comparison.locations[0]?.matchState, 'current-only');
    assert.equal(comparison.locations[1]?.matchState, 'reference-only');
  });

  it('nets a derived 1-vs-2 intersection into one location delta', () => {
    const course = courseFromPath();
    const { current, reference } = derivedPair(
      course,
      [{ progressMeters: 400, durationMs: 90_000 }],
      [
        { progressMeters: 395, durationMs: 40_000 },
        { progressMeters: 415, durationMs: 40_000 },
      ],
    );
    assert.equal(current.waitEvents.length, 1);
    assert.ok(reference.waitEvents.length >= 2);
    const comparison = compareAttemptWaiting({
      current,
      reference,
      referencePath: course.referencePath,
    });
    assert.equal(comparison.locations.length, 1);
    assert.equal(comparison.locations[0]?.matchState, 'matched');
    assert.ok(Math.abs((comparison.locations[0]?.deltaMs ?? 0) - 10_000) < 8_000);
  });
});

describe('wait comparison product wiring', () => {
  it('compares a new PB against the previous PB instead of self-zero', () => {
    const course = courseFromPath();
    const previousPb = makeAttempt({ id: 'previous-pb', sessionId: 'previous-pb', armedAtMs: 1_000 });
    const newPb = makeAttempt({ id: 'new-pb', sessionId: 'new-pb', armedAtMs: 2_000 });
    const traces: AttemptTrace[] = [
      {
        attempt: previousPb,
        samples: commuteWithBoundedWaits(course.referencePath, {
          sessionId: 'previous-pb',
          startMs: 1_000,
          waits: [{ progressMeters: 160, durationMs: 40_000 }],
        }),
      },
      {
        attempt: newPb,
        samples: commuteWithBoundedWaits(course.referencePath, {
          sessionId: 'new-pb',
          startMs: 200_000,
          waits: [{ progressMeters: 160, durationMs: 10_000 }],
        }),
      },
    ];
    const focus = analyzeFocusAttempt(course, traces, 'new-pb');
    assert.ok(focus);
    assert.equal(focus.isPb, true);
    assert.equal(focus.comparisonPbAttemptId, 'previous-pb');
    assert.equal(focus.waitingComparison.available, true);
    assert.equal(focus.waitingComparison.comparisonAttemptId, 'previous-pb');
    assert.ok(focus.waitingComparison.waitingDeltaMs < 0);
    assert.notEqual(focus.waitingComparison.waitingDeltaMs, 0);
    assert.equal(focus.waitingComparison.waitingDeltaMs, (focus.focus.movement?.waitingMs ?? 0) - (focus.waitingComparison.referenceWaitingMs));
    const previous = analyzeFocusAttempt(course, traces, 'previous-pb');
    assert.ok(previous?.focus.movement);
    assert.equal(focus.waitingComparison.referenceWaitingMs, previous.focus.movement.waitingMs);
  });

  it('marks a first-ever PB without a previous comparison target as unavailable', () => {
    const course = courseFromPath();
    const only = makeAttempt({ id: 'only', sessionId: 'only' });
    const traces: AttemptTrace[] = [
      {
        attempt: only,
        samples: commuteWithBoundedWaits(course.referencePath, {
          sessionId: 'only',
          startMs: 5_000,
          waits: [{ progressMeters: 140, durationMs: 20_000 }],
        }),
      },
    ];
    const focus = analyzeFocusAttempt(course, traces, 'only');
    assert.ok(focus);
    assert.equal(focus.isPb, true);
    assert.equal(focus.comparisonPbAttemptId, null);
    assert.equal(focus.waitingComparison.available, false);
    assert.equal(focus.waitingComparison.unavailableReason, 'missing_comparison_target');
  });

  it('rederives comparison after current-layout edits and restart', () => {
    const path = longPath();
    const original = courseFromPath(path, { startProgressMeters: 0 });
    const clipped = courseFromPath(path, {
      startProgressMeters: 200,
      startZone: {
        center: pointAtProgress(path, 200),
        radiusMeters: original.startZone.radiusMeters,
      },
    });
    const currentAttempt = makeAttempt({ id: 'current', sessionId: 'current', armedAtMs: 2_000 });
    const referenceAttempt = makeAttempt({ id: 'reference', sessionId: 'reference', armedAtMs: 1_000 });
    const traces: AttemptTrace[] = [
      {
        attempt: referenceAttempt,
        samples: commuteWithBoundedWaits(path, {
          sessionId: 'reference',
          startMs: 1_000,
          waits: [
            { progressMeters: 80, durationMs: 20_000 },
            { progressMeters: 320, durationMs: 18_000 },
          ],
        }),
      },
      {
        attempt: currentAttempt,
        samples: commuteWithBoundedWaits(path, {
          sessionId: 'current',
          startMs: 20_000,
          waits: [
            { progressMeters: 80, durationMs: 40_000 },
            { progressMeters: 320, durationMs: 18_000 },
          ],
        }),
      },
    ];
    const full = analyzeFocusAttempt(original, traces, 'current');
    const trimmed = analyzeFocusAttempt(clipped, traces, 'current');
    const again = analyzeFocusAttempt(original, traces, 'current');
    assert.ok(full && trimmed && again);
    assert.equal(full.waitingComparison.available, true);
    assert.deepEqual(full.waitingComparison, again.waitingComparison);
    assert.notEqual(full.focus.layoutIdentity, trimmed.focus.layoutIdentity);
    assert.ok(full.waitingComparison.locations.length >= trimmed.waitingComparison.locations.length);
    assert.ok((full.focus.waitEvents.length ?? 0) > (trimmed.focus.waitEvents.length ?? 0));
  });

  it('does not change competitive PB, rank, Gold, or Sum of Best', () => {
    const course = courseFromPath();
    const fast = makeAttempt({ id: 'fast', sessionId: 'fast', armedAtMs: 1_000 });
    const slow = makeAttempt({ id: 'slow', sessionId: 'slow', armedAtMs: 2_000 });
    const traces: AttemptTrace[] = [
      { attempt: fast, samples: coveringTrace(course.referencePath, { sessionId: 'fast', startMs: 1_000 }) },
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
    assert.equal(focus.comparisonPbAttemptId, 'fast');
    assert.equal(focus.summary.rankedAttemptCount, 2);
    assert.ok(focus.sumOfBestMs != null);
    assert.equal(
      focus.sumOfBestMs,
      focus.segments.reduce((sum, segment) => sum + (segment.goldDurationMs ?? 0), 0),
    );
    assert.equal(focus.focus.officialTimeMs, focus.focus.movement?.officialTimeMs);
    assert.equal(focus.waitingComparison.available, true);
    assert.ok(focus.waitingComparison.waitingDeltaMs > 0);
  });

  it('imports no Expo, native, or MapLibre code', () => {
    const source = readFileSync('src/domain/wait-comparison.ts', 'utf8');
    assert.doesNotMatch(
      source,
      /expo-location|expo-task-manager|expo-sqlite|react-native|@maplibre\/maplibre-react-native|maplibre/,
    );
  });
});
