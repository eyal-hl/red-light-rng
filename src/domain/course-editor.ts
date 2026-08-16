import {
  cloneCourseLayout,
  orderedCheckpoints,
  validateCourseLayout,
  type CourseLayout,
  type CourseLayoutValidation,
  type RouteCheckpoint,
} from './course-layout';
import { snapEditorTap, TAP_TOO_FAR_REASON, type PathProjection } from './path-projection';
import type { Route } from './route';
import type { LatLng } from './geo';

export const START_MARKER_ID = 'start';
export const FINISH_MARKER_ID = 'finish';

export type CourseMarkerId = typeof START_MARKER_ID | typeof FINISH_MARKER_ID | string;

export type CourseEditorMode = 'place' | 'move';

export type CourseEditorDraft = {
  routeId: string;
  referencePath: LatLng[];
  layout: CourseLayout;
  selectedMarkerId: CourseMarkerId | null;
  mode: CourseEditorMode;
  pendingSnap: PathProjection | null;
  tapRejection: string | null;
  dirty: boolean;
};

function cloneDraft(draft: CourseEditorDraft): CourseEditorDraft {
  return {
    routeId: draft.routeId,
    referencePath: draft.referencePath.map((point) => ({ ...point })),
    layout: cloneCourseLayout(draft.layout),
    selectedMarkerId: draft.selectedMarkerId,
    mode: draft.mode,
    pendingSnap: draft.pendingSnap
      ? {
          snapped: { ...draft.pendingSnap.snapped },
          progressMeters: draft.pendingSnap.progressMeters,
          snapDistanceMeters: draft.pendingSnap.snapDistanceMeters,
        }
      : null,
    tapRejection: draft.tapRejection,
    dirty: draft.dirty,
  };
}

function nextCheckpointName(checkpoints: RouteCheckpoint[]): string {
  const used = new Set(checkpoints.map((checkpoint) => checkpoint.name));
  let index = 1;
  while (used.has(`Checkpoint ${index}`)) {
    index += 1;
  }
  return `Checkpoint ${index}`;
}

export function createCourseEditorDraft(route: Route): CourseEditorDraft {
  return {
    routeId: route.id,
    referencePath: route.referencePath.map((point) => ({ ...point })),
    layout: {
      startZone: {
        center: { ...route.startZone.center },
        radiusMeters: route.startZone.radiusMeters,
      },
      finishZone: {
        center: { ...route.finishZone.center },
        radiusMeters: route.finishZone.radiusMeters,
      },
      startProgressMeters: route.startProgressMeters,
      finishProgressMeters: route.finishProgressMeters,
      checkpoints: route.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    },
    selectedMarkerId: null,
    mode: 'place',
    pendingSnap: null,
    tapRejection: null,
    dirty: false,
  };
}

export function previewMapTap(draft: CourseEditorDraft, tap: LatLng): CourseEditorDraft {
  const next = cloneDraft(draft);
  const snap = snapEditorTap(next.referencePath, tap);
  if (!snap.ok) {
    next.pendingSnap = null;
    next.tapRejection = snap.reason;
    return next;
  }
  next.pendingSnap = snap.projection;
  next.tapRejection = null;
  return next;
}

export function clearPendingSnap(draft: CourseEditorDraft): CourseEditorDraft {
  const next = cloneDraft(draft);
  next.pendingSnap = null;
  next.tapRejection = null;
  return next;
}

export function addCheckpointFromPending(
  draft: CourseEditorDraft,
  createCheckpointId: () => string,
): CourseEditorDraft {
  const next = cloneDraft(draft);
  if (next.mode !== 'place' || !next.pendingSnap) {
    next.tapRejection = next.pendingSnap ? null : TAP_TOO_FAR_REASON;
    return next;
  }
  const checkpoint: RouteCheckpoint = {
    id: createCheckpointId(),
    name: nextCheckpointName(next.layout.checkpoints),
    progressMeters: next.pendingSnap.progressMeters,
  };
  next.layout.checkpoints = [...next.layout.checkpoints, checkpoint];
  next.selectedMarkerId = checkpoint.id;
  next.pendingSnap = null;
  next.tapRejection = null;
  next.dirty = true;
  return next;
}

