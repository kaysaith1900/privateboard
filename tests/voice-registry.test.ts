import { beforeEach, describe, expect, it } from "vitest";

import { deleteKey, setKey } from "../src/storage/keys.js";
import { getDb } from "../src/storage/db.js";
import { updatePrefs } from "../src/storage/prefs.js";
import {
  createVoiceCredential,
  listVoiceCredentials,
  type VoiceProvider,
} from "../src/storage/voice-credentials.js";
import { defaultVoiceForProvider, listConfiguredVoices } from "../src/voice/registry.js";
import { voiceProfileForAgent } from "../src/voice/tts.js";
import type { Agent } from "../src/storage/agents.js";

// Minimal stub agent with no voice profile set.
function stubAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    name: "Test",
    handle: "@test",
    roleTag: "analyst",
    roleKind: "director",
    bio: "",
    coverQuote: null,
    instruction: "",
    modelV: "sonnet-4-6",
    carrierPref: null,
    avatarPath: "/avatars/t.svg",
    ability: null,
    isPinned: false,
    isSeed: false,
    webSearchEnabled: false,
    voice: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Wipe every voice credential + clear the active pointer so each test
 *  starts from a known "no voice provider" baseline. Same idea as
 *  `deleteKey` for the legacy provider_keys rows, scaled to the new
 *  multi-instance table. */
function resetVoiceCredentials(): void {
  getDb().prepare("DELETE FROM voice_credentials").run();
  updatePrefs({ activeVoiceCredentialId: null });
}

function setActiveVoice(provider: VoiceProvider, key: string): void {
  const meta = createVoiceCredential(provider, null, key);
  if (meta) updatePrefs({ activeVoiceCredentialId: meta.id });
}

describe("listConfiguredVoices", () => {
  beforeEach(() => {
    resetVoiceCredentials();
    deleteKey("openai");
  });

  it("returns only browser when no keys are set", () => {
    const voices = listConfiguredVoices();
    expect(voices.every((v) => v.provider === "browser")).toBe(true);
    expect(voices).toHaveLength(1);
  });

  it("includes elevenlabs voices when elevenlabs is the active voice provider", () => {
    setActiveVoice("elevenlabs", "xi-test");
    const voices = listConfiguredVoices();
    const elVoices = voices.filter((v) => v.provider === "elevenlabs");
    expect(elVoices.length).toBeGreaterThan(0);
    expect(elVoices.every((v) => v.configured)).toBe(true);
  });

  it("includes minimax voices when minimax is the active voice provider", () => {
    setActiveVoice("minimax", "mm-test");
    const voices = listConfiguredVoices();
    const minimaxVoices = voices.filter((v) => v.provider === "minimax");
    expect(minimaxVoices.length).toBeGreaterThan(0);
    expect(minimaxVoices.every((v) => v.configured)).toBe(true);
  });

  it("does NOT include the non-active voice provider's voices when both credentials exist", () => {
    // Add ElevenLabs first, then MiniMax — the MiniMax credential
    // becomes active because POST auto-activates only when active is
    // null. Manually flip active to MiniMax to mirror the route path.
    createVoiceCredential("elevenlabs", null, "xi-test");
    const mm = createVoiceCredential("minimax", null, "mm-test");
    if (mm) updatePrefs({ activeVoiceCredentialId: mm.id });

    const voices = listConfiguredVoices();
    expect(voices.some((v) => v.provider === "minimax")).toBe(true);
    expect(voices.some((v) => v.provider === "elevenlabs")).toBe(false);
    // And the credential list itself still carries both rows.
    expect(listVoiceCredentials().length).toBe(2);
  });

  it("includes openai voices when openai key is set", () => {
    setKey("openai", "sk-test");
    const voices = listConfiguredVoices();
    const openaiVoices = voices.filter((v) => v.provider === "openai");
    expect(openaiVoices.length).toBeGreaterThan(0);
    expect(openaiVoices.every((v) => v.configured)).toBe(true);
  });

  it("always includes browser regardless of key config", () => {
    const browserVoice = listConfiguredVoices().find((v) => v.provider === "browser");
    expect(browserVoice).toBeDefined();
    expect(browserVoice?.configured).toBe(true);
  });
});

describe("defaultVoiceForProvider", () => {
  beforeEach(() => {
    resetVoiceCredentials();
    deleteKey("openai");
  });

  it("returns an elevenlabs voice when elevenlabs is the active voice provider", () => {
    setActiveVoice("elevenlabs", "xi-test");
    const v = defaultVoiceForProvider("elevenlabs");
    expect(v?.provider).toBe("elevenlabs");
  });

  it("returns browser fallback when no voice credential is configured", () => {
    const v = defaultVoiceForProvider("elevenlabs");
    expect(v?.provider).toBe("browser");
  });

  it("returns a minimax voice when minimax is the active voice provider", () => {
    setActiveVoice("minimax", "mm-test");
    const v = defaultVoiceForProvider("minimax");
    expect(v?.provider).toBe("minimax");
  });

  it("returns browser fallback when minimax is NOT the active provider", () => {
    const v = defaultVoiceForProvider("minimax");
    expect(v?.provider).toBe("browser");
  });

  it("returns an openai voice when openai key is configured", () => {
    setKey("openai", "sk-test");
    const v = defaultVoiceForProvider("openai");
    expect(v?.provider).toBe("openai");
  });

  it("always returns a browser voice for provider='browser'", () => {
    const v = defaultVoiceForProvider("browser");
    expect(v?.provider).toBe("browser");
  });
});

describe("voiceProfileForAgent", () => {
  beforeEach(() => {
    resetVoiceCredentials();
    deleteKey("openai");
  });

  it("returns the agent's own voice profile when it matches the active provider", () => {
    setActiveVoice("minimax", "mm-test");
    const agent = stubAgent({
      voice: { provider: "minimax", model: "speech-2.8-turbo", voiceId: "Chinese_Calm_Woman" },
    });
    const p = voiceProfileForAgent(agent);
    expect(p.provider).toBe("minimax");
    expect(p.voiceId).toBe("Chinese_Calm_Woman");
  });

  it("falls back to minimax default when agent has no voice and minimax is active", () => {
    setActiveVoice("minimax", "mm-test");
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("minimax");
  });

  it("falls back to elevenlabs when only elevenlabs is active and agent has no voice", () => {
    setActiveVoice("elevenlabs", "xi-test");
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("elevenlabs");
  });

  it("falls back to browser when no provider is configured and agent has no voice", () => {
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("browser");
    expect(p.model).toBe("speechSynthesis");
  });

  it("falls back to openai when only openai key is set and agent has no voice", () => {
    setKey("openai", "sk-test");
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("openai");
  });

  it("rewrites a stale-provider voice profile onto the active provider's default", () => {
    // Agent carries a MiniMax voice but ElevenLabs is now active —
    // simulates the window between a provider switch and the reconcile
    // sweep. voiceProfileForAgent should overwrite the provider so
    // synthesis doesn't 404 against the wrong API.
    setActiveVoice("elevenlabs", "xi-test");
    const agent = stubAgent({
      voice: { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-qingse" },
    });
    const p = voiceProfileForAgent(agent);
    expect(p.provider).toBe("elevenlabs");
  });
});
