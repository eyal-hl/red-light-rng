import type { Route, TransportationMode } from '../domain/route';
import type { RouteStore } from './route-store';

export class MemoryRouteStore implements RouteStore {
  private readonly routes = new Map<string, Route>();

  async createRoute(route: Route): Promise<void> {
    const existing = [...this.routes.values()].find(
      (item) => item.sourceRecordingId === route.sourceRecordingId,
    );
    if (existing) {
      return;
    }
    this.routes.set(route.id, {
      ...route,
      referencePath: [...route.referencePath],
      startZone: { ...route.startZone, center: { ...route.startZone.center } },
      finishZone: { ...route.finishZone, center: { ...route.finishZone.center } },
    });
  }

  async listRoutes(): Promise<Route[]> {
    return [...this.routes.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((route) => ({
        ...route,
        referencePath: [...route.referencePath],
      }));
  }

  async getRoute(routeId: string): Promise<Route | null> {
    const route = this.routes.get(routeId);
    return route
      ? {
          ...route,
          referencePath: [...route.referencePath],
        }
      : null;
  }

  async deleteRoute(routeId: string): Promise<void> {
    this.routes.delete(routeId);
  }
}

export type { TransportationMode };
