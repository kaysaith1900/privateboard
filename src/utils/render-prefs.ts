/**
 * Parsed client overrides for composer / viewer defaults at generate time.
 * Sent as `renderPrefs` on adjourn / POST brief (nested or flat keys).
 */
import { SPINES } from "../ai/prompts/composer.js";
import { HOUSE_STYLES } from "../ai/prompts/house-styles.js";
import type { BriefMode } from "../storage/briefs.js";

export interface ParsedRenderPrefs {
  /** When set · overrides composer spine for research-note pipeline. */
  reportSpine: string | null;
  /** When set · overrides composer house-style id. */
  reportHouseStyle: string | null;
  pptVariant: string | null;
  magazineVariant: string | null;
  newspaperVariant: string | null;
}

export const VALID_SPINES = new Set<string>(SPINES);

export const VALID_HOUSE_STYLE_IDS = new Set<string>(HOUSE_STYLES.map((h) => h.id));

/** djb2 · matches public/ppt.html pickVariant (+ siblings). */
function hashSeed(s: string): number {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export type PptTemplateId = "anthropic" | "keynote";

export type MagazineTemplateId = "gq" | "vogue";

export type NewspaperTemplateId = "post" | "times";

/** Default ppt template for a seed (room id · matches preview URL before brief exists). */
export function pickPptVariantFromSeed(seed: string): PptTemplateId {
  const s = String(seed || "");
  if (!s) return "anthropic";
  return hashSeed(s) % 2 === 0 ? "anthropic" : "keynote";
}

export function pickMagazineVariantFromSeed(seed: string): MagazineTemplateId {
  const s = String(seed || "");
  if (!s) return "gq";
  return hashSeed(s) % 2 === 0 ? "gq" : "vogue";
}

export function pickNewspaperVariantFromSeed(seed: string): NewspaperTemplateId {
  const s = String(seed || "");
  if (!s) return "post";
  return hashSeed(s) % 2 === 0 ? "post" : "times";
}

export function emptyParsedRenderPrefs(): ParsedRenderPrefs {
  return {
    reportSpine: null,
    reportHouseStyle: null,
    pptVariant: null,
    magazineVariant: null,
    newspaperVariant: null,
  };
}

function strField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

/** Accept flat keys · reportSpine, reportHouseStyle, pptVariant, … */
export function parseRenderPrefsFlat(raw: Record<string, unknown>): ParsedRenderPrefs {
  const spine = strField(raw.reportSpine);
  const house = strField(raw.reportHouseStyle);
  const pv = strField(raw.pptVariant)?.toLowerCase() ?? null;
  const mv = strField(raw.magazineVariant)?.toLowerCase() ?? null;
  const nv = strField(raw.newspaperVariant)?.toLowerCase() ?? null;
  return {
    reportSpine: spine && VALID_SPINES.has(spine) ? spine : null,
    reportHouseStyle: house && VALID_HOUSE_STYLE_IDS.has(house) ? house : null,
    pptVariant: pv === "keynote" || pv === "anthropic" ? pv : null,
    magazineVariant: mv === "gq" || mv === "vogue" ? mv : null,
    newspaperVariant: nv === "post" || nv === "times" ? nv : null,
  };
}

/**
 * Lift `renderPrefs` from POST JSON (nested object merges over top-level dupes).
 */
export function parseRenderPrefsFromBody(body: unknown): ParsedRenderPrefs {
  if (!body || typeof body !== "object") return emptyParsedRenderPrefs();
  const o = body as Record<string, unknown>;
  const nested = o.renderPrefs;
  const flat: Record<string, unknown> =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? { ...o, ...(nested as Record<string, unknown>) }
      : { ...o };
  return parseRenderPrefsFlat(flat);
}

/** Value stored on `briefs.viewer_variant` for structured modes · null when n/a or legacy. */
export function viewerVariantForMode(
  mode: BriefMode,
  roomId: string,
  prefs: ParsedRenderPrefs,
): string | null {
  if (mode === "ppt") {
    return prefs.pptVariant ?? pickPptVariantFromSeed(roomId);
  }
  if (mode === "magazine") {
    return prefs.magazineVariant ?? pickMagazineVariantFromSeed(roomId);
  }
  if (mode === "newspaper") {
    return prefs.newspaperVariant ?? pickNewspaperVariantFromSeed(roomId);
  }
  return null;
}
