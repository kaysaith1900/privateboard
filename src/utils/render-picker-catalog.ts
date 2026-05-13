/**
 * Static catalog for report spine + house-style pickers in adjourn / supplement
 * overlays. No Stage 1 · no composer — just the allow-lists the pipeline already
 * validates via `parseRenderPrefsFlat`.
 *
 * UI fallback · `public/app.js` duplicates this list as `RENDER_CATALOG_FALLBACK` so
 * a missing route or offline fetch still shows full pickers (not Auto-only).
 */
import { SPINES } from "../ai/prompts/composer.js";
import { HOUSE_STYLES } from "../ai/prompts/house-styles.js";

export interface RenderPickerCatalog {
  spines: readonly string[];
  houseStyles: readonly { id: string; label: string }[];
}

export function renderPickerCatalog(): RenderPickerCatalog {
  return {
    spines: SPINES,
    houseStyles: HOUSE_STYLES.map((h) => ({ id: h.id, label: h.label })),
  };
}
