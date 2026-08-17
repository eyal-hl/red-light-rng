import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  handleSystemBack,
  isRootScreen,
  systemBackAction,
  type AppScreenKind,
  type SystemBackAction,
  type SystemBackActions,
} from '../src/ui/system-back';

function recordActions(): { calls: SystemBackAction[]; actions: SystemBackActions } {
  const calls: SystemBackAction[] = [];
  return {
    calls,
    actions: {
      leaveToHome: () => {
        calls.push('leaveToHome');
      },
      cancelRecording: () => {
        calls.push('cancelRecording');
      },
      cancelEditor: () => {
        calls.push('cancelEditor');
      },
      cancelAttempt: () => {
        calls.push('cancelAttempt');
      },
      acknowledgeAttemptResult: () => {
        calls.push('acknowledgeAttemptResult');
      },
    },
  };
}

describe('system back policy', () => {
  it('does not intercept root Home or loading, so Android can exit normally', () => {
    assert.equal(isRootScreen('home'), true);
    assert.equal(isRootScreen('loading'), true);
    assert.equal(systemBackAction('home'), 'none');
    assert.equal(systemBackAction('loading'), 'none');

    const { calls, actions } = recordActions();
    assert.equal(handleSystemBack('home', actions), false);
    assert.equal(handleSystemBack('loading', actions), false);
    assert.deepEqual(calls, []);
  });

  it('sends route detail and review to Home via the same leaveToHome action as the top-left arrow', () => {
    assert.equal(isRootScreen('detail'), false);
    assert.equal(isRootScreen('review'), false);
    assert.equal(systemBackAction('detail'), 'leaveToHome');
    assert.equal(systemBackAction('review'), 'leaveToHome');

    for (const kind of ['detail', 'review'] as const) {
      const { calls, actions } = recordActions();
      assert.equal(handleSystemBack(kind, actions), true);
      assert.deepEqual(calls, ['leaveToHome']);
    }
  });

  it('returns nested editor, attempt, and result screens to route detail via their existing leave actions', () => {
    const nested: Array<[AppScreenKind, SystemBackAction]> = [
      ['editor', 'cancelEditor'],
      ['attempt', 'cancelAttempt'],
      ['attempt-result', 'acknowledgeAttemptResult'],
    ];

    for (const [kind, action] of nested) {
      assert.equal(isRootScreen(kind), false);
      assert.equal(systemBackAction(kind), action);
      const { calls, actions } = recordActions();
      assert.equal(handleSystemBack(kind, actions), true);
      assert.deepEqual(calls, [action]);
    }
  });

  it('cancels an in-progress recording with the same leave action as the recording Cancel control', () => {
    assert.equal(isRootScreen('recording'), false);
    assert.equal(systemBackAction('recording'), 'cancelRecording');
    const { calls, actions } = recordActions();
    assert.equal(handleSystemBack('recording', actions), true);
    assert.deepEqual(calls, ['cancelRecording']);
  });

  it('wires Android BackHandler and the top-left arrows to the same parent actions', () => {
    const appRoot = readFileSync('src/ui/AppRoot.tsx', 'utf8');
    const review = readFileSync('src/ui/ReviewScreen.tsx', 'utf8');
    const detail = readFileSync('src/ui/RouteDetailScreen.tsx', 'utf8');
    const editor = readFileSync('src/ui/CourseEditorScreen.tsx', 'utf8');

    assert.match(appRoot, /BackHandler\.addEventListener\('hardwareBackPress'/);
    assert.match(appRoot, /handleSystemBack\(screen\.kind/);
    assert.match(appRoot, /onBack=\{leaveToHome\}/);
    assert.match(appRoot, /cancelRecording: \(\) => \{\s*void onCancel\(\);/s);
    assert.match(appRoot, /cancelEditor: \(\) => \{\s*void onCancelEditor\(\);/s);
    assert.match(appRoot, /cancelAttempt: \(\) => \{\s*void onCancelAttempt\(\);/s);
    assert.match(appRoot, /acknowledgeAttemptResult: \(\) => \{\s*void onAcknowledgeAttempt\(\);/s);
    assert.match(review, /onPress=\{onBack\}/);
    assert.match(detail, /onPress=\{onBack\}/);
    assert.match(editor, /onPress=\{onCancel\}/);
  });
});
