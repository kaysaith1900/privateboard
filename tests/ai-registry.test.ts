import { describe, expect, it } from "vitest";

import { getModel, isModelV, listModels, MODELS } from "../src/ai/registry.js";

describe("model registry", () => {
  it("exposes 18 known models", () => {
    expect(listModels()).toHaveLength(18);
  });

  it("isModelV gates unknown ids", () => {
    expect(isModelV("sonnet-4-6")).toBe(true);
    expect(isModelV("gpt-5-5")).toBe(true);
    expect(isModelV("gpt-5")).toBe(false); // legacy id, retired in favor of 5.5/5.4/5.4-mini
    expect(isModelV("claude-2")).toBe(false);
    expect(isModelV("")).toBe(false);
  });

  it("getModel returns the canonical entry", () => {
    const m = getModel("sonnet-4-6");
    expect(m.provider).toBe("anthropic");
    expect(m.directApiId).toMatch(/^claude-/);
    expect(m.openrouterId).toMatch(/^anthropic\//);
    expect(m.contextBudget).toBeGreaterThan(0);
  });

  it("every model groups under one of the known providers", () => {
    const valid = new Set(["anthropic", "openai", "google", "xai", "deepseek"]);
    for (const m of Object.values(MODELS)) {
      expect(valid.has(m.provider)).toBe(true);
    }
  });

  it("getModel throws on unknown id", () => {
    expect(() => getModel("not-real" as never)).toThrow();
  });
});
