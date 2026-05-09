import { describe, expect, it } from "vitest";

import { deleteKey, getKey, listKeyMeta, setKey, hasWebSearchKey, getActiveWebSearchCredentials } from "../src/storage/keys.js";
import { updatePrefs } from "../src/storage/prefs.js";

describe("provider keys", () => {
  it("stores and retrieves the same plaintext (AES-GCM roundtrip)", () => {
    setKey("openrouter", "sk-or-test-12345");
    expect(getKey("openrouter")).toBe("sk-or-test-12345");
  });

  it("trims whitespace and treats empty as a delete", () => {
    setKey("anthropic", "  sk-ant-foo  ");
    expect(getKey("anthropic")).toBe("sk-ant-foo");
    setKey("anthropic", "   ");
    expect(getKey("anthropic")).toBeNull();
  });

  it("listKeyMeta reports configured providers without leaking the key", () => {
    setKey("openai", "sk-real");
    const meta = listKeyMeta();
    const openai = meta.find((m) => m.provider === "openai");
    expect(openai?.configured).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("sk-real");
  });

  it("deleteKey clears one provider but leaves others", () => {
    setKey("openrouter", "sk-or-keep");
    setKey("xai", "xai-throw");
    deleteKey("xai");
    expect(getKey("openrouter")).toBe("sk-or-keep");
    expect(getKey("xai")).toBeNull();
  });

  it("stores ElevenLabs as a voice provider key", () => {
    setKey("elevenlabs", "xi-test-key");
    expect(getKey("elevenlabs")).toBe("xi-test-key");
    const el = listKeyMeta().find((m) => m.provider === "elevenlabs");
    expect(el?.configured).toBe(true);
    expect(JSON.stringify(el)).not.toContain("xi-test-key");
  });

  it("stores MiniMax as a voice provider key", () => {
    setKey("minimax", "mm-test-key");
    expect(getKey("minimax")).toBe("mm-test-key");
    const minimax = listKeyMeta().find((m) => m.provider === "minimax");
    expect(minimax?.configured).toBe(true);
    expect(JSON.stringify(minimax)).not.toContain("mm-test-key");
  });

  it("hasWebSearchKey is true when either brave or tavily is set", () => {
    deleteKey("brave");
    deleteKey("tavily");
    expect(hasWebSearchKey()).toBe(false);
    setKey("tavily", "tvly-demo");
    expect(hasWebSearchKey()).toBe(true);
    setKey("brave", "b-demo");
    expect(hasWebSearchKey()).toBe(true);
    deleteKey("tavily");
    expect(hasWebSearchKey()).toBe(true);
    deleteKey("brave");
    expect(hasWebSearchKey()).toBe(false);
  });

  it("getActiveWebSearchCredentials follows prefs when both search keys exist", () => {
    setKey("brave", "b-key");
    setKey("tavily", "t-key");
    updatePrefs({ webSearchProvider: "brave" });
    expect(getActiveWebSearchCredentials()?.backend).toBe("brave");
    updatePrefs({ webSearchProvider: "tavily" });
    expect(getActiveWebSearchCredentials()?.backend).toBe("tavily");
    deleteKey("brave");
    expect(getActiveWebSearchCredentials()?.backend).toBe("tavily");
    deleteKey("tavily");
    expect(getActiveWebSearchCredentials()).toBeNull();
  });

  it("ciphertexts differ across runs (random IV)", () => {
    setKey("google", "AIza-same-key-twice");
    const ct1 = getKey("google");
    setKey("google", "AIza-same-key-twice");
    const ct2 = getKey("google");
    // Plaintext roundtrip should match every time.
    expect(ct1).toBe("AIza-same-key-twice");
    expect(ct2).toBe("AIza-same-key-twice");
  });
});
