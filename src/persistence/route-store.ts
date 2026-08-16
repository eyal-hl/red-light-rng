import type { CourseLayout } from '../domain/course-layout';
import type { Route } from '../domain/route';

export interface RouteStore {
  createRoute(route: Route): Promise<void>;
  listRoutes(): Promise<Route[]>;
  getRoute(routeId: string): Promise<Route | null>;
  replaceCourseLayout(routeId: string, layout: CourseLayout): Promise<void>;
  deleteRoute(routeId: string): Promise<void>;
}
