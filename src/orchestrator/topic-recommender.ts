/**
 * Interest-driven topic recommendation pipeline.
 *
 * Triggered when the user clicks "找你可能感兴趣的话题" on the
 * home composer. Mines the chair's long-term memory about the
 * user, optionally cross-references the keywords against x.com /
 * web search, and synthesises 5 room subjects the user is
 * likely to want to convene around.
 *
 * Phases:
 *   1. Read     · pull chair memories (no LLM)
 *   2. Distil   · LLM picks top 10 recency-weighted keywords
 *   3. Web sweep· parallel runWebSearch per keyword (skipped when no key)
 *   4. Synth    · LLM produces 5 topics with rationale + citations
 *
 * Modelled on `src/orchestrator/persona-builder.ts` — same
 * AbortController + in-memory job state + SSE event bus pattern.
 */
import { randomUUID } from "node:crypto";

import { callLLMWithUsage } from "../ai/adapter.js";
import { utilityModelFor } from "../ai/availability.js";
import { isModelV } from "../ai/registry.js";
import { runWebSearch, type BraveResult } from "../ai/skills/web-search.js";
import {
  getActiveWebSearchCredentials,
  hasWebSearchKey,
} from "../storage/keys.js";
import { getChairAgent } from "../storage/agents.js";
import { memoriesForContext, type AgentMemory } from "../storage/memories.js";
import {
  clearAllTopicRecs,
  createTopicRecBatch,
  createTopicRecJob,
  insertTopicRec,
  updateTopicRecJob,
  type TopicRecSnippet,
} from "../storage/topic-recs.js";
import { topicRecBus } from "./topic-stream.js";

/** Per-call LLM timeout. The keyword + synthesis passes are
 *  small payloads (10-20 keywords or so); 60 s leaves headroom
 *  for slow providers without letting a single hang stall the
 *  pipeline. */
const LLM_CALL_TIMEOUT_MS = 60_000;
/** Wall-clock kill switch across the entire pipeline. Topic
 *  recommendations should feel responsive · 4 phases × ~15 s
 *  budget = 60 s ceiling, doubled for slack. */
const PIPELINE_WALL_CLOCK_MS = 120_000;
/** Web-search parallelism · same values as persona-builder
 *  (Brave free-tier is ~1 req/sec; chunks of 3 with a 1 s gap
 *  fit comfortably). */
const SEARCH_PARALLEL_CHUNK = 3;
const SEARCH_CHUNK_GAP_MS = 1_000;
/** Per-query result count fed to the synthesiser. 5 is the
 *  same default Brave uses; enough to give the LLM signal
 *  without bloating the prompt. */
const SEARCH_RESULTS_PER_QUERY = 5;

type LLMRole = "system" | "user" | "assistant";

interface JobState {
  id: string;
  startedAt: number;
  controller: AbortController;
}

const inFlightJobs = new Map<string, JobState>();

/** Mirror of `brief.ts:signalWithTimeout`. */
function signalWithTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** JSON extraction matching the persona-builder helper · fence-
 *  tolerant, balanced-brace walk. Returns null on parse failure. */
function extractJson<T>(raw: string): T | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fence ? fence[1] : raw;
  if (!candidate) return null;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === "{") depth++;
    else if (candidate[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as T; }
  catch { return null; }
}

