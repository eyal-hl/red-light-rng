export const OPENFREEMAP_LIBERTY_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Glyph stacks hosted by OpenFreeMap Liberty.
 * MapLibre's style-spec default (`Open Sans Regular` / `Arial Unicode MS Regular`)
 * 404s against `tiles.openfreemap.org/fonts`, so symbol `text-field` labels
 * (including wait durations) never render unless this stack is set explicitly.
 */
export const OPENFREEMAP_LIBERTY_TEXT_FONT: string[] = ['Noto Sans Regular'];

