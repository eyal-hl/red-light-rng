import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { resolveAttemptDisplayRoute } from '../src/ui/attempt-display-route';
import { makeRoute } from './helpers/routes';

const PATH_1 = makeRoute({ id: 'path-1', name: 'Path 1' });
const PATH_2 = makeRoute({ id: 'path-2', name: 'Path 2' });

describe('attempt display route', () => {
  it('loads the attempt assigned variant instead of leftover selectedRoute', async () => {
    const routes = new Map([
      [PATH_1.id, PATH_1],
      [PATH_2.id, PATH_2],
    ]);
    const getRoute = async (routeId: string) => routes.get(routeId) ?? null;

    const assigned = await resolveAttemptDisplayRoute({ routeId: PATH_1.id }, getRoute);
    assert.equal(assigned?.id, PATH_1.id);

    const unassigned = await resolveAttemptDisplayRoute({ routeId: null }, getRoute);
    assert.equal(unassigned, null);

    const missing = await resolveAttemptDisplayRoute({ routeId: 'gone' }, getRoute);
    assert.equal(missing, null);
  });

  it('wires live results and history detail through the same assigned-variant resolver', () => {
    const appRoot = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const showAttemptResult = appRoot.slice(
      appRoot.indexOf('const showAttemptResult'),
      appRoot.indexOf('const applyStartupSnapshot'),
    );
    const onOpenHistoryAttempt = appRoot.slice(
      appRoot.indexOf('const onOpenHistoryAttempt'),
      appRoot.indexOf('const onBackFromHistoryDetail'),
    );
    assert.match(showAttemptResult, /resolveAttemptDisplayRoute\(attempt,/);
    assert.match(onOpenHistoryAttempt, /resolveAttemptDisplayRoute\(attempt,/);
    assert.match(appRoot, /screen\.kind === 'attempt-detail' && attemptResult[\s\S]*route=\{selectedRoute\}/);
  });
});
