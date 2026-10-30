import type { DelayHotspot } from '../domain/delay-hotspots';
import type { DelayHeatFeature, DelayHeatViewState } from '../domain/delay-heatmap';

/**
 * Journey detail shows one of two mutually exclusive wait views: the recurring-waits
 * list (default) or the delay heatmap panel. Pure transitions only; no React here.
 */
export type JourneyWaitView = 'recurring' | 'heatmap';

export type JourneyWaitViewState = {
  view: JourneyWaitView;
  /** Whether the recurring-waits list shows every ranked hotspot. Kept across view switches. */
  expanded: boolean;
  /** Hotspot whose card (recurring view) or summary (heatmap view) is selected. Kept across switches. */
  selectedHotspotId: string | null;
};

export type JourneyWaitViewPresentation = {
  showRecurringList: boolean;
  showHeatPanel: boolean;
};

export type JourneyWaitViewOption = {
  key: JourneyWaitView;
  label: string;
  selected: boolean;
  accessibilityLabel: string;
};

export function createJourneyWaitViewState(): JourneyWaitViewState {
  return { view: 'recurring', expanded: false, selectedHotspotId: null };
}

/**
 * Switching views keeps the expanded flag and the selected hotspot, so switching back
 * restores the recurring list exactly as it was left.
 */
export function selectWaitView(state: JourneyWaitViewState, view: JourneyWaitView): JourneyWaitViewState {
  if (state.view === view) {
    return state;
  }
  return { ...state, view };
}

/**
 * Drill-down from a heat summary: always lands on the recurring list, selects the hotspot,
 * and expands the list only when the hotspot is not among the currently visible cards.
 */
export function openHotspotFromHeat(
  state: JourneyWaitViewState,
  hotspotId: string,
  visibleHotspotIds: readonly string[],
): JourneyWaitViewState {
  const alreadyVisible = visibleHotspotIds.includes(hotspotId);
  return {
    view: 'recurring',
    expanded: state.expanded || !alreadyVisible,
    selectedHotspotId: hotspotId,
  };
}

export function presentWaitView(state: JourneyWaitViewState): JourneyWaitViewPresentation {
  return {
    showRecurringList: state.view === 'recurring',
    showHeatPanel: state.view === 'heatmap',
  };
}

/** Heat is drawn on the map only while the heatmap view is active and the heat view is ready. */
export function mapHeatFeatures(view: JourneyWaitView, heatView: DelayHeatViewState): DelayHeatFeature[] {
  if (view !== 'heatmap' || heatView.kind !== 'ready') {
    return [];
  }
  return heatView.heat.features;
}

/**
 * Recurring wait pins (orange, n/total labels) are drawn only in the recurring view. The heatmap
 * view replaces them with heat circles, so it pins nothing, whatever the heat state is.
 */
export function mapWaitMarkerHotspots(
  view: JourneyWaitView,
  shownHotspots: readonly DelayHotspot[],
): readonly DelayHotspot[] {
  return view === 'recurring' ? shownHotspots : [];
}

export type JourneyMapLayerInputs = {
  markerHotspots: readonly DelayHotspot[];
  heatFeatures: DelayHeatFeature[];
};

/** Map inputs for the active view: exactly one of recurring pins or heat circles, never both. */
export function mapLayerInputs(
  view: JourneyWaitView,
  shownHotspots: readonly DelayHotspot[],
  heatView: DelayHeatViewState,
): JourneyMapLayerInputs {
  return {
    markerHotspots: mapWaitMarkerHotspots(view, shownHotspots),
    heatFeatures: mapHeatFeatures(view, heatView),
  };
}

export function waitViewOptions(view: JourneyWaitView): JourneyWaitViewOption[] {
  return [
    {
      key: 'recurring',
      label: 'Recurring waits',
      selected: view === 'recurring',
      accessibilityLabel: 'Show recurring waits list',
    },
    {
      key: 'heatmap',
      label: 'Heatmap',
      selected: view === 'heatmap',
      accessibilityLabel: 'Show delay heatmap on map',
    },
  ];
}

/** Gap kept above a drilled-into hotspot card when the recurring list scrolls to it. */
export const HOTSPOT_SCROLL_MARGIN = 16;

export type HotspotScrollInput = {
  /** Hotspot set by a heat drill-down that has not been scrolled to yet. */
  pendingHotspotId: string | null;
  /** Card y relative to the recurring list container, keyed by hotspot id. */
  cardOffsets: ReadonlyMap<string, number>;
  /** Recurring list container y inside the scroll content, or null until both parts are laid out. */
  listContentY: number | null;
};

/**
 * Scroll y that brings the pending hotspot card into view, or null when there is nothing
 * to scroll for (no drill-down pending, card not reported yet, or list not laid out).
 */
export function hotspotScrollTarget(input: HotspotScrollInput): number | null {
  const { pendingHotspotId, cardOffsets, listContentY } = input;
  if (pendingHotspotId == null || listContentY == null) {
    return null;
  }
  const cardY = cardOffsets.get(pendingHotspotId);
  if (cardY == null) {
    return null;
  }
  return Math.max(0, listContentY + cardY - HOTSPOT_SCROLL_MARGIN);
}
