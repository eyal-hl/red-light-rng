import {
  isOpenAttempt,
  type Attempt,
  type AttemptCheckpointCrossing,
} from '../domain/attempt';
import {
  replayAttemptTrace,
  type AttemptEngineState,
  type TimingCourse,
} from '../domain/attempt-timing';
import { validateCourseLayout } from '../domain/course-layout';
import { createId } from '../domain/ids';
import type { LocationSample } from '../domain/location-sample';
import type { Route } from '../domain/route';
import {
  deriveStartZoneStatus,
  type StartZoneStatus,
} from '../domain/start-zone-status';
import type { AttemptStore } from '../persistence/attempt-store';
import type { CompleteSessionInput, LocationSampleStore } from '../persistence/location-sample-store';
import type { RouteStore } from '../persistence/route-store';
import type { LocationPlatform, LocationTracker } from '../tracking/location-tracker';

export type ArmAttemptResult =
  | { ok: true; attempt: Attempt }
  | { ok: false; reason: string };

export type ProcessActiveAttemptResult = {
  attempt: Attempt | null;
  startZoneStatus: StartZoneStatus;
};

function toTimingCourse(route: Route): TimingCourse {
  return {
    referencePath: route.referencePath,
    startProgressMeters: route.startProgressMeters,
    finishProgressMeters: route.finishProgressMeters,
    startZone: route.startZone,
    finishZone: route.finishZone,
    checkpoints: route.checkpoints,
  };
}

function crossingId(attemptId: string, checkpointId: string): string {
  return `${attemptId}:${checkpointId}`;
}

function applyEngine(
  attempt: Attempt,
  route: Route,
  samples: LocationSample[],
): { attempt: Attempt; engine: AttemptEngineState } {
  const engine = replayAttemptTrace(toTimingCourse(route), samples);
  const crossings: AttemptCheckpointCrossing[] = engine.crossings.map((crossing) => ({
    id: crossingId(attempt.id, crossing.checkpointId),
    attemptId: attempt.id,
    checkpointId: crossing.checkpointId,
    checkpointName: crossing.checkpointName,
    checkpointProgressMeters: crossing.checkpointProgressMeters,
    crossedAtMs: crossing.crossedAtMs,
  }));
  return {
    attempt: {
      ...attempt,
      lifecycle: engine.lifecycle,
      validity: engine.validity,
      startedAtMs: engine.startedAtMs,
      finishedAtMs: engine.finishedAtMs,
      crossings,
    },
    engine,
  };
}

function terminalSessionInput(attempt: Attempt, stoppedAtMs: number): CompleteSessionInput {
  if (attempt.lifecycle === 'completed') {
    return { stoppedAtMs, captureOutcome: 'finished', reviewDisposition: 'saved' };
  }
  if (attempt.lifecycle === 'cancelled') {
    return { stoppedAtMs, captureOutcome: 'cancelled', reviewDisposition: 'discarded' };
  }
  return { stoppedAtMs, captureOutcome: 'interrupted', reviewDisposition: 'discarded' };
}

export class AttemptRuntime {
  constructor(
    private readonly tracker: LocationTracker,
    private readonly platform: LocationPlatform,
    private readonly sessions: LocationSampleStore,
    private readonly routes: RouteStore,
    private readonly attempts: AttemptStore,
    private readonly now: () => number = () => Date.now(),
    private readonly createAttemptId: () => string = createId,
  ) {}

