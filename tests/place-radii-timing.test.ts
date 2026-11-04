import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { haversineMeters } from '../src/domain/geo';
import type { LocationSample } from '../src/domain/location-sample';
import type { Place } from '../src/domain/place';
import {
  PLACE_DEPARTURE_SUSTAIN_METERS,
  PLACE_RETURN_TO_ORIGIN_DWELL_MS,
  PLACE_RETURN_TO_ORIGIN_MIN_DISTANCE_METERS,
  derivePlaceStartZoneStatus,
  interpolateRadiusCrossing,
  replayPlaceTrace,
  returnToOriginThresholdMeters,
  selectOriginCandidate,
} from '../src/domain/place-timing';
import { makePlace, sampleAt } from './helpers/places';
import { offsetLatLng as offset } from './helpers/samples';

const BASE = { latitude: 32.08, longitude: 34.78 };
const T0 = 1_700_000_000_000;

function place(
  id: string,
  northMeters: number,
  departureRadiusMeters: number,
  arrivalRadiusMeters: number,
  extra: Partial<Place> = {},
): Place {
  return makePlace({
    id,
    name: id,
    center: offset(BASE.latitude, BASE.longitude, northMeters, 0),
    departureRadiusMeters,
    arrivalRadiusMeters,
    ...extra,
  });
}

/** One sample per second, positioned `distance` metres north of BASE. */
function track(distances: number[], startMs = T0, accuracy: number[] = []): LocationSample[] {
  return distances.map((north, index) =>
    sampleAt(offset(BASE.latitude, BASE.longitude, north, 0), {
      sessionId: 's',
      recordedAtMs: startMs + index * 1000,
      accuracyMeters: accuracy[index] ?? 5,
    }),
  );
}

function sweep(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const dir = to >= from ? 1 : -1;
  for (let d = from; dir > 0 ? d < to : d > to; d += dir * step) {
    out.push(d);
  }
  out.push(to);
  return out;
}

function replay(places: Place[], samples: LocationSample[], nowMs?: number) {
  const last = samples[samples.length - 1]!.recordedAtMs;
  return replayPlaceTrace(places, samples, { armedAtMs: samples[0]!.recordedAtMs, nowMs: nowMs ?? last });
}

function dist(sample: LocationSample, p: Place): number {
  return haversineMeters(sample, p.center);
}

/** Expected interpolated crossing of `radius` around `p`, going outward or inward, from the raw samples. */
function expectedCrossing(samples: LocationSample[], p: Place, radius: number, direction: 'out' | 'in'): number {
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const a = dist(previous, p);
    const b = dist(current, p);
    const crosses = direction === 'out' ? a <= radius && b > radius : a > radius && b <= radius;
    if (crosses) {
      return interpolateRadiusCrossing(
        { recordedAtMs: previous.recordedAtMs, distanceMeters: a },
        { recordedAtMs: current.recordedAtMs, distanceMeters: b },
        radius,
      );
    }
  }
  throw new Error('no crossing found');
}

const HOME_DEP = 100;
const HOME_ARR = 30;
const WORK_DEP = 40;
const WORK_ARR = 60;
const DISTANCE = 600;

function homeWork(): { home: Place; work: Place } {
  return {
    home: place('home', 0, HOME_DEP, HOME_ARR, { name: 'Home' }),
    work: place('work', DISTANCE, WORK_DEP, WORK_ARR, { name: 'Work' }),
  };
}

function dwellAt(north: number, count: number, startMs: number): LocationSample[] {
  return track(Array<number>(count).fill(north), startMs);
}

