import { describe, expect, it } from "vitest";

import { deleteKey, setKey } from "../src/storage/keys.js";
import { defaultVoiceForProvider, listConfiguredVoices } from "../src/voice/registry.js";
import { voiceProfileForAgent } from "../src/voice/tts.js";
import type { Agent } from "../src/storage/agents.js";

// Minimal stub agent with no voice profile set.
function stubAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "test-agent",
    name: "Test",
    handle: "/test",
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

describe("listConfiguredVoices", () => {
  it("returns only browser when no keys are set", () => {
    deleteKey("minimax");
    deleteKey("openai");
    deleteKey("elevenlabs");
    const voices = listConfiguredVoices();
    expect(voices.every((v) => v.provider === "browser")).toBe(true);
    expect(voices).toHaveLength(1);
  });

  it("includes elevenlabs voices when elevenlabs key is set", () => {
    setKey("elevenlabs", "xi-test");
    const voices = listConfiguredVoices();
    const elVoices = voices.filter((v) => v.provider === "elevenlabs");
    expect(elVoices.length).toBeGreaterThan(0);
    expect(elVoices.every((v) => v.configured)).toBe(true);
  });

  it("includes minimax voices when minimax key is set", () => {
    setKey("minimax", "mm-test");
    const voices = listConfiguredVoices();
    const minimaxVoices = voices.filter((v) => v.provider === "minimax");
    expect(minimaxVoices.length).toBeGreaterThan(0);
    expect(minimaxVoices.every((v) => v.configured)).toBe(true);
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
  it("returns an elevenlabs voice when elevenlabs key is configured", () => {
    setKey("elevenlabs", "xi-test");
    const v = defaultVoiceForProvider("elevenlabs");
    expect(v?.provider).toBe("elevenlabs");
  });

  it("returns browser fallback when elevenlabs key is NOT configured", () => {
    deleteKey("elevenlabs");
    const v = defaultVoiceForProvider("elevenlabs");
    expect(v?.provider).toBe("browser");
  });

  it("returns a minimax voice when minimax key is configured", () => {
    setKey("minimax", "mm-test");
    const v = defaultVoiceForProvider("minimax");
    expect(v?.provider).toBe("minimax");
  });

  it("returns browser fallback when minimax key is NOT configured", () => {
    deleteKey("minimax");
    const v = defaultVoiceForProvider("minimax");
    // No minimax in list → should fall back to listConfiguredVoices()[0] (browser)
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

  it("returns minimax (not openai) when both keys are set and minimax is requested", () => {
    setKey("openai", "sk-test");
    setKey("minimax", "mm-test");
    const v = defaultVoiceForProvider("minimax");
    expect(v?.provider).toBe("minimax");
  });
});

describe("voiceProfileForAgent", () => {
  it("returns the agent's own voice profile when set", () => {
    const agent = stubAgent({
      voice: { provider: "minimax", model: "speech-2.8-turbo", voiceId: "Chinese_Calm_Woman" },
    });
    const p = voiceProfileForAgent(agent);
    expect(p.provider).toBe("minimax");
    expect(p.voiceId).toBe("Chinese_Calm_Woman");
  });

  it("falls back to minimax default when agent has no voice and minimax key is set", () => {
    deleteKey("openai");
    deleteKey("elevenlabs");
    setKey("minimax", "mm-test");
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("minimax");
  });

  it("falls back to elevenlabs when only elevenlabs key is set and agent has no voice", () => {
    deleteKey("minimax");
    deleteKey("openai");
    setKey("elevenlabs", "xi-test");
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("elevenlabs");
  });

  it("falls back to browser when no keys are set and agent has no voice", () => {
    deleteKey("minimax");
    deleteKey("openai");
    deleteKey("elevenlabs");
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("browser");
    expect(p.model).toBe("speechSynthesis");
  });

  it("falls back to openai when only openai key is set and agent has no voice", () => {
    deleteKey("minimax");
    deleteKey("elevenlabs");
    setKey("openai", "sk-test");
    const p = voiceProfileForAgent(stubAgent());
    expect(p.provider).toBe("openai");
  });
});
