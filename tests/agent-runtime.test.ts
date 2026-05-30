import { describe, expect, it } from "vitest";

import "../public/agent-runtime.js";

const AR = (globalThis as unknown as {
  AgentRuntime: {
    createAgentApi: (fetchImpl: unknown) => Record<string, (...args: unknown[]) => Promise<unknown>>;
    resolveModelPicker: (r: unknown) => { hasKey: boolean; entries: Array<Record<string, unknown>> };
    buildVoicePreviewPayload: (voice: unknown, text: unknown) => Record<string, unknown> | null;
    resolveKeyPointVote: (prev: unknown, requested: unknown) => string | null;
    agentDeletionGate: (a: unknown) => { ok: boolean; reason: string };
    isDeletableSkill: (s: unknown) => boolean;
    chairMemoryItems: (r: unknown) => unknown[];
    buildPersonaSavePayload: (p: unknown, o: unknown) => Record<string, unknown>;
    buildPersonaStartPayload: (d: unknown, o: unknown) => Record<string, unknown>;
    reducePersonaEvent: (t: string, d: unknown, prev: unknown, n?: number) => Record<string, unknown>;
    reduceVoiceDistillEvent: (t: string, d: unknown) => Record<string, unknown>;
  };
}).AgentRuntime;

describe("AgentRuntime · model picker", () => {
  it("offers only reachable models, pins carrierPref null, reads hasAnyKey", () => {
    const out = AR.resolveModelPicker({
      hasAnyKey: true,
      reachable: [
        { modelV: "opus-4-8", displayName: "Opus 4.8", provider: "anthropic" },
        { modelV: "gpt-x", displayName: "GPT-X", provider: "openai" },
      ],
      models: [{ modelV: "unreachable" }],
    });
    expect(out.hasKey).toBe(true);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({ modelV: "opus-4-8", carrierPref: null, label: "Opus 4.8 · anthropic" });
  });

  it("reports no key when hasAnyKey is falsy and tolerates missing reachable", () => {
    const out = AR.resolveModelPicker({});
    expect(out.hasKey).toBe(false);
    expect(out.entries).toEqual([]);
  });
});

describe("AgentRuntime · voice preview payload", () => {
  it("returns null when the director has no own voiceId (no default-voice fallback)", () => {
    expect(AR.buildVoicePreviewPayload(null, "hi")).toBeNull();
    expect(AR.buildVoicePreviewPayload({ provider: "minimax" }, "hi")).toBeNull();
  });

  it("forwards the full shaping payload when a voiceId exists", () => {
    const payload = AR.buildVoicePreviewPayload(
      { voiceId: "v1", provider: "minimax", model: "speech-2.8-hd", speed: 1.2, pitch: -2, emotion: "calm", modifyPitch: 10, modifyIntensity: -5, modifyTimbre: 3 },
      "x".repeat(260),
    )!;
    expect(payload).toMatchObject({ voiceId: "v1", provider: "minimax", model: "speech-2.8-hd", speed: 1.2, pitch: -2, emotion: "calm", modifyPitch: 10, modifyIntensity: -5, modifyTimbre: 3 });
    expect((payload.text as string).length).toBe(200); // clamped to the backend cap
  });
});

describe("AgentRuntime · keypoint vote toggle", () => {
  it("returns the requested direction from a clean slate", () => {
    expect(AR.resolveKeyPointVote(null, "up")).toBe("up");
    expect(AR.resolveKeyPointVote(null, "down")).toBe("down");
  });
  it("maps legacy numeric scores (>0 up, else down)", () => {
    expect(AR.resolveKeyPointVote(null, 5)).toBe("up");
    expect(AR.resolveKeyPointVote(null, -99)).toBe("down");
  });
  it("toggles off when re-voting the same direction", () => {
    expect(AR.resolveKeyPointVote("up", "up")).toBeNull();
    expect(AR.resolveKeyPointVote("down", "down")).toBeNull();
  });
  it("switches when voting the opposite direction", () => {
    expect(AR.resolveKeyPointVote("up", "down")).toBe("down");
  });
});

describe("AgentRuntime · deletion gate + skills + chair memory", () => {
  it("blocks moderator + seed directors, allows ordinary ones", () => {
    expect(AR.agentDeletionGate({ roleKind: "moderator" })).toMatchObject({ ok: false, reason: "moderator" });
    expect(AR.agentDeletionGate({ isSeed: true })).toMatchObject({ ok: false, reason: "seed" });
    expect(AR.agentDeletionGate({ id: "x" })).toMatchObject({ ok: true });
    expect(AR.agentDeletionGate(null)).toMatchObject({ ok: false });
  });
  it("treats only non-system skills as deletable", () => {
    expect(AR.isDeletableSkill({ id: "s1", system: false })).toBe(true);
    expect(AR.isDeletableSkill({ id: "system:web", system: true })).toBe(false);
  });
  it("reads chair memory rows from { items } only", () => {
    expect(AR.chairMemoryItems({ items: [{ id: "1" }] })).toHaveLength(1);
    expect(AR.chairMemoryItems({ memories: [{ id: "x" }] })).toEqual([]);
    expect(AR.chairMemoryItems(null)).toEqual([]);
  });
});