describe('independent departure and arrival radii: journeys', () => {
  it('Home -> Work starts at the Home DEPARTURE crossing and finishes at the Work ARRIVAL crossing', () => {
    const { home, work } = homeWork();
    const out = track([0, 0, ...sweep(0, DISTANCE, 7)], T0);
    const samples = [...out, ...dwellAt(DISTANCE, 4, out[out.length - 1]!.recordedAtMs + 1000)];
    const state = replay([home, work], samples);

    assert.equal(state.lifecycle, 'completed');
    assert.equal(state.originPlaceId, 'home');
    assert.equal(state.destinationPlaceId, 'work');
    assert.ok(Math.abs(state.startedAtMs! - expectedCrossing(samples, home, HOME_DEP, 'out')) < 1e-6);
    assert.ok(Math.abs(state.finishedAtMs! - expectedCrossing(samples, work, WORK_ARR, 'in')) < 1e-6);
    // Neither boundary is the other role's radius.
    assert.ok(Math.abs(state.startedAtMs! - expectedCrossing(samples, home, HOME_ARR, 'out')) > 1_000);
    assert.ok(Math.abs(state.finishedAtMs! - expectedCrossing(samples, work, WORK_DEP, 'in')) > 1_000);
  });

  it('Work -> Home swaps roles: Work DEPARTURE starts the clock, Home ARRIVAL stops it', () => {
    const { home, work } = homeWork();
    const back = track([DISTANCE, DISTANCE, ...sweep(DISTANCE, 0, 7)], T0);
    const samples = [...back, ...dwellAt(0, 4, back[back.length - 1]!.recordedAtMs + 1000)];
    const state = replay([home, work], samples);

    assert.equal(state.lifecycle, 'completed');
    assert.equal(state.originPlaceId, 'work');
    assert.equal(state.destinationPlaceId, 'home');
    assert.ok(Math.abs(state.startedAtMs! - expectedCrossing(samples, work, WORK_DEP, 'out')) < 1e-6);
    assert.ok(Math.abs(state.finishedAtMs! - expectedCrossing(samples, home, HOME_ARR, 'in')) < 1e-6);
  });

  it('a larger departure radius starts the clock later; a smaller arrival radius stops it later', () => {
    const samples = (() => {
      const out = track([0, 0, ...sweep(0, DISTANCE, 7)], T0);
      return [...out, ...dwellAt(DISTANCE, 4, out[out.length - 1]!.recordedAtMs + 1000)];
    })();
    const wide = replay([place('home', 0, 100, 30), place('work', DISTANCE, 40, 30)], samples);
    const narrow = replay([place('home', 0, 30, 30), place('work', DISTANCE, 40, 30)], samples);
    assert.ok(wide.startedAtMs! > narrow.startedAtMs!);
    const smallArrival = replay([place('home', 0, 30, 30), place('work', DISTANCE, 40, 20)], samples);
    const bigArrival = replay([place('home', 0, 30, 30), place('work', DISTANCE, 40, 90)], samples);
    assert.ok(smallArrival.finishedAtMs! > bigArrival.finishedAtMs!);
  });

  it('equal radii reproduce the single-radius timing exactly (start at r, finish at r)', () => {
    const home = place('home', 0, 30, 30);
    const work = place('work', DISTANCE, 30, 30);
    const out = track([0, 0, ...sweep(0, DISTANCE, 7)], T0);
    const samples = [...out, ...dwellAt(DISTANCE, 4, out[out.length - 1]!.recordedAtMs + 1000)];
    const state = replay([home, work], samples);
    assert.equal(state.lifecycle, 'completed');
    assert.ok(Math.abs(state.startedAtMs! - expectedCrossing(samples, home, 30, 'out')) < 1e-6);
    assert.ok(Math.abs(state.finishedAtMs! - expectedCrossing(samples, work, 30, 'in')) < 1e-6);
  });
});