async function callPhaseLLM(
  state: JobState,
  modelV: string,
  messages: { role: LLMRole; content: string }[],
  opts: { temperature: number; maxTokens: number },
): Promise<string | null> {
  if (!isModelV(modelV)) return null;
  const t = signalWithTimeout(state.controller.signal, LLM_CALL_TIMEOUT_MS);
  try {
    const r = await callLLMWithUsage({
      modelV,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: t.signal,
    });
    return r.text;
  } catch (e) {
    process.stderr.write(
      `[topic-recommender] ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  } finally {
    t.cleanup();
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ─── Public API ──────────────────────────────────────────────

export function startTopicRecommend(): string {
  const jobId = randomUUID();
  createTopicRecJob(jobId);
  const state: JobState = {
    id: jobId,
    startedAt: Date.now(),
    controller: new AbortController(),
  };
  inFlightJobs.set(jobId, state);
  const wallClock = setTimeout(() => {
    if (inFlightJobs.has(jobId)) state.controller.abort();
  }, PIPELINE_WALL_CLOCK_MS);
  void runPipeline(state).finally(() => {
    clearTimeout(wallClock);
    inFlightJobs.delete(jobId);
  });
  return jobId;
}

export function abortTopicRecommend(jobId: string): boolean {
  const state = inFlightJobs.get(jobId);
  if (!state) return false;
  try { state.controller.abort(); }
  catch { /* idempotent */ }
  return true;
}

export function isTopicRecJobRunning(jobId: string): boolean {
  return inFlightJobs.has(jobId);
}

// ─── Pipeline ────────────────────────────────────────────────

async function runPipeline(state: JobState): Promise<void> {
  const phaseLabels = [
    "Reading your boardroom history",
    "Distilling interests",
    "Scanning trending topics",
    "Synthesising recommendations",
  ];

  const emitPhaseStart = (phase: number) => {
    topicRecBus.emit(state.id, {
      type: "topic-phase-start",
      phase,
      label: phaseLabels[phase - 1] ?? `Phase ${phase}`,
    });
  };
  const emitPhaseProgress = (phase: number, detail: string, pct: number) => {
    topicRecBus.emit(state.id, {
      type: "topic-phase-progress",
      phase,
      detail,
      progressPct: Math.max(0, Math.min(100, Math.round(pct))),
    });
    updateTopicRecJob(state.id, { currentPhase: phase, progressPct: pct });
  };
  const emitPhaseEnd = (phase: number, pct: number) => {
    topicRecBus.emit(state.id, {
      type: "topic-phase-end",
      phase,
      progressPct: Math.max(0, Math.min(100, Math.round(pct))),
    });
    updateTopicRecJob(state.id, { currentPhase: phase, progressPct: pct });
  };

  const fail = (message: string) => {
    updateTopicRecJob(state.id, { status: "failed", error: message });
    topicRecBus.emit(state.id, { type: "topic-error", message });
    topicRecBus.drop(state.id);
  };
  const cancel = () => {
    updateTopicRecJob(state.id, { status: "aborted" });
    topicRecBus.emit(state.id, { type: "topic-aborted" });
    topicRecBus.drop(state.id);
  };

  try {
    // ── Phase 1 · Read chair memories ───────────────────────
    emitPhaseStart(1);
    const chair = getChairAgent();
    if (!chair) {
      fail("chair agent missing — set up onboarding first");
      return;
    }
    const memories = memoriesForContext(chair.id, 50);
    emitPhaseProgress(1, `read ${memories.length} memories`, 8);
    emitPhaseEnd(1, 10);
    if (state.controller.signal.aborted) { cancel(); return; }

    // ── Phase 2 · Distil top 10 keywords (LLM) ──────────────
    emitPhaseStart(2);
    const modelV = utilityModelFor();
    if (!modelV) {
      fail("no LLM provider configured — add an API key first");
      return;
    }
    const keywords = await distilKeywords(state, modelV, memories);
    if (state.controller.signal.aborted) { cancel(); return; }
    if (keywords.length === 0) {
      fail("couldn't distil any keywords from the chair's memory yet — try again after a couple of rooms");
      return;
    }
    emitPhaseProgress(2, `picked ${keywords.length} keywords`, 25);
    emitPhaseEnd(2, 30);

    // ── Phase 3 · Web sweep (when key available) ────────────
    const hasWeb = hasWebSearchKey();
    let snippetsByKeyword: Map<string, TopicRecSnippet[]> = new Map();
    if (hasWeb) {
      emitPhaseStart(3);
      snippetsByKeyword = await runWebSweep(state, keywords, (kw, snippets, idx) => {
        emitPhaseProgress(
          3,
          `scanned "${kw}" (${snippets.length} hits) · ${idx}/${keywords.length}`,
          30 + Math.round((idx / keywords.length) * 40),
        );
        topicRecBus.emit(state.id, {
          type: "topic-search-round",
          keyword: kw,
          query: `${kw} site:x.com`,
          resultsCount: snippets.length,
          snippets,
        });
      });
      if (state.controller.signal.aborted) { cancel(); return; }
      emitPhaseEnd(3, 70);
    } else {
      // No web key · skip phase 3 entirely. Synthesis falls
      // back to memory-only mode and every rec lands with
      // source='memory'.
      emitPhaseProgress(3, "no web-search key — skipping", 70);
    }

    // ── Phase 4 · Synthesise topics + persist rows ──────────
    emitPhaseStart(4);
    const batchId = randomUUID();
    createTopicRecBatch({ id: batchId, hasWeb, keywords });
    updateTopicRecJob(state.id, { batchId });

    const synth = await synthesiseTopics(state, modelV, {
      memories,
      keywords,
      snippetsByKeyword,
      hasWeb,
    });
    if (state.controller.signal.aborted) { cancel(); return; }
    if (synth.length === 0) {
      fail("synthesis returned no topics — try again or refine your boardroom history first");
      return;
    }

    // Replace-don't-accumulate · the home composer only ever
    // shows the LATEST batch of 6 recs. Wipe every existing
    // topic_rec row right before inserting the new batch so
    // there's no historical accumulation in the table or in
    // the picker. Batch audit rows survive as orphaned
    // metadata (cheap, useful for analytics later).
    clearAllTopicRecs();

    let inserted = 0;
    for (const t of synth) {
      const rec = insertTopicRec({
        id: randomUUID(),
        batchId,
        subject: t.subject,
        rationale: t.rationale,
        source: t.source,
        tag: t.tag,
        seedContext: t.seedContext,
      });
      inserted++;
      topicRecBus.emit(state.id, { type: "topic-rec", rec });
      emitPhaseProgress(
        4,
        `synthesised ${inserted}/${synth.length}`,
        70 + Math.round((inserted / synth.length) * 28),
      );
    }
    emitPhaseEnd(4, 100);

    updateTopicRecJob(state.id, {
      status: "done",
      progressPct: 100,
      currentPhase: 4,
    });
    topicRecBus.emit(state.id, {
      type: "topic-final",
      batchId,
      totalRecs: inserted,
      hasWeb,
    });
    topicRecBus.drop(state.id);
  } catch (e) {
    if (state.controller.signal.aborted) {
      cancel();
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[topic-recommender] pipeline crashed: ${msg}\n`);
    fail(msg);
  }
}

