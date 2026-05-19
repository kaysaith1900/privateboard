/** Persisted per-message MP3 from live voice-chunk streaming (voice mode). */
import { createHash } from "node:crypto";

import { getDb } from "./db.js";
import type { Message } from "./messages.js";
import type { AgentVoiceProfile } from "./agents.js";
import { getAgent, getChairAgent } from "./agents.js";
import { getMessage } from "./messages.js";
import { voiceProfileForAgent } from "../voice/tts.js";

export interface StoredVoiceMeta {
  mimeType: string;
  bodySha256: string;
  voiceFp: string;
  voice: { provider: string; model: string; voiceId: string };
  segments: Array<{ seq: number; byteStart: number; byteEnd: number; text: string }>;
  finalizedAt: number;
}

export function bodySha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Stable fingerprint for the synthesizer profile (matches voices.ts cache intent). */
export function voiceProfileFingerprint(p: AgentVoiceProfile): string {
  return [
    p.provider,
    p.model,
    p.voiceId,
    String(p.speed ?? 1),
    String(p.pitch ?? 0),
    String(p.volume ?? 1),
    p.emotion ?? "",
    String(p.modifyPitch ?? ""),
    String(p.modifyIntensity ?? ""),
    String(p.modifyTimbre ?? ""),
  ].join(":");
}

export function resolveVoiceProfileForMessage(msg: Message): AgentVoiceProfile | null {
  if (msg.authorKind === "user") {
    const chair = getChairAgent();
    return chair ? voiceProfileForAgent(chair) : null;
  }
  if (msg.authorKind === "agent" && msg.authorId) {
    const agent = getAgent(msg.authorId);
    return agent ? voiceProfileForAgent(agent) : null;
  }
  return null;
}

export interface MessageVoiceRow {
  audioMp3: Buffer;
  meta: StoredVoiceMeta;
}

export function upsertMessageVoice(
  messageId: string,
  audioMp3: Buffer,
  meta: StoredVoiceMeta,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO message_voice (message_id, audio_mp3, meta_json, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         audio_mp3 = excluded.audio_mp3,
         meta_json = excluded.meta_json,
         created_at = excluded.created_at`,
    )
    .run(messageId, audioMp3, JSON.stringify(meta), now);
}

export function deleteMessageVoice(messageId: string): void {
  getDb().prepare("DELETE FROM message_voice WHERE message_id = ?").run(messageId);
}

/** Messages in this room that have persisted MP3, chronological order. */
export function listRoomVoiceMessageIds(roomId: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT mv.message_id AS id
       FROM message_voice mv
       INNER JOIN messages m ON m.id = mv.message_id
       WHERE m.room_id = ?
       ORDER BY m.created_at ASC`,
    )
    .all(roomId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function getMessageVoice(messageId: string): MessageVoiceRow | null {
  const row = getDb()
    .prepare("SELECT audio_mp3, meta_json FROM message_voice WHERE message_id = ?")
    .get(messageId) as { audio_mp3: Buffer; meta_json: string } | undefined;
  if (!row) return null;
  try {
    const meta = JSON.parse(row.meta_json) as StoredVoiceMeta;
    return { audioMp3: row.audio_mp3, meta };
  } catch {
    return null;
  }
}

/**
 * Returns stored audio only if body + voice profile still match what was
 * captured at finalize time.
 */
export function getUsableMessageVoice(messageId: string): MessageVoiceRow | null {
  const row = getMessageVoice(messageId);
  if (!row) return null;

  const msg = getMessage(messageId);
  if (!msg) {
    deleteMessageVoice(messageId);
    return null;
  }

  const bodyHash = bodySha256Hex(msg.body);
  if (bodyHash !== row.meta.bodySha256) {
    deleteMessageVoice(messageId);
    return null;
  }

  const profile = resolveVoiceProfileForMessage(msg);
  if (!profile) {
    deleteMessageVoice(messageId);
    return null;
  }

  const fp = voiceProfileFingerprint(profile);
  if (fp !== row.meta.voiceFp) {
    deleteMessageVoice(messageId);
    return null;
  }

  return row;
}