describe('independent radii: origin selection and departure confirmation', () => {
  it('selects the armed origin with the DEPARTURE radius, not the arrival radius', () => {
    const wideArrival = place('a', 0, 20, 200);
    const wideDeparture = place('b', 0, 100, 10);
    const at50 = offset(BASE.latitude, BASE.longitude, 50, 0);
    assert.equal(selectOriginCandidate([wideArrival], at50), null);
    assert.equal(selectOriginCandidate([wideDeparture], at50)?.place.id, 'b');
  });

  it('keeps nearest-center and stable-id tie-breaks with overlapping unequal radii', () => {
    const near = place('z-near', 5, 60, 10);
    const far = place('a-far', 25, 80, 10);
    const point = offset(BASE.latitude, BASE.longitude, 0, 0);
    const nearest = selectOriginCandidate([far, near], point);
    assert.equal(nearest?.place.id, 'z-near');
    assert.equal(nearest?.overlapTieBreak, 'nearest');

    const east = place('b-east', 0, 50, 10, { center: offset(BASE.latitude, BASE.longitude, 0, 10) });
    const west = place('a-west', 0, 50, 10, { center: offset(BASE.latitude, BASE.longitude, 0, -10) });
    const tie = selectOriginCandidate([east, west], offset(BASE.latitude, BASE.longitude, 0, 0));
    assert.equal(tie?.overlapTieBreak, 'lowest-id');
    assert.equal(tie?.place.id, 'a-west');
  });

  it('start-zone status uses departure radii', () => {
    const home = place('home', 0, 100, 10);
    const samples = track([0, 60]);
    const engine = replay([home], samples);
    const status = derivePlaceStartZoneStatus([home], samples, engine);
    assert.equal(status.status, 'inside');
    assert.equal(status.placeId, 'home');
    const narrow = place('home', 0, 20, 100);
    const narrowEngine = replay([narrow], samples);
    assert.equal(derivePlaceStartZoneStatus([narrow], samples, narrowEngine).status, 'outside');
  });

  it('confirms departure at departure radius + 18 m after 4 accepted samples, not before', () => {
    const home = place('home', 0, 100, 30);
    const work = place('work', 900, 30, 30);
    const short = replay([home, work], track([0, 0, 90, 105, 110, 115, 117]));
    assert.equal(short.lifecycle, 'armed');
    assert.equal(PLACE_DEPARTURE_SUSTAIN_METERS, 18);
    const confirmed = replay([home, work], track([0, 0, 90, 105, 110, 115, 119]));
    assert.equal(confirmed.lifecycle, 'active');
    assert.equal(confirmed.originPlaceId, 'home');
  });

  it('GPS jitter around the departure boundary does not start a run', () => {
    const home = place('home', 0, 100, 30);
    const work = place('work', 900, 30, 30);
    const jitter = replay([home, work], track([0, 0, 95, 105, 96, 106, 97, 107, 98, 104, 99, 108]));
    assert.equal(jitter.lifecycle, 'armed');
    assert.equal(jitter.startedAtMs, null);
  });

  it('rejects poor-accuracy samples without moving the departure crossing', () => {
    const home = place('home', 0, 100, 30);
    const work = place('work', 900, 30, 30);
    const distances = [0, 0, 90, 300, 110, 125, 140, 150];
    const accurate = replay([home, work], track([0, 0, 90, 110, 125, 140, 150]));
    const withPoor = replay(
      [home, work],
      track(distances, T0, [5, 5, 5, 200, 5, 5, 5, 5]),
    );
    assert.equal(withPoor.rejectedPoorAccuracy, 1);
    assert.equal(withPoor.lifecycle, accurate.lifecycle);
    assert.equal(withPoor.lifecycle, 'active');
  });

  it('a short trip that turns back before confirmation never starts', () => {
    const home = place('home', 0, 100, 30);
    const work = place('work', 900, 30, 30);
    const state = replay([home, work], track([0, 0, 90, 110, 125, 60, 20, 0, 0, 0]));
    assert.equal(state.lifecycle, 'armed');
  });
});

