import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START } from '../src/domain/attempt';
import { PLACE_ACTIVE_MAX_DURATION_MS, PLACE_ARMED_MAX_DURATION_MS } from '../src/domain/place-timing';
import { JourneyFocusStoppedError } from '../src/domain/journey-analysis';
import {
  ATTEMPT_ACK_FAILURE_MESSAGE,
  PATH_ANALYTICS_BUDGET_MESSAGE,
  PATH_ANALYTICS_INTERRUPTED_MESSAGE,
  acknowledgementFailureStillVisible,
  beginResultOpen,
  claimAcknowledgement,
  createAttemptResultShell,
  forwardAbortSignal,
  beginAttemptClose,
  beginResultPresentation,
  captureResultWork,
  captureResumeWatch,
  createResultSession,
  finishAttemptClose,
  hideNavigationAfterDismiss,
  invalidateResultPresentation,
  isCurrentPathAnalyticsLoad,
  isCurrentResultRequest,
  isCurrentSecondaryLoad,
  journeyPoolForAttempt,
  modeUpdateMayReopen,
  openResultSession,
  restoreMayTouchAttempt,
  resumeMayReopenAttempt,
  retryPathAnalyticsSession,
  startResultLoads,
  loadAttemptPathAnalytics,
  loadAttemptResultSecondary,
  nextResultRequest,
  nextSecondaryLoad,
  releaseAcknowledgement,
  resultExitDestination,
  settledPathAnalyticsView,
  successorResultOpen,
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
    assert.equal(pathSurvives.pathAnalytics?.focus?.officialTimeMs, 99_000);
    assert.equal(pathSurvives.pathAnalytics?.focus?.pathAnalytics, null);
    assert.equal(pathSurvives.pathAnalytics?.focus?.pathUnavailable, true);
    assert.equal(pathSurvives.pathAnalyticsSkipped, false);
    assert.match(pathSurvives.debugError ?? '', /debug exploded/);
    assert.equal(pathSurvives.pathAnalyticsError, null);
    assert.equal(pathSurvives.pathAnalyticsCancelled, false);
  });

  it('bounds a hung path-analytics load and ignores a late success', async () => {
    let resolveHung: ((value: null) => void) | null = null;
    const updates: AttemptResultSecondaryUpdate[] = [];
    const secondary = await loadAttemptResultSecondary(
      {
        inspectAttempt: async () => null,
        analyzeJourney: () =>
          new Promise((resolve) => {
            resolveHung = resolve;
          }),
      },
      {
        id: 'hw-hung',
        sessionId: 'session-hung',
        lifecycle: 'completed',
        validity: 'valid',
        armedAtMs: 1_700_000_000_000 - 5_000,
        startedAtMs: 1_700_000_000_000,
        finishedAtMs: 1_700_000_000_000 + 99_000,
        ...EMPTY_ATTEMPT_LOCAL_START,
        resultAcknowledged: true,
        crossings: [],
        routeId: null,
        originPlaceId: 'place-home',
        destinationPlaceId: 'place-work',
        transportationMode: 'scooter',
      },
      (update) => {
        updates.push(update);
      },
      { pathAnalyticsBudgetMs: 30 },
    );

    assert.equal(secondary.debug, null);
    assert.equal(secondary.debugError, null);
    assert.equal(secondary.pathAnalytics, null);
    assert.equal(secondary.pathAnalyticsError, PATH_ANALYTICS_BUDGET_MESSAGE);
    assert.equal(secondary.pathAnalyticsCancelled, false);
    resolveHung?.(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pathUpdates = updates.filter((update) => update.kind === 'pathAnalytics');
    assert.equal(pathUpdates.length, 1);
    assert.equal(pathUpdates[0]?.kind === 'pathAnalytics' ? pathUpdates[0].pathAnalyticsError : null, PATH_ANALYTICS_BUDGET_MESSAGE);
  });

  it('cancels path analytics on abort without turning that into a load failure', async () => {
    const controller = new AbortController();
    const updates: AttemptResultSecondaryUpdate[] = [];
    const pending = loadAttemptResultSecondary(
      {
        inspectAttempt: async () => null,
        analyzeJourney: () => new Promise(() => {}),
      },
      {
        id: 'hw-abort',
        sessionId: 'session-abort',
        lifecycle: 'completed',
        validity: 'valid',
        armedAtMs: 1_700_000_000_000 - 5_000,
        startedAtMs: 1_700_000_000_000,
        finishedAtMs: 1_700_000_000_000 + 99_000,
        ...EMPTY_ATTEMPT_LOCAL_START,
        resultAcknowledged: true,
        crossings: [],
        routeId: null,
        originPlaceId: 'place-home',
        destinationPlaceId: 'place-work',
        transportationMode: 'scooter',
      },
      (update) => {
        updates.push(update);
      },
      { signal: controller.signal, pathAnalyticsBudgetMs: 5_000 },
    );
    controller.abort();
    const secondary = await pending;
    assert.equal(secondary.pathAnalyticsCancelled, true);
    assert.equal(secondary.pathAnalyticsError, null);
    assert.equal(secondary.pathAnalytics, null);
    const pathUpdate = updates.find((update) => update.kind === 'pathAnalytics');
    assert.equal(pathUpdate?.kind === 'pathAnalytics' ? pathUpdate.cancelled : false, true);
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
    assert.ok(showAttemptResult.indexOf('void loadAttemptResultSecondary') < showAttemptResult.indexOf('if (!pool)'));
    assert.match(appRoot, /debugPending=\{debugPending\}/);
    assert.match(appRoot, /pathAnalyticsPending=\{pathAnalyticsPending\}/);
    assert.match(appRoot, /yieldToIdle: yieldToEventLoop/);
    assert.match(appRoot, /onRetryPathAnalytics=\{retryPathAnalytics\}/);
    assert.match(showAttemptResult, /applyPathAnalyticsUpdate\(pathToken, update\)/);
    const acknowledge = appRoot.slice(
      appRoot.indexOf('const onAcknowledgeAttempt'),
      appRoot.indexOf('const leaveResultAfterHide'),
    );
    const screenAt = acknowledge.indexOf('setScreen(next)');
    const acknowledgeAt = acknowledge.indexOf('await workspace.acknowledgeAttemptResult');
    assert.ok(acknowledge.indexOf("kind: 'journey'") >= 0);
    assert.ok(screenAt >= 0 && acknowledgeAt > screenAt);
    assert.doesNotMatch(acknowledge, /setBusy\(true\)/);
    assert.match(acknowledge, /beginAttemptClose/);
    assert.match(acknowledge, /finishAttemptClose/);
    assert.match(acknowledge, /pathAnalyticsAbortRef\.current\?\.abort\(\)/);
    assert.match(acknowledge, /setDebugPending\(false\)/);
    assert.match(acknowledge, /ATTEMPT_ACK_FAILURE_MESSAGE/);
    const shellPaint = showAttemptResult.slice(0, showAttemptResult.indexOf('analyzeJourneyHeadline'));
    assert.match(shellPaint, /setScreen\(nextScreen\)/);
    assert.match(shellPaint, /open\.finish\(\)/);
    assert.match(shellPaint, /beginResultPresentation/);
    assert.match(shellPaint, /startResultLoads/);
    const retry = appRoot.slice(appRoot.indexOf('const retryPathAnalytics'), appRoot.indexOf('const leaveToHome'));
    assert.match(retry, /retryPathAnalyticsSession/);
    assert.doesNotMatch(retry, /nextSecondaryLoad/);
    assert.match(appRoot, /modeUpdateMayReopen/);
    assert.match(appRoot, /resumeMayReopenAttempt/);
    assert.match(appRoot, /hideNavigationAfterDismiss/);
    assert.match(appRoot, /restoreMayTouchAttempt/);
    assert.doesNotMatch(appRoot, /secondaryLoadTokenRef/);
    assert.match(showAttemptResult, /adoptSuccessor/);
    assert.match(showAttemptResult, /pathViewRef\.current === 'ready'/);
    assert.doesNotMatch(showAttemptResult, /kind: 'init-error'/);
    assert.match(resultScreen, /Loading debug trace…/);
    assert.match(resultScreen, /debugPending \?/);
    assert.match(resultScreen, /pathAnalyticsPending \?/);
    assert.match(resultScreen, /PATH_ANALYTICS_UNAVAILABLE_MESSAGE/);
    assert.match(resultScreen, /pathAnalyticsUnavailable \|\| journey\?\.pathUnavailable/);
    assert.match(resultScreen, /Retry path analytics/);
    assert.match(resultScreen, /disabled=\{busy\}/);
    assert.doesNotMatch(resultScreen, /disabled=\{[^}]*pathAnalyticsPending/);
    const doneButton = resultScreen.slice(resultScreen.indexOf('accessibilityLabel={doneLabel}'));
    assert.doesNotMatch(doneButton.slice(0, doneButton.indexOf('</Pressable>')), /disabled=/);
    assert.match(appRoot, /forwardAbortSignal/);
    assert.equal(PATH_ANALYTICS_INTERRUPTED_MESSAGE.includes('interrupted'), true);
  });

  it('makes a superseded result open wait for the replacement', async () => {
    const first = beginResultOpen(1);
    const second = beginResultOpen(2);
    const followed = successorResultOpen(second, first.requestId);
    assert.ok(followed);
    let settled = false;
    const pending = followed!.then(() => {
      settled = true;
    });
    assert.equal(settled, false);
    second.finish();
    await pending;
    assert.equal(settled, true);
    assert.equal(successorResultOpen(second, second.requestId), null);

    const failing = beginResultOpen(3);
    const chained = successorResultOpen(failing, first.requestId);
    const rejection = chained!.then(
      () => null,
      (error: unknown) => error,
    );
    failing.finish(new Error('headline exploded'));
    const error = await rejection;
    assert.ok(error instanceof Error);
    assert.match(error.message, /headline exploded/);
    failing.finish(new Error('second finish'));
  });

  it('keeps an in-flight path load current until a replacement load starts', () => {
    const initial = { requestId: 2, loadToken: 5, pathToken: 7 };
    const reopened = nextResultRequest(initial);
    assert.equal(reopened.loadToken, initial.loadToken);
    assert.equal(reopened.pathToken, initial.pathToken);
    assert.equal(isCurrentResultRequest(reopened, initial.requestId), false);
    assert.equal(isCurrentSecondaryLoad(reopened, initial.loadToken), true);
    assert.equal(isCurrentPathAnalyticsLoad(reopened, initial.pathToken), true);

    const replaced = nextSecondaryLoad(reopened);
    assert.equal(replaced.requestId, reopened.requestId);
    assert.equal(replaced.pathToken, initial.pathToken);
    assert.equal(isCurrentSecondaryLoad(replaced, initial.loadToken), false);
    assert.equal(isCurrentPathAnalyticsLoad(replaced, initial.pathToken), true);
    assert.equal(isCurrentResultRequest(replaced, reopened.requestId), true);

    const left = invalidateResultPresentation(reopened);
    assert.equal(isCurrentResultRequest(left, reopened.requestId), false);
    assert.equal(isCurrentSecondaryLoad(left, reopened.loadToken), false);
    assert.equal(isCurrentPathAnalyticsLoad(left, reopened.pathToken), false);
  });

  it('keeps the budget result when a yielded analysis finishes late', async () => {
    const updates: AttemptResultSecondaryUpdate[] = [];
    const secondary = await loadAttemptPathAnalytics(
      {
        inspectAttempt: async () => null,
        analyzeJourney: async (_pool, _attemptId, options) => {
          await options?.yieldToIdle?.();
          if (options?.shouldContinue && !options.shouldContinue()) {
            throw new JourneyFocusStoppedError();
          }
          return null;
        },
      },
      {
        id: 'hw-yield',
        sessionId: 'session-yield',
        lifecycle: 'completed',
        validity: 'valid',
        armedAtMs: 1_700_000_000_000 - 5_000,
        startedAtMs: 1_700_000_000_000,
        finishedAtMs: 1_700_000_000_000 + 99_000,
        ...EMPTY_ATTEMPT_LOCAL_START,
        resultAcknowledged: true,
        crossings: [],
        routeId: null,
        originPlaceId: 'place-home',
        destinationPlaceId: 'place-work',
        transportationMode: 'scooter',
      },
      (update) => {
        updates.push(update);
      },
      {
        pathAnalyticsBudgetMs: 20,
        yieldToIdle: () => new Promise((resolve) => setTimeout(resolve, 40)),
      },
    );

    assert.equal(secondary.pathAnalyticsError, PATH_ANALYTICS_BUDGET_MESSAGE);
    assert.equal(secondary.pathAnalytics, null);
    assert.equal(secondary.cancelled, false);
    assert.equal(updates.length, 1);
  });

  it('lets a slow yielding cohort finish when each step stays inside the stall budget', async () => {
    let steps = 0;
    const started = Date.now();
    const secondary = await loadAttemptPathAnalytics(
      {
        inspectAttempt: async () => null,
        analyzeJourney: async (_pool, _attemptId, options) => {
          for (let index = 0; index < 4; index += 1) {
            await options?.yieldToIdle?.();
            if (options?.shouldContinue && !options.shouldContinue()) {
              throw new JourneyFocusStoppedError();
            }
            steps += 1;
          }
          return null;
        },
      },
      {
        id: 'hw-slow',
        sessionId: 'session-slow',
        lifecycle: 'completed',
        validity: 'valid',
        armedAtMs: 1_700_000_000_000 - 5_000,
        startedAtMs: 1_700_000_000_000,
        finishedAtMs: 1_700_000_000_000 + 99_000,
        ...EMPTY_ATTEMPT_LOCAL_START,
        resultAcknowledged: true,
        crossings: [],
        routeId: null,
        originPlaceId: 'place-home',
        destinationPlaceId: 'place-work',
        transportationMode: 'scooter',
      },
      undefined,
      {
        pathAnalyticsBudgetMs: 40,
        yieldToIdle: () => new Promise((resolve) => setTimeout(resolve, 25)),
      },
    );

    assert.ok(Date.now() - started >= 80);
    assert.equal(steps, 4);
    assert.equal(secondary.pathAnalyticsError, null);
    assert.equal(secondary.cancelled, false);
    assert.equal(settledPathAnalyticsView(secondary), 'unavailable');
  });

  it('treats a null journey analysis as unavailable and a matching focus as ready', () => {
    assert.equal(
      settledPathAnalyticsView({
        pathAnalytics: null,
        pathAnalyticsError: null,
        skipped: false,
        cancelled: false,
      }),
      'unavailable',
    );
    assert.equal(
      settledPathAnalyticsView({
        pathAnalytics: { focus: null },
        pathAnalyticsError: null,
        skipped: false,
        cancelled: false,
      }),
      'unavailable',
    );
    assert.equal(
      settledPathAnalyticsView({
        pathAnalytics: { focus: { pathUnavailable: true } },
        pathAnalyticsError: null,
        skipped: false,
        cancelled: false,
      }),
      'unavailable',
    );
    assert.equal(
      settledPathAnalyticsView({
        pathAnalytics: { focus: { pathUnavailable: false } },
        pathAnalyticsError: null,
        skipped: false,
        cancelled: false,
      }),
      'ready',
    );
    assert.equal(
      settledPathAnalyticsView({
        pathAnalytics: null,
        pathAnalyticsError: null,
        skipped: true,
        cancelled: false,
      }),
      'skipped',
    );
  });

  it('leaves the result before acknowledgement and ignores a repeated close', () => {
    const attempt = {
      id: 'hw-ack',
      sessionId: 'session-ack',
      lifecycle: 'completed' as const,
      validity: 'valid' as const,
      armedAtMs: 1,
      startedAtMs: 2,
      finishedAtMs: 12,
      ...EMPTY_ATTEMPT_LOCAL_START,
      resultAcknowledged: false,
      crossings: [],
      routeId: null,
      originPlaceId: 'place-home',
      destinationPlaceId: 'place-work',
      transportationMode: 'scooter' as const,
    };
    const first = claimAcknowledgement(null, attempt.id);
    const destination = resultExitDestination(attempt);
    assert.equal(first.claimed, true);
    assert.equal(destination.kind, 'journey');
    const repeated = claimAcknowledgement(first.lease, attempt.id);
    assert.equal(repeated.claimed, false);
    assert.equal(resultExitDestination({ ...attempt, originPlaceId: null }).kind, 'home');
    const released = releaseAcknowledgement(first.lease, attempt.id);
    assert.equal(released, null);
    assert.equal(claimAcknowledgement(released, attempt.id).claimed, true);
    assert.equal(
      acknowledgementFailureStillVisible(
        { kind: 'journey', pool: destination.kind === 'journey' ? destination.pool : undefined },
        destination,
      ),
      true,
    );
    assert.equal(acknowledgementFailureStillVisible({ kind: 'home' }, destination), false);
    assert.equal(acknowledgementFailureStillVisible({ kind: 'home' }, { kind: 'home' }), true);
    assert.match(ATTEMPT_ACK_FAILURE_MESSAGE, /next time the app opens/);
  });

  it('releases a close when acknowledgement succeeds or fails, and a repeated back does nothing', () => {
    const attemptId = 'hw-close';
    let session = openResultSession(createResultSession()).session;
    const first = beginAttemptClose(session, attemptId);
    assert.equal(first.claimed, true);
    session = first.session;
    const repeated = beginAttemptClose(session, attemptId);
    assert.equal(repeated.claimed, false);
    assert.equal(repeated.session.gate.requestId, session.gate.requestId);
    assert.equal(repeated.session.acknowledgement?.attemptId, attemptId);

    session = finishAttemptClose(session, attemptId, first.generation);
    assert.equal(session.acknowledgement, null);
    assert.equal(session.dismissal.attemptId, attemptId);
    const afterSuccess = beginAttemptClose(session, attemptId);
    assert.equal(afterSuccess.claimed, true);

    session = finishAttemptClose(afterSuccess.session, attemptId, afterSuccess.generation);
    const failed = beginAttemptClose(session, attemptId);
    session = finishAttemptClose(failed.session, attemptId, failed.generation);
    assert.equal(session.acknowledgement, null);
    assert.equal(beginAttemptClose(session, attemptId).claimed, true);
  });

  it('does not reopen a result that Done left while mode, hide, restore, or resume were in flight', () => {
    const attemptId = 'hw-race';
    let session = openResultSession(createResultSession()).session;
    const modeCaptured = captureResultWork(session);
    const hideCaptured = captureResultWork(session);
    const restoreCaptured = captureResultWork(session);
    const resumeBeforeClose = captureResumeWatch(session);
    assert.equal(modeUpdateMayReopen(session, modeCaptured, attemptId), true);
    assert.equal(
      hideNavigationAfterDismiss(session, attemptId, hideCaptured, 'attempt-result', 'attempt-result'),
      'home',
    );
    assert.equal(restoreMayTouchAttempt(session, attemptId, restoreCaptured), true);

    const close = beginAttemptClose(session, attemptId);
    session = close.session;
    const resumeDuringClose = captureResumeWatch(session);
    assert.equal(modeUpdateMayReopen(session, modeCaptured, attemptId), false);
    assert.equal(
      hideNavigationAfterDismiss(session, attemptId, hideCaptured, 'attempt-result', 'attempt-result'),
      'stay',
    );
    assert.equal(
      hideNavigationAfterDismiss(session, attemptId, hideCaptured, 'attempt-detail', 'other'),
      'stay',
    );
    assert.equal(restoreMayTouchAttempt(session, attemptId, restoreCaptured), false);
    assert.equal(resumeMayReopenAttempt(session, resumeBeforeClose, attemptId), false);
    assert.equal(resumeMayReopenAttempt(session, resumeDuringClose, attemptId), false);

    session = finishAttemptClose(session, attemptId, close.generation);
    assert.equal(session.acknowledgement, null);
    assert.equal(modeUpdateMayReopen(session, modeCaptured, attemptId), false);
    assert.equal(resumeMayReopenAttempt(session, resumeBeforeClose, attemptId), false);
    assert.equal(resumeMayReopenAttempt(session, resumeDuringClose, attemptId), false);
    assert.equal(
      hideNavigationAfterDismiss(session, attemptId, hideCaptured, 'attempt-result', 'other'),
      'stay',
    );

    const laterResume = captureResumeWatch(session);
    assert.equal(resumeMayReopenAttempt(session, laterResume, attemptId), true);
    const other = beginAttemptClose(session, 'hw-other');
    session = finishAttemptClose(other.session, 'hw-other', other.generation);
    assert.equal(resumeMayReopenAttempt(session, resumeBeforeClose, attemptId), false);
    assert.equal(resumeMayReopenAttempt(session, resumeBeforeClose, 'hw-other'), false);
    assert.equal(session.acknowledgement, null);
    const reopened = openResultSession(session);
    session = reopened.session;
    const modeAfterReopen = captureResultWork(session);
    assert.equal(modeUpdateMayReopen(session, modeAfterReopen, attemptId), true);
    assert.equal(modeUpdateMayReopen(session, modeCaptured, attemptId), false);
  });

  it('keeps debug and headline current when path analytics is retried', () => {
    const begun = beginResultPresentation(createResultSession());
    assert.equal(isCurrentSecondaryLoad(begun.session.gate, begun.session.gate.loadToken), true);
    const started = startResultLoads(begun.session);
    const opened = openResultSession(createResultSession());
    assert.equal(started.loadToken, opened.loadToken);
    assert.equal(started.pathToken, opened.pathToken);
    const retried = retryPathAnalyticsSession(opened.session);
    assert.equal(retried.session.gate.requestId, opened.requestId);
    assert.equal(retried.session.gate.loadToken, opened.loadToken);
    assert.equal(isCurrentSecondaryLoad(retried.session.gate, opened.loadToken), true);
    assert.equal(isCurrentPathAnalyticsLoad(retried.session.gate, opened.pathToken), false);
    assert.equal(isCurrentPathAnalyticsLoad(retried.session.gate, retried.pathToken), true);
    const left = beginAttemptClose(retried.session, 'hw-retry');
    assert.equal(isCurrentSecondaryLoad(left.session.gate, opened.loadToken), false);
    assert.equal(isCurrentPathAnalyticsLoad(left.session.gate, retried.pathToken), false);
  });

  it('drops the parent abort listener when the child path-analytics signal ends', () => {
    const external = new AbortController();
    let removes = 0;
    const original = external.signal.removeEventListener.bind(external.signal);
    external.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      removes += 1;
      return original(...args);
    }) as AbortSignal['removeEventListener'];
    const child = forwardAbortSignal(external.signal);
    assert.equal(child.signal.aborted, false);
    child.abort();
    assert.equal(removes, 1);
    external.abort();
    assert.equal(removes, 1);

    const parent = new AbortController();
    const linked = forwardAbortSignal(parent.signal);
    parent.abort();
    assert.equal(linked.signal.aborted, true);
  });

  it('does not reuse a cancelled journey analysis', async () => {
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
      id: 'hw-cancel',
      sessionId: 'session-hw-cancel',
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
        count: 4,
        intervalMs: 1000,
      }),
    );
    await attempts.createAttempt(attempt);
    const pool = journeyPoolForAttempt(attempt);
    assert.ok(pool);
    workspace.resetNavigationLoad();
    await assert.rejects(
      () => workspace.analyzeJourney(pool!, attempt.id, { shouldContinue: () => false }),
      (error: unknown) => error instanceof JourneyFocusStoppedError,
    );
    const analyzed = await workspace.analyzeJourney(pool!, attempt.id);
    assert.equal(analyzed?.focus?.officialTimeMs, 99_000);
    assert.equal(workspace.navigationLoad.counters.analyzeJourneyHits, 0);
  });
});
