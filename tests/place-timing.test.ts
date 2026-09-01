import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_SAMPLE_ACCURACY_METERS } from '../src/domain/course-matching';
import { haversineMeters } from '../src/domain/geo';
import {
  MAX_SAMPLE_ACCURACY_METERS as PLACE_ACCURACY_GATE,
  PLACE_ACTIVE_MAX_DURATION_MS,
  PLACE_ARMED_MAX_DURATION_MS,
  PLACE_ARRIVAL_MIN_CONFIRMATION_MS,
  PLACE_ARRIVAL_MIN_INSIDE_SAMPLES,
  PLACE_DEPARTURE_MIN_SAMPLES,
  PLACE_DEPARTURE_SUSTAIN_METERS,
  PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS,
  PLACE_RETURN_TO_ORIGIN_DWELL_MS,
  interpolateRadiusCrossing,
  replayPlaceTrace,
  selectOriginCandidate,
} from '../src/domain/place-timing';
import { makePlace, sampleAt, completeJourneySamples, departureOnlySamples, dwellSamples, linearSamples } from './helpers/places';
import { offsetLatLng as offset } from './helpers/samples';

const HOME = makePlace({ id: 'place-home', name: 'Home' });
const WORK = makePlace({
  id: 'place-work',
  name: 'Work',
  center: offset(HOME.center.latitude, HOME.center.longitude, 300, 0),
  createdAtMs: 2,
});
const GYM = makePlace({
  id: 'place-gym',
  name: 'Gym',
  center: offset(HOME.center.latitude, HOME.center.longitude, 0, 300),
  createdAtMs: 3,
});

function replay(
  samples: Parameters<typeof replayPlaceTrace>[1],
  places = [HOME, WORK, GYM],
  armedAtMs = samples[0]?.recordedAtMs ?? 1_700_000_000_000,
  nowMs?: number,
) {
  const last = samples[samples.length - 1]?.recordedAtMs ?? armedAtMs;
  return replayPlaceTrace(places, samples, { armedAtMs, nowMs: nowMs ?? last });
}

describe('place timing constants', () => {
  it('keeps the pinned path-free thresholds centralized', () => {
    assert.equal(PLACE_ACCURACY_GATE, 45);
    assert.equal(MAX_SAMPLE_ACCURACY_METERS, 45);
    assert.equal(PLACE_DEPARTURE_MIN_SAMPLES, 4);
    assert.equal(PLACE_DEPARTURE_SUSTAIN_METERS, 18);
    assert.equal(PLACE_ARRIVAL_MIN_INSIDE_SAMPLES, 3);
    assert.equal(PLACE_ARRIVAL_MIN_CONFIRMATION_MS, 2_000);
    assert.equal(PLACE_DESTINATION_ELIGIBILITY_MARGIN_METERS, 10);
    assert.equal(PLACE_ARMED_MAX_DURATION_MS, 30 * 60 * 1000);
    assert.equal(PLACE_ACTIVE_MAX_DURATION_MS, 2 * 60 * 60 * 1000);
    assert.equal(PLACE_RETURN_TO_ORIGIN_DWELL_MS, 30_000);
  });
});

describe('origin candidate selection', () => {
  it('picks the nearest overlapping center and lowest id on equal distance', () => {
    const nearer = makePlace({
      id: 'place-b',
      name: 'Nearer',
      center: offset(HOME.center.latitude, HOME.center.longitude, 5, 0),
      radiusMeters: 30,
    });
    const farther = makePlace({
      id: 'place-a',
      name: 'Farther',
      center: offset(HOME.center.latitude, HOME.center.longitude, 12, 0),
      radiusMeters: 30,
    });
    const nearest = selectOriginCandidate([farther, nearer], HOME.center);
    assert.equal(nearest?.place.id, 'place-b');
    assert.equal(nearest?.overlapTieBreak, 'nearest');

    const left = makePlace({
      id: 'place-z',
      name: 'Left',
      center: offset(HOME.center.latitude, HOME.center.longitude, 0, -10),
    });
    const right = makePlace({
      id: 'place-a',
      name: 'Right',
      center: offset(HOME.center.latitude, HOME.center.longitude, 0, 10),
    });
    const mid = offset(HOME.center.latitude, HOME.center.longitude, 0, 0);
    const tied = selectOriginCandidate([left, right], mid);
    assert.equal(tied?.place.id, 'place-a');
    assert.equal(tied?.overlapTieBreak, 'lowest-id');
  });
});

