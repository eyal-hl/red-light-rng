import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DelayHeatFeature, DelayHeatViewState } from '../src/domain/delay-heatmap';
import {
  createJourneyWaitViewState,
  HOTSPOT_SCROLL_MARGIN,
  hotspotScrollTarget,
  mapHeatFeatures,
  openHotspotFromHeat,
  presentWaitView,
  selectWaitView,
  waitViewOptions,
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