describe('independent radii: destination eligibility', () => {
  it('requires the destination ARRIVAL radius + 10 m to have been seen outside', () => {
    const home = place('home', 0, 20, 20);
    // Work is only 125 m away: seen distance never reaches 100 + 10 with a 100 m arrival radius.
    const sticky = place('work', 125, 5, 100);
    const trail = [0, 0, ...sweep(0, 125, 5)];
    const stuck = replay([home, sticky], [...track(trail), ...dwellAt(125, 4, T0 + 200_000)]);
    assert.notEqual(stuck.lifecycle, 'completed');
    assert.equal(stuck.destinations.find((item) => item.placeId === 'work')?.seenEligibleOutside, false);

    const reachable = place('work', 125, 5, 50);
    const done = replay([home, reachable], [...track(trail), ...dwellAt(125, 4, T0 + 200_000)]);
    assert.equal(done.lifecycle, 'completed');
    assert.equal(done.destinationPlaceId, 'work');
  });

  it('never treats the origin as a destination, even when its arrival radius is the larger one', () => {
    const home = place('home', 0, 20, 200);
    const work = place('work', 900, 30, 30);
    const state = replay([home, work], track([0, 0, 60, 80, 100, 140, 200, 120, 60, 10, 0, 0, 0, 0]));
    assert.notEqual(state.destinationPlaceId, 'home');
    assert.equal(state.destinations.some((item) => item.placeId === 'home'), false);
  });

  it('finishes only with 3 inside samples spanning at least 2 s at the arrival radius', () => {
    const home = place('home', 0, 20, 20);
    const work = place('work', 300, 5, 50);
    const approach = [0, 0, ...sweep(0, 240, 20)];
    // Inside the 50 m arrival radius for only two samples, then back out.
    const twoInside = replay([home, work], track([...approach, 255, 270, 200, 150]));
    assert.notEqual(twoInside.lifecycle, 'completed');
    const three = replay([home, work], track([...approach, 255, 270, 280, 290]));
    assert.equal(three.lifecycle, 'completed');
    assert.ok(
      Math.abs(three.finishedAtMs! - expectedCrossing(track([...approach, 255, 270, 280, 290]), work, 50, 'in')) < 1e-6,
    );
  });
});