// ─── Phase implementations ───────────────────────────────────

async function distilKeywords(
  state: JobState,
  modelV: string,
  memories: AgentMemory[],
): Promise<string[]> {
  // Empty boardroom · skip the LLM call and seed with a tiny
  // generic prompt so phase 4 can still produce something
  // useful (it'll lean entirely on the LLM's priors).
  if (memories.length === 0) return [];

  const memoryLines = memories
    .slice(0, 60)
    .map((m, i) => {
      const tier = m.tier === "long" ? "STABLE" : "fresh";
      const prov = m.provenanceRooms > 1 ? ` · ×${m.provenanceRooms} rooms` : "";
      const recency = Math.max(0, Math.round((Date.now() - m.createdAt) / 86400000));
      return `${i + 1}. [${tier}${prov} · ${recency}d ago · ${m.kind}] ${m.content}`;
    })
    .join("\n");

  const system =
    "You distil a user's interests from a chair's accumulated memory log. " +
    "Pick the 10 keywords / domains / themes the user is MOST currently engaged with. " +
    "Weight: recency × kind salience (goal > preference > observation > fact) × " +
    "cross-room provenance. Reject any keyword that wouldn't make a good " +
    "boardroom subject (too narrow, too transient, too personal-irrelevant). " +
    "Output strict JSON only: { \"keywords\": [\"...\", \"...\", ...] } with up to 10 entries.";

  const user =
    `# Chair's memory about the user (newest first within each tier)\n${memoryLines}\n\n` +
    "Return up to 10 keywords as JSON.";

  const raw = await callPhaseLLM(state, modelV, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { temperature: 0.3, maxTokens: 600 });

  if (!raw) return [];
  const parsed = extractJson<{ keywords?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.keywords)) return [];
  return parsed.keywords
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .slice(0, 10);
}

async function runWebSweep(
  state: JobState,
  keywords: string[],
  onKeywordDone: (keyword: string, snippets: TopicRecSnippet[], idx: number) => void,
): Promise<Map<string, TopicRecSnippet[]>> {
  const out = new Map<string, TopicRecSnippet[]>();
  const creds = getActiveWebSearchCredentials();
  if (!creds) return out;

  let doneCount = 0;
  for (let i = 0; i < keywords.length; i += SEARCH_PARALLEL_CHUNK) {
    if (state.controller.signal.aborted) break;
    const chunk = keywords.slice(i, i + SEARCH_PARALLEL_CHUNK);
    const settled = await Promise.allSettled(
      chunk.map((kw) => fetchKeywordSnippets(creds.backend, creds.apiKey, kw)),
    );
    settled.forEach((res, j) => {
      const kw = chunk[j];
      const snippets = res.status === "fulfilled" ? res.value : [];
      out.set(kw, snippets);
      doneCount++;
      onKeywordDone(kw, snippets, doneCount);
    });
    if (i + SEARCH_PARALLEL_CHUNK < keywords.length) {
      await sleepWithSignal(SEARCH_CHUNK_GAP_MS, state.controller.signal);
    }
  }
  return out;
}

