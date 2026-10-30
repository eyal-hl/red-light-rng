import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DelayHotspot } from '../src/domain/delay-hotspots';
import type { DelayHeatFeature, DelayHeatViewState } from '../src/domain/delay-heatmap';
import { delayHotspotMapMarkers } from '../src/map/hotspot-display';
import {
  createJourneyWaitViewState,
  HOTSPOT_SCROLL_MARGIN,
  hotspotScrollTarget,
  mapHeatFeatures,
  mapLayerInputs,
  mapWaitMarkerHotspots,
  openHotspotFromHeat,
  presentWaitView,
  selectWaitView,
  waitViewOptions,
  type JourneyWaitView,
  type JourneyWaitViewState,
} from '../src/product/journey-wait-view';

const FEATURE: DelayHeatFeature = {
  hotspotId: 'hot-a',
  coordinate: { latitude: 51.5, longitude: -0.12 },
  intensity: 1,
  radiusMeters: 30,
  rawValue: 3,
  waitedAttempts: 3,
  encounteredAttempts: 4,
  medianWaitMs: 20_000,
  totalWaitMs: 60_000,
};

const READY: DelayHeatViewState = {
  kind: 'ready',
  heat: {
    mode: 'frequency',
    features: [FEATURE],
    recurringCount: 1,
    capped: false,
    scaleReference: 3,
    oneOffWaitMs: 0,
    unlocatedWaitMs: 0,
  },
};

function hotspot(id: string): DelayHotspot {
  return {
    id,
    coordinate: { latitude: 51.5, longitude: -0.12 },
    spreadMeters: 5,
    confidence: 'high',
    encounteredAttempts: 4,
    waitedAttempts: 3,
    waitedRatio: 0.75,
    eventCount: 3,
    totalWaitMs: 60_000,
    averageWaitMs: 20_000,
    medianWaitMs: 20_000,
    worstWaitMs: 30_000,
    worstAttemptId: 'attempt-1',
    trend: null,
    contributions: [],
  };
}

const LOADING: DelayHeatViewState = { kind: 'loading' };
const UNAVAILABLE: DelayHeatViewState = { kind: 'unavailable' };
const NOT_ENOUGH: DelayHeatViewState = { kind: 'not-enough-history', analyzedAttemptCount: 1 };

function state(overrides: Partial<JourneyWaitViewState> = {}): JourneyWaitViewState {
  return { view: 'recurring', expanded: false, selectedHotspotId: null, ...overrides };
}

describe('journey wait view presentation', () => {
  it('defaults to the recurring waits view, collapsed and unselected', () => {
    assert.deepEqual(createJourneyWaitViewState(), { view: 'recurring', expanded: false, selectedHotspotId: null });
  });

  it('shows exactly one of the recurring list or the heat panel in each view', () => {
    const recurring = presentWaitView(state({ view: 'recurring' }));
    const heatmap = presentWaitView(state({ view: 'heatmap' }));

    assert.deepEqual(recurring, { showRecurringList: true, showHeatPanel: false });
    assert.deepEqual(heatmap, { showRecurringList: false, showHeatPanel: true });
    assert.notEqual(recurring.showRecurringList, recurring.showHeatPanel);
    assert.notEqual(heatmap.showRecurringList, heatmap.showHeatPanel);
  });

  it('passes heat features to the map only in heatmap view with a ready heat state', () => {
    assert.deepEqual(mapHeatFeatures('heatmap', READY), [FEATURE]);
    assert.deepEqual(mapHeatFeatures('recurring', READY), []);
    assert.deepEqual(mapHeatFeatures('heatmap', { kind: 'loading' }), []);
    assert.deepEqual(mapHeatFeatures('heatmap', { kind: 'unavailable' }), []);
    assert.deepEqual(mapHeatFeatures('heatmap', { kind: 'not-enough-history', analyzedAttemptCount: 1 }), []);
  });
});

