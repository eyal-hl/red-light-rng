import { defaultCourseProgress, validateCourseLayout, type CourseLayout } from '../domain/course-layout';
import { createId } from '../domain/ids';
import type { LocationSample } from '../domain/location-sample';
import type { Route, TransportationMode } from '../domain/route';
import { deriveRouteGeometry, type RouteDerivation } from '../domain/route-derivation';
import type { TrackingState } from '../domain/tracking-state';
import type { Attempt } from '../domain/attempt';
import type { LocationSampleStore, TrackingSessionRecord } from '../persistence/location-sample-store';
import type { RouteStore } from '../persistence/route-store';
import type { LocationTracker } from '../tracking/location-tracker';
import { AttemptRuntime, type ArmAttemptResult } from './attempt-runtime';

export type HomeSnapshot = {
  routes: Route[];
  activeRecording: TrackingSessionRecord | null;
  pendingRecording: TrackingSessionRecord | null;
  activeAttempt: Attempt | null;
  attemptResult: Attempt | null;
  canStartNewRecording: boolean;
};

export type SaveRouteResult =
  | { ok: true; route: Route }
  | { ok: false; reason: string };

export type SaveCourseLayoutResult =
  | { ok: true; route: Route }
  | { ok: false; reason: string };

export class RouteWorkspace {
  constructor(
    private readonly tracker: LocationTracker,
    private readonly sessions: LocationSampleStore,
    private readonly routes: RouteStore,
    private readonly attempts: AttemptRuntime,
    private readonly now: () => number = () => Date.now(),
    private readonly createRouteId: () => string = createId,
  ) {}

  async bootstrap(): Promise<HomeSnapshot> {
    await this.tracker.recover();
    await this.attempts.reconcile();
    return this.loadHome();
  }

  async loadHome(): Promise<HomeSnapshot> {
    const [routes, activeSession, pendingRecording, activeAttempt, attemptResult] = await Promise.all([
      this.routes.listRoutes(),
      this.sessions.getActiveSession(),
      this.sessions.findPendingRouteCreation(),
      this.attempts.getOpenAttempt(),
      this.attempts.getUnacknowledgedResult(),
    ]);
    const activeRecording = activeSession?.purpose === 'route_creation' ? activeSession : null;
    return {
      routes,
      activeRecording,
      pendingRecording,
      activeAttempt,
      attemptResult: activeAttempt ? null : attemptResult,
      canStartNewRecording: activeSession == null && pendingRecording == null,
    };
  }

  async startRouteRecording(): Promise<void> {
    await this.tracker.startTracking('route_creation');
  }

  async finishRecording(): Promise<void> {
    await this.tracker.finishTracking();
  }

  async cancelRecording(): Promise<void> {
    await this.tracker.cancelTracking();
  }

  async interruptRecording(): Promise<void> {
    await this.tracker.interruptTracking();
  }

  async recover(): Promise<void> {
    await this.tracker.recover();
    await this.attempts.reconcile();
  }

  async getTrackingState(): Promise<TrackingState> {
    return this.tracker.getState();
  }

  async getSession(sessionId: string): Promise<TrackingSessionRecord | null> {
    return this.sessions.getSession(sessionId);
  }

  async countSamples(sessionId: string): Promise<number> {
    return this.sessions.countSamples(sessionId);
  }

  async listSamples(sessionId: string): Promise<LocationSample[]> {
    return this.sessions.listSamples(sessionId);
  }

  async deriveSession(sessionId: string): Promise<{
    session: TrackingSessionRecord | null;
    samples: LocationSample[];
    derivation: RouteDerivation;
  }> {
    const session = await this.sessions.getSession(sessionId);
    const samples = await this.sessions.listSamples(sessionId);
    return {
      session,
      samples,
      derivation: deriveRouteGeometry(samples),
    };
  }

  async discardRecording(sessionId: string): Promise<void> {
    await this.sessions.setReviewDisposition(sessionId, 'discarded');
  }

  async saveRoute(
    sessionId: string,
    name: string,
    transportationMode: TransportationMode,
  ): Promise<SaveRouteResult> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return { ok: false, reason: 'Enter a route name before saving.' };
    }

    const { session, derivation } = await this.deriveSession(sessionId);
    if (!session || session.reviewDisposition !== 'pending') {
      return { ok: false, reason: 'This recording is no longer waiting to be saved.' };
    }
    if (!derivation.saveable || !derivation.startZone || !derivation.finishZone) {
      return {
        ok: false,
        reason: derivation.reason ?? 'This recording is too short or low-quality to save as a route.',
      };
    }

    const progress = defaultCourseProgress(derivation.referencePath);
    const route: Route = {
      id: this.createRouteId(),
      name: trimmedName,
      transportationMode,
      createdAtMs: this.now(),
      sourceRecordingId: sessionId,
      referencePath: derivation.referencePath,
      startZone: derivation.startZone,
      finishZone: derivation.finishZone,
      startProgressMeters: progress.startProgressMeters,
      finishProgressMeters: progress.finishProgressMeters,
      checkpoints: [],
    };
    await this.routes.createRoute(route);
    await this.sessions.setReviewDisposition(sessionId, 'saved');
    return { ok: true, route };
  }

  async getRoute(routeId: string): Promise<Route | null> {
    return this.routes.getRoute(routeId);
  }

  async saveCourseLayout(routeId: string, layout: CourseLayout): Promise<SaveCourseLayoutResult> {
    const existing = await this.routes.getRoute(routeId);
    if (!existing) {
      return { ok: false, reason: 'This route is no longer available.' };
    }
    const validation = validateCourseLayout(layout);
    if (!validation.valid) {
      return { ok: false, reason: validation.reason ?? 'This course layout cannot be saved.' };
    }
    await this.routes.replaceCourseLayout(routeId, layout);
    const route = await this.routes.getRoute(routeId);
    if (!route) {
      return { ok: false, reason: 'This route is no longer available.' };
    }
    return { ok: true, route };
  }

  async deleteRoute(routeId: string): Promise<void> {
    await this.routes.deleteRoute(routeId);
  }

  async armRun(routeId: string): Promise<ArmAttemptResult> {
    return this.attempts.arm(routeId);
  }

  async cancelAttempt(): Promise<Attempt | null> {
    return this.attempts.cancel();
  }

  async processActiveAttempt(): Promise<Attempt | null> {
    return this.attempts.processActive();
  }

  async getOpenAttempt(): Promise<Attempt | null> {
    return this.attempts.getOpenAttempt();
  }

  async getAttemptResult(): Promise<Attempt | null> {
    return this.attempts.getUnacknowledgedResult();
  }

  async acknowledgeAttemptResult(attemptId: string): Promise<void> {
    await this.attempts.acknowledgeResult(attemptId);
  }

  async listAttemptsForRoute(routeId: string): Promise<Attempt[]> {
    return this.attempts.listAttemptsForRoute(routeId);
  }
}
