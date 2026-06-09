/* ═══════════════════════════════════════════════════════════════════
   api.js · the single seam between the mobile H5 shell and the REAL
   backend (the same-origin Hono server that already powers the desktop
   app). Replaces the offline `store.js`. Two parts:

     · REST    — thin async wrappers returning parsed JSON
     · SSE      — openRoomStream / openPersonaStream (named-event
                  EventSource, mirrors public/app.js)

   Same origin → no CORS, no auth (single-user local backend). Every
   shape here was verified against the live routes; see the plan's
   contract map. The desktop client `public/app.js` is the reference.
   ═══════════════════════════════════════════════════════════════════ */

/** Core fetch · throws an Error with `.status` + `.body` on non-2xx so
 *  callers can branch (e.g. 404 usage → degrade, 410 legacy → ignore). */
async function jx(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(path, opt); }
  catch (e) { const err = new Error("network error"); err.status = 0; err.cause = e; throw err; }
  if (!r.ok) {
    let parsed = null; try { parsed = await r.json(); } catch (_) { /* */ }
    const err = new Error((parsed && parsed.error) || ("HTTP " + r.status));
    err.status = r.status; err.body = parsed;
    throw err;
  }
  if (r.status === 204) return null;
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r.text();
}
const enc = encodeURIComponent;

export const api = {
  health: () => jx("GET", "/api/health"),

  // ── Prefs ──────────────────────────────────────────────────────
  getPrefs: () => jx("GET", "/api/prefs"),
  putPrefs: (p) => jx("PUT", "/api/prefs", p),

  // ── LLM credentials (multi-instance, single-active) ────────────
  listCredentials: () => jx("GET", "/api/credentials"),          // {credentials:[{id,provider,label,preview,isActive,...}], activeId?}
  createCredential: (provider, label, key) => jx("POST", "/api/credentials", { provider, label: label || null, key }),
  setActiveCredential: (id) => jx("PUT", "/api/credentials/active", { id }),
  deleteCredential: (id) => jx("DELETE", "/api/credentials/" + enc(id)),

  // ── Voice / search credentials + legacy keys list ──────────────
  listKeys: () => jx("GET", "/api/keys"),                        // {keys:[{provider,configured,preview,updatedAt}], classification:{multiModel,singleModel,voice,skill}}
  listVoiceCredentials: () => jx("GET", "/api/voice-credentials"),
  createVoiceCredential: (provider, label, key) => jx("POST", "/api/voice-credentials", { provider, label: label || null, key }),
  setActiveVoiceCredential: (id) => jx("PUT", "/api/voice-credentials/active", { id }),
  deleteVoiceCredential: (id) => jx("DELETE", "/api/voice-credentials/" + enc(id)),
  listSearchCredentials: () => jx("GET", "/api/search-credentials"),
  createSearchCredential: (provider, label, key) => jx("POST", "/api/search-credentials", { provider, label: label || null, key }),
  setActiveSearchCredential: (id) => jx("PUT", "/api/search-credentials/active", { id }),
  deleteSearchCredential: (id) => jx("DELETE", "/api/search-credentials/" + enc(id)),

  // ── Models ─────────────────────────────────────────────────────
  listModels: () => jx("GET", "/api/models"),                    // {hasAnyKey, models:[{modelV,displayName,provider,deck,reachable,preferredRoute}]}

  // ── Usage · /api/usage may not exist → callers tolerate null ───
  getUsage: () => jx("GET", "/api/usage/summary").catch((e) => { if (e.status === 404) return null; throw e; }),

  // ── Agents ─────────────────────────────────────────────────────
  listAgents: () => jx("GET", "/api/agents"),                    // {agents:[Agent], chair:Agent|null}
  getAgent: (id) => jx("GET", "/api/agents/" + enc(id)),
  createAgent: (body) => jx("POST", "/api/agents", body),        // {name,bio,instruction?,modelV,avatarPath?,roleTag?,ability?,coverQuote?}
  patchAgent: (id, body) => jx("PATCH", "/api/agents/" + enc(id), body),
  deleteAgent: (id) => jx("DELETE", "/api/agents/" + enc(id)),
  generateSpec: (description, webSearch) => jx("POST", "/api/agents/generate-spec", { description, webSearch: !!webSearch }),
  generatePersona: (description, locale) => jx("POST", "/api/agents/generate-persona", { description, locale: locale || "en" }),
  savePersona: (jobId, body) => jx("POST", "/api/agents/generate-persona/" + enc(jobId) + "/save", body),
  listMemories: (id) => jx("GET", "/api/agents/" + enc(id) + "/memories"),
  addMemory: (id, body) => jx("POST", "/api/agents/" + enc(id) + "/memories", body),
  deleteMemory: (id, memId) => jx("DELETE", "/api/agents/" + enc(id) + "/memories/" + enc(memId)),
  agentStats: (id) => jx("GET", "/api/agents/" + enc(id) + "/stats"),
  personaMd: (id) => jx("GET", "/api/agents/" + enc(id) + "/persona.md"),   // returns markdown text
  celebritySeed: (excludeIds) => jx("POST", "/api/agents/celebrity-seed", { excludeIds: excludeIds || [] }),

  // ── Rooms ──────────────────────────────────────────────────────
  listRooms: () => jx("GET", "/api/rooms"),                      // {rooms:[Room]}
  getRoom: (id) => jx("GET", "/api/rooms/" + enc(id)),           // {room,members,messages,events,queue,round,parentRef?,followUps}
  createRoom: (body) => jx("POST", "/api/rooms", body),          // {subject,mode,intensity,deliveryMode,briefStyle,agentIds?,autoPick?}
  sendMessage: (id, body) => jx("POST", "/api/rooms/" + enc(id) + "/messages", body),  // {body,replyToId?,mentions?,mode:"now"|"after-speaker"}
  abortRoom: (id) => jx("POST", "/api/rooms/" + enc(id) + "/abort"),
  adjournRoom: (id, body) => jx("POST", "/api/rooms/" + enc(id) + "/adjourn", body || {}),
  deleteRoom: (id) => jx("DELETE", "/api/rooms/" + enc(id)),
  pauseRoom: (id, mode) => jx("POST", "/api/rooms/" + enc(id) + "/pause", { mode: mode || "soft" }),
  resumeRoom: (id) => jx("POST", "/api/rooms/" + enc(id) + "/resume"),
  continueRoom: (id) => jx("POST", "/api/rooms/" + enc(id) + "/continue"),   // next reactive round after a round-end (requires status "live")
  roundEnd: (id, mode) => jx("POST", "/api/rooms/" + enc(id) + "/round-end", { mode: mode || "now" }),   // chair formal round-end + key-point vote (desktop "Open vote")
  voteKeyPoint: (id, kpId, vote) => jx("POST", "/api/rooms/" + enc(id) + "/keypoints/" + enc(kpId) + "/vote", { vote }),   // vote: "up" | "down" | null (toggle)
  patchRoom: (id, body) => jx("PATCH", "/api/rooms/" + enc(id), body),
  patchMembers: (id, agentIds) => jx("PATCH", "/api/rooms/" + enc(id) + "/members", { agentIds }),
  roomBriefs: (id) => jx("GET", "/api/rooms/" + enc(id) + "/briefs"),
  generateBrief: (id, body) => jx("POST", "/api/rooms/" + enc(id) + "/brief", body || {}),
  renderCatalog: () => jx("GET", "/api/render-catalog").catch(() => null),
  voiceProgress: (id, mid) => jx("POST", "/api/rooms/" + enc(id) + "/messages/" + enc(mid) + "/voice-progress").catch(() => null),
  voiceDone: (id, mid) => jx("POST", "/api/rooms/" + enc(id) + "/messages/" + enc(mid) + "/voice-done").catch(() => null),

  // ── Briefs ─────────────────────────────────────────────────────
  getBrief: (id) => jx("GET", "/api/briefs/" + enc(id)),
  briefStatus: (id) => jx("GET", "/api/briefs/" + enc(id) + "/status"),

  // ── Voice setup · TTS voice catalog + preview + friendly labels.
  // Mirrors the desktop agent-profile voice block. Saving a director's
  // voice goes through patchAgent(id, { voice: {...} }).
  listVoices: (cursor, pageSize) =>
    jx("GET", "/api/voices?pageSize=" + (pageSize || 30) + (cursor ? "&cursor=" + enc(cursor) : "")),
  // → {voices:[{provider,model,voiceId,label,language}], nextCursor, hasMore, provider, configured, error}
  // FULL catalog (no paging params) · complete voiceId→label map so a saved
  // voice resolves to its friendly name even when it's not on a loaded page.
  listAllVoices: () => jx("GET", "/api/voices"), // → {voices:[...], provider, configured}
  previewVoice: (body) => jx("POST", "/api/voices/preview", body), // → {audioBase64, mimeType} | {error,code,upgradeUrl}
  renameVoiceLabel: (voiceId, provider, label) =>
    jx("PUT", "/api/voice-labels/" + enc(voiceId), { provider, label }),
};

