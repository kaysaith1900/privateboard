/**
 * Memory metabolism · Phase 1 (heuristic decay) tests.
 *
 * Validates that `runDreamCycle` only culls memories matching ALL
 * three decay predicates (old + low-confidence + never-injected),
 * leaves pinned + manually-added + recently-used + long-tier
 * memories untouched, and is idempotent (a second pass over a
 * fresh state is a no-op).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertAgent } from "../src/storage/agents.js";
import {
  bumpUsage,
  countMemoriesForAgent,
  insertMemory,
  listMemoriesForAgent,
  memoriesForContext,
} from "../src/storage/memories.js";
import { getDb } from "../src/storage/db.js";
import {
  bumpAdjournCounter,
  resetAdjournCounter,
  runDreamCycle,
  DREAM_TRIGGER_THRESHOLD_DIRECTOR,
  DREAM_TRIGGER_THRESHOLD_CHAIR,
} from "../src/orchestrator/dream.js";

const AGENT_ID = "ag-test";

beforeEach(() => {
  insertAgent({
    id: AGENT_ID,
    name: "Test Agent",
    handle: "/test",
    roleTag: "director",
    bio: "",
    instruction: "",
    modelV: "sonnet-4-6",
    avatarPath: "/avatars/test.svg",
  });
});

afterEach(() => {
  resetAdjournCounter(AGENT_ID);
});

/** Insert a memory and back-date its created_at via direct SQL · the
 *  decay heuristic is age-gated so we need to simulate a 60-day-old
 *  memory without waiting 60 days. */
function insertOld(opts: {
  content: string;
  confidence: number;
  ageDays: number;
  pinned?: boolean;
  tier?: "short" | "long";
  usageCount?: number;
}): string {
  const m = insertMemory({
    agentId: AGENT_ID,
    content: opts.content,
    confidence: opts.confidence,
    pinned: opts.pinned ?? false,
  });
  const ageMs = opts.ageDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ageMs;
  getDb()
    .prepare(
      `UPDATE agent_memories
          SET created_at = ?, tier = ?, usage_count = ?
        WHERE id = ?`,
    )
    .run(cutoff, opts.tier ?? "short", opts.usageCount ?? 0, m.id);
  return m.id;
}

describe("dream cycle · Phase 1 (heuristic decay)", () => {
  it("decays old, low-confidence, never-injected, non-pinned memories", async () => {
    insertOld({ content: "user mentioned tired today", confidence: 0.3, ageDays: 60 });
    insertOld({ content: "stale guess about user's job", confidence: 0.4, ageDays: 45 });

    const result = await runDreamCycle(AGENT_ID);
    expect(result.decayed).toBe(2);
    expect(countMemoriesForAgent(AGENT_ID)).toBe(0);
  });

  it("preserves pinned memories regardless of age / confidence / use", async () => {
    insertOld({
      content: "pinned · sacred",
      confidence: 0.2,
      ageDays: 90,
      pinned: true,
    });
    const result = await runDreamCycle(AGENT_ID);
    expect(result.decayed).toBe(0);
    expect(countMemoriesForAgent(AGENT_ID)).toBe(1);
  });

  it("preserves recently-used memories (usage_count > 0)", async () => {
    const id = insertOld({
      content: "old but recently injected",
      confidence: 0.3,
      ageDays: 60,
    });
    bumpUsage([id]);
    const result = await runDreamCycle(AGENT_ID);
    expect(result.decayed).toBe(0);
    expect(countMemoriesForAgent(AGENT_ID)).toBe(1);
  });

  it("preserves high-confidence memories regardless of age", async () => {
    insertOld({ content: "load-bearing fact", confidence: 0.9, ageDays: 90 });
    const result = await runDreamCycle(AGENT_ID);
    expect(result.decayed).toBe(0);
    expect(countMemoriesForAgent(AGENT_ID)).toBe(1);
  });

  it("preserves long-tier memories regardless of age", async () => {
    insertOld({
      content: "promoted to stable",
      confidence: 0.3,
      ageDays: 90,
      tier: "long",
    });
    const result = await runDreamCycle(AGENT_ID);
    expect(result.decayed).toBe(0);
    expect(countMemoriesForAgent(AGENT_ID)).toBe(1);
  });

  it("preserves recent memories (< 30 days) regardless of confidence", async () => {
    insertOld({ content: "yesterday's chatter", confidence: 0.2, ageDays: 5 });
    const result = await runDreamCycle(AGENT_ID);
    expect(result.decayed).toBe(0);
    expect(countMemoriesForAgent(AGENT_ID)).toBe(1);
  });

  it("is idempotent · second pass over decayed state is a no-op", async () => {
    insertOld({ content: "noise", confidence: 0.3, ageDays: 60 });
    const a = await runDreamCycle(AGENT_ID);
    expect(a.decayed).toBe(1);
    const b = await runDreamCycle(AGENT_ID);
    expect(b.decayed).toBe(0);
    expect(b.beforeCount).toBe(0);
    expect(b.afterCount).toBe(0);
  });
});

