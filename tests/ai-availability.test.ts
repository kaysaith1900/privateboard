import { describe, expect, it } from "vitest";

import {
  defaultModelFor,
  hasAnyModelKey,
  modelAvailability,
  reachableModels,
  utilityModelFor,
  getProviderKeyState,
} from "../src/ai/availability.js";
import { setKey } from "../src/storage/keys.js";

describe("ai/availability · provider key state", () => {
  it("starts empty when no keys are configured", () => {
    const state = getProviderKeyState();
    expect(state.hasOpenRouter).toBe(false);
    expect(state.directProviders.size).toBe(0);
    expect(hasAnyModelKey()).toBe(false);
  });

  it("flips openrouter on once configured", () => {
    setKey("openrouter", "sk-or-test");
    const state = getProviderKeyState();
    expect(state.hasOpenRouter).toBe(true);
    expect(state.directProviders.size).toBe(0);
    expect(hasAnyModelKey()).toBe(true);
  });

  it("collects multiple direct providers", () => {
    setKey("openai", "sk-oa");
    setKey("google", "AIza-x");
    const state = getProviderKeyState();
    expect(state.hasOpenRouter).toBe(false);
    expect(state.directProviders.has("openai")).toBe(true);
    expect(state.directProviders.has("google")).toBe(true);
    expect(state.directProviders.size).toBe(2);
  });

  it("ignores brave (skill key, not an LLM provider)", () => {
    setKey("brave", "brave-key");
    expect(hasAnyModelKey()).toBe(false);
  });
});

describe("ai/availability · model reachability per user state", () => {
  it("OpenRouter only · every model reachable via openrouter", () => {
    setKey("openrouter", "sk-or-test");
    const reachable = reachableModels();
    // Every registry entry should be reachable since they all carry an openrouterId.
    expect(reachable.length).toBeGreaterThan(10);
    // Each one should resolve to the openrouter route, never direct.
    for (const m of reachable) {
      expect(m.routes.openrouter).toBe(true);
      expect(m.routes.direct).toBe(false);
      expect(m.preferredRoute).toBe("openrouter");
    }
  });

  it("OpenAI direct only · only OpenAI models reachable, route=direct", () => {
    setKey("openai", "sk-oa-test");
    const all = modelAvailability();
    const reachable = all.filter((m) => m.reachable);
    // No anthropic / google / xai / deepseek models should be reachable.
    expect(reachable.find((m) => m.provider === "anthropic")).toBeUndefined();
    expect(reachable.find((m) => m.provider === "google")).toBeUndefined();
    expect(reachable.find((m) => m.provider === "xai")).toBeUndefined();
    expect(reachable.find((m) => m.provider === "deepseek")).toBeUndefined();
    // OpenAI direct-eligible models (i.e. not openrouterOnly) ARE reachable.
    const directOpenai = reachable.filter((m) => m.provider === "openai");
    expect(directOpenai.length).toBeGreaterThan(0);
    for (const m of directOpenai) {
      expect(m.routes.direct).toBe(true);
      expect(m.routes.openrouter).toBe(false);
      expect(m.preferredRoute).toBe("direct");
    }
  });

  it("Multiple direct providers · union of those providers", () => {
    // Note · we use openai + google here (both have at least one
    // non-openrouterOnly model). Anthropic + xAI flagship models are
    // currently flagged openrouterOnly in the registry so a direct
    // Anthropic / xAI key alone unlocks zero models — that's a
    // registry-shape detail, not an availability-layer bug. See the
    // "Anthropic-only is functionally empty" test below for the
    // explicit case.
    setKey("openai", "sk-oa");
    setKey("google", "AIza-x");
    const reachable = reachableModels();
    const providers = new Set(reachable.map((m) => m.provider));
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("google")).toBe(true);
    expect(providers.has("anthropic")).toBe(false);
    expect(providers.has("xai")).toBe(false);
    // Every reachable model uses direct routing (no OR set).
    for (const m of reachable) expect(m.preferredRoute).toBe("direct");
  });

  it("Anthropic-only · all current-gen Claude models reachable direct", () => {
    setKey("anthropic", "sk-ant");
    const reachable = reachableModels();
    const slugs = reachable.map((m) => m.modelV).sort();
    // `opus-4-6` retired from registry (remapped to opus-4-7 in migration).
    expect(slugs).toEqual(["haiku-4-5", "opus-4-6-fast", "opus-4-7", "sonnet-4-6"]);
    for (const m of reachable) expect(m.preferredRoute).toBe("direct");
  });

  it("OpenRouter + direct · direct preferred for that provider, others go via OR", () => {
    setKey("openrouter", "sk-or");
    setKey("openai", "sk-oa");
    const reachable = reachableModels();
    const opus = reachable.find((m) => m.modelV === "opus-4-7");
    expect(opus?.preferredRoute).toBe("openrouter");
    const gpt55 = reachable.find((m) => m.modelV === "gpt-5-5");
    expect(gpt55?.preferredRoute).toBe("direct");
    expect(gpt55?.routes.direct).toBe(true);
    expect(gpt55?.routes.openrouter).toBe(true);
  });

  it("openrouterOnly models can never use direct route even when provider key is present", () => {
    // codex-5-4 is flagged openrouterOnly · OpenAI direct key shouldn't unlock it.
    setKey("openai", "sk-oa");
    const reachable = reachableModels();
    const codex = reachable.find((m) => m.modelV === "codex-5-4");
    // No OR + openrouterOnly · should NOT be reachable.
    expect(codex).toBeUndefined();
    setKey("openrouter", "sk-or");
    const reachable2 = reachableModels();
    const codex2 = reachable2.find((m) => m.modelV === "codex-5-4");
    expect(codex2).toBeDefined();
    expect(codex2?.routes.direct).toBe(false);
    expect(codex2?.routes.openrouter).toBe(true);
    expect(codex2?.preferredRoute).toBe("openrouter");
  });

  it("No keys · empty reachable list", () => {
    expect(reachableModels()).toEqual([]);
  });
});