/* ── SSE · room event stream ─────────────────────────────────────────
   EventSource auto-reconnects; the server ring-buffers + replays via
   Last-Event-ID. `handlers` is a map of event-name → (data, rawEvent).
   Returns the EventSource so the caller can `.close()`. */
const ROOM_EVENTS = [
  "hello", "message-appended", "message-token", "message-final",
  "message-removed", "message-error", "message-updated",
  "voice-chunk", "voice-final", "voice-error", "config-event", "queue-update",
];
export function openRoomStream(roomId, handlers) {
  let es;
  try { es = new EventSource("/api/rooms/" + enc(roomId) + "/stream"); }
  catch (_) { return null; }
  for (const type of ROOM_EVENTS) {
    if (!handlers[type]) continue;
    es.addEventListener(type, (e) => {
      let d = null; try { d = e.data ? JSON.parse(e.data) : null; } catch (_) { /* */ }
      handlers[type](d, e);
    });
  }
  if (handlers.error) es.onerror = (e) => handlers.error(e);
  return es;
}

/* ── SSE · persona-build job stream (Full-persona director) ─────────
   Event names mirror src/orchestrator/persona-stream.ts (PersonaEvent.type):
   phase-start/progress/end drive the 7-step timeline; persona-final
   carries the save-form payload {spec,instruction,bio,coverQuote,ability,
   guessName,guessRoleTag}. */
const PERSONA_EVENTS = [
  "hello", "persona-phase-start", "persona-phase-progress", "persona-phase-end",
  "persona-dimension-plan", "persona-search-round",
  "persona-final", "persona-error", "persona-aborted",
];
export function openPersonaStream(jobId, handlers) {
  let es;
  try { es = new EventSource("/api/agents/generate-persona/" + enc(jobId) + "/stream"); }
  catch (_) { return null; }
  for (const type of PERSONA_EVENTS) {
    if (!handlers[type]) continue;
    es.addEventListener(type, (e) => {
      let d = null; try { d = e.data ? JSON.parse(e.data) : null; } catch (_) { /* */ }
      handlers[type](d, e);
    });
  }
  if (handlers.error) es.onerror = (e) => handlers.error(e);
  return es;
}
