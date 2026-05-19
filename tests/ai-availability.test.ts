import { describe, expect, it } from "vitest";

import {
  defaultModelFor,
  hasAnyModelKey,
  modelAvailability,
  reachableModels,
  utilityModelFor,
  getProviderKeyState,
} from "../src/ai/availability.js";
import type { LlmProvider } from "../src/ai/providers.js";
import { createLlmCredential } from "../src/storage/credentials.js";
import { setKey } from "../src/storage/keys.js";
import { updatePrefs } from "../src/storage/prefs.js";

function activateLlm(provider: LlmProvider, plain: string) {
  const meta = createLlmCredential(provider, null, plain);
  if (!meta) throw new Error(`failed to create ${provider} credential`);
  updatePrefs({ activeLlmCredentialId: meta.id });
  return meta;
}

describe("ai/availability · provider key state", () => {
  it("starts empty when no keys are configured", () => {
    const state = getProviderKeyState();
    expect(state.activeLlmProvider).toBeNull();
    expect(state.hasAnyLlmKey).toBe(false);
    expect(hasAnyModelKey()).toBe(false);
  });

  it("flips openrouter on once configured", () => {
    activateLlm("openrouter", "sk-or-test");
    const state = getProviderKeyState();
    expect(state.activeLlmProvider).toBe("openrouter");
    expect(state.hasAnyLlmKey).toBe(true);
    expect(hasAnyModelKey()).toBe(true);
  });

  it("tracks a single direct provider", () => {
    activateLlm("openai", "sk-oa");
    const state = getProviderKeyState();
    expect(state.activeLlmProvider).toBe("openai");
    expect(state.hasAnyLlmKey).toBe(true);
  });

  it("ignores brave (skill key, not an LLM provider)", () => {
    setKey("brave", "brave-key");
    expect(hasAnyModelKey()).toBe(false);
  });
});

describe("ai/availability · model reachability per user state", () => {
  it("OpenRouter only · every model reachable via openrouter", () => {
    activateLlm("openrouter", "sk-or-test");
    const reachable = reachableModels();
    expect(reachable.length).toBeGreaterThan(10);
    for (const m of reachable) {
      expect(m.reachable).toBe(true);
      expect(m.preferredRoute).toBe("openrouter");
    }
  });

  it("OpenAI direct only · only OpenAI models reachable, route=direct", () => {
    activateLlm("openai", "sk-oa-test");
    const all = modelAvailability();
    const reachable = all.filter((m) => m.reachable);
    expect(reachable.find((m) => m.provider === "anthropic")).toBeUndefined();
    expect(reachable.find((m) => m.provider === "google")).toBeUndefined();
    expect(reachable.find((m) => m.provider === "xai")).toBeUndefined();
    expect(reachable.find((m) => m.provider === "deepseek")).toBeUndefined();
    const directOpenai = reachable.filter((m) => m.provider === "openai");
    expect(directOpenai.length).toBeGreaterThan(0);
    for (const m of directOpenai) {
      expect(m.preferredRoute).toBe("direct");
    }
  });

  it("Anthropic-only · all current-gen Claude models reachable direct", () => {
    activateLlm("anthropic", "sk-ant");
    const reachable = reachableModels();
    const slugs = reachable.map((m) => m.modelV).sort();
    expect(slugs).toEqual(["haiku-4-5", "opus-4-6-fast", "opus-4-7", "sonnet-4-6"]);
    for (const m of reachable) expect(m.preferredRoute).toBe("direct");
  });

  it("openrouterOnly models reachable via openrouter, not direct openai", () => {
    activateLlm("openai", "sk-oa");
    expect(reachableModels().find((m) => m.modelV === "codex-5-4")).toBeUndefined();
    activateLlm("openrouter", "sk-or");
    const codex = reachableModels().find((m) => m.modelV === "codex-5-4");
    expect(codex).toBeDefined();
    expect(codex?.preferredRoute).toBe("openrouter");
  });

  it("No keys · empty reachable list", () => {
    expect(reachableModels()).toEqual([]);
  });
});

describe("ai/availability · default model selection", () => {
  it("returns null when no keys configured", () => {
    expect(defaultModelFor()).toBeNull();
  });

  it("OpenAI only · returns gpt-5-4-mini (fast tier)", () => {
    activateLlm("openai", "sk-oa");
    expect(defaultModelFor()).toBe("gpt-5-4-mini");
  });

  it("Anthropic only · returns haiku-4-5 (fast tier)", () => {
    activateLlm("anthropic", "sk-ant");
    expect(defaultModelFor()).toBe("haiku-4-5");
  });

  it("OpenRouter present · prefers opus-4-6-fast (fast tier)", () => {
    activateLlm("openrouter", "sk-or");
    expect(defaultModelFor()).toBe("opus-4-6-fast");
  });

  it("Google direct · returns gemini-3-1-flash (fast tier)", () => {
    activateLlm("google", "AIza-x");
    expect(defaultModelFor()).toBe("gemini-3-1-flash");
  });
});

describe("ai/availability · utility model selection", () => {
  it("returns null when no keys configured", () => {
    expect(utilityModelFor()).toBeNull();
  });

  it("OpenRouter only · prefers haiku-4-5 (cheapest)", () => {
    activateLlm("openrouter", "sk-or");
    expect(utilityModelFor()).toBe("haiku-4-5");
  });

  it("OpenAI only · falls through to gpt-5-4-mini (haiku unreachable)", () => {
    activateLlm("openai", "sk-oa");
    expect(utilityModelFor()).toBe("gpt-5-4-mini");
  });

  it("Google only · falls through to gemini-3-1-flash (3.1 Flash Lite)", () => {
    activateLlm("google", "AIza");
    expect(utilityModelFor()).toBe("gemini-3-1-flash");
  });

  it("xAI only · no LLM modelV in registry · utility is null", () => {
    activateLlm("xai", "xai-test");
    expect(utilityModelFor()).toBeNull();
  });
});
