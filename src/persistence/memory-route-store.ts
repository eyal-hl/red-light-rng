import { cloneCourseLayout, type CourseLayout } from '../domain/course-layout';
import type { Route, TransportationMode } from '../domain/route';
import type { RouteStore } from './route-store';

function cloneRoute(route: Route): Route {
  const layout = cloneCourseLayout({
    startZone: route.startZone,
    finishZone: route.finishZone,
    startProgressMeters: route.startProgressMeters,
    finishProgressMeters: route.finishProgressMeters,
    checkpoints: route.checkpoints,
  });
  return {
    ...route,
    referencePath: route.referencePath.map((point) => ({ ...point })),
    startZone: layout.startZone,
    finishZone: layout.finishZone,
    startProgressMeters: layout.startProgressMeters,
    finishProgressMeters: layout.finishProgressMeters,
    checkpoints: layout.checkpoints,
  };
}

export class MemoryRouteStore implements RouteStore {
  private readonly routes = new Map<string, Route>();

  async createRoute(route: Route): Promise<void> {
    const existing = [...this.routes.values()].find(
      (item) => item.sourceRecordingId === route.sourceRecordingId,
    );
    if (existing) {
      return;
    }
    this.routes.set(route.id, cloneRoute(route));
  }

  async listRoutes(): Promise<Route[]> {
    return [...this.routes.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((route) => cloneRoute(route));
  }

  async getRoute(routeId: string): Promise<Route | null> {
    const route = this.routes.get(routeId);
    return route ? cloneRoute(route) : null;
  }

  async replaceCourseLayout(routeId: string, layout: CourseLayout): Promise<void> {
    const existing = this.routes.get(routeId);
    if (!existing) {
      throw new Error(`Route not found: ${routeId}`);
    }
    const nextLayout = cloneCourseLayout(layout);
    this.routes.set(routeId, {
      ...existing,
      startZone: nextLayout.startZone,
      finishZone: nextLayout.finishZone,
      startProgressMeters: nextLayout.startProgressMeters,
      finishProgressMeters: nextLayout.finishProgressMeters,
      checkpoints: nextLayout.checkpoints,
    });
  }

  async deleteRoute(routeId: string): Promise<void> {
    this.routes.delete(routeId);
  }
}

export type { TransportationMode };