describe("AgentRuntime · persona payloads", () => {
  it("builds a save payload, defaulting roleTag and omitting empty avatar", () => {
    const body = AR.buildPersonaSavePayload(
      { bio: "b", guessRoleTag: "  ", instruction: "i", coverQuote: "q", ability: { rigor: 5 } },
      { name: "  Warren  " },
    );
    expect(body).toMatchObject({ name: "Warren", bio: "b", roleTag: "director", instruction: "i", coverQuote: "q", ability: { rigor: 5 } });
    expect("avatarPath" in body).toBe(false);
  });
  it("only attaches voiceSourceUrl when present", () => {
    expect(AR.buildPersonaStartPayload("desc", { locale: "zh" })).toEqual({ description: "desc", locale: "zh" });
    expect(AR.buildPersonaStartPayload("desc", { locale: "zh", voiceSourceUrl: "https://x" })).toMatchObject({ voiceSourceUrl: "https://x" });
  });
});

describe("AgentRuntime · SSE reducers", () => {
  it("reduces persona phase events and flags terminal states", () => {
    expect(AR.reducePersonaEvent("persona-phase-progress", { phase: 3, detail: "drafting", progressPct: 40 }, { phase: 2 })).toMatchObject({ phase: 3, detail: "drafting", progressPct: 40 });
    expect(AR.reducePersonaEvent("persona-phase-end", { phase: 2, progressPct: 50 }, { phase: 2 }, 7)).toMatchObject({ phase: 3, detail: "" });
    expect(AR.reducePersonaEvent("persona-final", {}, {})).toMatchObject({ terminal: true, outcome: "final" });
    expect(AR.reducePersonaEvent("persona-error", { message: "boom" }, {})).toMatchObject({ terminal: true, outcome: "error", error: "boom" });
  });
  it("clears voice-distill substate when leaving phase 5", () => {
    expect(AR.reducePersonaEvent("persona-phase-start", { phase: 6 }, { phase: 5 })).toMatchObject({ phase: 6, voiceDistillPhase: 0 });
  });
  it("reduces voice-distill events and flags terminal final/error", () => {
    expect(AR.reduceVoiceDistillEvent("voice-distill-phase-progress", { phase: 2, progressPct: 30, detail: "x" })).toMatchObject({ status: "running", phase: 2, progressPct: 30, detail: "x" });
    expect(AR.reduceVoiceDistillEvent("voice-distill-final", { voiceId: "vv" })).toMatchObject({ terminal: true, status: "done", voiceId: "vv", progressPct: 100 });
    expect(AR.reduceVoiceDistillEvent("voice-distill-error", { message: "no audio" })).toMatchObject({ terminal: true, status: "failed", error: "no audio" });
  });
});

describe("AgentRuntime · api client contracts", () => {
  it("sends the backend keypoint... no — agent endpoints with correct verbs/bodies", async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = [];
    const fakeFetch = async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init: init || {} });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    };
    const api = AR.createAgentApi(fakeFetch);

    await api.patchAgent("a1", { modelV: "m", carrierPref: null });
    await api.deleteSkill("a1", "s1");
    await api.savePersona("job1", { name: "N" });
    await api.previewVoice({ voiceId: "v" });

    expect(calls[0]).toMatchObject({ url: "/api/agents/a1", init: { method: "PATCH" } });
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ modelV: "m", carrierPref: null });
    expect(calls[1]).toMatchObject({ url: "/api/agents/a1/skills/s1", init: { method: "DELETE" } });
    expect(calls[2].url).toBe("/api/agents/generate-persona/job1/save");
    expect(calls[3].url).toBe("/api/voices/preview");
  });

  it("throws with propagated structured fields on a paid-plan-required error", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: "insufficient balance", code: "paid-plan-required", provider: "minimax", upgradeUrl: "https://pay" }),
    } as unknown as Response);
    const api = AR.createAgentApi(fakeFetch);
    await expect(api.previewVoice({ voiceId: "v" })).rejects.toMatchObject({ code: "paid-plan-required", provider: "minimax", upgradeUrl: "https://pay" });
  });
});
