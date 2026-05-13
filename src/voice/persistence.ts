/**
 * Subscribes to roomBus voice + lifecycle events (via stream.ts emit hook)
 * and persists concatenated MP3 bytes per message on `voice-final`.
 */
import { Buffer } from "node:buffer";

import type { RoomEvent } from "../orchestrator/stream.js";
import type { Message } from "../storage/messages.js";
import {
  bodySha256Hex,
  deleteMessageVoice,
  getMessageVoice,
  resolveVoiceProfileForMessage,
  upsertMessageVoice,
  voiceProfileFingerprint,
  type StoredVoiceMeta,
} from "../storage/message-voice.js";
import { getMessage } from "../storage/messages.js";
import type { AgentVoiceProfile } from "../storage/agents.js";

interface Acc {
  roomId: string;
  parts: Buffer[];
  segments: Array<{ seq: number; byteStart: number; byteEnd: number; text: string }>;
  byteLen: number;
  mimeType: string;
}

const accumulators = new Map<string, Acc>();

function getProfileForFinalize(msg: Message): AgentVoiceProfile | null {
  return resolveVoiceProfileForMessage(msg);
}

export function handleVoiceRoomEvent(roomId: string, event: RoomEvent): void {
  if (event.type === "voice-chunk") {
    const messageId = event.messageId;
    if (!event.audioBase64) return;

    let acc = accumulators.get(messageId);
    if (!acc) {
      acc = {
        roomId,
        parts: [],
        segments: [],
        byteLen: 0,
        mimeType: event.mimeType && event.mimeType.startsWith("audio/")
          ? event.mimeType
          : "audio/mpeg",
      };
      accumulators.set(messageId, acc);
    } else if (event.mimeType && event.mimeType.startsWith("audio/")) {
      acc.mimeType = event.mimeType;
    }

    const buf = Buffer.from(event.audioBase64, "base64");
    const start = acc.byteLen;
    acc.parts.push(buf);
    acc.byteLen += buf.length;
    acc.segments.push({
      seq: event.seq,
      byteStart: start,
      byteEnd: acc.byteLen,
      text: typeof event.text === "string" ? event.text : "",
    });
    return;
  }

  if (event.type === "voice-final") {
    finalizeVoice(event.messageId);
    return;
  }

  if (event.type === "message-updated") {
    const id = event.messageId;
    accumulators.delete(id);
    const stored = getMessageVoice(id);
    if (!stored) return;
    const msg = getMessage(id);
    if (!msg) {
      deleteMessageVoice(id);
      return;
    }
    if (bodySha256Hex(msg.body) !== stored.meta.bodySha256) {
      deleteMessageVoice(id);
      return;
    }
    const profile = resolveVoiceProfileForMessage(msg);
    if (!profile || voiceProfileFingerprint(profile) !== stored.meta.voiceFp) {
      deleteMessageVoice(id);
    }
    return;
  }

  if (event.type === "message-removed") {
    const id = event.messageId;
    accumulators.delete(id);
    deleteMessageVoice(id);
  }
}

function finalizeVoice(messageId: string): void {
  const acc = accumulators.get(messageId);
  accumulators.delete(messageId);

  if (!acc || acc.byteLen === 0 || acc.parts.length === 0) return;

  const msg = getMessage(messageId);
  if (!msg) return;

  const profile = getProfileForFinalize(msg);
  if (!profile) return;

  const audioMp3 = Buffer.concat(acc.parts);
  const meta: StoredVoiceMeta = {
    mimeType: acc.mimeType,
    bodySha256: bodySha256Hex(msg.body),
    voiceFp: voiceProfileFingerprint(profile),
    voice: {
      provider: profile.provider,
      model: profile.model,
      voiceId: profile.voiceId,
    },
    segments: acc.segments,
    finalizedAt: Date.now(),
  };

  try {
    upsertMessageVoice(messageId, audioMp3, meta);
  } catch (e) {
    process.stderr.write(
      `[voice-persist] failed messageId=${messageId}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}
