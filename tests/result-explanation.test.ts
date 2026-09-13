import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { officialTimeMs, type Attempt } from '../src/domain/attempt';
import {
  deriveCurrentLayoutAttempt,
  timingCourseFromRoute,
} from '../src/domain/attempt-analysis';
import { elapsedOnIncreasingFlanks } from '../src/domain/ghost-comparison';
import { pathDistanceMeters } from '../src/domain/geo';
import {
  analyzeJourneyFocus,
  type JourneyAttemptTrace,
} from '../src/domain/journey-analysis';
import {
  MIN_DISPLAYABLE_COVERAGE_RATIO,
  MOVEMENT_ANALYSIS_VERSION,
  MOVEMENT_TOTAL_TOLERANCE_MS,
  type MovementBreakdown,
} from '../src/domain/movement-analysis';
import { pointAtProgress } from '../src/domain/path-projection';
import {
  EXPLANATION_RECONCILE_TOLERANCE_MS,
  MAX_EXPLANATION_ITEMS,
  MIN_EXPLANATION_ABS_MS,
  RESULT_EXPLANATION_VERSION,
  TARGET_EXPLANATION_ITEMS,
  additiveDisplayedSumMs,
  explainOfficialDelta,
  formatExplanationDelta,
  isProgressWaitAttributed,
  type ExplanationRow,
} from '../src/domain/result-explanation';
import type { LocationSample } from '../src/domain/location-sample';
import {
  MIN_DISPLAY_WAIT_COMPARISON_ABS_MS,
  compareWaitingBehavior,
} from '../src/domain/wait-comparison';
import type { WaitEvent } from '../src/domain/wait-events';
import { attemptIdentity } from './helpers/attempts';
import { makePlace } from './helpers/places';
import { makeRoute, northPath } from './helpers/routes';
import { offsetLatLng, sample } from './helpers/samples';