  async arm(routeId: string): Promise<ArmAttemptResult> {
    const route = await this.routes.getRoute(routeId);
    if (!route) {
      return { ok: false, reason: 'This route is no longer available.' };
    }
    const validation = validateCourseLayout({
      startZone: route.startZone,
      finishZone: route.finishZone,
      startProgressMeters: route.startProgressMeters,
      finishProgressMeters: route.finishProgressMeters,
      checkpoints: route.checkpoints,
    });
    if (!validation.valid) {
      return { ok: false, reason: validation.reason ?? 'This course cannot be armed.' };
    }
    if (route.referencePath.length < 2 || route.finishProgressMeters <= route.startProgressMeters) {
      return { ok: false, reason: 'This course cannot be armed.' };
    }

    const active = await this.sessions.getActiveSession();
    if (active) {
      return { ok: false, reason: 'Finish or cancel the current recording before arming a run.' };
    }
    const pending = await this.sessions.findPendingRouteCreation();
    if (pending) {
      return { ok: false, reason: 'Save or discard the unsaved route recording first.' };
    }
    const open = await this.attempts.getOpenAttempt();
    if (open) {
      return { ok: false, reason: 'An attempt is already armed or active.' };
    }

    await this.tracker.startTracking('attempt');
    const session = await this.sessions.getActiveSession();
    if (!session || session.purpose !== 'attempt') {
      return { ok: false, reason: 'Could not start attempt tracking.' };
    }

    const attempt: Attempt = {
      id: this.createAttemptId(),
      routeId: route.id,
      sessionId: session.id,
      lifecycle: 'armed',
      validity: 'pending',
      armedAtMs: this.now(),
      startedAtMs: null,
      finishedAtMs: null,
      resultAcknowledged: false,
      crossings: [],
    };
    try {
      await this.attempts.createAttempt(attempt);
    } catch (error) {
      await this.tracker.cancelTracking();
      throw error;
    }
    return { ok: true, attempt };
  }

  async cancel(): Promise<Attempt | null> {
    const open = await this.attempts.getOpenAttempt();
    if (!open) {
      return null;
    }
    const cancelled: Attempt = {
      ...open,
      lifecycle: 'cancelled',
      validity: 'unranked',
      resultAcknowledged: true,
    };
    await this.tracker.stopLocationUpdates();
    await this.attempts.finalizeAttempt(cancelled, terminalSessionInput(cancelled, this.now()));
    return cancelled;
  }

  async processActiveWithStartZoneStatus(): Promise<ProcessActiveAttemptResult> {
    const open = await this.attempts.getOpenAttempt();
    if (!open) {
      return {
        attempt: await this.attempts.getUnacknowledgedResult(),
        startZoneStatus: 'locating',
      };
    }
    const route = await this.routes.getRoute(open.routeId);
    if (!route) {
      return {
        attempt: await this.abandon(open, 'unranked'),
        startZoneStatus: 'locating',
      };
    }
    const samples = await this.sessions.listSamples(open.sessionId);
    const course = toTimingCourse(route);
    const applied = applyEngine(open, route, samples);
    const next = applied.attempt;
    const startZoneStatus =
      next.lifecycle === 'armed'
        ? deriveStartZoneStatus(course, samples, applied.engine)
        : 'locating';
    if (!isOpenAttempt(next)) {
      await this.tracker.stopLocationUpdates();
      await this.attempts.finalizeAttempt(next, terminalSessionInput(next, this.now()));
      return { attempt: next, startZoneStatus };
    }
    await this.attempts.saveAttempt(next);
    return { attempt: next, startZoneStatus };
  }

  async processActive(): Promise<Attempt | null> {
    return (await this.processActiveWithStartZoneStatus()).attempt;
  }

  async reconcile(): Promise<Attempt | null> {
    const processed = await this.processActive();
    const open = await this.attempts.getOpenAttempt();
    if (!open) {
      return processed ?? this.attempts.getUnacknowledgedResult();
    }

    const osUpdating = await this.platform.isUpdating();
    const servicesEnabled = await this.platform.hasServicesEnabled();
    const foregroundGranted = await this.platform.hasForegroundPermission();
    if (osUpdating && servicesEnabled && foregroundGranted) {
      return open;
    }
    return this.abandon(open, 'unranked');
  }

  async acknowledgeResult(attemptId: string): Promise<void> {
    await this.attempts.acknowledgeResult(attemptId);
  }

  async getOpenAttempt(): Promise<Attempt | null> {
    return this.attempts.getOpenAttempt();
  }

  async getUnacknowledgedResult(): Promise<Attempt | null> {
    return this.attempts.getUnacknowledgedResult();
  }

  async getAttempt(attemptId: string): Promise<Attempt | null> {
    return this.attempts.getAttempt(attemptId);
  }

  async listAttemptsForRoute(routeId: string): Promise<Attempt[]> {
    return this.attempts.listAttemptsForRoute(routeId);
  }

  private async abandon(open: Attempt, validity: 'unranked'): Promise<Attempt> {
    const abandoned: Attempt = {
      ...open,
      lifecycle: 'abandoned',
      validity,
    };
    await this.tracker.stopLocationUpdates();
    await this.attempts.finalizeAttempt(abandoned, terminalSessionInput(abandoned, this.now()));
    return abandoned;
  }
}
