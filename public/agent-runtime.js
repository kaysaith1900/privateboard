/* ════════════════════════════════════════════════════════════════
   AgentRuntime · shared agent / voice / persona-build logic
   ════════════════════════════════════════════════════════════════
   The desktop controller (public/app.js + public/agent-profile.js +
   public/new-agent.js) and the mobile shell (public/m/index.html)
   historically each reimplemented director-profile mutations, voice
   preview / distill, and the persona-build flow. That dual
   implementation is exactly what drifts out of sync (wrong payload
   fields, missing key gates, fire-and-forget streams).

   This module is the single home for that logic — DOM-agnostic, like
   room-meeting-runtime.js. It exposes:
     · createAgentApi()      — the one place every agent/voice/persona
                                HTTP contract is encoded.
     · pure helpers          — model-picker resolution, voice-preview
                                payload, keypoint-vote toggle, seed
                                deletion gate, persona save payload,
                                persona / distill SSE → state reducers.
   Both surfaces call these; each keeps only its own thin view layer
   (DOM rendering, optimistic repaint, overlays).

   Loaded by BOTH public/index.html and public/m/index.html. Exposed as
   `global.AgentRuntime`. Also exported for vitest via module.exports.
   ════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  function enc(v) {
    return encodeURIComponent(String(v == null ? "" : v));
  }

  async function readJson(res, fallbackMsg) {
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || fallbackMsg || ("HTTP " + res.status);
      const err = new Error(msg);
      // Propagate structured fields (paid-plan-required, provider, upgradeUrl)
      // so callers can branch without re-parsing.
      if (data && typeof data === "object") {
        if (data.code) err.code = data.code;
        if (data.provider) err.provider = data.provider;
        if (data.upgradeUrl) err.upgradeUrl = data.upgradeUrl;
      }
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** The single source of truth for agent / voice / persona HTTP
   *  contracts. `fetchImpl` is injectable for tests. */
  function createAgentApi(fetchImpl) {
    const f = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const jsonPost = (url, body) => f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return {
      // ── reads ──
      async listAgents() {
        return readJson(await f("/api/agents"), "failed to load agents");
      },
      async agentStats(id) {
        return readJson(await f("/api/agents/" + enc(id) + "/stats"), "failed to load stats");
      },
      async personaMarkdown(id) {
        const r = await f("/api/agents/" + enc(id) + "/persona.md", { credentials: "same-origin" });
        if (!r.ok) throw new Error("failed to load persona.md (HTTP " + r.status + ")");
        return r.text();
      },
      // ── director profile mutations ──
      async patchAgent(id, patch) {
        return readJson(await f("/api/agents/" + enc(id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch || {}),
        }), "update failed");
      },
      async deleteAgent(id) {
        return readJson(await f("/api/agents/" + enc(id), { method: "DELETE" }), "delete failed");
      },
      // ── skills ──
      async listSkills(id) {
        return readJson(await f("/api/agents/" + enc(id) + "/skills"), "failed to load skills");
      },
      async addSkill(id, md) {
        return readJson(await jsonPost("/api/agents/" + enc(id) + "/skills", { md }), "skill install failed");
      },
      async deleteSkill(id, skillId) {
        return readJson(await f("/api/agents/" + enc(id) + "/skills/" + enc(skillId), { method: "DELETE" }), "skill delete failed");
      },
      // ── director memories ──
      async listMemories(id) {
        return readJson(await f("/api/agents/" + enc(id) + "/memories"), "failed to load memories");
      },
      async addMemory(id, body) {
        return readJson(await jsonPost("/api/agents/" + enc(id) + "/memories", body), "memory add failed");
      },
      async patchMemory(id, memId, patch) {
        return readJson(await f("/api/agents/" + enc(id) + "/memories/" + enc(memId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch || {}),
        }), "memory update failed");
      },
      async deleteMemory(id, memId) {
        return readJson(await f("/api/agents/" + enc(id) + "/memories/" + enc(memId), { method: "DELETE" }), "memory delete failed");
      },
      async triggerDream(id) {
        return readJson(await f("/api/agents/" + enc(id) + "/dream", { method: "POST" }), "dream failed");
      },
      // ── chair long-term (about-the-user) memory ──
      async chairLongMemory() {
        return readJson(await f("/api/agents/chair/user-long-memory"), "failed to load chair memory");
      },
      async patchChairMemory(memId, claim) {
        return readJson(await f("/api/agents/chair/user-long-memory/" + enc(memId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ claim }),
        }), "chair memory update failed");
      },
      async deleteChairMemory(memId) {
        const r = await f("/api/agents/chair/user-long-memory/" + enc(memId), { method: "DELETE" });
        // DELETE may answer 204 No Content; treat that as success.
        if (r.status === 204) return {};
        return readJson(r, "chair memory delete failed");
      },
      // ── models ──
      async models() {
        return readJson(await f("/api/models"), "failed to load models");
      },
      // ── voice ──
      async previewVoice(payload) {
        return readJson(await jsonPost("/api/voices/preview", payload), "voice preview failed");
      },
      async cloneFromVideo(body) {
        return readJson(await jsonPost("/api/voices/clone-from-video", body), "voice distill failed");
      },
      async abortClone(jobId) {
        return readJson(await f("/api/voices/clone-from-video/" + enc(jobId) + "/abort", { method: "POST" }), "voice distill abort failed");
      },
      // ── persona build ──
      async generatePersona(body) {
        return readJson(await jsonPost("/api/agents/generate-persona", body), "persona build kickoff failed");
      },
      async savePersona(jobId, body) {
        return readJson(await jsonPost("/api/agents/generate-persona/" + enc(jobId) + "/save", body), "persona save failed");
      },
      async abortPersona(jobId) {
        return readJson(await f("/api/agents/generate-persona/" + enc(jobId) + "/abort", { method: "POST" }), "persona abort failed");
      },
    };
  }

  // ───────────────────────── pure helpers ─────────────────────────

  /** Resolve the model picker from a /api/models response. Only models
   *  the active credential can REACH are offered (matches PC
   *  pickerEntries — never the full registry). carrierPref is pinned to
   *  null under the single-active-provider invariant. */
  function resolveModelPicker(modelsResponse) {
    const data = modelsResponse || {};
    const reachable = Array.isArray(data.reachable) ? data.reachable : [];
    return {
      hasKey: !!data.hasAnyKey,
      entries: reachable.map((m) => ({
        modelV: m.modelV,
        carrierPref: null,
        displayName: m.displayName || m.modelV,
        provider: m.provider || "",
        label: (m.displayName || m.modelV) + (m.provider ? " · " + m.provider : ""),
      })),
    };
  }

  /** Build the /api/voices/preview payload from a director's voice
   *  profile. Returns null when the director has no own voiceId — the
   *  caller must refuse rather than synthesize a default voice that
   *  misrepresents the director (matches PC previewVoice). */
  function buildVoicePreviewPayload(voice, text) {
    if (!voice || !voice.voiceId) return null;
    return {
      // Cap matches the backend contract (src/routes/voices.ts caps at 200);
      // PC previously sent up to 200, so keep parity.
      text: String(text || "").slice(0, 200),
      provider: voice.provider,
      model: voice.model,
      voiceId: voice.voiceId,
      speed: voice.speed,
      pitch: voice.pitch,
      emotion: voice.emotion,
      modifyPitch: voice.modifyPitch,
      modifyIntensity: voice.modifyIntensity,
      modifyTimbre: voice.modifyTimbre,
    };
  }

  /** Keypoint vote toggle: re-voting the same direction clears the vote.
   *  Accepts "up"/"down" or a legacy numeric score (>0 → up, else down).
   *  Returns the final vote ("up" | "down" | null) to send as { vote }. */
  function resolveKeyPointVote(prevVote, requested) {
    let desired = requested;
    if (typeof requested === "number") desired = requested > 0 ? "up" : "down";
    if (desired !== "up" && desired !== "down") desired = null;
    const prev = prevVote === "up" || prevVote === "down" ? prevVote : null;
    return prev !== null && prev === desired ? null : desired;
  }

  /** Seed / chair deletion gate (mirrors backend 403s + PC guard). */
  function agentDeletionGate(agent) {
    if (!agent) return { ok: false, reason: "missing" };
    if (agent.roleKind === "moderator") return { ok: false, reason: "moderator" };
    if (agent.isSeed) return { ok: false, reason: "seed" };
    return { ok: true, reason: "" };
  }

  /** A skill row is user-installed (deletable) iff it is not a system
   *  skill. Backend tags system skills with `system: true` and prefixes
   *  their ids with "system:". */
  function isDeletableSkill(skill) {
    return !!skill && !skill.system;
  }

  /** Normalize the chair long-memory response to its rows. Backend
   *  returns { items: UserLongMemory[] } (id, label, claim, ...). */
  function chairMemoryItems(response) {
    return response && Array.isArray(response.items) ? response.items : [];
  }

  /** Build the POST /save body from a persona-final payload + the
   *  user-confirmed name and a chosen avatar. Backend fills sensible
   *  defaults for anything omitted. */
  function buildPersonaSavePayload(finalPayload, opts) {
    const data = finalPayload || {};
    const o = opts || {};
    const body = {
      name: String(o.name || "").trim(),
      bio: typeof data.bio === "string" ? data.bio : "",
      roleTag: typeof data.guessRoleTag === "string" && data.guessRoleTag.trim() ? data.guessRoleTag.trim() : "director",
      instruction: typeof data.instruction === "string" ? data.instruction : "",
      coverQuote: typeof data.coverQuote === "string" ? data.coverQuote : "",
    };
    if (o.avatarPath) body.avatarPath = o.avatarPath;
    if (data.ability && typeof data.ability === "object") body.ability = data.ability;
    return body;
  }

  /** Build the /generate-persona body. voiceSourceUrl is only attached
   *  when a recognised video URL was actually extracted (PC omits it
   *  otherwise; an empty string would read as an intentional override). */
  function buildPersonaStartPayload(description, opts) {
    const o = opts || {};
    const body = { description: String(description || ""), locale: o.locale || "en" };
    if (o.voiceSourceUrl) body.voiceSourceUrl = o.voiceSourceUrl;
    return body;
  }

  /** Reduce a persona-build SSE event into a partial state patch — the single
   *  home for the mobile shell's phase/detail/progress bookkeeping (it folds
   *  all four phase events through one function instead of four near-identical
   *  handlers). NOTE: this preserves the mobile shell's prior progress cadence
   *  (belt-and-braces advance to phase+1 on persona-phase-end so a slow next
   *  phase-start doesn't strand the UI); the PC composer's own handler advances
   *  only on phase-start and prefixes the detail with "starting · ". That is a
   *  view-layer display difference only — the build LOGIC (phases, API calls,
   *  save) is identical. `prev` is the current
   *  {phase, detail, progressPct, voiceDistillPhase}; terminal events set
   *  `terminal`. */
  function reducePersonaEvent(type, data, prev, phaseCount) {
    const d = data || {};
    const p = prev || {};
    const max = phaseCount || 7;
    switch (type) {
      case "hello": {
        const patch = {};
        if (typeof d.currentPhase === "number") patch.phase = Math.max(1, d.currentPhase);
        if (typeof d.progressPct === "number") patch.progressPct = d.progressPct;
        return patch;
      }
      case "persona-phase-start": {
        const patch = {};
        if (typeof d.phase === "number") {
          if (p.phase === 5 && d.phase !== 5) patch.voiceDistillPhase = 0;
          patch.phase = d.phase;
        }
        if (typeof d.label === "string") patch.detail = d.label;
        return patch;
      }
      case "persona-phase-progress": {
        const patch = {};
        if (typeof d.phase === "number") patch.phase = d.phase;
        if (typeof d.detail === "string") patch.detail = d.detail;
        if (typeof d.progressPct === "number") patch.progressPct = d.progressPct;
        if (typeof d.voiceDistillPhase === "number") patch.voiceDistillPhase = d.voiceDistillPhase;
        return patch;
      }
      case "persona-phase-end": {
        const patch = {};
        if (typeof d.phase === "number" && d.phase >= (p.phase || 1)) {
          if (d.phase === 5) patch.voiceDistillPhase = 0;
          patch.phase = Math.min(max, d.phase + 1);
          patch.detail = "";
        }
        if (typeof d.progressPct === "number") patch.progressPct = d.progressPct;
        return patch;
      }
      case "persona-final": return { terminal: true, outcome: "final", progressPct: 100 };
      case "persona-aborted": return { terminal: true, outcome: "aborted" };
      case "persona-error": return { terminal: true, outcome: "error", error: d.message || "build failed" };
      default: return {};
    }
  }

  /** Reduce a voice-distill SSE event into a job-state patch (mirrors PC
   *  _openVoiceDistillSse). Returns patch; terminal events set `terminal`. */
  function reduceVoiceDistillEvent(type, data) {
    const d = data || {};
    switch (type) {
      case "hello": {
        const patch = {};
        if (d.currentPhase) patch.phase = d.currentPhase;
        if (typeof d.progressPct === "number") patch.progressPct = d.progressPct;
        patch.status = d.status && d.status !== "running" ? d.status : "running";
        if (d.voiceId) patch.voiceId = d.voiceId;
        return patch;
      }
      case "voice-distill-phase-start": return { status: "running", phase: d.phase, detail: d.label || "" };
      case "voice-distill-phase-progress": {
        const patch = { status: "running", phase: d.phase };
        if (typeof d.progressPct === "number") patch.progressPct = d.progressPct;
        if (d.detail) patch.detail = d.detail;
        return patch;
      }
      case "voice-distill-phase-end": {
        const patch = {};
        if (typeof d.progressPct === "number") patch.progressPct = d.progressPct;
        return patch;
      }
      case "voice-distill-warning": return { detail: "⚠ " + (d.message || "") };
      case "voice-distill-final": return { terminal: true, status: "done", progressPct: 100, voiceId: d.voiceId };
      case "voice-distill-error": return { terminal: true, status: "failed", error: d.message || "distill failed" };
      case "voice-distill-aborted": return { terminal: true, status: "aborted" };
      default: return {};
    }
  }

  const AgentRuntime = {
    createAgentApi,
    resolveModelPicker,
    buildVoicePreviewPayload,
    resolveKeyPointVote,
    agentDeletionGate,
    isDeletableSkill,
    chairMemoryItems,
    buildPersonaSavePayload,
    buildPersonaStartPayload,
    reducePersonaEvent,
    reduceVoiceDistillEvent,
  };

  global.AgentRuntime = AgentRuntime;
  if (typeof module !== "undefined" && module.exports) module.exports = AgentRuntime;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
