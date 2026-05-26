/* voice-labels · CRUD over the `voice_labels` table (migration 055).
 *
 * Stores user-typed friendly names for cloned voice_ids so the UI
 * can render "Chloe" instead of `Chloe_l5xqf0` after the provider's
 * own catalogue is reloaded (e.g. on cold-start / cache invalidation
 * / multi-device). Keyed by voice_id alone — voice_ids are globally
 * unique per provider account, and the provider column lets future
 * tooling scope queries when needed.
 */
import { getDb } from "./db.js";

export type VoiceLabelProvider = "minimax" | "elevenlabs";

export interface VoiceLabel {
  voiceId: string;
  provider: VoiceLabelProvider;
  label: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  voice_id: string;
  provider: string;
  label: string;
  created_at: number;
  updated_at: number;
}

function rowToLabel(r: Row): VoiceLabel {
  return {
    voiceId: r.voice_id,
    provider: r.provider as VoiceLabelProvider,
    label: r.label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** UPSERT a custom label · idempotent across re-clones of the same
 *  voice_id (won't happen with the current id-generation strategy
 *  but defensive against future renames). */
export function setVoiceLabel(input: { voiceId: string; provider: VoiceLabelProvider; label: string }): void {
  const now = Date.now();
  const id = (input.voiceId || "").trim();
  const label = (input.label || "").trim();
  if (!id || !label) return;
  getDb()
    .prepare(
      `INSERT INTO voice_labels (voice_id, provider, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(voice_id) DO UPDATE SET
         provider = excluded.provider,
         label = excluded.label,
         updated_at = excluded.updated_at`,
    )
    .run(id, input.provider, label, now, now);
}

export function getVoiceLabel(voiceId: string): string | null {
  if (!voiceId) return null;
  const row = getDb()
    .prepare(`SELECT label FROM voice_labels WHERE voice_id = ?`)
    .get(voiceId) as { label: string } | undefined;
  return row?.label ?? null;
}

/** Bulk lookup for callers (e.g. `listVoicesPage` building the
 *  catalogue) so they can merge labels into many voice rows with
 *  one DB hit. Returns a Map<voiceId, label>. */
export function getVoiceLabelMap(voiceIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (voiceIds.length === 0) return out;
  // SQLite has a parameter limit (~999 default); chunk to 500.
  const CHUNK = 500;
  for (let i = 0; i < voiceIds.length; i += CHUNK) {
    const slice = voiceIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const rows = getDb()
      .prepare(`SELECT voice_id, label FROM voice_labels WHERE voice_id IN (${placeholders})`)
      .all(...slice) as Array<{ voice_id: string; label: string }>;
    for (const r of rows) out.set(r.voice_id, r.label);
  }
  return out;
}

export function listVoiceLabels(): VoiceLabel[] {
  const rows = getDb()
    .prepare(`SELECT * FROM voice_labels ORDER BY updated_at DESC`)
    .all() as Row[];
  return rows.map(rowToLabel);
}

export function deleteVoiceLabel(voiceId: string): boolean {
  const r = getDb().prepare(`DELETE FROM voice_labels WHERE voice_id = ?`).run(voiceId);
  return r.changes > 0;
}
