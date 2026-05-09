/**
 * Tests for public/keys-store.js
 *
 * These run in Node (no browser, no DOM). fetch is mocked via
 * vi.stubGlobal so no network hits occur. The module uses ES-module
 * live bindings, so the imported `keysMeta` reference updates in-place
 * when fetchKeyMeta / setProviderKey reassign the module variable.
 *
 * These tests are intentionally NOT in the DB-setup pool — they have
 * nothing to do with SQLite. The shared _setup.ts still runs (creates
 * a tmp dir + migrations) but is harmless here.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// Dynamic import lets us re-import a fresh module instance per suite.
// We use a single import here because the test runner forks a new
// process per file anyway (pool: "forks").
import {
  keysMeta,
  fetchKeyMeta,
  setProviderKey,
  getConfiguredKeys,
} from "../public/keys-store.js";

// ── fetch mock helpers ──────────────────────────────────────────────

type KeyRow = { provider: string; configured: boolean; preview: string | null; updatedAt?: number | null };

function mockGetKeys(rows: KeyRow[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ keys: rows }),
  }));
}

function mockPutKey(meta: KeyRow) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(meta),
  }));
}

function mockDeleteKey(provider: string) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ provider, configured: false, updatedAt: null, preview: null }),
  }));
}

function mockServerError() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
}

function mockNetworkError() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));
}

// ── clean slate before each test ───────────────────────────────────

beforeEach(async () => {
  vi.unstubAllGlobals();
  // Reset module state to empty by simulating a server returning no keys.
  mockGetKeys([]);
  await fetchKeyMeta();
});

// ── fetchKeyMeta ───────────────────────────────────────────────────

describe("fetchKeyMeta", () => {
  it("populates keysMeta from all rows the server returns", async () => {
    mockGetKeys([
      { provider: "openai",   configured: true,  preview: "sk-o••••st" },
      { provider: "minimax",  configured: true,  preview: "mm••••ey"  },
      { provider: "brave",    configured: false, preview: null        },
    ]);
    await fetchKeyMeta();
    expect(keysMeta["openai"]?.configured).toBe(true);
    expect(keysMeta["minimax"]?.configured).toBe(true);
    expect(keysMeta["brave"]?.configured).toBe(false);
  });

  it("marks minimax configured when server returns configured: true", async () => {
    mockGetKeys([{ provider: "minimax", configured: true, preview: "mm••••ey" }]);
    await fetchKeyMeta();
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });

  it("marks minimax NOT configured when server returns configured: false", async () => {
    mockGetKeys([{ provider: "minimax", configured: false, preview: null }]);
    await fetchKeyMeta();
    expect(keysMeta["minimax"]?.configured).toBe(false);
  });

  it("REGRESSION: fetchKeyMeta on reopen must NOT clear a previously set minimax key", async () => {
    // Simulate: user set the key (state already in keysMeta)
    mockPutKey({ provider: "minimax", configured: true, preview: "mm••••ey" });
    await setProviderKey("minimax", "mm-real-key");
    expect(keysMeta["minimax"]?.configured).toBe(true); // sanity

    // Simulate: settings closed and reopened → fetchKeyMeta called again.
    // Server confirms the key is still there.
    mockGetKeys([{ provider: "minimax", configured: true, preview: "mm••••ey" }]);
    await fetchKeyMeta();

    // Must still be configured after the refetch.
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });

  it("replaces whole keysMeta — removed providers disappear from map", async () => {
    mockGetKeys([{ provider: "openai", configured: true, preview: "sk-o••••st" }]);
    await fetchKeyMeta();
    expect(keysMeta["openai"]?.configured).toBe(true);

    // Second fetch: openai gone, minimax present
    mockGetKeys([{ provider: "minimax", configured: true, preview: "mm••••ey" }]);
    await fetchKeyMeta();
    expect(keysMeta["openai"]).toBeUndefined();
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });

  it("keeps last snapshot when server returns non-ok", async () => {
    mockGetKeys([{ provider: "minimax", configured: true, preview: "mm••••ey" }]);
    await fetchKeyMeta();

    mockServerError();
    await fetchKeyMeta(); // should silently no-op
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });

  it("keeps last snapshot on network error", async () => {
    mockGetKeys([{ provider: "minimax", configured: true, preview: "mm••••ey" }]);
    await fetchKeyMeta();

    mockNetworkError();
    await fetchKeyMeta();
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });
});

// ── setProviderKey ─────────────────────────────────────────────────

describe("setProviderKey", () => {
  it("updates keysMeta when PUT succeeds", async () => {
    mockPutKey({ provider: "minimax", configured: true, preview: "mm••••ey" });
    const meta = await setProviderKey("minimax", "mm-real-key");
    expect(meta?.configured).toBe(true);
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });

  it("uses DELETE for empty/whitespace value", async () => {
    mockDeleteKey("minimax");
    const meta = await setProviderKey("minimax", "  ");
    expect(meta?.configured).toBe(false);
    expect(keysMeta["minimax"]?.configured).toBe(false);
  });

  it("returns null and leaves keysMeta unchanged on server error", async () => {
    mockGetKeys([{ provider: "minimax", configured: true, preview: "mm••••ey" }]);
    await fetchKeyMeta();

    mockServerError();
    const meta = await setProviderKey("minimax", "mm-new-key");
    expect(meta).toBeNull();
    // prior state must be preserved
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });

  it("returns null and leaves keysMeta unchanged on network error", async () => {
    mockGetKeys([{ provider: "minimax", configured: true, preview: "mm••••ey" }]);
    await fetchKeyMeta();

    mockNetworkError();
    const meta = await setProviderKey("minimax", "mm-new-key");
    expect(meta).toBeNull();
    expect(keysMeta["minimax"]?.configured).toBe(true);
  });
});

// ── getConfiguredKeys ──────────────────────────────────────────────

describe("getConfiguredKeys", () => {
  it("returns only configured providers", async () => {
    mockGetKeys([
      { provider: "openai",  configured: true,  preview: "sk-o••••st" },
      { provider: "minimax", configured: false, preview: null         },
    ]);
    await fetchKeyMeta();
    const out = getConfiguredKeys();
    expect(out["openai"]).toBeTruthy();
    expect(out["minimax"]).toBeUndefined();
  });

  it("includes minimax when configured", async () => {
    mockGetKeys([
      { provider: "minimax", configured: true, preview: "mm••••ey" },
    ]);
    await fetchKeyMeta();
    const out = getConfiguredKeys();
    expect(out["minimax"]).toBeTruthy();
  });

  it("excludes minimax when not configured", async () => {
    mockGetKeys([
      { provider: "minimax", configured: false, preview: null },
    ]);
    await fetchKeyMeta();
    expect(getConfiguredKeys()["minimax"]).toBeUndefined();
  });
});
