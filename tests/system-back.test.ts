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
      leavePlaceEditor: () => {
        calls.push('leavePlaceEditor');
      },
      leaveDetailToJourney: () => {
        calls.push('leaveDetailToJourney');
      },
      cancelEditor: () => {
        calls.push('cancelEditor');
      },
      leaveHistoryToDetail: () => {
        calls.push('leaveHistoryToDetail');
      },
      inspectAttempt: () => {
        calls.push('inspectAttempt');
      },
      acknowledgeAttemptResult: () => {
        calls.push('acknowledgeAttemptResult');
      },
      leaveAttemptDetailToHistory: () => {
        calls.push('leaveAttemptDetailToHistory');
      },
    },
  };
}

describe('system back policy', () => {
  it('does not intercept root Home, loading, or init-error, so Android can exit normally', () => {
    assert.equal(isRootScreen('home'), true);
    assert.equal(isRootScreen('loading'), true);
    assert.equal(isRootScreen('init-error'), true);
    assert.equal(systemBackAction('home'), 'none');
    assert.equal(systemBackAction('loading'), 'none');
    assert.equal(systemBackAction('init-error'), 'none');

    const { calls, actions } = recordActions();
    assert.equal(handleSystemBack('home', actions), false);
    assert.equal(handleSystemBack('loading', actions), false);
    assert.equal(handleSystemBack('init-error', actions), false);
    assert.deepEqual(calls, []);
  });

  it('sends places, settings, journey, and review to Home, and route detail back to the journey', () => {
    assert.equal(isRootScreen('detail'), false);
    assert.equal(isRootScreen('review'), false);
    assert.equal(systemBackAction('places'), 'leaveToHome');
    assert.equal(systemBackAction('settings'), 'leaveToHome');
    assert.equal(systemBackAction('journey'), 'leaveToHome');
    assert.equal(systemBackAction('review'), 'leaveToHome');
    assert.equal(systemBackAction('detail'), 'leaveDetailToJourney');
    assert.equal(systemBackAction('place-editor'), 'leavePlaceEditor');

    for (const kind of ['places', 'settings', 'journey', 'review'] as const) {
      const { calls, actions } = recordActions();
      assert.equal(handleSystemBack(kind, actions), true);
      assert.deepEqual(calls, ['leaveToHome']);
    }
    const detail = recordActions();
    assert.equal(handleSystemBack('detail', detail.actions), true);
    assert.deepEqual(detail.calls, ['leaveDetailToJourney']);
    const editor = recordActions();
    assert.equal(handleSystemBack('place-editor', editor.actions), true);
    assert.deepEqual(editor.calls, ['leavePlaceEditor']);
  });

  it('returns nested editor, attempt, and result screens to route detail via their existing leave actions', () => {
    const nested: Array<[AppScreenKind, SystemBackAction]> = [
      ['editor', 'cancelEditor'],
      ['attempt', 'inspectAttempt'],
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

  it('walks History back to route detail and historical attempt detail back to History', () => {
    const nested: Array<[AppScreenKind, SystemBackAction]> = [
      ['history', 'leaveHistoryToDetail'],
      ['attempt-detail', 'leaveAttemptDetailToHistory'],
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
    assert.match(appRoot, /setScreen\(\{ kind: 'init-error' \}\)/);
    assert.match(appRoot, /TRY AGAIN/);
    assert.match(appRoot, /retryBootstrap/);
    assert.match(appRoot, /startAppStartup/);
    assert.match(appRoot, /APP_STARTUP_WATCHDOG_MS/);
    assert.match(appRoot, /onBack=\{leaveToHome\}/);
    assert.match(appRoot, /onBack=\{onBackFromHistory\}/);
    assert.match(appRoot, /cancelRecording: \(\) => \{\s*void onCancel\(\);/s);
    assert.match(appRoot, /cancelEditor: \(\) => \{\s*void onCancelEditor\(\);/s);
    assert.match(appRoot, /leaveHistoryToDetail: onBackFromHistory/);
    assert.match(appRoot, /leaveDetailToJourney/);
    assert.match(appRoot, /leavePlaceEditor/);
    assert.match(appRoot, /inspectAttempt: \(\) => \{\s*void onEndAndInspectAttempt\(\);/s);
    assert.match(appRoot, /acknowledgeAttemptResult: \(\) => \{\s*void onAcknowledgeAttempt\(\);/s);
    assert.match(appRoot, /leaveAttemptDetailToHistory: \(\) => \{\s*void onBackFromHistoryDetail\(\);/s);
    assert.match(review, /onPress=\{onBack\}/);
    assert.match(detail, /onPress=\{onBack\}/);
    assert.match(editor, /onPress=\{onCancel\}/);
  });
});