describe("dream trigger · adjourn counter", () => {
  it("director threshold (K=5) does not fire until the 5th bump", () => {
    for (let i = 0; i < DREAM_TRIGGER_THRESHOLD_DIRECTOR - 1; i += 1) {
      expect(bumpAdjournCounter(AGENT_ID, "director")).toBe(false);
    }
    expect(bumpAdjournCounter(AGENT_ID, "director")).toBe(true);
  });

  it("chair threshold (K=3) fires twice as fast as director", () => {
    insertAgent({
      id: "ag-chair",
      name: "Chair",
      handle: "/chair",
      roleTag: "moderator",
      roleKind: "moderator",
      bio: "",
      instruction: "",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/chair.svg",
    });
    for (let i = 0; i < DREAM_TRIGGER_THRESHOLD_CHAIR - 1; i += 1) {
      expect(bumpAdjournCounter("ag-chair", "moderator")).toBe(false);
    }
    expect(bumpAdjournCounter("ag-chair", "moderator")).toBe(true);
    resetAdjournCounter("ag-chair");
  });

  it("counter is per-agent", () => {
    insertAgent({
      id: "ag-other",
      name: "Other",
      handle: "/other",
      roleTag: "director",
      bio: "",
      instruction: "",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/other.svg",
    });
    bumpAdjournCounter(AGENT_ID, "director");
    bumpAdjournCounter(AGENT_ID, "director");
    // Other agent's counter is independent; one bump shouldn't trip.
    expect(bumpAdjournCounter("ag-other", "director")).toBe(false);
    resetAdjournCounter("ag-other");
  });
});

describe("memoriesForContext · tier-aware retrieval", () => {
  it("includes long-tier memories without recency cap", async () => {
    // 10 short-tier + 3 long-tier; recencyCap is 5, so we expect
    // 3 long + 5 short = 8 total (no pins).
    for (let i = 0; i < 10; i += 1) {
      insertMemory({ agentId: AGENT_ID, content: `short note ${i}`, confidence: 0.7 });
    }
    for (let i = 0; i < 3; i += 1) {
      const m = insertMemory({ agentId: AGENT_ID, content: `stable ${i}`, confidence: 0.9 });
      getDb().prepare(`UPDATE agent_memories SET tier = 'long' WHERE id = ?`).run(m.id);
    }
    const ctx = memoriesForContext(AGENT_ID, 5);
    const longs = ctx.filter((m) => m.tier === "long");
    const shorts = ctx.filter((m) => m.tier === "short");
    expect(longs.length).toBe(3);
    expect(shorts.length).toBe(5);
  });

  it("bumpUsage increments usage_count + last_used_at", () => {
    const m1 = insertMemory({ agentId: AGENT_ID, content: "a", confidence: 0.7 });
    const m2 = insertMemory({ agentId: AGENT_ID, content: "b", confidence: 0.7 });
    bumpUsage([m1.id, m2.id]);
    const after = listMemoriesForAgent(AGENT_ID);
    for (const m of after) {
      expect(m.usageCount).toBe(1);
      expect(m.lastUsedAt).not.toBeNull();
    }
  });
});
