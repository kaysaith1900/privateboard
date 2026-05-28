/** User preferences (single-row table). */
import { isLlmProvider, type LlmProvider } from "../ai/providers.js";
import { parseAvatar3d, type Avatar3dConfig } from "./agents.js";
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
  /** 3D "捏 avatar" config for the user (host). NULL → no 3D avatar (falls
   *  back to the 8-bit seed avatar). Mirrors `Agent.avatar3d`. */
  avatar3d: Avatar3dConfig | null;
  /** Rendered PNG portrait (data URL) from the 3D editor. Preferred over the
   *  seed-generated SVG by the sidebar / room / settings when present. */
  avatarUrl: string | null;
  defaultModelV: string | null;
  /** Active search backend preference (honoured only when both keys exist). */
  webSearchProvider: WebSearchProviderPref;
  /** MiniMax API region — determines the base URL for TTS calls. */
  minimaxRegion: MinimaxRegion;
  /** Multi-SIM-style active LLM provider · LEGACY field, kept for
   *  the brief window where `active_llm_provider` was the source of
   *  truth (migrations 042 → 043). Always NULL after 043 runs. The
   *  current source of truth is `activeLlmCredentialId`. */
  activeLlmProvider: LlmProvider | null;
  /** Active credential id from `llm_credentials`. NULL when no LLM
   *  credential is configured. Switching active = one UPDATE on this
   *  column; the credential rows themselves stay on file so the user
   *  can flip back without re-pasting. */
  activeLlmCredentialId: string | null;
  /** Active credential id from `voice_credentials`. Mirrors the LLM
   *  field above for TTS providers (MiniMax / ElevenLabs / …). NULL
   *  when no voice credential is configured · downstream UI shows
   *  the "no active voice provider" empty state. */
  activeVoiceCredentialId: string | null;
  /** Active credential id from `search_credentials`. Mirrors the LLM
   *  and voice fields for web-search providers (Brave / Tavily). NULL
   *  when no search credential is configured · the Web Search system
   *  skill silently no-ops in that case. Replaces the legacy
   *  `webSearchProvider` preference, which only resolved which key to
   *  use when BOTH brave and tavily were configured. */
  activeSearchCredentialId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  name: string;
  intro: string;
  avatar_seed: string | null;
  avatar3d_json: string | null;
  avatar_url: string | null;
  default_model_v: string | null;
  web_search_provider: string;
  minimax_region: string;
  active_llm_provider: string | null;
  active_llm_credential_id: string | null;
  active_voice_credential_id: string | null;
  active_search_credential_id: string | null;
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
  const raw = row.active_llm_provider;
  return {
    name: row.name,
    intro: row.intro,
    avatarSeed: row.avatar_seed,
    avatar3d: parseAvatar3d(row.avatar3d_json),
    avatarUrl: row.avatar_url,
    defaultModelV: row.default_model_v,
    webSearchProvider: normalizeWebSearchProviderPref(row.web_search_provider),
    minimaxRegion: normalizeMinimaxRegion(row.minimax_region),
    activeLlmProvider: raw && isLlmProvider(raw) ? raw : null,
    activeLlmCredentialId: row.active_llm_credential_id,
    activeVoiceCredentialId: row.active_voice_credential_id,
    activeSearchCredentialId: row.active_search_credential_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPrefs(): Prefs {
  const row = getDb()
    .prepare(
      `SELECT name, intro, avatar_seed, avatar3d_json, avatar_url, default_model_v,
              COALESCE(web_search_provider, 'brave') AS web_search_provider,
              COALESCE(minimax_region, 'cn') AS minimax_region,
              active_llm_provider,
              active_llm_credential_id,
              active_voice_credential_id,
              active_search_credential_id,
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
  avatar3d?: Avatar3dConfig | null;
  avatarUrl?: string | null;
  defaultModelV?: string | null;
  webSearchProvider?: WebSearchProviderPref;
  minimaxRegion?: MinimaxRegion;
  activeLlmProvider?: LlmProvider | null;
  activeLlmCredentialId?: string | null;
  activeVoiceCredentialId?: string | null;
  activeSearchCredentialId?: string | null;
}

export function updatePrefs(patch: PrefsPatch): Prefs {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined)           { fields.push("name = ?");            values.push(patch.name); }
  if (patch.intro !== undefined)          { fields.push("intro = ?");           values.push(patch.intro); }
  if (patch.avatarSeed !== undefined)     { fields.push("avatar_seed = ?");     values.push(patch.avatarSeed); }
  if (patch.avatar3d !== undefined)       { fields.push("avatar3d_json = ?");   values.push(patch.avatar3d ? JSON.stringify(patch.avatar3d) : null); }
  if (patch.avatarUrl !== undefined)      { fields.push("avatar_url = ?");      values.push(patch.avatarUrl); }
  if (patch.defaultModelV !== undefined)  { fields.push("default_model_v = ?"); values.push(patch.defaultModelV); }
  if (patch.webSearchProvider !== undefined) {
    fields.push("web_search_provider = ?");
    values.push(patch.webSearchProvider === "tavily" ? "tavily" : "brave");
  }
  if (patch.minimaxRegion !== undefined) {
    fields.push("minimax_region = ?");
    values.push(patch.minimaxRegion === "intl" ? "intl" : "cn");
  }
  if (patch.activeLlmProvider !== undefined) {
    fields.push("active_llm_provider = ?");
    values.push(patch.activeLlmProvider);
  }
  if (patch.activeLlmCredentialId !== undefined) {
    fields.push("active_llm_credential_id = ?");
    values.push(patch.activeLlmCredentialId);
  }
  if (patch.activeVoiceCredentialId !== undefined) {
    fields.push("active_voice_credential_id = ?");
    values.push(patch.activeVoiceCredentialId);
  }
  if (patch.activeSearchCredentialId !== undefined) {
    fields.push("active_search_credential_id = ?");
    values.push(patch.activeSearchCredentialId);
  }

  if (fields.length === 0) return getPrefs();

  fields.push("updated_at = ?");
  values.push(Date.now());

  getDb()
    .prepare(`UPDATE prefs SET ${fields.join(", ")} WHERE id = 1`)
    .run(...values);

  return getPrefs();
}
