/**
 * SIM-swap memory · per-agent model + voice picks survive a provider
 * round-trip. Each agent's `model_by_provider_json` and
 * `voice_by_provider_json` columns are server-side internal state; the
 * reconcile pass snapshots into them before overwriting agent.modelV
 * / agent.voice, and restores from them on the way back.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  getModelBucket,
  getVoiceBucket,
  insertAgent,
  listAllAgents,
  updateAgent,
  writeModelBucketEntry,
  writeVoiceBucketEntry,
  type AgentVoiceProfile,
} from "../src/storage/agents.js";
import { getDb } from "../src/storage/db.js";
import { getPrefs, updatePrefs } from "../src/storage/prefs.js";
import { createLlmCredential } from "../src/storage/credentials.js";
import { createVoiceCredential } from "../src/storage/voice-credentials.js";
import { reconcileAgentModels } from "../src/storage/reconcile-models.js";
import { reconcileAgentVoices } from "../src/storage/reconcile-voices.js";
import type { LlmProvider } from "../src/ai/providers.js";

function clearLlmCreds(): void {
  getDb().prepare("DELETE FROM llm_credentials").run();
  updatePrefs({ activeLlmCredentialId: null, defaultModelV: null });
}

function clearVoiceCreds(): void {
  getDb().prepare("DELETE FROM voice_credentials").run();
  updatePrefs({ activeVoiceCredentialId: null });
}

function setActiveLlm(provider: LlmProvider, key: string): string {
  const meta = createLlmCredential(provider, null, key);
  if (!meta) throw new Error(`failed to create LLM credential for ${provider}`);
  updatePrefs({ activeLlmCredentialId: meta.id });
  return meta.id;
}

function setActiveVoice(provider: "minimax" | "elevenlabs", key: string): string {
  const meta = createVoiceCredential(provider, null, key);
  if (!meta) throw new Error(`failed to create voice credential for ${provider}`);
  updatePrefs({ activeVoiceCredentialId: meta.id });
  return meta.id;
}

/** Insert a director with a fixed identity for the round-trip tests.
 *  The seed model is `opus-4-6-fast` (reachable on every LLM provider
 *  via the `openrouterId`/`baiId`/direct routes for Anthropic). */
function makeDirector(id: string, modelV = "opus-4-6-fast"): void {
  insertAgent({
    id,
    name: id.toUpperCase(),
    handle: `@${id}`,
    roleTag: "analyst",
    roleKind: "director",
    bio: "",
    instruction: "",
    modelV,
    avatarPath: `/avatars/${id}.svg`,
  });
}

function makeChair(id: string, modelV = "opus-4-6-fast"): void {
  insertAgent({
    id,
    name: "CHAIR",
    handle: "@chair",
    roleTag: "moderator",
    roleKind: "moderator",
    bio: "",
    instruction: "",
    modelV,
    avatarPath: `/avatars/${id}.svg`,
  });
}

function agentById(id: string) {
  return listAllAgents().find((a) => a.id === id) ?? null;
}

