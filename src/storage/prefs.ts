/** User preferences (single-row table). */
import { getDb } from "./db.js";

/** Which configured search API backs Web Search when both Brave and
 *  Tavily keys exist · otherwise inferred from whichever key is set. */
export type WebSearchProviderPref = "brave" | "tavily";

/** MiniMax API region: "cn" for China mainland, "intl" for international. */
export type MinimaxRegion = "cn" | "intl";

export interface Prefs {
  name: string;
  intro: string;
  avatarSeed: string | null;
  defaultModelV: string | null;
  /** Active search backend preference (honoured only when both keys exist). */
  webSearchProvider: WebSearchProviderPref;
  /** MiniMax API region — determines the base URL for TTS calls. */
  minimaxRegion: MinimaxRegion;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  name: string;
  intro: string;
  avatar_seed: string | null;
  default_model_v: string | null;
  web_search_provider: string;
  minimax_region: string;
  created_at: number;
  updated_at: number;
}

function normalizeWebSearchProviderPref(raw: string | null | undefined): WebSearchProviderPref {
  return raw === "tavily" ? "tavily" : "brave";
}

function normalizeMinimaxRegion(raw: string | null | undefined): MinimaxRegion {
  return raw === "intl" ? "intl" : "cn";
}

function mapRow(row: Row): Prefs {
  return {
    name: row.name,
    intro: row.intro,
    avatarSeed: row.avatar_seed,
    defaultModelV: row.default_model_v,
    webSearchProvider: normalizeWebSearchProviderPref(row.web_search_provider),
    minimaxRegion: normalizeMinimaxRegion(row.minimax_region),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPrefs(): Prefs {
  const row = getDb()
    .prepare(
      `SELECT name, intro, avatar_seed, default_model_v,
              COALESCE(web_search_provider, 'brave') AS web_search_provider,
              COALESCE(minimax_region, 'cn') AS minimax_region,
              created_at, updated_at FROM prefs WHERE id = 1`,
    )
    .get() as Row | undefined;
  if (!row) {
    // The 001 migration seeds a row, so this should never happen.
    throw new Error("prefs row missing — did migrations run?");
  }
  return mapRow(row);
}

export interface PrefsPatch {
  name?: string;
  intro?: string;
  avatarSeed?: string | null;
  defaultModelV?: string | null;
  webSearchProvider?: WebSearchProviderPref;
  minimaxRegion?: MinimaxRegion;
}

export function updatePrefs(patch: PrefsPatch): Prefs {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined)           { fields.push("name = ?");            values.push(patch.name); }
  if (patch.intro !== undefined)          { fields.push("intro = ?");           values.push(patch.intro); }
  if (patch.avatarSeed !== undefined)     { fields.push("avatar_seed = ?");     values.push(patch.avatarSeed); }
  if (patch.defaultModelV !== undefined)  { fields.push("default_model_v = ?"); values.push(patch.defaultModelV); }
  if (patch.webSearchProvider !== undefined) {
    fields.push("web_search_provider = ?");
    values.push(patch.webSearchProvider === "tavily" ? "tavily" : "brave");
  }
  if (patch.minimaxRegion !== undefined) {
    fields.push("minimax_region = ?");
    values.push(patch.minimaxRegion === "intl" ? "intl" : "cn");
  }

  if (fields.length === 0) return getPrefs();

  fields.push("updated_at = ?");
  values.push(Date.now());

  getDb()
    .prepare(`UPDATE prefs SET ${fields.join(", ")} WHERE id = 1`)
    .run(...values);

  return getPrefs();
}
