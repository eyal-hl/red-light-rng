import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START } from '../src/domain/attempt';
import { PLACE_ACTIVE_MAX_DURATION_MS, PLACE_ARMED_MAX_DURATION_MS } from '../src/domain/place-timing';
import {
  createAttemptResultShell,
  journeyPoolForAttempt,
  loadAttemptResultSecondary,
  type AttemptResultSecondaryUpdate,
} from '../src/product/attempt-result-load';
import { departureOnlySamples, dwellSamples, makePlace } from './helpers/places';
import { offsetLatLng } from './helpers/samples';
import { createMemoryWorkspace } from './helpers/workspace';

describe('attempt result secondary load', () => {
  it('paints DID NOT START shell before debug inspection and never fabricates path analytics', async () => {
    let now = 1_700_000_000_000;
    const { workspace, sessions } = createMemoryWorkspace({ now: () => now });
    const origin = await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: 30,
    });
    assert.equal(origin.ok, true);
    if (!origin.ok) {
      return;
    }

    const armed = await workspace.startAttempt();
    assert.equal(armed.ok, true);
    await sessions.appendSamples(
      dwellSamples(origin.place.center, {
        sessionId: 'id-1',
        startMs: now,
        count: 6,
        intervalMs: 1000,
      }),
    );
    now += PLACE_ARMED_MAX_DURATION_MS;
    const timedOut = await workspace.processActiveAttempt();
    assert.equal(timedOut?.lifecycle, 'ended');
    assert.equal(timedOut?.startedAtMs, null);
    assert.equal(timedOut?.originPlaceId, null);
    assert.equal(timedOut?.destinationPlaceId, null);

    workspace.resetNavigationLoad();
    const shell = createAttemptResultShell(timedOut!);
    assert.equal(shell.debug, null);
    assert.equal(shell.debugPending, true);
    assert.equal(shell.pathAnalyticsPending, false);
    assert.equal(journeyPoolForAttempt(timedOut!), null);
    assert.equal(workspace.navigationLoad.counters.inspectAttemptReads, 0);
    assert.equal(workspace.navigationLoad.counters.analyzeJourneyReads, 0);

    const updates: AttemptResultSecondaryUpdate[] = [];
    const secondary = await loadAttemptResultSecondary(workspace, timedOut!, (update) => {
      updates.push(update);
    });

    assert.ok(updates.some((update) => update.kind === 'debug'));
    assert.ok(updates.some((update) => update.kind === 'pathAnalytics' && update.skipped));
    assert.equal(secondary.pathAnalyticsSkipped, true);
    assert.equal(secondary.pathAnalytics, null);
    assert.equal(secondary.pathAnalyticsError, null);
    assert.equal(secondary.debug?.place.incompleteLabel, 'DID NOT START');
    assert.equal(secondary.debug?.place.armedTimeout, true);
    assert.ok((secondary.debug?.place.recordedPath.length ?? 0) > 0);
    assert.ok((secondary.debug?.place.rawSampleCount ?? 0) > 0);
    assert.equal(workspace.navigationLoad.counters.inspectAttemptReads, 1);
    assert.equal(workspace.navigationLoad.counters.analyzeJourneyReads, 0);
    assert.ok(workspace.navigationLoad.counters.listSamplesCalls >= 1);
  });

  it('paints DID NOT FINISH shell before debug inspection and skips journey analysis without a pool', async () => {
    let now = 1_700_000_000_000;
    const { workspace, sessions } = createMemoryWorkspace({ now: () => now, attemptId: 'attempt-dnf' });
    const origin = await workspace.createPlace({
      name: 'Home',
      center: { latitude: 32.08, longitude: 34.78 },
      radiusMeters: 30,
    });
    const dest = await workspace.createPlace({
      name: 'Work',
      center: offsetLatLng(32.08, 34.78, 300, 0),
      radiusMeters: 30,
    });
    assert.equal(origin.ok && dest.ok, true);
    if (!origin.ok || !dest.ok) {
      return;
    }

    await workspace.startAttempt();
    await sessions.appendSamples(
      departureOnlySamples({ origin: origin.place, sessionId: 'id-1', extraMeters: 40 }),
    );
    const active = await workspace.processActiveAttempt();
    assert.equal(active?.lifecycle, 'active');
    now = (active?.startedAtMs ?? now) + PLACE_ACTIVE_MAX_DURATION_MS;
    const dnf = await workspace.processActiveAttempt();
    assert.equal(dnf?.lifecycle, 'ended');
    assert.ok(dnf?.startedAtMs != null);
    assert.ok(dnf?.originPlaceId);
    assert.equal(dnf?.destinationPlaceId, null);

    workspace.resetNavigationLoad();
    const shell = createAttemptResultShell(dnf!);
    assert.equal(shell.debugPending, true);
    assert.equal(shell.pathAnalyticsPending, false);
    assert.equal(journeyPoolForAttempt(dnf!), null);
    assert.equal(workspace.navigationLoad.counters.inspectAttemptReads, 0);

    const secondary = await loadAttemptResultSecondary(workspace, dnf!);
    assert.equal(secondary.pathAnalyticsSkipped, true);
    assert.equal(secondary.pathAnalytics, null);
    assert.equal(secondary.debug?.place.incompleteLabel, 'DID NOT FINISH');
    assert.ok((secondary.debug?.place.recordedPath.length ?? 0) > 0);
    assert.ok((secondary.debug?.place.rawSampleCount ?? 0) > 0);
    assert.equal(workspace.navigationLoad.counters.inspectAttemptReads, 1);
    assert.equal(workspace.navigationLoad.counters.analyzeJourneyReads, 0);
  });

  it('keeps debug when path analytics fails and keeps path analytics when debug fails', async () => {
    const { workspace, sessions, attempts, places } = createMemoryWorkspace();
    const home = makePlace({ id: 'place-home', name: 'Home' });
    const work = makePlace({
      id: 'place-work',
      name: 'Work',
      center: offsetLatLng(home.center.latitude, home.center.longitude, 1000, 0),
      createdAtMs: 2,
    });
    await places.createPlace(home);
    await places.createPlace(work);
    const attempt = {
      id: 'hw-1',
      sessionId: 'session-hw-1',
      lifecycle: 'completed' as const,
      validity: 'valid' as const,
      armedAtMs: 1_700_000_000_000 - 5_000,
      startedAtMs: 1_700_000_000_000,
      finishedAtMs: 1_700_000_000_000 + 99_000,
      ...EMPTY_ATTEMPT_LOCAL_START,
      resultAcknowledged: true,
      crossings: [],
      routeId: null,
      originPlaceId: home.id,
      destinationPlaceId: work.id,
      transportationMode: 'scooter' as const,
    };
    sessions.seedSession(
      {
        id: attempt.sessionId,
        startedAtMs: attempt.startedAtMs,
        stoppedAtMs: attempt.finishedAtMs,
        isActive: false,
        purpose: 'attempt',
        captureOutcome: 'finished',
        reviewDisposition: 'saved',
        lastSampleAtMs: attempt.finishedAtMs,
        backgroundPermissionConfirmed: true,
      },
      dwellSamples(home.center, {
        sessionId: attempt.sessionId,
        startMs: attempt.startedAtMs,
        count: 8,
        intervalMs: 1000,
      }),
    );
    await attempts.createAttempt(attempt);

    const debugSurvives = await loadAttemptResultSecondary(
      {
        inspectAttempt: (attemptId) => workspace.inspectAttempt(attemptId),
        analyzeJourney: async () => {
          throw new Error('path exploded');
        },
      },
      attempt,
    );
    assert.ok(debugSurvives.debug?.place);
    assert.equal(debugSurvives.pathAnalytics, null);
    assert.equal(debugSurvives.pathAnalyticsSkipped, false);
    assert.match(debugSurvives.pathAnalyticsError ?? '', /path exploded/);
    assert.equal(debugSurvives.debugError, null);

    const pathSurvives = await loadAttemptResultSecondary(
      {
        inspectAttempt: async () => {
          throw new Error('debug exploded');
        },
        analyzeJourney: (pool, attemptId) => workspace.analyzeJourney(pool, attemptId),
      },
      attempt,
    );
    assert.equal(pathSurvives.debug, null);
    assert.ok(pathSurvives.pathAnalytics?.focus?.officialTimeMs != null);
    assert.equal(pathSurvives.pathAnalyticsSkipped, false);
    assert.match(pathSurvives.debugError ?? '', /debug exploded/);
    assert.equal(pathSurvives.pathAnalyticsError, null);
  });

  it('wires AppRoot to paint the result shell before independent debug inspection', () => {
    const appRoot = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const resultScreen = readFileSync('src/ui/AttemptResultScreen.tsx', 'utf8');
    const showAttemptResult = appRoot.slice(
      appRoot.indexOf('const showAttemptResult'),
      appRoot.indexOf('const applyStartupSnapshot'),
    );

    assert.match(showAttemptResult, /createAttemptResultShell\(attempt\)/);
    assert.match(showAttemptResult, /setScreen\(nextScreen\);\s*void loadAttemptResultSecondary/s);
    assert.match(showAttemptResult, /workspace\.inspectAttempt|loadAttemptResultSecondary/);
    assert.doesNotMatch(showAttemptResult, /if \(!pool\) \{/);
    assert.match(appRoot, /debugPending=\{debugPending\}/);
    assert.match(appRoot, /pathAnalyticsPending=\{pathAnalyticsPending\}/);
    assert.match(resultScreen, /Loading debug trace…/);
    assert.match(resultScreen, /debugPending \?/);
    assert.match(resultScreen, /pathAnalyticsPending \?/);
  });
});