describe('selectWaitView', () => {
  it('switches views while keeping the expanded flag and selection', () => {
    const expanded = state({ view: 'recurring', expanded: true, selectedHotspotId: 'hot-b' });
    const heat = selectWaitView(expanded, 'heatmap');

    assert.deepEqual(heat, { view: 'heatmap', expanded: true, selectedHotspotId: 'hot-b' });
  });

  it('restores the recurring view with its prior expanded state on switching back', () => {
    const start = state({ view: 'recurring', expanded: true, selectedHotspotId: 'hot-c' });
    const back = selectWaitView(selectWaitView(start, 'heatmap'), 'recurring');

    assert.deepEqual(back, start);
  });

  it('returns the same state when the view is already selected', () => {
    const start = state({ view: 'heatmap' });
    assert.equal(selectWaitView(start, 'heatmap'), start);
  });
});

describe('openHotspotFromHeat', () => {
  it('switches to recurring, selects the hotspot, and expands when it is not visible', () => {
    const next = openHotspotFromHeat(
      state({ view: 'heatmap', expanded: false, selectedHotspotId: 'hot-a' }),
      'hot-z',
      ['hot-a', 'hot-b', 'hot-c'],
    );

    assert.deepEqual(next, { view: 'recurring', expanded: true, selectedHotspotId: 'hot-z' });
  });

  it('does not force expansion when the hotspot is already visible', () => {
    const next = openHotspotFromHeat(
      state({ view: 'heatmap', expanded: false, selectedHotspotId: null }),
      'hot-b',
      ['hot-a', 'hot-b', 'hot-c'],
    );

    assert.deepEqual(next, { view: 'recurring', expanded: false, selectedHotspotId: 'hot-b' });
  });

  it('keeps an already expanded list expanded', () => {
    const next = openHotspotFromHeat(state({ view: 'heatmap', expanded: true }), 'hot-d', ['hot-a']);

    assert.deepEqual(next, { view: 'recurring', expanded: true, selectedHotspotId: 'hot-d' });
  });

  it('leaves the recurring list showing the selected hotspot with the heat panel hidden', () => {
    const next = openHotspotFromHeat(state({ view: 'heatmap' }), 'hot-d', ['hot-a', 'hot-b', 'hot-c']);
    const presentation = presentWaitView(next);

    assert.equal(presentation.showRecurringList, true);
    assert.equal(presentation.showHeatPanel, false);
    assert.equal(next.selectedHotspotId, 'hot-d');
    assert.equal(next.expanded, true);
  });
});

describe('waitViewOptions', () => {
  it('exposes two labelled options with the selected state on the active view', () => {
    const recurring = waitViewOptions('recurring');
    const heatmap = waitViewOptions('heatmap');

    assert.deepEqual(
      recurring.map((option) => option.key),
      ['recurring', 'heatmap'],
    );
    assert.deepEqual(
      recurring.map((option) => option.selected),
      [true, false],
    );
    assert.deepEqual(
      heatmap.map((option) => option.selected),
      [false, true],
    );
    for (const option of [...recurring, ...heatmap]) {
      assert.ok(option.label.length > 0);
      assert.ok(option.accessibilityLabel.length > 0);
    }
    assert.equal(recurring[0]?.label, 'Recurring waits');
    assert.equal(recurring[1]?.label, 'Heatmap');
  });
});

describe('hotspot drill-down scroll target', () => {
  const offsets = new Map([
    ['hot-a', 0],
    ['hot-d', 420],
  ]);

  it('returns null when no drill-down is pending', () => {
    assert.equal(hotspotScrollTarget({ pendingHotspotId: null, cardOffsets: offsets, listContentY: 900 }), null);
  });

  it('returns null until the pending card and the list position are both known', () => {
    assert.equal(hotspotScrollTarget({ pendingHotspotId: 'hot-d', cardOffsets: offsets, listContentY: null }), null);
    assert.equal(hotspotScrollTarget({ pendingHotspotId: 'hot-x', cardOffsets: offsets, listContentY: 900 }), null);
  });

  it('scrolls so a card below the fold sits just under the top margin', () => {
    const target = hotspotScrollTarget({ pendingHotspotId: 'hot-d', cardOffsets: offsets, listContentY: 900 });
    assert.equal(target, 900 + 420 - HOTSPOT_SCROLL_MARGIN);
  });

  it('never returns a negative scroll offset', () => {
    assert.equal(hotspotScrollTarget({ pendingHotspotId: 'hot-a', cardOffsets: offsets, listContentY: 0 }), 0);
  });
});

