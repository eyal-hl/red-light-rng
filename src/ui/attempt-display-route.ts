import type { Attempt } from '../domain/attempt';
import type { Route } from '../domain/route';

export async function resolveAttemptDisplayRoute(
  attempt: Pick<Attempt, 'routeId'>,
  getRoute: (routeId: string) => Promise<Route | null>,
): Promise<Route | null> {
  if (!attempt.routeId) {
    return null;
  }
  return getRoute(attempt.routeId);
}