function movementBreakdown(
  waitingMs: number,
  movingMs: number,
  unknownMs = 0,
): MovementBreakdown {
  const officialTimeMs = waitingMs + movingMs + unknownMs;
  const classifiedMs = movingMs + waitingMs;
  const coverageRatio = officialTimeMs > 0 ? classifiedMs / officialTimeMs : 0;
  let trust: MovementBreakdown['trust'] = 'unavailable';
  if (officialTimeMs > 0 && coverageRatio >= MIN_DISPLAYABLE_COVERAGE_RATIO) {
    trust = unknownMs <= MOVEMENT_TOTAL_TOLERANCE_MS ? 'complete' : 'partial';
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

function locatedWait(id: string, progressMeters: number, durationMs: number, startMs = 0): WaitEvent {
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

function longPath() {
  return northPath({ points: 41, stepMeters: 20 });
}

function waitComparisonAt(
  currentWaitingMs: number,
  referenceWaitingMs: number,
  locations: { id: string; progressMeters: number; currentMs: number; referenceMs: number }[],
  comparisonAttemptId = 'pb',
) {
  return compareWaitingBehavior({
    currentWaitingMs,
    referenceWaitingMs,
    currentEvents: locations.map((location, index) =>
      locatedWait(`c-${location.id}`, location.progressMeters, location.currentMs, index * 20_000),
    ),
    referenceEvents: locations.map((location, index) =>
      locatedWait(`r-${location.id}`, location.progressMeters, location.referenceMs, index * 20_000),
    ),
    comparisonAttemptId,
    referencePath: longPath(),
  });
}

function kinds(rows: ExplanationRow[]): ExplanationRow['kind'][] {
  return rows.map((row) => row.kind);
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

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `${id}-session`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 2_000,
    finishedAtMs: 12_000,
    resultAcknowledged: true,
    crossings: [],
    ...attemptIdentity(),
    ...overrides,
  };
}

function detourPath(path: { latitude: number; longitude: number }[], eastMeters: number) {
  return path.map((point, index) => {
    if (index === 0 || index === path.length - 1) {
      return point;
    }
    return offsetLatLng(point.latitude, point.longitude, 0, eastMeters);
  });
}

function journeyPlaces(path: { latitude: number; longitude: number }[]) {
  const start = path[0]!;
  const end = path[path.length - 1]!;
  return {
    origin: makePlace({ id: 'place-home', name: 'Home', center: start }),
    destination: makePlace({ id: 'place-work', name: 'Work', center: end, createdAtMs: 2 }),
  };
}

function routeOnPath(id: string, path: { latitude: number; longitude: number }[]) {
  const start = path[0]!;
  const end = path[path.length - 1]!;
  return makeRoute({
    id,
    name: id,
    referencePath: path,
    startZone: { center: start, radiusMeters: 30 },
    finishZone: { center: end, radiusMeters: 30 },
  });
}

function traceOnRoute(
  id: string,
  route: ReturnType<typeof routeOnPath>,
  waits: { progressMeters: number; durationMs: number }[],
  startMs: number,
  armedAtMs: number,
): JourneyAttemptTrace {
  const samples = commuteWithBoundedWaits(route.referencePath, { sessionId: id, startMs, waits });
  const derived = deriveCurrentLayoutAttempt(
    timingCourseFromRoute(route),
    completedAttempt(id, {
      routeId: route.id,
      armedAtMs,
      startedAtMs: startMs,
      finishedAtMs: startMs + 2_000_000,
    }),
    samples,
  );
  assert.equal(derived.eligible, true, `${id} should derive an eligible layout attempt`);
  assert.ok(derived.startedAtMs != null && derived.finishedAtMs != null);
  return {
    attempt: completedAttempt(id, {
      routeId: route.id,
      armedAtMs,
      startedAtMs: derived.startedAtMs,
      finishedAtMs: derived.finishedAtMs,
    }),
    samples,
  };
}

describe('result explanation constants and source bounds', () => {
  it('reuses the wait-comparison display threshold and documents additive tolerance', () => {
    assert.equal(MIN_EXPLANATION_ABS_MS, MIN_DISPLAY_WAIT_COMPARISON_ABS_MS);
    assert.equal(MIN_EXPLANATION_ABS_MS, 3_000);
    assert.equal(EXPLANATION_RECONCILE_TOLERANCE_MS, 1_000);
    assert.equal(MAX_EXPLANATION_ITEMS, 5);
    assert.equal(TARGET_EXPLANATION_ITEMS, 3);
    assert.equal(RESULT_EXPLANATION_VERSION, 'explanation-v1');
    assert.equal(formatExplanationDelta(42_000), '+42s');
    assert.equal(formatExplanationDelta(-11_000), '-11s');
  });

  it('does not import ghost pairing helpers or invent a path-free wait classifier', () => {
    const source = readFileSync('src/domain/result-explanation.ts', 'utf8');
    assert.doesNotMatch(source, /from '\.\/ghost-comparison'/);
    assert.doesNotMatch(source, /elapsedOnIncreasingFlanks\(/);
    assert.doesNotMatch(source, /finishTriggerDeltaMs/);
    assert.doesNotMatch(source, /analyzeAttemptMovement/);
    const wiring = readFileSync('src/domain/journey-analysis.ts', 'utf8');
    assert.match(wiring, /comparisonAttemptId/);
    assert.match(wiring, /explainOfficialDelta/);
    assert.doesNotMatch(wiring, /pathAnalytics\.waitingComparison/);
    assert.doesNotMatch(wiring, /pathAnalytics\.ghostComparison/);
    assert.doesNotMatch(wiring, /comparisonPbRun/);
  });
});

describe('explainOfficialDelta', () => {
  it('uses a clean first-attempt state when there is no headline comparison target', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: null,
      headlineDeltaMs: null,
      currentMovement: movementBreakdown(40_000, 100_000),
      referenceMovement: null,
      waitComparison: null,
    });
    assert.equal(explanation.availability, 'no_comparison_target');
    assert.equal(explanation.rows.length, 0);
    assert.equal(explanation.additive, null);
    assert.equal(explanation.pathSpecificAvailable, false);
  });

  it('shows the headline without invented causes when totals are not trustworthy', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 26_000,
      currentMovement: null,
      referenceMovement: movementBreakdown(20_000, 100_000),
      waitComparison: null,
    });
    assert.equal(explanation.availability, 'headline_only');
    assert.equal(explanation.headlineDeltaMs, 26_000);
    assert.equal(explanation.rows.length, 0);
    assert.equal(explanation.additive, null);
  });

  it('explains a slower run with one dominant extra wait without double-counting the location', () => {
    const wait = waitComparisonAt(90_000, 40_000, [
      { id: 'light', progressMeters: 400, currentMs: 90_000, referenceMs: 40_000 },
    ]);
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 50_000,
      currentMovement: movementBreakdown(90_000, 100_000),
      referenceMovement: movementBreakdown(40_000, 100_000),
      waitComparison: wait,
    });
    assert.equal(explanation.availability, 'additive');
    assert.equal(explanation.additive?.waitingDeltaMs, 50_000);
    assert.equal(explanation.additive?.movingDeltaMs, 0);
    assert.equal(explanation.additive?.remainderMs, 0);
    assert.equal(explanation.additive?.reconciled, true);
    const additive = explanation.rows.filter((row) => row.role === 'additive');
    const details = explanation.rows.filter((row) => row.role === 'detail');
    assert.deepEqual(kinds(additive), ['waiting_total']);
    assert.equal(additive[0]?.label, 'more waiting');
    assert.equal(details.length, 1);
    assert.equal(details[0]?.kind, 'waiting_location');
    assert.equal(details[0]?.parentId, 'explanation:waiting_total');
    assert.equal(details[0]?.deltaMs, 50_000);
    assert.equal(additiveDisplayedSumMs(explanation.rows), 50_000);
    assert.notEqual(additiveDisplayedSumMs(explanation.rows), 100_000);
    assert.ok(isProgressWaitAttributed(400, wait.displayedLocations));
    assert.equal(
      explanation.rows.some((row) => row.kind === 'moving_total'),
      false,
    );
  });

  it('explains a faster run with less waiting', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'previous-pb',
      headlineDeltaMs: -30_000,
      currentMovement: movementBreakdown(10_000, 100_000),
      referenceMovement: movementBreakdown(40_000, 100_000),
      waitComparison: waitComparisonAt(10_000, 40_000, [
        { id: 'light', progressMeters: 160, currentMs: 10_000, referenceMs: 40_000 },
      ]),
    });
    const waiting = explanation.rows.find((row) => row.kind === 'waiting_total');
    assert.ok(waiting);
    assert.equal(waiting.deltaMs, -30_000);
    assert.equal(waiting.label, 'less waiting');
    assert.equal(formatExplanationDelta(waiting.deltaMs), '-30s');
  });

  it('uses an additive waiting + moving + remainder skeleton for mixed gains and losses', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 42_000,
      currentMovement: movementBreakdown(80_000, 120_000, 3_000),
      referenceMovement: movementBreakdown(52_000, 109_000, 0),
      waitComparison: null,
    });
    assert.equal(explanation.additive?.waitingDeltaMs, 28_000);
    assert.equal(explanation.additive?.movingDeltaMs, 11_000);
    assert.equal(explanation.additive?.remainderMs, 3_000);
    assert.deepEqual(
      explanation.rows.map((row) => [row.kind, row.deltaMs, row.label]),
      [
        ['waiting_total', 28_000, 'more waiting'],
        ['moving_total', 11_000, 'slower moving time'],
        ['unexplained_remainder', 3_000, 'unexplained / uncovered'],
      ],
    );
    assert.equal(explanation.rows.length <= MAX_EXPLANATION_ITEMS, true);
    assert.equal(additiveDisplayedSumMs(explanation.rows), 42_000);
  });

  it('filters tiny standalone candidates and folds them into remainder', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 42_000,
      currentMovement: movementBreakdown(2_000, 140_000),
      referenceMovement: movementBreakdown(0, 100_000),
      waitComparison: null,
    });
    assert.equal(explanation.additive?.waitingDeltaMs, 2_000);
    assert.equal(explanation.additive?.movingDeltaMs, 40_000);
    assert.deepEqual(kinds(explanation.rows), ['moving_total', 'unexplained_remainder']);
    const remainder = explanation.rows.find((row) => row.kind === 'unexplained_remainder');
    assert.equal(remainder?.deltaMs, 2_000);
    assert.ok(Math.abs(remainder?.deltaMs ?? 0) < MIN_EXPLANATION_ABS_MS);
  });

  it('omits a reconciled remainder within the documented tolerance', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 40_400,
      currentMovement: movementBreakdown(20_000, 120_400),
      referenceMovement: movementBreakdown(20_000, 80_000),
      waitComparison: null,
    });
    assert.equal(explanation.additive?.reconciled, true);
    assert.deepEqual(kinds(explanation.rows), ['moving_total']);
  });

  it('keeps waiting visible when location children are meaningful even if the net total is tiny', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 2_000,
      currentMovement: movementBreakdown(32_000, 100_000),
      referenceMovement: movementBreakdown(30_000, 100_000),
      waitComparison: waitComparisonAt(32_000, 30_000, [
        { id: 'late', progressMeters: 600, currentMs: 22_000, referenceMs: 2_000 },
        { id: 'early', progressMeters: 200, currentMs: 10_000, referenceMs: 28_000 },
      ]),
    });
    assert.equal(explanation.rows[0]?.kind, 'waiting_total');
    const details = explanation.rows.filter((row) => row.kind === 'waiting_location');
    assert.equal(details.length, 2);
    assert.ok(Math.abs(details[0]?.deltaMs ?? 0) >= Math.abs(details[1]?.deltaMs ?? 0));
    assert.equal(details.every((row) => row.role === 'detail'), true);
  });

  it('orders equal-magnitude location details by progress then id', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 20_000,
      currentMovement: movementBreakdown(40_000, 100_000),
      referenceMovement: movementBreakdown(20_000, 100_000),
      waitComparison: waitComparisonAt(40_000, 20_000, [
        { id: 'b', progressMeters: 500, currentMs: 10_000, referenceMs: 0 },
        { id: 'a', progressMeters: 200, currentMs: 10_000, referenceMs: 0 },
      ]),
    });
    const details = explanation.rows.filter((row) => row.kind === 'waiting_location');
    assert.equal(details.length, 2);
    assert.ok((details[0]?.progressMeters ?? 0) < (details[1]?.progressMeters ?? 0));
  });

  it('caps displayed items at five and never treats location details as additive', () => {
    const locations = [120, 200, 280, 360, 440, 520].map((progressMeters, index) => ({
      id: `stop-${index}`,
      progressMeters,
      currentMs: 12_000,
      referenceMs: 0,
    }));
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 80_000,
      currentMovement: movementBreakdown(72_000, 110_000, 4_000),
      referenceMovement: movementBreakdown(0, 100_000, 0),
      waitComparison: waitComparisonAt(
        72_000,
        0,
        locations,
      ),
    });
    assert.ok(explanation.rows.length <= MAX_EXPLANATION_ITEMS);
    assert.equal(
      explanation.rows.filter((row) => row.role === 'additive').every((row) => row.kind !== 'waiting_location'),
      true,
    );
    const waiting = explanation.rows.find((row) => row.kind === 'waiting_total');
    const firstDetail = explanation.rows.find((row) => row.kind === 'waiting_location');
    assert.ok(waiting);
    assert.ok(firstDetail);
    assert.notEqual(waiting.id, firstDetail.id);
  });

  it('never uses unique-first +0 or ghost finish delta as a no-loss claim', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 50_000,
      currentMovement: movementBreakdown(90_000, 100_000),
      referenceMovement: movementBreakdown(40_000, 100_000),
      waitComparison: waitComparisonAt(90_000, 40_000, [
        { id: 'light', progressMeters: 400, currentMs: 90_000, referenceMs: 40_000 },
      ]),
    });
    assert.equal(
      explanation.rows.some((row) => row.kind === 'waiting_location' && row.deltaMs === 0),
      false,
    );
    assert.equal(
      explanation.rows.some((row) => row.source !== 'movement_totals' && row.source !== 'wait_comparison' && row.source !== 'remainder'),
      false,
    );
    const waiting = explanation.rows.find((row) => row.kind === 'waiting_total');
    assert.ok((waiting?.deltaMs ?? 0) >= 50_000);
  });

  it('degrades honestly for partial telemetry and restart/reload is stable', () => {
    const input = {
      comparisonAttemptId: 'pb',
      headlineDeltaMs: 40_000,
      currentMovement: movementBreakdown(20_000, 80_000, 20_000),
      referenceMovement: movementBreakdown(15_000, 75_000, 10_000),
      waitComparison: null,
    };
    const first = explainOfficialDelta(input);
    const second = explainOfficialDelta(input);
    assert.deepEqual(first, second);
    assert.equal(first.rows.find((row) => row.kind === 'unexplained_remainder')?.confidence, 'partial');
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('does not treat a path-variant wait comparison aimed at a different attempt as path-specific evidence', () => {
    const explanation = explainOfficialDelta({
      comparisonAttemptId: 'b-fast',
      headlineDeltaMs: 90_000,
      currentMovement: movementBreakdown(40_000, 199_000),
      referenceMovement: movementBreakdown(13_000, 136_000),
      waitComparison: waitComparisonAt(
        40_000,
        90_000,
        [{ id: 'light', progressMeters: 400, currentMs: 40_000, referenceMs: 90_000 }],
        'a-slow',
      ),
    });
    assert.equal(explanation.pathSpecificAvailable, false);
    assert.equal(
      explanation.rows.some((row) => row.kind === 'waiting_location'),
      false,
    );
    assert.equal(explanation.comparisonAttemptId, 'b-fast');
    const waiting = explanation.rows.find((row) => row.kind === 'waiting_total');
    assert.equal(waiting?.deltaMs, 27_000);
  });
});