async function fetchKeywordSnippets(
  backend: "brave" | "tavily",
  apiKey: string,
  keyword: string,
): Promise<TopicRecSnippet[]> {
  // Try x.com first; if empty, widen to a general query. Both
  // backends honour `site:` operators.
  const xQuery = `${keyword} site:x.com`;
  const xResults = await runWebSearch(backend, apiKey, xQuery, {
    count: SEARCH_RESULTS_PER_QUERY,
  });
  if (xResults && xResults.length > 0) {
    return xResults.map(toSnippet);
  }
  const generic = await runWebSearch(backend, apiKey, keyword, {
    count: SEARCH_RESULTS_PER_QUERY,
  });
  return (generic ?? []).map(toSnippet);
}

function toSnippet(r: BraveResult): TopicRecSnippet {
  return {
    title: r.title || "(untitled)",
    url: r.url,
    description: r.description || "",
  };
}

interface SynthesisedTopic {
  subject: string;
  rationale: string;
  source: "web" | "memory";
  /** Short 1-2 word category label the synthesiser picks for
   *  this topic. Drives the composer card's left tag column
   *  (e.g. "strategy", "product", "market", "ops"). */
  tag: string | null;
  seedContext: TopicRecSnippet[] | null;
}

async function synthesiseTopics(
  state: JobState,
  modelV: string,
  opts: {
    memories: AgentMemory[];
    keywords: string[];
    snippetsByKeyword: Map<string, TopicRecSnippet[]>;
    hasWeb: boolean;
  },
): Promise<SynthesisedTopic[]> {
  const { memories, keywords, snippetsByKeyword, hasWeb } = opts;

  // Flatten snippets to a numbered list. Each entry gets an
  // index the synthesiser can cite (e.g. "snippetRefs": [3, 7]).
  const flatSnippets: Array<TopicRecSnippet & { keyword: string }> = [];
  if (hasWeb) {
    for (const kw of keywords) {
      for (const s of snippetsByKeyword.get(kw) ?? []) {
        flatSnippets.push({ ...s, keyword: kw });
      }
    }
  }

  const memorySummary = memories.length === 0
    ? "(no chair memory yet — recommend topics that introduce the user to the boardroom format)"
    : memories
      .slice(0, 24)
      .map((m, i) => `M${i + 1}. [${m.kind}] ${m.content}`)
      .join("\n");

  const snippetBlock = flatSnippets.length === 0
    ? "(no web snippets — synthesise from memory only)"
    : flatSnippets
      .map((s, i) =>
        `S${i + 1}. [keyword: ${s.keyword}] ${s.title}\n   ${s.description}\n   ${s.url}`,
      )
      .join("\n\n");

  const system =
    "You recommend boardroom discussion topics to a user, based on (a) the " +
    "chair's long-term memory of who they are + what they care about, and " +
    "optionally (b) a set of currently-trending web/x.com snippets keyed off " +
    "the user's recent interests. Produce EXACTLY 5 distinct topics — not " +
    "4, not 6, five. Each topic is a subject line a user could plausibly " +
    "drop into the convene composer.\n\n" +
    "The 5 topics MUST span DIFFERENT dimensions/categories — don't return " +
    "five pricing topics. Use the 10 keywords as a multi-dimensional search " +
    "index; the 5 final topics should distil ACROSS those dimensions so the " +
    "picker reads as a balanced board agenda, not a single-angle obsession. " +
    "Each topic gets a different `tag`.\n\n" +
    "Voice: tight, specific, opinionated. Avoid corporate-speak. Skew toward " +
    "questions the user would actually want to debate, not generic explainers.\n\n" +
    "EVERY topic MUST include a `tag` field · a SHORT CATEGORY in 1-2 " +
    "lowercase words naming what bucket the topic falls into. Pick from " +
    "the user's actual subject matter (examples: strategy / product / market / " +
    "pricing / positioning / brand / hiring / fundraising / ops / infra / " +
    "research / craft / ethics / personal / leadership / growth / sales / " +
    "design / data / partnerships / regulation). FORBIDDEN tag values: " +
    "\"web\", \"memory\", \"general\", \"misc\", \"other\", \"topic\", " +
    "\"recommendation\" — these are meta-vocabulary that leaks the system, " +
    "not real categories. If the topic spans two areas, pick the dominant " +
    "one. NEVER omit the tag field.\n\n" +
    "Each topic must cite either (a) at least one snippet ref (S<n>) — in which " +
    "case set \"source\":\"web\" — OR (b) no snippet refs at all — in which case " +
    "set \"source\":\"memory\". The `source` and `tag` fields are independent: " +
    "`source` is the data provenance, `tag` is the topic category. Never use " +
    "\"web\" or \"memory\" as a tag.\n\n" +
    "Strict JSON output only:\n" +
    "{ \"topics\": [ { \"tag\": \"pricing\", \"subject\": \"...\", \"rationale\": \"one sentence on why this fits the user\", \"source\": \"web|memory\", \"snippetRefs\": [<S indexes, omit when source=memory>] } ] }";

  const user =
    `# Keywords distilled from chair memory\n${keywords.map((k, i) => `K${i + 1}. ${k}`).join("\n")}\n\n` +
    `# Memory excerpts\n${memorySummary}\n\n` +
    `# Web snippets ${hasWeb ? "(use these to ground at least some recs as source=web)" : "(none — synthesise from memory only)"}\n${snippetBlock}\n\n` +
    `Return EXACTLY 5 topics as JSON, each with a different tag, spanning different dimensions.`;

  const raw = await callPhaseLLM(state, modelV, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { temperature: 0.6, maxTokens: 2000 });

  if (!raw) return [];
  const parsed = extractJson<{
    topics?: Array<{
      tag?: unknown;
      subject?: unknown;
      rationale?: unknown;
      source?: unknown;
      snippetRefs?: unknown;
    }>;
  }>(raw);
  if (!parsed || !Array.isArray(parsed.topics)) return [];

  const out: SynthesisedTopic[] = [];
  for (const t of parsed.topics) {
    const subject = typeof t.subject === "string" ? t.subject.trim() : "";
    const rationale = typeof t.rationale === "string" ? t.rationale.trim() : "";
    if (!subject || !rationale) continue;
    // Clean the tag · keep it short, lowercase, and reject the
    // "leaky meta vocabulary" values that occasionally slip
    // through (e.g. tag="web" — the model echoing the source
    // field). When the model didn't produce a usable tag we
    // derive one from the subject so the card never falls back
    // to displaying "web" / "memory" / nothing.
    let tag: string | null = null;
    const TAG_BLOCKLIST = new Set([
      "web", "memory", "general", "misc", "other", "topic",
      "recommendation", "recommendations", "rec", "category",
      "n/a", "na", "none",
    ]);
    if (typeof t.tag === "string") {
      const cleaned = t.tag
        .trim()
        .replace(/^\/\/\s*/, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 28);
      if (cleaned.length > 0 && !TAG_BLOCKLIST.has(cleaned)) {
        tag = cleaned;
      }
    }
    // Derive a fallback tag from the subject when the LLM
    // forgot or produced a blocklisted value. Heuristic: take
    // the first 1-2 lowercase content words from the subject,
    // stripped of articles / question marks / etc. Lower
    // signal than a real category but better than "web".
    if (!tag) {
      const words = subject
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !["the", "and", "for", "are", "you", "your", "what", "how", "why", "when", "with", "from", "this", "that"].includes(w));
      if (words.length > 0) {
        tag = words.slice(0, 2).join(" ").slice(0, 28);
      } else {
        // Truly empty-subject edge case · use the source as a
        // last-resort but visually-distinct label.
        tag = "topic";
      }
    }
    let source: "web" | "memory" = t.source === "web" ? "web" : "memory";
    let seedContext: TopicRecSnippet[] | null = null;
    if (source === "web" && hasWeb && Array.isArray(t.snippetRefs)) {
      const refs = t.snippetRefs
        .map((r) => {
          if (typeof r === "number") return r;
          if (typeof r === "string") {
            const m = r.match(/^S?(\d+)$/i);
            return m ? Number(m[1]) : NaN;
          }
          return NaN;
        })
        .filter((n) => Number.isInteger(n) && n > 0 && n <= flatSnippets.length);
      const seen = new Set<string>();
      const cited: TopicRecSnippet[] = [];
      for (const ref of refs) {
        const snip = flatSnippets[ref - 1];
        if (!snip || seen.has(snip.url)) continue;
        seen.add(snip.url);
        cited.push({ title: snip.title, url: snip.url, description: snip.description });
      }
      if (cited.length > 0) {
        seedContext = cited;
      } else {
        // LLM claimed source=web but didn't cite anything · downgrade.
        source = "memory";
      }
    } else if (source === "web") {
      // No snippets available · downgrade.
      source = "memory";
    }
    out.push({ subject, rationale, source, tag, seedContext });
    if (out.length >= 6) break;
  }
  return out;
}
