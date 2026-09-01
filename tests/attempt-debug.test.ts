import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { timingCourseFromRoute } from '../src/domain/attempt-analysis';
import {
  inspectAttempt,
  inspectAttemptRecord,
  nearestDebugSample,
} from '../src/domain/attempt-debug';
import { replayAttemptTrace } from '../src/domain/attempt-timing';
import { createCourseMatchState, matchSampleToCourse } from '../src/domain/course-matching';
import type { RouteWorkspace } from '../src/product/route-workspace';
import { makeRoute, northPath } from './helpers/routes';
import { movingTrace, offsetLatLng, sample, traceAlongPath } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

async function saveDefaultRoute(
  workspace: RouteWorkspace,
  sessions: { appendSamples: (samples: ReturnType<typeof movingTrace>) => Promise<void> },
) {
  await workspace.startRouteRecording();
  await sessions.appendSamples(movingTrace({ sessionId: 'id-1', points: 16, stepMeters: 15 }));
  await workspace.finishRecording();
  const saved = await workspace.saveRoute('id-1', 'Home → Work', 'scooter');
  assert.equal(saved.ok, true);
  if (!saved.ok) {
    throw new Error('expected saved route');
  }
  return saved.route;
}

describe('attempt debug inspection', () => {
  it('replays the shared matcher and counts accepted vs rejected qualities', () => {
    const route = makeRoute({ referencePath: northPath({ points: 16, stepMeters: 20 }) });
    const course = timingCourseFromRoute(route);
    const accepted = traceAlongPath(course.referencePath, {
      sessionId: 'run',
      stepMeters: 6,
      count: 12,
    });
    const poor = sample({
      id: 'poor',
      sessionId: 'run',
      recordedAtMs: accepted[0]!.recordedAtMs - 1000,
      latitude: accepted[0]!.latitude,
      longitude: accepted[0]!.longitude,
      horizontalAccuracyMeters: 80,
    });
    const last = accepted[accepted.length - 1]!;
    const drifted = offsetLatLng(last.latitude, last.longitude, 0, 80);
    const off = sample({
      id: 'off',
      sessionId: 'run',
      recordedAtMs: last.recordedAtMs + 1000,
      latitude: drifted.latitude,
      longitude: drifted.longitude,
    });
    const samples = [poor, ...accepted, off];
    const report = inspectAttempt(course, samples);

    let matchState = createCourseMatchState();
    let acceptedCount = 0;
    const rejected = { poor_accuracy: 0, off_course: 0, out_of_window: 0, unprojected: 0 };
    for (const item of samples) {
      const match = matchSampleToCourse(course.referencePath, item, matchState, course.startProgressMeters);
      if (match.accepted) {
        matchState = match.state;
        acceptedCount += 1;
      } else if (match.quality !== 'accepted') {
        rejected[match.quality] += 1;
      }
    }

    assert.equal(report.rawSampleCount, samples.length);
    assert.equal(report.acceptedCount, acceptedCount);
    assert.deepEqual(report.rejectedByQuality, rejected);
    assert.ok(report.rejectedByQuality.poor_accuracy >= 1);
    assert.ok(report.rejectedByQuality.off_course >= 1);
    assert.equal(report.recordedPath.length, samples.length);
    assert.equal(report.samples.some((entry) => !entry.match.accepted), true);
  });

  it('explains a missing pre-start when the rider is already past the start line', () => {
    const route = makeRoute({
      referencePath: northPath({ points: 16, stepMeters: 20 }),
      startProgressMeters: 40,
    });
    const course = timingCourseFromRoute(route);
    const samples = traceAlongPath(course.referencePath, {
      startProgressMeters: 60,
      stepMeters: 5,
      count: 10,
    });
    const engine = replayAttemptTrace(course, samples);
    const report = inspectAttemptRecord(
      { lifecycle: 'ended', startedAtMs: engine.startedAtMs },
      course,
      samples,
    );
    assert.equal(engine.lifecycle, 'armed');
    assert.equal(report.preStartRequired, true);
    assert.equal(report.sawPreStart, false);
    assert.equal(report.qualifyingDepartureFound, true);
    assert.equal(report.reconstructedStartAtMs, null);
    assert.equal(report.incompleteLabel, 'DID NOT START');
  });

  it('keeps qualifyingDepartureFound after a later parked window when pre-start is still missing', () => {
    const route = makeRoute({
      referencePath: northPath({ points: 16, stepMeters: 20 }),
      startProgressMeters: 40,
    });
    const course = timingCourseFromRoute(route);
    const moving = traceAlongPath(course.referencePath, {
      startProgressMeters: 60,
      stepMeters: 5,
      count: 10,
    });
    const parkedAt = moving[moving.length - 1]!;
    const parked = Array.from({ length: 8 }, (_, index) =>
      sample({
        id: `parked-${index}`,
        sessionId: parkedAt.sessionId,
        recordedAtMs: parkedAt.recordedAtMs + (index + 1) * 1000,
        latitude: parkedAt.latitude,
        longitude: parkedAt.longitude,
        speedMetersPerSecond: 0,
      }),
    );
    const samples = [...moving, ...parked];
    const movingReport = inspectAttempt(course, moving);
    const parkedReport = inspectAttemptRecord(
      { lifecycle: 'ended', startedAtMs: null },
      course,
      samples,
    );

    assert.equal(movingReport.engine.lifecycle, 'armed');
    assert.equal(movingReport.qualifyingDepartureFound, true);
    assert.ok((movingReport.departure.advanceMeters ?? 0) >= movingReport.departure.minAdvanceMeters);

    assert.equal(parkedReport.engine.lifecycle, 'armed');
    assert.equal(parkedReport.preStartRequired, true);
    assert.equal(parkedReport.sawPreStart, false);
    assert.equal(parkedReport.qualifyingDepartureFound, true);
    assert.equal(parkedReport.incompleteLabel, 'DID NOT START');
    assert.ok((parkedReport.departure.advanceMeters ?? 0) < parkedReport.departure.minAdvanceMeters);
    assert.equal(parkedReport.reconstructedStartAtMs, null);
  });

  it('explains an insufficient 18 m / 4-sample / 5 s departure window', () => {
    const route = makeRoute({ referencePath: northPath({ points: 16, stepMeters: 20 }) });
    const course = timingCourseFromRoute(route);
    const samples = traceAlongPath(course.referencePath, {
      startProgressMeters: 0,
      stepMeters: 2,
      count: 3,
      intervalMs: 1000,
    });
    const report = inspectAttempt(course, samples);
    assert.equal(report.engine.lifecycle, 'armed');
    assert.equal(report.qualifyingDepartureFound, false);
    assert.ok(report.departure.windowSampleCount < report.departure.minSamples);
    assert.equal(report.departure.minAdvanceMeters, 18);
    assert.equal(report.departure.minSamples, 4);
    assert.equal(report.departure.windowMs, 5000);
    assert.equal(report.reconstructedStartAtMs, null);
  });

  it('exposes start-zone evidence, finish-trigger state, and sample selection', () => {
    const route = makeRoute({ referencePath: northPath({ points: 16, stepMeters: 20 }) });
    const course = timingCourseFromRoute(route);
    const samples = traceAlongPath(course.referencePath, {
      startProgressMeters: 0,
      stepMeters: 6,
      count: 55,
    });
    const report = inspectAttempt(course, samples);
    assert.equal(report.anyAcceptedInStartZone, true);
    assert.equal(report.finishTriggerReachedAfterStart, true);
    assert.ok(report.officialStartPoint != null);
    assert.ok(report.officialFinishPoint != null);
    const target = samples[4]!;
    const selected = nearestDebugSample(report.samples, {
      latitude: target.latitude,
      longitude: target.longitude,
    });
    assert.equal(selected?.sample.id, target.id);
    assert.equal(typeof selected?.inStartZone, 'boolean');
    assert.equal(typeof selected?.match.accepted, 'boolean');
  });

  it('does not import platform location APIs', () => {
    const source = readFileSync('src/domain/attempt-debug.ts', 'utf8');
    assert.doesNotMatch(source, /expo-location|expo-task-manager|android\.permission|UIBackgroundModes/);
    assert.doesNotMatch(source, /@maplibre\/maplibre-react-native|maplibre/);
  });
});

describe('end and inspect workspace flow', () => {
  it('retains ARM-session samples before official start and inspects them', async () => {
    const { workspace, sessions } = createMemoryWorkspace();
    const route = await saveDefaultRoute(workspace, sessions);
    await workspace.armRun(route.id);
    await sessions.appendSamples(
      traceAlongPath(route.referencePath, { sessionId: 'id-2', stepMeters: 4, count: 3 }),
    );
    assert.equal(await sessions.countSamples('id-2'), 3);
    const ended = await workspace.endAndInspectAttempt();
    assert.equal(ended?.lifecycle, 'ended');
    assert.equal(await sessions.countSamples('id-2'), 3);
    const debug = await workspace.inspectAttempt(ended!.id);
    assert.equal(debug?.place.rawSampleCount, 3);
    assert.equal(debug?.place.samples.length, 3);
    assert.equal(debug?.place.incompleteLabel, 'DID NOT START');
  });
});
