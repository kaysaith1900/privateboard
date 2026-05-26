/* voice-labels routes · CRUD for the `voice_labels` table (mig 055).
 *
 * The clone modal writes a label automatically on success, but users
 * also need to fix typos, rename `pb_<id>_<ts>` voices that were
 * cloned before this table existed, and clear a name to fall back
 * to the provider catalogue's own label.
 *
 *   · GET    /api/voice-labels                · list all entries
 *   · PUT    /api/voice-labels/:voiceId       · upsert label
 *   · DELETE /api/voice-labels/:voiceId       · remove label
 *
 * Every write also drops the provider voice-catalogue cache so the
 * next `/api/voices` request reflects the rename without waiting for
 * the 5-minute TTL.
 */
import { Hono } from "hono";
import {
  listVoiceLabels,
  setVoiceLabel,
  deleteVoiceLabel,
  type VoiceLabelProvider,
} from "../storage/voice-labels.js";
import { invalidateVoicesCache } from "../voice/registry.js";

export function voiceLabelsRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    return c.json({ labels: listVoiceLabels() });
  });

  r.put("/:voiceId", async (c) => {
    const voiceId = c.req.param("voiceId");
    if (!voiceId) return c.json({ error: "missing voiceId" }, 400);
    const body = await c.req.json<{ provider?: string; label?: string }>();
    const provider = body.provider === "minimax" || body.provider === "elevenlabs"
      ? body.provider as VoiceLabelProvider
      : null;
    if (!provider) return c.json({ error: "provider must be minimax or elevenlabs" }, 400);
    const label = (body.label || "").trim();
    if (!label) return c.json({ error: "label is required" }, 400);
    setVoiceLabel({ voiceId, provider, label });
    invalidateVoicesCache();
    return c.json({ ok: true, voiceId, provider, label });
  });

  r.delete("/:voiceId", (c) => {
    const voiceId = c.req.param("voiceId");
    if (!voiceId) return c.json({ error: "missing voiceId" }, 400);
    const removed = deleteVoiceLabel(voiceId);
    if (removed) invalidateVoicesCache();
    return c.json({ ok: true, removed });
  });

  return r;
}