export function selectMarker(draft: CourseEditorDraft, markerId: CourseMarkerId): CourseEditorDraft {
  const next = cloneDraft(draft);
  next.selectedMarkerId = markerId;
  next.mode = 'place';
  next.pendingSnap = null;
  next.tapRejection = null;
  return next;
}

export function beginMoveSelected(draft: CourseEditorDraft): CourseEditorDraft {
  const next = cloneDraft(draft);
  if (!next.selectedMarkerId) {
    return next;
  }
  next.mode = 'move';
  next.pendingSnap = null;
  next.tapRejection = null;
  return next;
}

export function cancelMove(draft: CourseEditorDraft): CourseEditorDraft {
  const next = cloneDraft(draft);
  next.mode = 'place';
  next.pendingSnap = null;
  next.tapRejection = null;
  return next;
}

export function commitMoveFromPending(draft: CourseEditorDraft): CourseEditorDraft {
  const next = cloneDraft(draft);
  if (next.mode !== 'move' || !next.selectedMarkerId || !next.pendingSnap) {
    return next;
  }

  const progress = next.pendingSnap.progressMeters;
  const snapped = next.pendingSnap.snapped;
  if (next.selectedMarkerId === START_MARKER_ID) {
    next.layout.startProgressMeters = progress;
    next.layout.startZone = {
      center: { ...snapped },
      radiusMeters: next.layout.startZone.radiusMeters,
    };
  } else if (next.selectedMarkerId === FINISH_MARKER_ID) {
    next.layout.finishProgressMeters = progress;
    next.layout.finishZone = {
      center: { ...snapped },
      radiusMeters: next.layout.finishZone.radiusMeters,
    };
  } else {
    next.layout.checkpoints = next.layout.checkpoints.map((checkpoint) =>
      checkpoint.id === next.selectedMarkerId
        ? { ...checkpoint, progressMeters: progress }
        : checkpoint,
    );
  }

  next.pendingSnap = null;
  next.tapRejection = null;
  next.mode = 'place';
  next.dirty = true;
  return next;
}

export function renameSelectedCheckpoint(draft: CourseEditorDraft, name: string): CourseEditorDraft {
  const next = cloneDraft(draft);
  if (!next.selectedMarkerId || next.selectedMarkerId === START_MARKER_ID || next.selectedMarkerId === FINISH_MARKER_ID) {
    return next;
  }
  next.layout.checkpoints = next.layout.checkpoints.map((checkpoint) =>
    checkpoint.id === next.selectedMarkerId ? { ...checkpoint, name } : checkpoint,
  );
  next.dirty = true;
  return next;
}

export function deleteSelectedCheckpoint(draft: CourseEditorDraft): CourseEditorDraft {
  const next = cloneDraft(draft);
  if (!next.selectedMarkerId || next.selectedMarkerId === START_MARKER_ID || next.selectedMarkerId === FINISH_MARKER_ID) {
    return next;
  }
  next.layout.checkpoints = next.layout.checkpoints.filter(
    (checkpoint) => checkpoint.id !== next.selectedMarkerId,
  );
  next.selectedMarkerId = null;
  next.mode = 'place';
  next.pendingSnap = null;
  next.tapRejection = null;
  next.dirty = true;
  return next;
}

export function draftValidation(draft: CourseEditorDraft): CourseLayoutValidation {
  return validateCourseLayout(draft.layout);
}

export function draftCheckpointsInOrder(draft: CourseEditorDraft): RouteCheckpoint[] {
  return orderedCheckpoints(draft.layout.checkpoints);
}

export function toCourseLayout(draft: CourseEditorDraft): CourseLayout {
  return cloneCourseLayout(draft.layout);
}