describe('path-free departure', () => {
  it('identifies Home while armed inside the start zone and stays armed outside all places', () => {
    const inside = sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000 });
    const insideState = replay([inside], [HOME, WORK], 1_000);
    assert.equal(insideState.lifecycle, 'armed');
    assert.equal(insideState.startZone.status, 'inside');
    assert.equal(insideState.startZone.placeName, 'Home');
    assert.equal(insideState.startedAtMs, null);

    const far = offset(HOME.center.latitude, HOME.center.longitude, 120, 0);
    const outside = sampleAt(far, { sessionId: 's', recordedAtMs: 1_000 });
    const outsideState = replay([outside], [HOME, WORK], 1_000);
    assert.equal(outsideState.lifecycle, 'armed');
    assert.equal(outsideState.startZone.status, 'outside');
    assert.equal(outsideState.startedAtMs, null);
  });

  it('interpolates the outward radius crossing and ignores poor-accuracy samples', () => {
    const inner = offset(HOME.center.latitude, HOME.center.longitude, 20, 0);
    const outer = offset(HOME.center.latitude, HOME.center.longitude, 40, 0);
    const samples = [
      sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000 }),
      sampleAt(inner, { sessionId: 's', recordedAtMs: 2_000 }),
      sampleAt(outer, { sessionId: 's', recordedAtMs: 3_000 }),
    ];
    const expected = interpolateRadiusCrossing(
      { recordedAtMs: 2_000, distanceMeters: haversineMeters(inner, HOME.center) },
      { recordedAtMs: 3_000, distanceMeters: haversineMeters(outer, HOME.center) },
      HOME.radiusMeters,
    );
    const poor = sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 80, 0), {
      sessionId: 's',
      recordedAtMs: 2_500,
      accuracyMeters: 80,
    });
    const started = replay(
      [
        ...samples,
        poor,
        ...linearSamples(outer, offset(HOME.center.latitude, HOME.center.longitude, 80, 0), {
          sessionId: 's',
          startMs: 4_000,
          speedMps: 4,
          intervalMs: 1000,
          startIndex: 10,
        }),
      ],
      [HOME, WORK],
      1_000,
    );
    assert.equal(started.rejectedPoorAccuracy >= 1, true);
    assert.ok(started.startedAtMs != null);
    assert.equal(Math.round(started.startedAtMs ?? 0), Math.round(expected));
  });

  it('does not start with fewer than 4 accepted samples or after returning inside the radius', () => {
    const short = [
      sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000 }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 20, 0), {
        sessionId: 's',
        recordedAtMs: 2_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 40, 0), {
        sessionId: 's',
        recordedAtMs: 3_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 45, 0), {
        sessionId: 's',
        recordedAtMs: 4_000,
      }),
    ];
    const shortState = replay(short, [HOME, WORK], 1_000);
    assert.equal(shortState.lifecycle, 'armed');
    assert.equal(shortState.startedAtMs, null);

    const returned = [
      sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000 }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 20, 0), {
        sessionId: 's',
        recordedAtMs: 2_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 40, 0), {
        sessionId: 's',
        recordedAtMs: 3_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 50, 0), {
        sessionId: 's',
        recordedAtMs: 4_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 55, 0), {
        sessionId: 's',
        recordedAtMs: 5_000,
      }),
      sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 6_000 }),
    ];
    const returnedState = replay(returned, [HOME, WORK], 1_000);
    assert.equal(returnedState.lifecycle, 'armed');
    assert.equal(returnedState.startedAtMs, null);
  });

  it('still qualifies after more than 8 seconds with no speed deadline', () => {
    const samples = departureOnlySamples({
      origin: HOME,
      sessionId: 's',
      startMs: 1_000,
      speedMps: 1.5,
      extraMeters: 25,
    });
    const spanAfterCrossing = samples[samples.length - 1]!.recordedAtMs - samples[0]!.recordedAtMs;
    assert.ok(spanAfterCrossing > 8_000);
    const state = replay(samples, [HOME, WORK], 1_000);
    assert.equal(state.lifecycle, 'active');
    assert.equal(state.originPlaceId, HOME.id);
    assert.ok(state.startedAtMs != null);
  });

  it('qualifies a walking fixture at 1.2–1.5 m/s with a non-radial departure and keeps the original crossing', () => {
    const inner = offset(HOME.center.latitude, HOME.center.longitude, 18, 4);
    const samples = [
      sampleAt(HOME.center, { sessionId: 'walk', recordedAtMs: 10_000 }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 10, 2), {
        sessionId: 'walk',
        recordedAtMs: 11_000,
        speedMps: 1.3,
      }),
      sampleAt(inner, { sessionId: 'walk', recordedAtMs: 12_000, speedMps: 1.3 }),
      ...linearSamples(inner, offset(HOME.center.latitude, HOME.center.longitude, 70, 12), {
        sessionId: 'walk',
        startMs: 13_000,
        speedMps: 1.3,
        intervalMs: 1000,
        startIndex: 3,
      }),
    ];
    let crossing = samples[0]!.recordedAtMs;
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      const previousDistance = haversineMeters(previous, HOME.center);
      const currentDistance = haversineMeters(current, HOME.center);
      if (previousDistance <= HOME.radiusMeters && currentDistance > HOME.radiusMeters) {
        crossing = interpolateRadiusCrossing(
          { recordedAtMs: previous.recordedAtMs, distanceMeters: previousDistance },
          { recordedAtMs: current.recordedAtMs, distanceMeters: currentDistance },
          HOME.radiusMeters,
        );
        break;
      }
    }
    const state = replay(samples, [HOME, WORK], 10_000);
    assert.equal(state.lifecycle, 'active');
    assert.equal(state.originPlaceId, HOME.id);
    assert.ok(state.startedAtMs != null);
    assert.ok(Math.abs((state.startedAtMs ?? 0) - crossing) < 2);
    assert.equal(state.startedAtMs, state.departureCrossingAtMs);
  });

  it('keeps the origin departure candidate after samples leave every saved-place radius', () => {
    const samples = [
      sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000 }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 20, 0), {
        sessionId: 's',
        recordedAtMs: 2_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 40, 0), {
        sessionId: 's',
        recordedAtMs: 3_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 50, 0), {
        sessionId: 's',
        recordedAtMs: 4_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 55, 0), {
        sessionId: 's',
        recordedAtMs: 5_000,
      }),
      sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 60, 0), {
        sessionId: 's',
        recordedAtMs: 6_000,
      }),
    ];
    const state = replay(samples, [HOME, WORK], 1_000);
    assert.equal(state.lifecycle, 'active');
    assert.equal(state.originPlaceId, HOME.id);
    assert.ok(state.startedAtMs != null);
    assert.ok((state.startedAtMs ?? 0) >= 2_000);
    assert.ok((state.startedAtMs ?? 0) <= 3_000);
  });

  it('pins origin exactly once after a qualifying departure', () => {
    const samples = departureOnlySamples({ origin: HOME, sessionId: 's', extraMeters: 40 });
    const state = replay(samples, [HOME, WORK], samples[0]!.recordedAtMs);
    assert.equal(state.lifecycle, 'active');
    assert.equal(state.originPlaceId, HOME.id);
    const continued = replay(
      [
        ...samples,
        sampleAt(offset(HOME.center.latitude, HOME.center.longitude, 90, 0), {
          sessionId: 's',
          recordedAtMs: samples[samples.length - 1]!.recordedAtMs + 1000,
        }),
      ],
      [HOME, WORK],
      samples[0]!.recordedAtMs,
    );
    assert.equal(continued.originPlaceId, HOME.id);
    assert.equal(continued.startedAtMs, state.startedAtMs);
  });
});

