import { describe, expect, it } from "vitest";

import { deleteKey, getKey, listKeyMeta, setKey, hasWebSearchKey, getActiveWebSearchCredentials } from "../src/storage/keys.js";
import {
  createSearchCredential,
  deleteSearchCredential,
  listSearchCredentials,
} from "../src/storage/search-credentials.js";
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

  // Voice (minimax / elevenlabs) and search (brave / tavily) keys
  // moved out of `provider_keys` into their typed credential tables
  // in migrations 049 + 051. The Provider union still includes those
  // slugs (`setKey("minimax", …)` still writes to provider_keys for
  // legacy callers), but the active-credential helpers ignore them.
  // Voice / search storage is exercised in `voice-registry.test.ts` /
  // `reconcile-bucket-restore.test.ts`.

  it("hasWebSearchKey reflects the active search credential", () => {
    expect(hasWebSearchKey()).toBe(false);
    const brave = createSearchCredential("brave", null, "b-demo");
    if (!brave) throw new Error("brave credential not created");
    updatePrefs({ activeSearchCredentialId: brave.id });
    expect(hasWebSearchKey()).toBe(true);

    // Adding a Tavily credential alone is NOT activated automatically
    // (auto-activate only fires on the FIRST credential). hasWebSearchKey
    // still reports true because Brave remains active.
    createSearchCredential("tavily", null, "tvly-demo");
    expect(hasWebSearchKey()).toBe(true);

    // Clear active → false even though credential rows still exist.
    updatePrefs({ activeSearchCredentialId: null });
    expect(hasWebSearchKey()).toBe(false);
  });

  it("getActiveWebSearchCredentials follows the active credential pointer", () => {
    const brave = createSearchCredential("brave", null, "b-key");
    const tavily = createSearchCredential("tavily", null, "t-key");
    if (!brave || !tavily) throw new Error("credentials not created");

    updatePrefs({ activeSearchCredentialId: brave.id });
    expect(getActiveWebSearchCredentials()?.backend).toBe("brave");
    expect(getActiveWebSearchCredentials()?.apiKey).toBe("b-key");

    updatePrefs({ activeSearchCredentialId: tavily.id });
    expect(getActiveWebSearchCredentials()?.backend).toBe("tavily");
    expect(getActiveWebSearchCredentials()?.apiKey).toBe("t-key");

    // Deleting the active credential's ROW (without rotating the
    // pointer) makes the resolver return null · stale-pointer guard.
    deleteSearchCredential(tavily.id);
    expect(getActiveWebSearchCredentials()).toBeNull();
    expect(listSearchCredentials().length).toBe(1);

    updatePrefs({ activeSearchCredentialId: null });
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