describe('map layer gating', () => {
  const SHOWN = [hotspot('hot-a'), hotspot('hot-b')];
  const markerIds = (hotspots: readonly DelayHotspot[]) => delayHotspotMapMarkers(hotspots).map((marker) => marker.id);

  it('recurring view with ready heat draws wait pins and no heat circles', () => {
    const inputs = mapLayerInputs('recurring', SHOWN, READY);

    assert.deepEqual(markerIds(inputs.markerHotspots), ['hot-a', 'hot-b']);
    assert.deepEqual(inputs.heatFeatures, []);
    assert.deepEqual(
      delayHotspotMapMarkers(inputs.markerHotspots).map((marker) => marker.label),
      ['3/4', '3/4'],
    );
  });

  it('heatmap view with ready heat draws heat circles and no wait pins', () => {
    const inputs = mapLayerInputs('heatmap', SHOWN, READY);

    assert.deepEqual(inputs.markerHotspots, []);
    assert.deepEqual(inputs.heatFeatures, [FEATURE]);
    assert.deepEqual(delayHotspotMapMarkers(inputs.markerHotspots), []);
  });

  it('heatmap view with loading, not-enough-history or unavailable heat draws neither pins nor heat', () => {
    for (const heatView of [LOADING, NOT_ENOUGH, UNAVAILABLE]) {
      const inputs = mapLayerInputs('heatmap', SHOWN, heatView);
      assert.deepEqual(inputs.markerHotspots, [], heatView.kind);
      assert.deepEqual(inputs.heatFeatures, [], heatView.kind);
    }
  });

  it('recurring view with zero hotspots draws neither pins nor heat', () => {
    const inputs = mapLayerInputs('recurring', [], READY);

    assert.deepEqual(inputs.markerHotspots, []);
    assert.deepEqual(inputs.heatFeatures, []);
  });

  it('heatmap view with zero hotspots and ready heat draws no pins', () => {
    assert.deepEqual(mapWaitMarkerHotspots('heatmap', []), []);
  });

  it('drill-down from a heat summary yields pins that include the selected hotspot', () => {
    const shownIds = ['hot-a', 'hot-b', 'hot-c'];
    const shown = shownIds.map(hotspot);
    const start = state({ view: 'heatmap', expanded: false, selectedHotspotId: 'hot-a' });
    const next = openHotspotFromHeat(start, 'hot-b', shownIds);
    const inputs = mapLayerInputs(next.view, shown, READY);

    assert.equal(next.view, 'recurring');
    assert.equal(next.selectedHotspotId, 'hot-b');
    assert.ok(markerIds(inputs.markerHotspots).includes('hot-b'));
    assert.deepEqual(inputs.heatFeatures, []);
  });

  it('drill-down to a hidden hotspot expands the list so its pin is drawn', () => {
    const shownIds = ['hot-a', 'hot-b', 'hot-c', 'hot-d'];
    const next = openHotspotFromHeat(state({ view: 'heatmap', expanded: false }), 'hot-d', ['hot-a', 'hot-b', 'hot-c']);
    const shown = next.expanded ? shownIds.map(hotspot) : shownIds.slice(0, 3).map(hotspot);
    const inputs = mapLayerInputs(next.view, shown, READY);

    assert.ok(markerIds(inputs.markerHotspots).includes('hot-d'));
  });

  it('toggling back to heatmap removes the pins again and restores heat', () => {
    const shown = [hotspot('hot-a')];
    const recurring = openHotspotFromHeat(state({ view: 'heatmap' }), 'hot-a', ['hot-a']);
    assert.deepEqual(markerIds(mapLayerInputs(recurring.view, shown, READY).markerHotspots), ['hot-a']);

    const heat = selectWaitView(recurring, 'heatmap');
    const inputs = mapLayerInputs(heat.view, shown, READY);

    assert.deepEqual(inputs.markerHotspots, []);
    assert.deepEqual(inputs.heatFeatures, [FEATURE]);
  });

  it('mapWaitMarkerHotspots and mapHeatFeatures agree with mapLayerInputs for every view', () => {
    const views: JourneyWaitView[] = ['recurring', 'heatmap'];
    for (const view of views) {
      const inputs = mapLayerInputs(view, SHOWN, READY);
      assert.deepEqual(inputs.markerHotspots, mapWaitMarkerHotspots(view, SHOWN));
      assert.deepEqual(inputs.heatFeatures, mapHeatFeatures(view, READY));
    }
  });
});
