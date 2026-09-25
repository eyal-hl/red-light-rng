import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_ATTEMPT_LOCAL_START, type Attempt } from '../src/domain/attempt';
import {
  debugDerivationKey,
  fingerprintAttempt,
  focusDerivationKey,
  homeDerivationKey,
  journeyDerivationKey,
  pathVariantRecomputeInputKey,
  rollingWindowMembershipKey,
  routeAnalysisDerivationKey,
} from '../src/product/derived-view-cache';
import { MILLISECONDS_PER_DAY } from '../src/domain/journey-statistics';
import { makePlace } from './helpers/places';
import { makeRoute } from './helpers/routes';
import { offsetLatLng } from './helpers/samples';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offsetLatLng(HOME.center.latitude, HOME.center.longitude, 240, 0),
  createdAtMs: 2,
});
const POOL = {
  originPlaceId: HOME.id,
  destinationPlaceId: WORK.id,
  transportationMode: 'scooter' as const,
};

function completedAttempt(id: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id,
    sessionId: `${id}-session`,
    lifecycle: 'completed',
    validity: 'valid',
    armedAtMs: 1_000,
    startedAtMs: 2_000,
    finishedAtMs: 12_000,
    ...EMPTY_ATTEMPT_LOCAL_START,
    resultAcknowledged: true,
    crossings: [],
    routeId: 'route-1',
    originPlaceId: HOME.id,
    destinationPlaceId: WORK.id,
    transportationMode: 'scooter',
    ...overrides,
  };
}

describe('derived view cache keys', () => {
  it('changes the home key when a Place name changes without attempt writes', () => {
    const attempt = completedAttempt('a1');
    const before = homeDerivationKey({
      attempts: [attempt],
      places: [HOME, WORK],
      activeTransportationMode: 'scooter',
      activeRecording: null,
      pendingRecording: null,
      activeAttemptId: null,
      attemptResultId: null,
    });
    const after = homeDerivationKey({
      attempts: [attempt],
      places: [{ ...HOME, name: 'Casa' }, WORK],
      activeTransportationMode: 'scooter',
      activeRecording: null,
      pendingRecording: null,
      activeAttemptId: null,
      attemptResultId: null,
    });
    assert.notEqual(before, after);
    assert.equal(fingerprintAttempt(attempt), fingerprintAttempt({ ...attempt }));
  });

  it('changes journey and focus keys when course layout changes without attempt-row writes', () => {
    const attempt = completedAttempt('a1');
    const route = makeRoute({ id: 'route-1' });
    const edited = makeRoute({
      id: 'route-1',
      checkpoints: [{ id: 'cp-1', name: 'Park', progressMeters: 40 }],
    });
    const journeyBefore = journeyDerivationKey({
      pool: POOL,
      attempts: [attempt],
      origin: HOME,
      destination: WORK,
      routes: [route],
      asOfMs: 20_000,
    });
    const journeyAfter = journeyDerivationKey({
      pool: POOL,
      attempts: [attempt],
      origin: HOME,
      destination: WORK,
      routes: [edited],
      asOfMs: 20_000,
    });
    const focusBefore = focusDerivationKey({
      pool: POOL,
      attemptId: attempt.id,
      attempts: [attempt],
      origin: HOME,
      destination: WORK,
      routes: [route],
      sampleIdentities: [{ sessionId: attempt.sessionId, lastSampleAtMs: 12_000 }],
    });
    const focusAfter = focusDerivationKey({
      pool: POOL,
      attemptId: attempt.id,
      attempts: [attempt],
      origin: HOME,
      destination: WORK,
      routes: [edited],
      sampleIdentities: [{ sessionId: attempt.sessionId, lastSampleAtMs: 12_000 }],
    });
    const debugBefore = debugDerivationKey({
      attempt,
      places: [HOME, WORK],
      route,
      sampleIdentity: { sessionId: attempt.sessionId, lastSampleAtMs: 12_000 },
    });
    const debugAfter = debugDerivationKey({
      attempt,
      places: [HOME, WORK],
      route: edited,
      sampleIdentity: { sessionId: attempt.sessionId, lastSampleAtMs: 12_000 },
    });
    const analysisBefore = routeAnalysisDerivationKey({
      route,
      attempts: [attempt],
      sampleIdentities: [{ sessionId: attempt.sessionId, lastSampleAtMs: 12_000 }],
    });
    const analysisAfter = routeAnalysisDerivationKey({
      route: edited,
      attempts: [attempt],
      sampleIdentities: [{ sessionId: attempt.sessionId, lastSampleAtMs: 12_000 }],
    });
    assert.notEqual(journeyBefore, journeyAfter);
    assert.notEqual(focusBefore, focusAfter);
    assert.notEqual(debugBefore, debugAfter);
    assert.notEqual(analysisBefore, analysisAfter);
  });

  it('keeps journey reuse only while rolling 7-day membership would be unchanged', () => {
    const asOfMs = 1_700_000_000_000;
    const attempt = completedAttempt('edge', {
      startedAtMs: asOfMs - 7 * MILLISECONDS_PER_DAY + 1_000 - 10_000,
      finishedAtMs: asOfMs - 7 * MILLISECONDS_PER_DAY + 1_000,
    });
    const inWindow = rollingWindowMembershipKey([attempt], asOfMs);
    const afterAdvance = rollingWindowMembershipKey([attempt], asOfMs + 2_000);
    const laterStillOut = rollingWindowMembershipKey([attempt], asOfMs + 3_000);
    assert.notEqual(inWindow, afterAdvance);
    assert.equal(afterAdvance, laterStillOut);
    assert.match(inWindow, /^7:edge\|30:edge$/);
    assert.match(afterAdvance, /^7:\|30:edge$/);
  });

  it('changes journey/focus keys when deferred path-variant recompute assigns a routeId', () => {
    const beforeAttempt = completedAttempt('a1', { routeId: null });
    const afterAttempt = completedAttempt('a1', { routeId: 'route-1' });
    const route = makeRoute({ id: 'route-1' });
    const before = journeyDerivationKey({
      pool: POOL,
      attempts: [beforeAttempt],
      origin: HOME,
      destination: WORK,
      routes: [route],
      asOfMs: 20_000,
    });
    const after = journeyDerivationKey({
      pool: POOL,
      attempts: [afterAttempt],
      origin: HOME,
      destination: WORK,
      routes: [route],
      asOfMs: 20_000,
    });
    assert.notEqual(before, after);
  });

  it('changes the path-variant recompute fingerprint when classification version or routeId changes', () => {
    const attempt = completedAttempt('a1', { routeId: null });
    const assigned = completedAttempt('a1', { routeId: 'route-1' });
    const route = makeRoute({ id: 'route-1' });
    const samples = [{ sessionId: 'session-a1', lastSampleAtMs: 20_000 }];
    const before = pathVariantRecomputeInputKey({
      classificationVersion: 1,
      attempts: [attempt],
      places: [HOME, WORK],
      routes: [route],
      sampleIdentities: samples,
    });
    const afterAssignment = pathVariantRecomputeInputKey({
      classificationVersion: 1,
      attempts: [assigned],
      places: [HOME, WORK],
      routes: [route],
      sampleIdentities: samples,
    });
    const afterVersion = pathVariantRecomputeInputKey({
      classificationVersion: 2,
      attempts: [attempt],
      places: [HOME, WORK],
      routes: [route],
      sampleIdentities: samples,
    });
    assert.notEqual(before, afterAssignment);
    assert.notEqual(before, afterVersion);
  });
});