describe("ai/availability · default model selection", () => {
  it("returns null when no keys configured", () => {
    expect(defaultModelFor()).toBeNull();
  });

  // Fast-default policy · defaultModelFor() now returns the FAST-tier
  // model for the active provider so a brand-new user doesn't burn
  // the flagship rate on every chair turn. Flagships are still in
  // PROVIDER_FLAGSHIP but they're no longer the user-facing default.
  // See src/ai/availability.ts ~L252.

  it("OpenAI only · returns gpt-5-4-mini (fast tier)", () => {
    setKey("openai", "sk-oa");
    expect(defaultModelFor()).toBe("gpt-5-4-mini");
  });

  it("Anthropic only · returns haiku-4-5 (fast tier)", () => {
    // PROVIDER_FAST.anthropic = "haiku-4-5" — the cheap/fast tier
    // surfaces as the default per the fast-default policy.
    setKey("anthropic", "sk-ant");
    expect(defaultModelFor()).toBe("haiku-4-5");
  });

  it("OpenRouter present · prefers opus-4-6-fast (fast tier)", () => {
    setKey("openrouter", "sk-or");
    expect(defaultModelFor()).toBe("opus-4-6-fast");
  });

  it("OpenRouter + OpenAI · still opus-4-6-fast (OR rule wins for default)", () => {
    setKey("openrouter", "sk-or");
    setKey("openai", "sk-oa");
    expect(defaultModelFor()).toBe("opus-4-6-fast");
  });

  it("Multiple direct, no OR · picks one of the configured fast tiers", () => {
    setKey("openai", "sk-oa");
    setKey("google", "AIza-x");
    const def = defaultModelFor();
    // PROVIDER_FAST.openai = "gpt-5-4-mini"; PROVIDER_FAST.google =
    // "gemini-3-1-flash". Either is acceptable depending on the
    // direct-provider Set's iteration order.
    expect(
      def !== null && (def === "gpt-5-4-mini" || def === "gemini-3-1-flash"),
    ).toBe(true);
  });
});

describe("ai/availability · utility model selection", () => {
  it("returns null when no keys configured", () => {
    expect(utilityModelFor()).toBeNull();
  });

  it("OpenRouter only · prefers haiku-4-5 (cheapest)", () => {
    setKey("openrouter", "sk-or");
    expect(utilityModelFor()).toBe("haiku-4-5");
  });

  it("OpenAI only · falls through to gpt-5-4-mini (haiku unreachable)", () => {
    setKey("openai", "sk-oa");
    expect(utilityModelFor()).toBe("gpt-5-4-mini");
  });

  it("Google only · falls through to gemini-3-1-flash (3.1 Flash Lite)", () => {
    setKey("google", "AIza");
    expect(utilityModelFor()).toBe("gemini-3-1-flash");
  });

  it("xAI only · no LLM modelV in registry · utility is null", () => {
    setKey("xai", "xai-test");
    expect(utilityModelFor()).toBeNull();
  });
});
