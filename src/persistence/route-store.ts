import type { Route } from '../domain/route';

export interface RouteStore {
  createRoute(route: Route): Promise<void>;
  listRoutes(): Promise<Route[]>;
  getRoute(routeId: string): Promise<Route | null>;
  deleteRoute(routeId: string): Promise<void>;
}