describe('path-free destination and finish', () => {
  it('finishes Home → Work and Home → Gym from the same origin', () => {
    const toWork = completeJourneySamples({ origin: HOME, destination: WORK, sessionId: 'work' });
    const workState = replay(toWork);
    assert.equal(workState.lifecycle, 'completed');
    assert.equal(workState.originPlaceId, HOME.id);
    assert.equal(workState.destinationPlaceId, WORK.id);
    assert.ok(workState.startedAtMs != null);
    assert.ok(workState.finishedAtMs != null);
    assert.ok((workState.finishedAtMs ?? 0) > (workState.startedAtMs ?? 0));

    const toGym = completeJourneySamples({ origin: HOME, destination: GYM, sessionId: 'gym' });
    const gymState = replay(toGym);
    assert.equal(gymState.lifecycle, 'completed');
    assert.equal(gymState.destinationPlaceId, GYM.id);
  });

  it('does not finish at a destination overlapping the origin until radius + 10 m outside has been seen', () => {
    const nearbyGym = makePlace({
      id: 'place-gym-near',
      name: 'Gym',
      center: offset(HOME.center.latitude, HOME.center.longitude, 0, 15),
    });
    const towardGym = [
      sampleAt(HOME.center, { sessionId: 's', recordedAtMs: 1_000 }),
      ...linearSamples(HOME.center, nearbyGym.center, {
        sessionId: 's',
        startMs: 2_000,
        speedMps: 4,
        intervalMs: 1000,
      }),
      ...dwellSamples(nearbyGym.center, { sessionId: 's', startMs: 20_000, count: 5 }),
    ];
    const state = replay(towardGym, [HOME, nearbyGym], 1_000);
    assert.notEqual(state.lifecycle, 'completed');
    assert.equal(state.destinationPlaceId, null);
    const gymWatch = state.destinations.find((item) => item.placeId === nearbyGym.id);
    assert.equal(gymWatch?.seenEligibleOutside ?? false, false);
  });

  it('interpolates finishedAtMs at the inbound radius crossing', () => {
    const samples = completeJourneySamples({ origin: HOME, destination: WORK, sessionId: 's' });
    const state = replay(samples);
    assert.equal(state.lifecycle, 'completed');
    const workWatch = state.destinations.find((item) => item.placeId === WORK.id);
    assert.equal(state.finishedAtMs, workWatch?.arrivalCrossingAtMs);
    assert.ok(state.finishedAtMs != null);
  });

  it('does not finish with fewer than 3 inside samples, under 2s confirmation, or after an exit', () => {
    const approach = completeJourneySamples({ origin: HOME, destination: WORK, sessionId: 's' });
    const beforeArrival = approach.filter((sample) => {
      return haversineMeters(sample, WORK.center) > WORK.radiusMeters;
    });
    const firstInside = approach.find((sample) => haversineMeters(sample, WORK.center) <= WORK.radiusMeters);
    assert.ok(firstInside);
    const twoInside = [
      ...beforeArrival,
      firstInside,
      sampleAt(WORK.center, { sessionId: 's', recordedAtMs: firstInside.recordedAtMs + 500 }),
    ];
    const twoState = replay(twoInside);
    assert.notEqual(twoState.lifecycle, 'completed');

    const quick = [
      ...beforeArrival,
      firstInside,
      sampleAt(WORK.center, { sessionId: 's', recordedAtMs: firstInside.recordedAtMs + 400 }),
      sampleAt(WORK.center, { sessionId: 's', recordedAtMs: firstInside.recordedAtMs + 800 }),
    ];
    const quickState = replay(quick);
    assert.notEqual(quickState.lifecycle, 'completed');

    const exited = [
      ...beforeArrival,
      firstInside,
      sampleAt(WORK.center, { sessionId: 's', recordedAtMs: firstInside.recordedAtMs + 1000 }),
      sampleAt(offset(WORK.center.latitude, WORK.center.longitude, 80, 0), {
        sessionId: 's',
        recordedAtMs: firstInside.recordedAtMs + 2000,
      }),
    ];
    const exitedState = replay(exited);
    assert.notEqual(exitedState.lifecycle, 'completed');
  });

  it('never treats the origin as a competitive destination', () => {
    const out = departureOnlySamples({ origin: HOME, sessionId: 's', extraMeters: 80 });
    const back = [
      ...out,
      ...linearSamples(
        offset(HOME.center.latitude, HOME.center.longitude, 80, 0),
        HOME.center,
        {
          sessionId: 's',
          startMs: out[out.length - 1]!.recordedAtMs + 1000,
          speedMps: 4,
        },
      ),
      ...dwellSamples(HOME.center, {
        sessionId: 's',
        startMs: out[out.length - 1]!.recordedAtMs + 30_000,
        count: 4,
      }),
    ];
    const state = replay(back, [HOME, WORK], out[0]!.recordedAtMs);
    assert.notEqual(state.destinationPlaceId, HOME.id);
    assert.notEqual(state.lifecycle, 'completed');
  });
});

