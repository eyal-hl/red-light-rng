import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addCheckpointFromPending,
  beginMoveMarker,
  beginMoveSelected,
  commitMoveFromPending,
  createCourseEditorDraft,
  deleteSelectedCheckpoint,
  draftCheckpointsInOrder,
  draftValidation,
  previewMapTap,
  renameSelectedCheckpoint,
  selectMarker,
  selectedMarkerLabel,
  START_MARKER_ID,
  FINISH_MARKER_ID,
  toCourseLayout,
} from '../src/domain/course-editor';
import { MIN_COURSE_MARKER_SEPARATION_METERS, validateCourseLayout } from '../src/domain/course-layout';
import { pathDistanceMeters } from '../src/domain/geo';
import { pointAtProgress } from '../src/domain/path-projection';
import { DEFAULT_ZONE_RADIUS_METERS } from '../src/domain/route-derivation';
import { MemoryRouteStore } from '../src/persistence/memory-route-store';
import { offsetLatLng } from './helpers/samples';
import { makeRoute, northPath, outAndBackPath } from './helpers/routes';

function tapAtProgress(path: ReturnType<typeof northPath>, progressMeters: number, eastMeters = 0) {
  const point = pointAtProgress(path, progressMeters);
  return eastMeters === 0 ? point : offsetLatLng(point.latitude, point.longitude, 0, eastMeters);
}

describe('course editor draft', () => {
  it('treats a zero-checkpoint route as valid', () => {
    const draft = createCourseEditorDraft(makeRoute());
    const validation = draftValidation(draft);
    assert.equal(validation.valid, true);
    assert.equal(draft.layout.checkpoints.length, 0);
  });

  it('adds, renames, and deletes checkpoints without mutating the original route', () => {
    const route = makeRoute();
    const originalCheckpoints = route.checkpoints;
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    draft = renameSelectedCheckpoint(draft, 'Katznelson');
    assert.equal(draft.layout.checkpoints[0]?.name, 'Katznelson');
    assert.equal(originalCheckpoints.length, 0);
    assert.equal(route.checkpoints.length, 0);

    draft = deleteSelectedCheckpoint(draft);
    assert.equal(draft.layout.checkpoints.length, 0);
    assert.equal(draft.dirty, true);
    assert.equal(route.checkpoints.length, 0);
  });

  it('reorders checkpoints by route progress after a move', () => {
    const route = makeRoute();
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 70));
    draft = addCheckpointFromPending(draft, () => 'cp-late');
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 30));
    draft = addCheckpointFromPending(draft, () => 'cp-early');

    let ordered = draftCheckpointsInOrder(draft);
    assert.deepEqual(
      ordered.map((item) => item.id),
      ['cp-early', 'cp-late'],
    );

    draft = selectMarker(draft, 'cp-late');
    draft = beginMoveSelected(draft);
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 20));
    draft = commitMoveFromPending(draft);
    ordered = draftCheckpointsInOrder(draft);
    assert.deepEqual(
      ordered.map((item) => item.id),
      ['cp-late', 'cp-early'],
    );
    assert.ok(ordered[0] && ordered[0].progressMeters < 25);
  });

  it('moves start and finish centers while keeping their existing radius', () => {
    const route = makeRoute();
    const startRadius = route.startZone.radiusMeters;
    const finishRadius = route.finishZone.radiusMeters;
    let draft = createCourseEditorDraft(route);
    draft = beginMoveMarker(draft, START_MARKER_ID);
    assert.equal(draft.selectedMarkerId, START_MARKER_ID);
    assert.equal(draft.mode, 'move');
    assert.equal(selectedMarkerLabel(draft), 'Start');
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 15));
    draft = commitMoveFromPending(draft);
    assert.equal(draft.layout.startZone.radiusMeters, startRadius);
    assert.ok(draft.layout.startProgressMeters > 10);

    draft = beginMoveMarker(draft, FINISH_MARKER_ID);
    assert.equal(draft.selectedMarkerId, FINISH_MARKER_ID);
    assert.equal(draft.mode, 'move');
    assert.equal(selectedMarkerLabel(draft), 'Finish');
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 85));
    draft = commitMoveFromPending(draft);
    assert.equal(draft.layout.finishZone.radiusMeters, finishRadius);
    assert.equal(finishRadius, DEFAULT_ZONE_RADIUS_METERS);
    assert.ok(draft.layout.finishProgressMeters < pathDistanceMeters(route.referencePath) - 5);
  });

  it('rejects degenerate layouts where adjacent markers are closer than the named separation', () => {
    const route = makeRoute();
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 40 + MIN_COURSE_MARKER_SEPARATION_METERS - 3));
    draft = addCheckpointFromPending(draft, () => 'cp-2');
    const validation = draftValidation(draft);
    assert.equal(validation.valid, false);
    assert.ok(validation.reason);
  });

  it('does not mutate a persisted route while an unsaved draft is edited', async () => {
    const routes = new MemoryRouteStore();
    const route = makeRoute();
    await routes.createRoute(route);
    let draft = createCourseEditorDraft((await routes.getRoute(route.id))!);
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 45));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    draft = renameSelectedCheckpoint(draft, 'Park');
    const persisted = await routes.getRoute(route.id);
    assert.equal(persisted?.checkpoints.length, 0);
    assert.equal(draft.layout.checkpoints.length, 1);
  });

  it('keeps the draft when the map renderer is remounted', () => {
    const route = makeRoute();
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    const afterRemount = { ...draft };
    const continued = previewMapTap(afterRemount, tapAtProgress(route.referencePath, 70));
    const withSecond = addCheckpointFromPending(continued, () => 'cp-2');
    assert.equal(withSecond.layout.checkpoints.length, 2);
    assert.equal(draft.layout.checkpoints.length, 1);
  });

  it('anchors a doubled-back finish at path end so outbound checkpoints stay valid', () => {
    const referencePath = outAndBackPath(20, 5);
    const finishCenter = offsetLatLng(referencePath[0]!.latitude, referencePath[0]!.longitude, 0, 3);
    const route = makeRoute({
      referencePath,
      finishZone: { center: finishCenter, radiusMeters: DEFAULT_ZONE_RADIUS_METERS },
      startProgressMeters: 0,
      finishProgressMeters: pathDistanceMeters(referencePath),
    });
    let draft = createCourseEditorDraft(route);
    assert.equal(draft.layout.finishProgressMeters, pathDistanceMeters(referencePath));
    assert.deepEqual(draft.layout.finishZone.center, finishCenter);
    draft = previewMapTap(draft, tapAtProgress(referencePath, 40));
    draft = addCheckpointFromPending(draft, () => 'cp-out');
    const validation = draftValidation(draft);
    assert.equal(validation.valid, true);
    assert.equal(draftCheckpointsInOrder(draft)[0]?.id, 'cp-out');
    assert.ok(draft.layout.checkpoints[0]!.progressMeters < draft.layout.finishProgressMeters);
  });

  it('builds a save payload from the draft without changing the source route', () => {
    const route = makeRoute();
    let draft = createCourseEditorDraft(route);
    draft = previewMapTap(draft, tapAtProgress(route.referencePath, 50));
    draft = addCheckpointFromPending(draft, () => 'cp-1');
    const layout = toCourseLayout(draft);
    assert.equal(layout.checkpoints.length, 1);
    assert.equal(route.checkpoints.length, 0);
    assert.equal(validateCourseLayout(layout).valid, true);
  });
});
