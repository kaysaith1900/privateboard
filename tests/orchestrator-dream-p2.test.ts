/**
 * Memory metabolism · Phase 2 tests · LLM pipeline parsers + the
 * supersession / promotion mutations + mocked end-to-end cycle.
 *
 * The cluster / merge / conflict prompts are tested in isolation
 * (parser fixtures · no LLM call) and via a mocked callLLM that
 * lets us drive a deterministic full-pipeline run without any
 * network access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertAgent } from "../src/storage/agents.js";
import { setKey } from "../src/storage/keys.js";
import {
  insertMemory,
  listMemoriesForAgent,
  listTierForAgent,
  markSuperseded,
  insertConsolidatedMemory,
  promoteToLong,
  bumpProvenance,
  recordDream,
  listDreamsForAgent,
  purgeStaleSupersededMemories,
  memoriesForContext,
} from "../src/storage/memories.js";
import { getDb } from "../src/storage/db.js";
import {
  parseClusterOutput,
  parseMergeOutput,
  parseConflictOutput,
  buildClusterPrompt,
  buildMergePrompt,
  buildConflictPrompt,
} from "../src/ai/prompts/dream-prompts.js";
import { runDreamCycle, resetAdjournCounter } from "../src/orchestrator/dream.js";
import * as adapter from "../src/ai/adapter.js";

const AGENT_ID = "ag-p2";

beforeEach(() => {
  insertAgent({
    id: AGENT_ID,
    name: "P2",
    handle: "/p2",
    roleTag: "director",
    bio: "",
    instruction: "",
    modelV: "sonnet-4-6",
    avatarPath: "/avatars/p2.svg",
  });
});

afterEach(() => {
  resetAdjournCounter(AGENT_ID);
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────
// Prompt parsers · pure-function fixtures
// ─────────────────────────────────────────────────────────────────

describe("dream prompt builders · shape sanity", () => {
  it("cluster prompt includes user name + each memory's id", () => {
    const m1 = insertMemory({ agentId: AGENT_ID, content: "a", confidence: 0.7 });
    const m2 = insertMemory({ agentId: AGENT_ID, content: "b", confidence: 0.7 });
    const ms = [m1, m2];
    const { system, user } = buildClusterPrompt(ms, "Kay");
    expect(system).toContain("Kay");
    expect(user).toContain(m1.id);
    expect(user).toContain(m2.id);
  });

  it("merge prompt enforces JSON output format", () => {
    const m = insertMemory({ agentId: AGENT_ID, content: "concise output", confidence: 0.7 });
    const { system } = buildMergePrompt([m], "Kay");
    expect(system).toContain('{"content"');
    expect(system).toContain('"kind"');
  });

  it("conflict prompt includes date stamps for ordering", () => {
    const m = insertMemory({ agentId: AGENT_ID, content: "old claim", confidence: 0.7 });
    const { user } = buildConflictPrompt([m], "Kay");
    // ISO date prefix (YYYY-MM-DD) must appear next to the id
    expect(user).toMatch(new RegExp(`${m.id} \\(\\d{4}-\\d{2}-\\d{2}\\):`));
  });
});

describe("parseClusterOutput", () => {
  it("returns clusters of size >= 2 only", () => {
    const out = parseClusterOutput('[["m1","m2"], ["m3"], ["m4","m5","m6"]]', new Set(["m1", "m2", "m3", "m4", "m5", "m6"]));
    expect(out).toEqual([["m1", "m2"], ["m4", "m5", "m6"]]);
  });

  it("filters unknown ids out, drops cluster if remainder < 2", () => {
    const out = parseClusterOutput('[["m1","ghost"], ["m2","m3"]]', new Set(["m1", "m2", "m3"]));
    // first cluster only has m1 after filtering, drops; second survives
    expect(out).toEqual([["m2", "m3"]]);
  });

  it("tolerates code-fenced output", () => {
    const out = parseClusterOutput('```json\n[["m1","m2"]]\n```', new Set(["m1", "m2"]));
    expect(out).toEqual([["m1", "m2"]]);
  });

  it("returns [] on empty / NONE / garbage", () => {
    expect(parseClusterOutput("", new Set(["m1"]))).toEqual([]);
    expect(parseClusterOutput("not json", new Set(["m1"]))).toEqual([]);
    expect(parseClusterOutput("[]", new Set(["m1"]))).toEqual([]);
  });
});

describe("parseMergeOutput", () => {
  it("returns content + kind for valid input", () => {
    expect(parseMergeOutput('{"content": "User prefers concise output", "kind": "preference"}'))
      .toEqual({ content: "User prefers concise output", kind: "preference" });
  });

  it("defaults kind to fact when missing / invalid", () => {
    expect(parseMergeOutput('{"content": "c", "kind": "weird"}'))
      .toEqual({ content: "c", kind: "fact" });
    expect(parseMergeOutput('{"content": "c"}'))
      .toEqual({ content: "c", kind: "fact" });
  });

  it("rejects content > 200 chars or empty", () => {
    expect(parseMergeOutput('{"content": ""}')).toBeNull();
    expect(parseMergeOutput(`{"content": "${"x".repeat(250)}"}`)).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseMergeOutput("nope")).toBeNull();
    expect(parseMergeOutput("[]")).toBeNull();
  });
});

describe("parseConflictOutput", () => {
  it("returns ordered pairs", () => {
    const out = parseConflictOutput(
      '[{"older": "m1", "newer": "m2", "why": "evolved"}]',
      new Set(["m1", "m2"]),
    );
    expect(out).toEqual([{ older: "m1", newer: "m2", why: "evolved" }]);
  });

  it("filters self-pairs and unknown ids", () => {
    const out = parseConflictOutput(
      '[{"older": "m1", "newer": "m1", "why": "self"}, {"older": "m1", "newer": "ghost"}, {"older": "m1", "newer": "m2"}]',
      new Set(["m1", "m2"]),
    );
    expect(out).toEqual([{ older: "m1", newer: "m2", why: "" }]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Storage mutations · supersession + consolidation + promotion
// ─────────────────────────────────────────────────────────────────

describe("supersession + consolidation", () => {
  it("markSuperseded skips pinned + skips self", () => {
    const a = insertMemory({ agentId: AGENT_ID, content: "old", confidence: 0.7 });
    const b = insertMemory({ agentId: AGENT_ID, content: "newer", confidence: 0.8 });
    const pinned = insertMemory({ agentId: AGENT_ID, content: "pinned", confidence: 0.7, pinned: true });

    const n = markSuperseded([a.id, pinned.id, b.id], b.id);
    // a is superseded; pinned skipped; b is self-skipped → 1
    expect(n).toBe(1);
    const live = listMemoriesForAgent(AGENT_ID);
    // pinned + b survive in default (non-superseded) view
    const liveIds = new Set(live.map((m) => m.id));
    expect(liveIds.has(b.id)).toBe(true);
    expect(liveIds.has(pinned.id)).toBe(true);
    expect(liveIds.has(a.id)).toBe(false);
  });

  it("listMemoriesForAgent default excludes superseded · includeSuperseded surfaces them", () => {
    const a = insertMemory({ agentId: AGENT_ID, content: "old", confidence: 0.7 });
    const b = insertMemory({ agentId: AGENT_ID, content: "newer", confidence: 0.8 });
    markSuperseded([a.id], b.id);
    expect(listMemoriesForAgent(AGENT_ID).length).toBe(1);
    expect(listMemoriesForAgent(AGENT_ID, { includeSuperseded: true }).length).toBe(2);
  });

  it("memoriesForContext never injects superseded memories", () => {
    const a = insertMemory({ agentId: AGENT_ID, content: "old", confidence: 0.7 });
    const b = insertMemory({ agentId: AGENT_ID, content: "newer", confidence: 0.8 });
    markSuperseded([a.id], b.id);
    const ctx = memoriesForContext(AGENT_ID);
    expect(ctx.find((m) => m.id === a.id)).toBeUndefined();
  });

  it("insertConsolidatedMemory sums provenance + carries max confidence", () => {
    const a = insertMemory({ agentId: AGENT_ID, content: "a", confidence: 0.7 });
    const b = insertMemory({ agentId: AGENT_ID, content: "b", confidence: 0.9 });
    bumpProvenance(a.id, 2); // a now has provenance 3
    const aFresh = listMemoriesForAgent(AGENT_ID).find((m) => m.id === a.id)!;
    const bFresh = listMemoriesForAgent(AGENT_ID).find((m) => m.id === b.id)!;
    const merged = insertConsolidatedMemory({
      agentId: AGENT_ID,
      content: "user prefers concise · merged",
      sources: [aFresh, bFresh],
    });
    expect(merged.confidence).toBeCloseTo(0.9);
    expect(merged.provenanceRooms).toBe(4); // 3 + 1
    expect(merged.consolidatedFrom).toEqual([a.id, b.id]);
  });

  it("insertConsolidatedMemory throws on empty sources", () => {
    expect(() =>
      insertConsolidatedMemory({ agentId: AGENT_ID, content: "x", sources: [] }),
    ).toThrow();
  });

  it("insertConsolidatedMemory promotes to long when any source was long", () => {
    const a = insertMemory({ agentId: AGENT_ID, content: "a", confidence: 0.7 });
    getDb().prepare(`UPDATE agent_memories SET tier = 'long' WHERE id = ?`).run(a.id);
    const aFresh = listMemoriesForAgent(AGENT_ID).find((m) => m.id === a.id)!;
    const b = insertMemory({ agentId: AGENT_ID, content: "b", confidence: 0.7 });
    const bFresh = listMemoriesForAgent(AGENT_ID).find((m) => m.id === b.id)!;
    const merged = insertConsolidatedMemory({
      agentId: AGENT_ID,
      content: "merged",
      sources: [aFresh, bFresh],
    });
    expect(merged.tier).toBe("long");
  });
});

describe("promoteToLong", () => {
  it("promotes only short-tier non-superseded memories", () => {
    const a = insertMemory({ agentId: AGENT_ID, content: "stable", confidence: 0.8 });
    const b = insertMemory({ agentId: AGENT_ID, content: "also stable", confidence: 0.8 });
    const c = insertMemory({ agentId: AGENT_ID, content: "already long", confidence: 0.8 });
    getDb().prepare(`UPDATE agent_memories SET tier = 'long' WHERE id = ?`).run(c.id);
    const n = promoteToLong([a.id, b.id, c.id]);
    expect(n).toBe(2);
    const longs = listTierForAgent(AGENT_ID, "long");
    expect(longs.length).toBe(3);
  });
});

describe("agent_dreams audit log", () => {
  it("recordDream + listDreamsForAgent round-trip", () => {
    const id = recordDream({
      agentId: AGENT_ID,
      startedAt: 1000,
      finishedAt: 1234,
      beforeCount: 10,
      afterCount: 7,
      decayed: 2,
      merged: 1,
      promoted: 0,
      superseded: 2,
      notes: "test",
    });
    expect(typeof id).toBe("string");
    const list = listDreamsForAgent(AGENT_ID);
    expect(list.length).toBe(1);
    expect(list[0].decayed).toBe(2);
    expect(list[0].merged).toBe(1);
    expect(list[0].notes).toBe("test");
  });

  it("listDreamsForAgent newest-first", () => {
    recordDream({ agentId: AGENT_ID, startedAt: 100, finishedAt: 200, beforeCount: 1, afterCount: 1, decayed: 0, merged: 0, promoted: 0, superseded: 0 });
    recordDream({ agentId: AGENT_ID, startedAt: 300, finishedAt: 400, beforeCount: 1, afterCount: 1, decayed: 0, merged: 0, promoted: 0, superseded: 0 });
    const list = listDreamsForAgent(AGENT_ID);
    expect(list[0].startedAt).toBe(300);
    expect(list[1].startedAt).toBe(100);
  });
});

describe("purgeStaleSupersededMemories", () => {
  it("hard-deletes superseded rows older than the cutoff", () => {
    const a = insertMemory({ agentId: AGENT_ID, content: "old", confidence: 0.7 });
    const b = insertMemory({ agentId: AGENT_ID, content: "newer", confidence: 0.8 });
    markSuperseded([a.id], b.id);
    // Back-date the supersession update_at
    getDb().prepare(`UPDATE agent_memories SET updated_at = ? WHERE id = ?`)
      .run(Date.now() - 60 * 24 * 60 * 60 * 1000, a.id);
    const purged = purgeStaleSupersededMemories();
    expect(purged).toBe(1);
    expect(listMemoriesForAgent(AGENT_ID, { includeSuperseded: true }).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// Mocked-LLM end-to-end · drive the full pipeline deterministically
// ─────────────────────────────────────────────────────────────────

describe("runDreamCycle · full pipeline (mocked LLM)", () => {
  it("merges duplicates, supersedes contradictions, promotes stable, decays noise", async () => {
    // Make a utility model reachable so the LLM-gated steps run.
    setKey("openai", "sk-test");

    // Set up a varied memory pile:
    //   · two near-duplicates (about concise output)
    //   · two contradicting (crypto interested → rejected)
    //   · one stable (mentioned across 3 rooms, > 7d old, conf 0.8)
    //   · one decayable (60d old, conf 0.3, never used)
    //   · one fresh + low-conf (preserved · age too short)
    const dupA = insertMemory({ agentId: AGENT_ID, content: "user prefers concise output", confidence: 0.7 });
    const dupB = insertMemory({ agentId: AGENT_ID, content: "user dislikes long lists", confidence: 0.8 });
    const oldClaim = insertMemory({ agentId: AGENT_ID, content: "user is exploring crypto", confidence: 0.7 });
    // Make oldClaim chronologically older than newClaim
    getDb().prepare(`UPDATE agent_memories SET created_at = ? WHERE id = ?`)
      .run(Date.now() - 10 * 24 * 60 * 60 * 1000, oldClaim.id);
    const newClaim = insertMemory({ agentId: AGENT_ID, content: "user has decided crypto isn't relevant", confidence: 0.85 });

    const stableId = insertMemory({ agentId: AGENT_ID, content: "user works in fintech", confidence: 0.85 }).id;
    getDb().prepare(`UPDATE agent_memories SET created_at = ?, provenance_rooms = 3 WHERE id = ?`)
      .run(Date.now() - 14 * 24 * 60 * 60 * 1000, stableId);

    const decayId = insertMemory({ agentId: AGENT_ID, content: "user mentioned tired", confidence: 0.3 }).id;
    getDb().prepare(`UPDATE agent_memories SET created_at = ? WHERE id = ?`)
      .run(Date.now() - 60 * 24 * 60 * 60 * 1000, decayId);

    insertMemory({ agentId: AGENT_ID, content: "fresh low-conf chatter", confidence: 0.3 });

    // Mock callLLM · respond differently per system prompt content.
    const callLLMSpy = vi.spyOn(adapter, "callLLM");
    callLLMSpy.mockImplementation(async ({ messages }) => {
      const sys = messages[0]?.content || "";
      if (typeof sys === "string" && sys.includes("near-duplicates")) {
        // Cluster step · say dupA + dupB are duplicates
        return JSON.stringify([[dupA.id, dupB.id]]);
      }
      if (typeof sys === "string" && sys.includes("collapsing")) {
        // Merge step
        return JSON.stringify({
          content: "user prefers concise output, never padded lists",
          kind: "preference",
        });
      }
      if (typeof sys === "string" && sys.includes("contradictions")) {
        // Conflict step
        return JSON.stringify([{ older: oldClaim.id, newer: newClaim.id, why: "exploration → rejected" }]);
      }
      return "[]";
    });

    const summary = await runDreamCycle(AGENT_ID);
    expect(summary.decayed).toBe(1);          // decayId
    expect(summary.merged).toBeGreaterThanOrEqual(1);    // dupA+dupB
    expect(summary.superseded).toBeGreaterThanOrEqual(3); // dupA, dupB (merge) + oldClaim (conflict)
    expect(summary.promoted).toBe(1);          // stableId

    // Verify final state shape:
    const live = listMemoriesForAgent(AGENT_ID);
    const liveIds = new Set(live.map((m) => m.id));
    expect(liveIds.has(decayId)).toBe(false);
    expect(liveIds.has(dupA.id)).toBe(false); // superseded by merged
    expect(liveIds.has(dupB.id)).toBe(false);
    expect(liveIds.has(oldClaim.id)).toBe(false); // superseded by newClaim
    expect(liveIds.has(newClaim.id)).toBe(true);
    // The merged memory exists with consolidatedFrom referencing both sources
    const merged = live.find((m) => m.consolidatedFrom);
    expect(merged?.consolidatedFrom).toEqual(expect.arrayContaining([dupA.id, dupB.id]));
    // Stable was promoted
    const stable = live.find((m) => m.id === stableId);
    expect(stable?.tier).toBe("long");

    // Audit row was written
    const dreams = listDreamsForAgent(AGENT_ID);
    expect(dreams.length).toBe(1);
    expect(dreams[0].decayed).toBe(1);
  });

  it("falls through gracefully when no utility model is reachable", async () => {
    // No keys configured → utilityModelFor returns null → LLM steps skip
    insertMemory({ agentId: AGENT_ID, content: "won't be touched", confidence: 0.8 });
    const summary = await runDreamCycle(AGENT_ID);
    expect(summary.merged).toBe(0);
    expect(summary.superseded).toBe(0);
    // Still records audit row + still does heuristic decay/promote
    expect(listDreamsForAgent(AGENT_ID).length).toBe(1);
  });
});
