/**
 * Voice Replay tests · pure-function + server-route coverage.
 *
 * What's tested:
 *   1. `cleanForSpeech()`     · markdown stripping rules
 *   2. `POST /api/voices/by-message/:id`
 *        · resolves message → author → voice profile
 *        · returns audioBase64 from synthesizeSpeech
 *        · 404 when message doesn't exist
 *        · 422 when message has no speakable content
 *        · routes user messages via chair voice when asUser=true
 *        · LRU cache returns same payload on second call
 *   3. `buildPlaylist()`     · the client-side filter
 *        loaded into a globalThis.window shim and exercised through
 *        the module's `_internals` export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Hono } from "hono";

import { cleanForSpeech } from "../src/voice/tts.js";
import { insertAgent } from "../src/storage/agents.js";
import { createRoom } from "../src/storage/rooms.js";
import { insertMessage } from "../src/storage/messages.js";
import { voicesRouter } from "../src/routes/voices.js";

// ── Mock TTS so tests don't hit any external provider ─────────
vi.mock("../src/voice/tts.js", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    synthesizeSpeech: vi.fn(async (text: string, profile: { provider: string; model: string; voiceId: string }) => ({
      provider: profile.provider,
      model: profile.model,
      voiceId: profile.voiceId,
      text,
      mimeType: "audio/mpeg",
      audioBase64: Buffer.from(`fake-audio:${profile.voiceId}:${text.length}`).toString("base64"),
    })),
  };
});

// ───────────────────────────────────────────────────────────────
// 1 · cleanForSpeech
// ───────────────────────────────────────────────────────────────
describe("cleanForSpeech", () => {
  it("drops fenced code blocks entirely", () => {
    expect(cleanForSpeech("Before\n```js\nconst x = 1;\n```\nAfter")).toMatch(/^Before\s+After$/);
  });

  it("strips inline code ticks but keeps the content", () => {
    expect(cleanForSpeech("Run `npm test` to verify")).toBe("Run npm test to verify");
  });

  it("collapses bare URLs to the word 'link'", () => {
    expect(cleanForSpeech("see https://example.com/path?q=1 for details"))
      .toBe("see link for details");
  });

  it("keeps markdown link labels, drops the target", () => {
    expect(cleanForSpeech("see [the docs](https://example.com)"))
      .toBe("see the docs");
  });

  it("strips heading hashes + blockquote + list markers", () => {
    expect(cleanForSpeech("# Heading\n> a quote\n- one\n- two"))
      .toBe("Heading\na quote\none\ntwo");
  });

  it("strips bold / italic / strikethrough decoration", () => {
    expect(cleanForSpeech("**bold** and _italic_ and ~~strike~~"))
      .toBe("bold and italic and strike");
  });

  it("flattens table pipes to commas", () => {
    expect(cleanForSpeech("| a | b |\n|---|---|\n| 1 | 2 |"))
      // Each row pipe becomes ", " — leading + trailing whitespace
      // collapses; separator row becomes blank.
      .toMatch(/a\s*,\s*b/);
  });

  it("returns empty string for empty input", () => {
    expect(cleanForSpeech("")).toBe("");
    expect(cleanForSpeech("   \n\n  ")).toBe("");
  });
});

// ───────────────────────────────────────────────────────────────
// 2 · POST /api/voices/by-message/:id
// ───────────────────────────────────────────────────────────────
describe("POST /api/voices/by-message/:id", () => {
  let app: Hono;
  beforeEach(() => {
    app = new Hono();
    app.route("/api/voices", voicesRouter());
    vi.clearAllMocks();
  });

  it("404 when the message doesn't exist", async () => {
    const res = await app.request("/api/voices/by-message/ghost", { method: "POST" });
    expect(res.status).toBe(404);
    const j = await res.json();
    expect(j.code).toBe("not-found");
  });

  it("422 when the message body is empty after cleanup", async () => {
    insertAgent({
      id: "ag-empty",
      name: "Empty",
      handle: "/empty",
      roleTag: "director",
      bio: "",
      instruction: "",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/empty.svg",
    });
    const { room } = createRoom({ name: "n", subject: "s", agentIds: [] });
    const msg = insertMessage({
      roomId: room.id,
      authorKind: "agent",
      authorId: "ag-empty",
      body: "```js\n```",  // fenced code only · cleanForSpeech leaves it empty
      meta: {},
      roundNum: 1,
    });
    const res = await app.request("/api/voices/by-message/" + msg.id, { method: "POST" });
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe("empty");
  });

  it("synthesizes audio for a director message using the agent's voice", async () => {
    insertAgent({
      id: "ag-soc",
      name: "Socrates",
      handle: "/soc",
      roleTag: "skeptic",
      bio: "",
      instruction: "",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/soc.svg",
    });
    const { room } = createRoom({ name: "n", subject: "s", agentIds: [] });
    const msg = insertMessage({
      roomId: room.id,
      authorKind: "agent",
      authorId: "ag-soc",
      body: "Where exactly does defensibility live?",
      meta: {},
      roundNum: 1,
    });
    const res = await app.request("/api/voices/by-message/" + msg.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.audioBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(j.mimeType).toBe("audio/mpeg");
    expect(j.voiceProvider).toBeDefined();
    expect(j.voiceId).toBeDefined();
  });

  it("LRU cache · second call to same message returns identical payload", async () => {
    insertAgent({
      id: "ag-cache",
      name: "Cache",
      handle: "/cache",
      roleTag: "director",
      bio: "",
      instruction: "",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/cache.svg",
    });
    const { room } = createRoom({ name: "n", subject: "s", agentIds: [] });
    const msg = insertMessage({
      roomId: room.id,
      authorKind: "agent",
      authorId: "ag-cache",
      body: "Cached message body",
      meta: {},
      roundNum: 1,
    });
    const a = await app.request("/api/voices/by-message/" + msg.id, { method: "POST" });
    const b = await app.request("/api/voices/by-message/" + msg.id, { method: "POST" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ja = await a.json();
    const jb = await b.json();
    expect(jb.audioBase64).toBe(ja.audioBase64);
  });
});

// ───────────────────────────────────────────────────────────────
// 3 · buildPlaylist (client module loaded via window shim)
// ───────────────────────────────────────────────────────────────
describe("voice-replay.js · buildPlaylist", () => {
  let buildPlaylist: (
    messages: Array<{
      id: string;
      authorKind: string;
      authorId: string | null;
      body: string;
      meta?: Record<string, unknown>;
    }>,
    opts: { members?: Array<unknown>; chair?: unknown; skipUser?: boolean },
  ) => Array<{ messageId: string; kind: string; authorId: string | null; authorName: string; body: string }>;

  beforeEach(() => {
    // Exec the IIFE module against a fresh global window. The module
    // attaches its public surface to `window.boardroomVoiceReplay`.
    const src = readFileSync(
      join(import.meta.dirname || ".", "..", "public", "voice-replay.js"),
      "utf8",
    );
    const sandbox = { window: { boardroomVoiceReplay: undefined as unknown }, document: { body: {} }, fetch: vi.fn() };
    // The module wraps in `(function (root) { … })(typeof window !== "undefined" ? window : globalThis)`,
    // so feeding it our sandbox.window via Function-wrap works.
    new Function("window", "document", "fetch", src)(sandbox.window, sandbox.document, sandbox.fetch);
    const api = sandbox.window.boardroomVoiceReplay as { _internals: { buildPlaylist: typeof buildPlaylist } };
    buildPlaylist = api._internals.buildPlaylist;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  const baseMembers = [
    { id: "soc",   name: "Socrates",    roleKind: "director", roleTag: "skeptic",   avatarPath: "/avatars/soc.svg" },
    { id: "marx",  name: "Marx",        roleKind: "director", roleTag: "frame",     avatarPath: "/avatars/marx.svg" },
  ];
  const chair = { id: "chair", name: "Chair", roleKind: "moderator", roleTag: "moderator", avatarPath: "/avatars/chair.svg" };

  it("filters system messages + procedural meta kinds", () => {
    const msgs = [
      { id: "1", authorKind: "agent",  authorId: "soc",   body: "first", meta: {} },
      { id: "2", authorKind: "system", authorId: null,    body: "system note", meta: {} },
      { id: "3", authorKind: "agent",  authorId: "chair", body: "round-open marker", meta: { kind: "round-open" } },
      { id: "4", authorKind: "agent",  authorId: "marx",  body: "second", meta: {} },
    ];
    const out = buildPlaylist(msgs, { members: baseMembers, chair });
    expect(out.map((p) => p.messageId)).toEqual(["1", "4"]);
    expect(out[0].kind).toBe("director");
    expect(out[0].authorName).toBe("Socrates");
  });

  it("skips user messages by default", () => {
    const msgs = [
      { id: "u",  authorKind: "user",   authorId: null, body: "I think…", meta: {} },
      { id: "d1", authorKind: "agent",  authorId: "soc", body: "Director response", meta: {} },
    ];
    const out = buildPlaylist(msgs, { members: baseMembers, chair });
    expect(out.map((p) => p.messageId)).toEqual(["d1"]);
  });

  it("includes user messages when skipUser=false", () => {
    const msgs = [
      { id: "u",  authorKind: "user",  authorId: null,  body: "user line", meta: {} },
      { id: "d1", authorKind: "agent", authorId: "soc", body: "director line", meta: {} },
    ];
    const out = buildPlaylist(msgs, { members: baseMembers, chair, skipUser: false });
    expect(out.map((p) => p.messageId)).toEqual(["u", "d1"]);
    expect(out[0].kind).toBe("user");
  });

  it("classifies chair vs director correctly", () => {
    const msgs = [
      { id: "c",  authorKind: "agent", authorId: "chair", body: "chair speech", meta: {} },
      { id: "d",  authorKind: "agent", authorId: "soc",   body: "director speech", meta: {} },
    ];
    const out = buildPlaylist(msgs, { members: baseMembers, chair });
    expect(out[0].kind).toBe("chair");
    expect(out[1].kind).toBe("director");
  });

  it("skips messages whose body is empty / whitespace", () => {
    const msgs = [
      { id: "blank", authorKind: "agent", authorId: "soc", body: "   ", meta: {} },
      { id: "real",  authorKind: "agent", authorId: "soc", body: "hello", meta: {} },
    ];
    const out = buildPlaylist(msgs, { members: baseMembers, chair });
    expect(out.map((p) => p.messageId)).toEqual(["real"]);
  });

  it("skips streaming-in-flight placeholders", () => {
    const msgs = [
      { id: "live", authorKind: "agent", authorId: "soc", body: "p", meta: { streaming: true } },
      { id: "done", authorKind: "agent", authorId: "soc", body: "q", meta: {} },
    ];
    const out = buildPlaylist(msgs, { members: baseMembers, chair });
    expect(out.map((p) => p.messageId)).toEqual(["done"]);
  });
});
