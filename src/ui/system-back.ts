export type AppScreenKind =
  | 'loading'
  | 'home'
  | 'recording'
  | 'review'
  | 'places'
  | 'place-editor'
  | 'settings'
  | 'journey'
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
  | 'leavePlaceEditor'
  | 'leaveDetailToJourney'
  | 'cancelEditor'
  | 'leaveHistoryToDetail'
  | 'inspectAttempt'
  | 'acknowledgeAttemptResult'
  | 'leaveAttemptDetailToHistory';

export type SystemBackActions = {
  leaveToHome: () => void;
  cancelRecording: () => void;
  leavePlaceEditor: () => void;
  leaveDetailToJourney: () => void;
  cancelEditor: () => void;
  leaveHistoryToDetail: () => void;
  inspectAttempt: () => void;
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
    case 'places':
    case 'settings':
    case 'journey':
    case 'review':
      return 'leaveToHome';
    case 'place-editor':
      return 'leavePlaceEditor';
    case 'detail':
      return 'leaveDetailToJourney';
    case 'recording':
      return 'cancelRecording';
    case 'editor':
      return 'cancelEditor';
    case 'history':
      return 'leaveHistoryToDetail';
    case 'attempt':
      return 'inspectAttempt';
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