describe("reconcile-models · SIM-swap memory", () => {
  beforeEach(() => {
    clearLlmCreds();
    clearVoiceCreds();
    getDb().prepare("DELETE FROM agents").run();
  });

  it("restores a director's manual modelV pick after a provider round-trip", () => {
    setActiveLlm("openrouter", "sk-or-v1-test");
    makeDirector("d1");

    // User manually picks claude-sonnet-4.6 under OpenRouter · also
    // seed the bucket the same way PATCH /api/agents/:id would have.
    updateAgent("d1", { modelV: "sonnet-4-6" });
    writeModelBucketEntry("d1", "openrouter", "sonnet-4-6");
    expect(agentById("d1")?.modelV).toBe("sonnet-4-6");

    // Switch active to Anthropic-direct · simulate the route layer:
    // capture priorCarrier BEFORE flipping prefs, then reconcile with
    // forcePrimary so every agent funnels through the bucket-aware
    // restore branch (Anthropic-direct can reach sonnet-4-6 too, so
    // without forcePrimary the agent would be "reachable, keep").
    const priorCarrier: LlmProvider = "openrouter";
    setActiveLlm("anthropic", "sk-ant-test");
    reconcileAgentModels({ forcePrimary: true, priorCarrier });

    // Bucket['openrouter'] survives the switch.
    const bucketAfterSwitch = getModelBucket("d1");
    expect(bucketAfterSwitch.openrouter).toBe("sonnet-4-6");
    // Director's current modelV is now SOMETHING from the Anthropic
    // fast pool (random pick · opus-4-6-fast or haiku-4-5). Either
    // way it's no longer sonnet-4-6 (that pick was provider-gone) and
    // bucket['anthropic'] mirrors whatever we landed on.
    const anthropicFastPool = ["opus-4-6-fast", "haiku-4-5"];
    const landedOnAnthropic = agentById("d1")?.modelV;
    expect(landedOnAnthropic && anthropicFastPool.includes(landedOnAnthropic)).toBe(true);
    expect(bucketAfterSwitch.anthropic).toBe(landedOnAnthropic);

    // Switch back to OpenRouter · the bucket entry should restore.
    clearLlmCreds();
    setActiveLlm("openrouter", "sk-or-v1-test2");
    reconcileAgentModels({ forcePrimary: true, priorCarrier: "anthropic" });
    expect(agentById("d1")?.modelV).toBe("sonnet-4-6");
  });

  it("restores a chair's manual modelV pick across providers (chair is not exempt)", () => {
    setActiveLlm("openrouter", "sk-or-v1-test");
    makeChair("chair-1");

    // Chair manually pinned to opus-4-7 under OpenRouter.
    updateAgent("chair-1", { modelV: "opus-4-7" });
    writeModelBucketEntry("chair-1", "openrouter", "opus-4-7");

    setActiveLlm("anthropic", "sk-ant-test");
    reconcileAgentModels({ forcePrimary: true, priorCarrier: "openrouter" });
    // Under Anthropic, chair lands on the carrier primary (haiku-4-5).
    expect(agentById("chair-1")?.modelV).toBe("haiku-4-5");

    clearLlmCreds();
    setActiveLlm("openrouter", "sk-or-v1-test2");
    reconcileAgentModels({ forcePrimary: true, priorCarrier: "anthropic" });
    // Chair restored to the user's explicit pick on OpenRouter.
    expect(agentById("chair-1")?.modelV).toBe("opus-4-7");
  });

  it("drops a stale bucket entry whose model is no longer in the registry", () => {
    setActiveLlm("openrouter", "sk-or-v1-test");
    makeDirector("d2");
    // Seed a bucket entry pointing at a model that doesn't exist.
    writeModelBucketEntry("d2", "openrouter", "imaginary-model-v999");

    // Force the reconcile to consult the bucket on the same provider ·
    // priorCarrier intentionally differs so the "keep if reachable"
    // guard would normally fire, but the agent's current modelV
    // (opus-4-6-fast) is reachable so without forcePrimary it'd skip
    // the bucket lookup entirely. Use forcePrimary to funnel through.
    reconcileAgentModels({ forcePrimary: true, priorCarrier: "anthropic" });

    // Stale entry should have been removed; agent gets a fresh
    // OpenRouter fast-pool pick.
    const bucket = getModelBucket("d2");
    expect(bucket.openrouter).not.toBe("imaginary-model-v999");
    // Bucket['openrouter'] is whatever the reconcile picked.
    expect(typeof bucket.openrouter).toBe("string");
    expect(bucket.openrouter!.length).toBeGreaterThan(0);
  });

  it("self-heal (no priorCarrier) honours existing bucket entries without snapshotting", () => {
    setActiveLlm("openrouter", "sk-or-v1-test");
    makeDirector("d3");

    // Pre-populate bucket as if from a prior session.
    updateAgent("d3", { modelV: "haiku-4-5" });   // current row value
    writeModelBucketEntry("d3", "openrouter", "sonnet-4-6"); // bucket disagrees

    // Boot-time self-heal · no priorCarrier passed. Should NOT
    // snapshot (we don't want to clobber bucket['openrouter'] with
    // the stale row value). forcePrimary funnels every agent through
    // the bucket-aware branch · the bucket value should win.
    reconcileAgentModels({ forcePrimary: true });

    expect(agentById("d3")?.modelV).toBe("sonnet-4-6");
    // The bucket['openrouter'] entry was honoured and re-seeded with
    // the same value (not overwritten by the stale modelV).
    expect(getModelBucket("d3").openrouter).toBe("sonnet-4-6");
  });

  it("same-provider rotation (two OpenRouter credentials) is a no-op for modelV", () => {
    const id1 = setActiveLlm("openrouter", "sk-or-v1-a");
    void id1;
    makeDirector("d4");
    updateAgent("d4", { modelV: "sonnet-4-6" });
    writeModelBucketEntry("d4", "openrouter", "sonnet-4-6");

    // Add a SECOND OpenRouter credential, then "switch" to it · same
    // provider, just a different credential row.
    const id2 = setActiveLlm("openrouter", "sk-or-v1-b");
    updatePrefs({ activeLlmCredentialId: id2 });
    reconcileAgentModels({ forcePrimary: true, priorCarrier: "openrouter" });

    // Agent's modelV is unchanged · same-provider rotation doesn't
    // cross a SIM boundary.
    expect(agentById("d4")?.modelV).toBe("sonnet-4-6");
    expect(getModelBucket("d4").openrouter).toBe("sonnet-4-6");
  });
});

