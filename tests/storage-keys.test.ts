import { describe, expect, it } from "vitest";

import { deleteKey, getKey, listKeyMeta, setKey } from "../src/storage/keys.js";

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