describe('place timing lifecycle caps', () => {
  it('ends armed attempts as DID NOT START after 30 minutes', () => {
    const armedAtMs = 1_000;
    const samples = [sampleAt(HOME.center, { sessionId: 's', recordedAtMs: armedAtMs })];
    const state = replay(samples, [HOME, WORK], armedAtMs, armedAtMs + PLACE_ARMED_MAX_DURATION_MS);
    assert.equal(state.lifecycle, 'ended');
    assert.equal(state.endReason, 'armed_timeout');
    assert.equal(state.startedAtMs, null);
    assert.equal(state.validity, 'unranked');
  });

  it('ends active attempts as DID NOT FINISH after 2 hours from startedAtMs', () => {
    const samples = departureOnlySamples({ origin: HOME, sessionId: 's', extraMeters: 40 });
    const started = replay(samples, [HOME, WORK]);
    assert.equal(started.lifecycle, 'active');
    const timed = replay(
      samples,
      [HOME, WORK],
      samples[0]!.recordedAtMs,
      (started.startedAtMs ?? 0) + PLACE_ACTIVE_MAX_DURATION_MS,
    );
    assert.equal(timed.lifecycle, 'ended');
    assert.equal(timed.endReason, 'active_timeout');
    assert.equal(timed.destinationPlaceId, null);
  });

  it('ends a qualified return-to-origin dwell as DID NOT FINISH', () => {
    const outbound = departureOnlySamples({ origin: HOME, sessionId: 's', extraMeters: 90 });
    const last = outbound[outbound.length - 1]!;
    const inbound = linearSamples(
      { latitude: last.latitude, longitude: last.longitude },
      HOME.center,
      {
        sessionId: 's',
        startMs: last.recordedAtMs + 1000,
        speedMps: 4,
      },
    );
    const dwell = dwellSamples(HOME.center, {
      sessionId: 's',
      startMs: inbound[inbound.length - 1]!.recordedAtMs + 1000,
      count: 32,
      intervalMs: 1000,
    });
    const state = replay([...outbound, ...inbound, ...dwell], [HOME, WORK]);
    assert.equal(state.lifecycle, 'ended');
    assert.equal(state.endReason, 'return_to_origin');
    assert.ok(state.startedAtMs != null);
    assert.equal(state.destinationPlaceId, null);
  });

  it('does not DID NOT FINISH on a brief origin re-entry when wall-clock now is much later', () => {
    const outbound = departureOnlySamples({ origin: HOME, sessionId: 's', extraMeters: 90 });
    const last = outbound[outbound.length - 1]!;
    const dip = sampleAt(HOME.center, {
      sessionId: 's',
      recordedAtMs: last.recordedAtMs + 1000,
    });
    const resume = completeJourneySamples({
      origin: HOME,
      destination: WORK,
      sessionId: 's',
      startMs: dip.recordedAtMs + 1000,
    });
    const samples = [...outbound, dip, ...resume];
    const lastMs = samples[samples.length - 1]!.recordedAtMs;
    const state = replay(samples, [HOME, WORK], samples[0]!.recordedAtMs, lastMs + 60_000);
    assert.equal(state.lifecycle, 'completed');
    assert.equal(state.originPlaceId, HOME.id);
    assert.equal(state.destinationPlaceId, WORK.id);
    assert.notEqual(state.endReason, 'return_to_origin');
  });
});
