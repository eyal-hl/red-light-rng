export type AppScreenKind =
  | 'loading'
  | 'home'
  | 'recording'
  | 'review'
  | 'detail'
  | 'editor'
  | 'history'
  | 'attempt'
  | 'attempt-result'
  | 'attempt-detail';

export type SystemBackAction =
  | 'none'
  | 'leaveToHome'
  | 'cancelRecording'
  | 'cancelEditor'
  | 'leaveHistoryToDetail'
  | 'cancelAttempt'
  | 'acknowledgeAttemptResult'
  | 'leaveAttemptDetailToHistory';

export type SystemBackActions = {
  leaveToHome: () => void;
  cancelRecording: () => void;
  cancelEditor: () => void;
  leaveHistoryToDetail: () => void;
  cancelAttempt: () => void;
  acknowledgeAttemptResult: () => void;
  leaveAttemptDetailToHistory: () => void;
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
    case 'history':
      return 'leaveHistoryToDetail';
    case 'attempt':
      return 'cancelAttempt';
    case 'attempt-result':
      return 'acknowledgeAttemptResult';
    case 'attempt-detail':
      return 'leaveAttemptDetailToHistory';
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