describe('independent radii: return-to-origin', () => {
  const DWELL_SAMPLES = PLACE_RETURN_TO_ORIGIN_DWELL_MS / 1000 + 5;

  function stayAt(north: number, from: LocationSample[]): LocationSample[] {
    return dwellAt(north, DWELL_SAMPLES, from[from.length - 1]!.recordedAtMs + 1000);
  }

  it('gate = max(50, 2 * max(departure, arrival)); equal radii match the single-radius rule', () => {
    assert.equal(PLACE_RETURN_TO_ORIGIN_MIN_DISTANCE_METERS, 50);
    for (const radius of [8, 20, 25, 30, 100, 250]) {
      assert.equal(
        returnToOriginThresholdMeters({ departureRadiusMeters: radius, arrivalRadiusMeters: radius }),
        Math.max(50, 2 * radius),
      );
    }
    assert.equal(returnToOriginThresholdMeters({ departureRadiusMeters: 100, arrivalRadiusMeters: 20 }), 200);
    assert.equal(returnToOriginThresholdMeters({ departureRadiusMeters: 20, arrivalRadiusMeters: 100 }), 200);
    assert.equal(returnToOriginThresholdMeters({ departureRadiusMeters: 10, arrivalRadiusMeters: 12 }), 50);
  });

  it('departure > arrival: dwell uses the ARRIVAL radius and the gate uses the larger radius', () => {
    const home = place('home', 0, 100, 20);
    const work = place('work', 1500, 30, 30);
    const outTo130 = track([0, 0, ...sweep(0, 130, 15)]);

    // Max distance 130 < gate 200: coming home and dwelling must not end the run.
    const shallow = [...outTo130, ...track(sweep(130, 0, 15), outTo130[outTo130.length - 1]!.recordedAtMs + 1000)];
    const shallowFull = [...shallow, ...stayAt(0, shallow)];
    const shallowState = replay([home, work], shallowFull);
    assert.equal(shallowState.lifecycle, 'active');
    assert.equal(shallowState.endReason, null);

    // Went clearly beyond both zones (240 m), then rests 60 m from Home: inside the 100 m departure
    // radius but outside the 20 m arrival radius, so it is not "inside origin" and never ends the run.
    const far = [...track([0, 0, ...sweep(0, 240, 20)])];
    const hover = [...far, ...track(sweep(240, 60, 20), far[far.length - 1]!.recordedAtMs + 1000)];
    const hoverState = replay([home, work], [...hover, ...stayAt(60, hover)]);
    assert.equal(hoverState.lifecycle, 'active');

    // Same excursion, but the dwell is inside the arrival radius: DID NOT FINISH.
    const home10 = [...hover, ...track(sweep(60, 10, 10), hover[hover.length - 1]!.recordedAtMs + 1000)];
    const returned = replay([home, work], [...home10, ...stayAt(10, home10)]);
    assert.equal(returned.lifecycle, 'ended');
    assert.equal(returned.endReason, 'return_to_origin');
  });

  it('arrival > departure: dwell uses the ARRIVAL radius and the gate uses the larger radius', () => {
    const home = place('home', 0, 20, 100);
    const work = place('work', 1500, 30, 30);

    // Leave only to 60 m (confirmed: 38 m needed) and rest back at Home: max 60 < gate 200.
    const small = track([0, 0, ...sweep(0, 60, 10), ...sweep(50, 0, 10)]);
    const smallState = replay([home, work], [...small, ...stayAt(0, small)]);
    assert.equal(smallState.lifecycle, 'active');
    assert.equal(smallState.endReason, null);

    // Excursion to 240 m then rest 90 m away: outside the 20 m departure radius but inside the 100 m
    // arrival radius -> counts as returned, DID NOT FINISH after the dwell.
    const far = track([0, 0, ...sweep(0, 240, 20), ...sweep(220, 90, 20)]);
    const state = replay([home, work], [...far, ...stayAt(90, far)]);
    assert.equal(state.lifecycle, 'ended');
    assert.equal(state.endReason, 'return_to_origin');
  });

  it('no spurious return_to_origin right after departure confirmation, and no stuck ACTIVE state', () => {
    // Slow departure through an arrival zone much larger than the departure zone.
    const home = place('home', 0, 20, 100);
    const work = place('work', 600, 30, 30);
    const slowOut = track([0, 0, ...Array.from({ length: 80 }, (_, index) => 21 + index)]);
    const slow = replay([home, work], slowOut);
    assert.equal(slow.lifecycle, 'active');
    assert.equal(slow.endReason, null);

    // The run is not stuck: continuing to Work completes it.
    const rest = sweep(100, 600, 10);
    const toWork = track(rest, slowOut[slowOut.length - 1]!.recordedAtMs + 1000);
    const finish = dwellAt(600, 4, toWork[toWork.length - 1]!.recordedAtMs + 1000);
    const done = replay([home, work], [...slowOut, ...toWork, ...finish]);
    assert.equal(done.lifecycle, 'completed');
    assert.equal(done.destinationPlaceId, 'work');
  });

  it('rapid turn-around before confirmation neither completes nor cancels', () => {
    const home = place('home', 0, 40, 25);
    const work = place('work', 800, 30, 30);
    const state = replay([home, work], track([0, 0, 30, 45, 60, 70, 40, 20, 0, 0]));
    // Returning inside the departure radius before confirmation resets the candidate: still armed.
    assert.equal(state.lifecycle, 'armed');
    assert.equal(state.startedAtMs, null);
    assert.equal(state.destinationPlaceId, null);
    assert.equal(state.endReason, null);
  });
});

describe('independent radii: overlapping places', () => {
  it('a nearby second place keeps its own arrival radius for eligibility and finish', () => {
    const home = place('home', 0, 30, 30);
    const cafe = place('cafe', 90, 10, 15);
    const out = track([0, 0, ...sweep(0, 200, 10), ...sweep(190, 90, 10)]);
    const state = replay([home, cafe], [...out, ...dwellAt(90, 4, out[out.length - 1]!.recordedAtMs + 1000)]);
    assert.equal(state.lifecycle, 'completed');
    assert.equal(state.destinationPlaceId, 'cafe');
  });
});