describe('journey headline comparison wiring', () => {
  it('keeps official timing, PB, and rank unchanged while explaining a same-path extra wait', () => {
    const path = longPath();
    const { origin, destination } = journeyPlaces(path);
    const route = routeOnPath('route-a', path);
    const pb = traceOnRoute('pb', route, [{ progressMeters: 400, durationMs: 40_000 }], 5_000, 1_000);
    const current = traceOnRoute(
      'current',
      route,
      [{ progressMeters: 400, durationMs: 90_000 }],
      200_000,
      180_000,
    );
    const traces = [pb, current];
    const focus = analyzeJourneyFocus(
      { originPlaceId: origin.id, destinationPlaceId: destination.id, transportationMode: 'scooter' },
      origin,
      destination,
      traces,
      'current',
      [route],
    );
    assert.ok(focus);
    assert.equal(focus.officialTimeMs, officialTimeMs(current.attempt));
    assert.equal(focus.isPb, false);
    assert.equal(focus.comparisonAttemptId, 'pb');
    assert.equal(focus.deltaVsPbMs, (focus.officialTimeMs ?? 0) - (officialTimeMs(pb.attempt) ?? 0));
    assert.equal(focus.resultExplanation.comparisonAttemptId, 'pb');
    assert.equal(focus.pathAnalytics?.comparisonPbAttemptId, 'pb');
    const waiting = focus.resultExplanation.rows.find((row) => row.kind === 'waiting_total');
    assert.ok((waiting?.deltaMs ?? 0) > 30_000);
    const details = focus.resultExplanation.rows.filter((row) => row.kind === 'waiting_location');
    assert.equal(details.length, 1);
    assert.equal(details[0]?.role, 'detail');
    assert.equal(
      focus.resultExplanation.rows.filter((row) => row.role === 'additive' && row.kind === 'waiting_location').length,
      0,
    );
    const ghost = focus.pathAnalytics?.ghostComparison;
    assert.ok(ghost?.available && ghost.currentPolyline && ghost.referencePolyline);
    const waitProgress = details[0]?.progressMeters ?? 400;
    const currentFirst = elapsedOnIncreasingFlanks(ghost.currentPolyline, waitProgress)[0];
    const referenceFirst = elapsedOnIncreasingFlanks(ghost.referencePolyline, waitProgress)[0];
    if (currentFirst != null && referenceFirst != null) {
      assert.ok(
        Math.abs(currentFirst - referenceFirst) < 8_000,
        `unique-first delta ${currentFirst - referenceFirst} must not be the explanation`,
      );
    }
    assert.equal(
      focus.resultExplanation.rows.some((row) => row.deltaMs === 0 && row.kind === 'waiting_location'),
      false,
    );
    assert.notEqual(ghost.finishTriggerDeltaMs, waiting?.deltaMs);
    assert.equal(
      focus.resultExplanation.rows.some((row) => Math.abs(row.deltaMs) === Math.abs(ghost.finishTriggerDeltaMs ?? 0) && row.kind !== 'waiting_total' && row.kind !== 'unexplained_remainder'),
      false,
    );
  });

  it('compares a new journey PB with the previous journey PB', () => {
    const path = longPath();
    const { origin, destination } = journeyPlaces(path);
    const route = routeOnPath('route-a', path);
    const previous = traceOnRoute('previous-pb', route, [{ progressMeters: 160, durationMs: 40_000 }], 5_000, 1_000);
    const current = traceOnRoute('new-pb', route, [{ progressMeters: 160, durationMs: 10_000 }], 200_000, 180_000);
    const focus = analyzeJourneyFocus(
      { originPlaceId: origin.id, destinationPlaceId: destination.id, transportationMode: 'scooter' },
      origin,
      destination,
      [previous, current],
      'new-pb',
      [route],
    );
    assert.ok(focus);
    assert.equal(focus.isPb, true);
    assert.equal(focus.comparisonAttemptId, 'previous-pb');
    assert.equal(focus.resultExplanation.comparisonAttemptId, 'previous-pb');
    assert.ok((focus.deltaVsPbMs ?? 0) < 0);
    const waiting = focus.resultExplanation.rows.find((row) => row.kind === 'waiting_total');
    assert.equal(waiting?.label, 'less waiting');
    assert.ok((waiting?.deltaMs ?? 0) < 0);
  });

  it('does not substitute a path-variant PB when the journey headline target is another path', () => {
    const pathA = longPath();
    const pathB = detourPath(pathA, 80);
    const { origin, destination } = journeyPlaces(pathA);
    const routeA = routeOnPath('route-a', pathA);
    const routeB = routeOnPath('route-b', pathB);
    const bFast = traceOnRoute('b-fast', routeB, [{ progressMeters: 400, durationMs: 8_000 }], 5_000, 1_000);
    const aSlow = traceOnRoute('a-slow', routeA, [{ progressMeters: 400, durationMs: 120_000 }], 80_000, 70_000);
    const aCurrent = traceOnRoute(
      'a-current',
      routeA,
      [{ progressMeters: 400, durationMs: 70_000 }],
      200_000,
      190_000,
    );
    const traces = [bFast, aSlow, aCurrent];
    const focus = analyzeJourneyFocus(
      { originPlaceId: origin.id, destinationPlaceId: destination.id, transportationMode: 'scooter' },
      origin,
      destination,
      traces,
      'a-current',
      [routeA, routeB],
    );
    assert.ok(focus);
    assert.equal(focus.summary.pbAttemptId, 'b-fast');
    assert.equal(focus.comparisonAttemptId, 'b-fast');
    assert.notEqual(focus.pathAnalytics?.comparisonPbAttemptId, 'b-fast');
    assert.equal(focus.pathAnalytics?.comparisonPbAttemptId, 'a-slow');
    assert.equal(focus.resultExplanation.comparisonAttemptId, 'b-fast');
    assert.equal(focus.resultExplanation.pathSpecificAvailable, false);
    assert.equal(
      focus.resultExplanation.rows.some((row) => row.kind === 'waiting_location'),
      false,
    );
    assert.equal(focus.resultExplanation.availability, 'additive');
    const waiting = focus.resultExplanation.rows.find((row) => row.kind === 'waiting_total');
    const pathWait = focus.pathAnalytics?.waitingComparison;
    assert.ok(waiting);
    assert.ok(pathWait?.available);
    assert.ok(waiting.deltaMs > 0, 'headline explanation vs path B must not reuse the path-A waiting gain');
    assert.ok(pathWait.waitingDeltaMs < 0, 'path analytics vs a-slow still reports less waiting');
    if (focus.resultExplanation.additive) {
      const { waitingDeltaMs, movingDeltaMs, remainderMs } = focus.resultExplanation.additive;
      assert.ok(
        Math.abs(waitingDeltaMs + movingDeltaMs + remainderMs - (focus.deltaVsPbMs ?? 0)) <=
          EXPLANATION_RECONCILE_TOLERANCE_MS,
      );
    }
    assert.equal(focus.officialTimeMs, officialTimeMs(aCurrent.attempt));
    assert.equal(focus.rank, 2);
  });

  it('uses the previous journey PB when a new PB is on a different path', () => {
    const pathA = longPath();
    const pathB = detourPath(pathA, 80);
    const { origin, destination } = journeyPlaces(pathA);
    const routeA = routeOnPath('route-a', pathA);
    const routeB = routeOnPath('route-b', pathB);
    const bPrev = traceOnRoute('b-prev', routeB, [{ progressMeters: 400, durationMs: 50_000 }], 5_000, 1_000);
    const aNew = traceOnRoute('a-new', routeA, [{ progressMeters: 400, durationMs: 10_000 }], 200_000, 180_000);
    const focus = analyzeJourneyFocus(
      { originPlaceId: origin.id, destinationPlaceId: destination.id, transportationMode: 'scooter' },
      origin,
      destination,
      [bPrev, aNew],
      'a-new',
      [routeA, routeB],
    );
    assert.ok(focus);
    assert.equal(focus.isPb, true);
    assert.equal(focus.comparisonAttemptId, 'b-prev');
    assert.equal(focus.resultExplanation.comparisonAttemptId, 'b-prev');
    assert.equal(focus.resultExplanation.pathSpecificAvailable, false);
    assert.equal(focus.pathAnalytics?.comparisonPbAttemptId, null);
    assert.equal(focus.resultExplanation.availability, 'additive');
    assert.equal(
      focus.resultExplanation.rows.some((row) => row.kind === 'waiting_location'),
      false,
    );
  });

  it('leaves an unmatched path unexplained instead of inventing path-free waiting', () => {
    const pathA = longPath();
    const { origin, destination } = journeyPlaces(pathA);
    const routeA = routeOnPath('route-a', pathA);
    const pb = traceOnRoute('pb', routeA, [{ progressMeters: 200, durationMs: 10_000 }], 5_000, 1_000);
    const unmatchedSamples = commuteWithBoundedWaits(detourPath(pathA, 80), {
      sessionId: 'unmatched',
      startMs: 200_000,
      waits: [{ progressMeters: 200, durationMs: 10_000 }],
    });
    const unmatchedDerived = deriveCurrentLayoutAttempt(
      timingCourseFromRoute(routeA),
      completedAttempt('unmatched', { routeId: null, armedAtMs: 180_000 }),
      unmatchedSamples,
    );
    const unmatched: JourneyAttemptTrace = {
      attempt: completedAttempt('unmatched', {
        routeId: null,
        armedAtMs: 180_000,
        startedAtMs: unmatchedSamples[2]?.recordedAtMs ?? 202_000,
        finishedAtMs: unmatchedSamples[unmatchedSamples.length - 2]?.recordedAtMs ?? 400_000,
      }),
      samples: unmatchedSamples,
    };
    const focus = analyzeJourneyFocus(
      { originPlaceId: origin.id, destinationPlaceId: destination.id, transportationMode: 'scooter' },
      origin,
      destination,
      [pb, unmatched],
      'unmatched',
      [routeA],
    );
    assert.ok(focus);
    assert.equal(focus.pathUnavailable, true);
    assert.equal(focus.pathAnalytics, null);
    assert.equal(focus.comparisonAttemptId, 'pb');
    assert.equal(unmatchedDerived.eligible, false);
    assert.equal(focus.resultExplanation.availability, 'headline_only');
    assert.equal(focus.resultExplanation.rows.length, 0);
    assert.ok((focus.deltaVsPbMs ?? 0) !== 0);
  });
});
