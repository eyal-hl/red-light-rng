export type AppScreenKind =
  | 'loading'
  | 'home'
  | 'recording'
  | 'review'
  | 'detail'
  | 'editor'
  | 'attempt'
  | 'attempt-result';

export type SystemBackAction =
  | 'none'
  | 'leaveToHome'
  | 'cancelRecording'
  | 'cancelEditor'
  | 'cancelAttempt'
  | 'acknowledgeAttemptResult';

export type SystemBackActions = {
  leaveToHome: () => void;
  cancelRecording: () => void;
  cancelEditor: () => void;
  cancelAttempt: () => void;
  acknowledgeAttemptResult: () => void;
};

export function isRootScreen(kind: AppScreenKind): boolean {
  return kind === 'home' || kind === 'loading';
}

export function systemBackAction(kind: AppScreenKind): SystemBackAction {
  switch (kind) {
    case 'loading':
    case 'home':
      return 'none';
    case 'detail':
    case 'review':
      return 'leaveToHome';
    case 'recording':
      return 'cancelRecording';
    case 'editor':
      return 'cancelEditor';
    case 'attempt':
      return 'cancelAttempt';
    case 'attempt-result':
      return 'acknowledgeAttemptResult';
  }
}

export function handleSystemBack(kind: AppScreenKind, actions: SystemBackActions): boolean {
  const action = systemBackAction(kind);
  if (action === 'none') {
    return false;
  }
  actions[action]();
  return true;
}
