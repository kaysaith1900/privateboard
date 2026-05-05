/** User preferences (single-row table). */
import { getDb } from "./db.js";

export interface Prefs {
  name: string;
  intro: string;
  avatarSeed: string | null;
  theme: string;
  defaultModelV: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  name: string;
  intro: string;
  avatar_seed: string | null;
  theme: string;
  default_model_v: string | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: Row): Prefs {
  return {
    name: row.name,
    intro: row.intro,
    avatarSeed: row.avatar_seed,
    theme: row.theme,
    defaultModelV: row.default_model_v,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPrefs(): Prefs {
  const row = getDb()
    .prepare(
      "SELECT name, intro, avatar_seed, theme, default_model_v, created_at, updated_at FROM prefs WHERE id = 1",
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
  theme?: string;
  defaultModelV?: string | null;
}

export function updatePrefs(patch: PrefsPatch): Prefs {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined)           { fields.push("name = ?");            values.push(patch.name); }
  if (patch.intro !== undefined)          { fields.push("intro = ?");           values.push(patch.intro); }
  if (patch.avatarSeed !== undefined)     { fields.push("avatar_seed = ?");     values.push(patch.avatarSeed); }
  if (patch.theme !== undefined)          { fields.push("theme = ?");           values.push(patch.theme); }
  if (patch.defaultModelV !== undefined)  { fields.push("default_model_v = ?"); values.push(patch.defaultModelV); }

  if (fields.length === 0) return getPrefs();

  fields.push("updated_at = ?");
  values.push(Date.now());

  getDb()
    .prepare(`UPDATE prefs SET ${fields.join(", ")} WHERE id = 1`)
    .run(...values);

  return getPrefs();
}