describe("reconcile-voices · SIM-swap memory", () => {
  beforeEach(() => {
    clearLlmCreds();
    clearVoiceCreds();
    getDb().prepare("DELETE FROM agents").run();
  });

  it("restores a director's manual voice pick after a provider round-trip", () => {
    setActiveVoice("minimax", "mm-test");
    makeDirector("dv1");

    const customVoice: AgentVoiceProfile = {
      provider: "minimax",
      model: "speech-2.8-hd",
      voiceId: "male-qn-qingse",
      speed: 1.2,
    };
    updateAgent("dv1", { voice: customVoice });
    writeVoiceBucketEntry("dv1", "minimax", customVoice);
    expect(agentById("dv1")?.voice?.voiceId).toBe("male-qn-qingse");

    // Switch to ElevenLabs · reconcile snapshots into bucket['minimax']
    // and reshuffles to an ElevenLabs voice from the seed pool.
    setActiveVoice("elevenlabs", "xi-test");
    reconcileAgentVoices({ reason: "provider-switch", priorProvider: "minimax" });

    expect(getVoiceBucket("dv1").minimax?.voiceId).toBe("male-qn-qingse");
    expect(agentById("dv1")?.voice?.provider).toBe("elevenlabs");

    // Switch back to MiniMax · the original voiceId should be restored.
    clearVoiceCreds();
    setActiveVoice("minimax", "mm-test-2");
    reconcileAgentVoices({ reason: "provider-switch", priorProvider: "elevenlabs" });

    expect(agentById("dv1")?.voice?.provider).toBe("minimax");
    expect(agentById("dv1")?.voice?.voiceId).toBe("male-qn-qingse");
    expect(agentById("dv1")?.voice?.speed).toBe(1.2);
  });

  it("clears voice when last credential deleted but preserves the bucket for later restore", () => {
    setActiveVoice("minimax", "mm-test");
    makeDirector("dv2");
    const v: AgentVoiceProfile = {
      provider: "minimax",
      model: "speech-2.8-hd",
      voiceId: "female-yujie",
    };
    updateAgent("dv2", { voice: v });
    writeVoiceBucketEntry("dv2", "minimax", v);

    // Simulate "last credential deleted" · prior was minimax, target is null.
    clearVoiceCreds();
    reconcileAgentVoices({ reason: "provider-switch", priorProvider: "minimax" });

    expect(agentById("dv2")?.voice).toBeNull();
    // Bucket survives the clear.
    expect(getVoiceBucket("dv2").minimax?.voiceId).toBe("female-yujie");

    // Re-add the same provider · the bucket should restore (via
    // first-key path which now seeds from bucket when present).
    setActiveVoice("minimax", "mm-test-2");
    reconcileAgentVoices({ reason: "first-key", priorProvider: null });
    expect(agentById("dv2")?.voice?.voiceId).toBe("female-yujie");
  });
});

describe("PATCH /api/agents/:id bucket write-through", () => {
  // Lightweight in-process test of the bucket-write side-effect that
  // the route handler invokes. We don't spin up Hono · we just check
  // that the helpers themselves write the bucket correctly, which is
  // what the route handler delegates to.
  beforeEach(() => {
    clearLlmCreds();
    clearVoiceCreds();
    getDb().prepare("DELETE FROM agents").run();
  });

  it("writeModelBucketEntry seeds the bucket so subsequent provider switches restore", () => {
    setActiveLlm("openrouter", "sk-or-v1-test");
    makeDirector("p1");

    // Direct call · mirrors what the route handler does after updateAgent.
    writeModelBucketEntry("p1", "openrouter", "sonnet-4-6");

    expect(getModelBucket("p1").openrouter).toBe("sonnet-4-6");
  });

  it("writeVoiceBucketEntry stores credentialed providers; non-credentialed silently no-op", () => {
    setActiveVoice("minimax", "mm-test");
    makeDirector("p2");

    const valid: AgentVoiceProfile = {
      provider: "minimax",
      model: "speech-2.8-hd",
      voiceId: "male-qn-jingying",
    };
    writeVoiceBucketEntry("p2", "minimax", valid);
    expect(getVoiceBucket("p2").minimax?.voiceId).toBe("male-qn-jingying");

    // Mismatched key/profile provider · writeVoiceBucketEntry rejects
    // the write defensively (key === profile.provider invariant).
    writeVoiceBucketEntry("p2", "minimax", {
      ...valid,
      provider: "elevenlabs",
      voiceId: "should-not-land",
    });
    expect(getVoiceBucket("p2").minimax?.voiceId).toBe("male-qn-jingying");
  });
});
