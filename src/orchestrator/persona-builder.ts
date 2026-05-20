/**
 * Full-persona builder pipeline · the 7-phase, 5-10 minute deep build
 * that produces a `PersonaSpec` artifact rich enough to keep a director
 * distinct under multi-agent room pressure.
 *
 * This file is the orchestrator only · phase prompts live in
 * `src/ai/prompts/persona-builder.ts`, the search/fetch helpers live
 * in `src/ai/skills/web-search.ts` + `src/skills/url-fetch.ts`, and
 * SSE event shapes live in `src/orchestrator/persona-stream.ts`.
 *
 * Pattern intentionally mirrors `src/orchestrator/brief.ts` for
 * consistency · `signalWithTimeout` (per-phase wall-clock), the
 * in-flight Map keyed by jobId, the abort flow that propagates
 * upstream HTTP cancellation. Anyone reading brief.ts will recognise
 * the shape here.
 */
import { randomUUID } from "node:crypto";

import {
  buildAgentProfileMessages,
  parseAgentProfile,
  type AgentProfile,
} from "../ai/prompts/agent-spec.js";
import {
  buildDimensionPlannerMessages,
  buildEvalMessages,
  buildFewShotMessages,
  buildKnowledgeSynthesisMessages,
  buildPersonaNameMessages,
  buildPlannerMessages,
  buildProbeMessages,
  buildReflectionMessages,
  buildRulesMessages,
  parseDimensionPlan,
  parsePersonaName,
  parsePlannerDecision,
} from "../ai/prompts/persona-builder.js";
import { callLLMWithUsage } from "../ai/adapter.js";
import {
  effectiveDefaultModel,
  FLAGSHIP_TIER,
  reachableModels,
  utilityModelFor,
} from "../ai/availability.js";
import { isModelV } from "../ai/registry.js";
import { runWebSearch, formatSearchResults } from "../ai/skills/web-search.js";
import { fetchUrls, type UrlExtract } from "../skills/url-fetch.js";
import {
  getActiveWebSearchCredentials,
  hasWebSearchKey,
} from "../storage/keys.js";
import {
  createPersonaJob,
  getPersonaJob,
  updatePersonaJob,
} from "../storage/persona-jobs.js";
import type {
  PersonaBuildLog,
  PersonaEvalEntry,
  PersonaFewShot,
  PersonaKnowledge,
  PersonaKnowledgeEntry,
  PersonaRule,
  PersonaSpec,
  PersonaSpecCore,
} from "../storage/agents.js";

import { personaBus, type BuildEvent } from "./persona-stream.js";
import { runPersonaNarrator } from "./persona-narrator.js";

/* ─────────── Caps · derived from the plan §8 ─────────── */

/** Per-LLM-call wall-clock. Phase-3..7 calls finish well under this;
 *  Phase 2 search rounds use `REACT_ROUND_BUDGET_MS` instead. */
const LLM_CALL_TIMEOUT_MS = 90_000;
/** Build-wide hard ceiling. The user explicitly asked for 5-10 min;
 *  10 min is the wall-clock kill switch. */
const BUILD_WALL_CLOCK_MS = 10 * 60_000;
/** Token kill switch · prevents a runaway model from spending
 *  unbounded tokens. The user said "don't save tokens" but a runaway
 *  is a different failure mode. */
const PROMPT_TOKEN_CEILING = 200_000;
const OUTPUT_TOKEN_CEILING = 50_000;
/** ReAct loop parameters. Each round runs one planner LLM call + one
 *  search + up to 3 page fetches. As of the multi-dimensional
 *  research refactor, the legacy `REACT_MAX_ROUNDS` is unused at
 *  runtime — Phase 2 now runs a parallel dimension batch (4-6 angles)
 *  followed by a small ReAct top-up (capped by `REACT_TOPUP_MAX_ROUNDS`)
 *  to fill gaps. Exported so any downstream test or doc that imports
 *  it keeps compiling. */
export const REACT_MAX_ROUNDS = 5;
const REACT_TOPUP_MAX_ROUNDS = 2;
const REACT_PAGES_PER_ROUND = 3;
const REACT_FETCH_BUDGET_MS = 20_000; // wall-clock cap per round for page fetches

/** Dimension planner parameters. The LLM picks 4-6 angles (clamped on
 *  output); each runs in parallel with the same per-round result /
 *  page budgets as the legacy single-track loop. */
const DIMENSION_TARGET_MIN = 4;
const DIMENSION_TARGET_MAX = 6;
const DIMENSION_PAGES = 3;
const DIMENSION_RESULTS_PER_QUERY = 6;
/** Concurrency cap on the parallel dimension batch · keeps Brave's
 *  ~1 req/sec free-tier rate limit out of trouble. The orchestrator
 *  chunks the batch into groups of this size with a small inter-chunk
 *  sleep. */
const DIMENSION_PARALLEL_CHUNK = 3;
const DIMENSION_CHUNK_GAP_MS = 1_000;

/** Per-bucket caps on the raw-source string fed to the synthesizer.
 *  6 dims × 11k + 2 top-up × 7k = 80k worst case · final synthesizer
 *  slice at `RAW_SOURCES_SYNTH_CAP` is the safety net. */
const RAW_SOURCES_PER_DIM_CAP = 11_000;
const RAW_SOURCES_TOPUP_CAP = 7_000;
const RAW_SOURCES_SYNTH_CAP = 80_000;

/* ─────────── State + helpers ─────────── */

interface PersonaJobState {
  id: string;
  description: string;
  /** Locale to write the narrator's pitch summary in. Passed from the
   *  composer-side `locale` body field on `/generate-persona`. Falls
   *  back to "en" if not supplied. The narrative is generated once at
   *  build-end; the agent profile renders it as-is and never
   *  re-translates. */
  locale: "en" | "zh" | "ja" | "es";
  startedAt: number;
  controller: AbortController;
  promptTokens: number;
  outputTokens: number;
  /** Cumulative tokens billed across the WHOLE build. The existing
   *  `promptTokens` / `outputTokens` get reset to zero at every phase
   *  boundary (so the DB ADD-semantics counter doesn't double-count);
   *  this carries the true grand total for the build-log footer. */
  totalPromptTokens: number;
  totalOutputTokens: number;
  /** Append-only timeline · every meaningful event the build produced.
   *  Mirrored from the `personaBus.emit` sites via `recordEvent` so
   *  the narrative pass + saved build log can render what happened
   *  long after the SSE stream is gone. Cleaned of progress noise
   *  (we don't push every `persona-phase-progress` event — only phase
   *  boundaries, dimension plans, searches, divergence scores). */
  buildEvents: BuildEvent[];
  /** Per-phase start timestamp · used to compute the `durationMs` on
   *  the matching `phase-end` event. Keyed by phase number. */
  phaseStartedAt: Map<number, number>;
  /** Phase-2 audit log of search rounds the planner has already run.
   *  Used both for dedup (reject repeated normalised queries) and for
   *  the top-up planner's prompt (it sees what the dimension batch
   *  already covered, via the `dimension` tag). Kept here in memory
   *  rather than re-reading from the DB every round. */
  searchRounds: Array<{
    query: string;
    angle: string;
    resultsCount: number;
    pagesRead: number;
    notes: string;
    /** Set on rows from the parallel dimension batch (Phase 2b);
     *  undefined on top-up rounds (Phase 2c). The top-up planner
     *  prompt formats this into `[dimension: X]` audit-log lines. */
    dimension?: string;
    phase?: "dimension" | "topup";
  }>;
  /** Phase 2a · the dimension planner's output. Drives the parallel
   *  batch and the UI checklist. Persisted to the SSE stream once
   *  via `persona-dimension-plan`. */
  dimensionPlan: Array<{ dimension: string; query: string; why: string }>;
  /** Per-dimension raw-source blocks · capped at
   *  `RAW_SOURCES_PER_DIM_CAP`. Concat order at synthesis time
   *  follows `dimensionPlan` so the synthesizer sees the angles in
   *  the same order the user saw them. */
  rawSourcesByDim: Map<string, string>;
  /** Phase 2c · top-up rounds (max `REACT_TOPUP_MAX_ROUNDS`).
   *  Capped at `RAW_SOURCES_TOPUP_CAP` per round before merge. */
  rawSourcesTopup: string[];
}

const inFlightJobs = new Map<string, PersonaJobState>();

/** Mirror of `brief.ts:signalWithTimeout` · combines a parent abort
 *  signal with a per-call timeout into one signal the LLM / fetch
 *  call sees. Returns the merged signal + a cleanup fn the caller
 *  must invoke (clears the timer + detaches the parent listener). */
function signalWithTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeout = false;
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => didTimeout,
  };
}

/** Track tokens spent against the kill-switch ceiling. Returns true
 *  when the ceiling is breached (caller aborts). Persists the running
 *  totals to the job row so the eventual save can flush them via
 *  `incrementAgentTokens(newAgentId, total)`. */
function bumpTokens(state: PersonaJobState, prompt: number, output: number): boolean {
  const p = Math.max(0, prompt | 0);
  const o = Math.max(0, output | 0);
  state.promptTokens += p;
  state.outputTokens += o;
  state.totalPromptTokens += p;
  state.totalOutputTokens += o;
  // Defer the DB write until phase boundary · we update_at-bump on
  // every increment otherwise (write amplification). The phase-end
  // helper flushes both counters at once via `addPromptTokens` /
  // `addOutputTokens`.
  return state.promptTokens > PROMPT_TOKEN_CEILING || state.outputTokens > OUTPUT_TOKEN_CEILING;
}

/** Pick a flagship model the user actually has reachable, with the
 *  user's preferred default first. Mirrors `agentSpecModelCandidates`
 *  in `routes/agents.ts`. */
function flagshipCandidates(): string[] {
  const out: string[] = [];
  const flagship = effectiveDefaultModel();
  if (flagship) out.push(flagship);
  for (const m of reachableModels()) {
    if (FLAGSHIP_TIER.has(m.modelV) && !out.includes(m.modelV)) out.push(m.modelV);
  }
  const cheap = utilityModelFor();
  if (cheap && !out.includes(cheap)) out.push(cheap);
  return out;
}

/** Shared LLM call · wraps `callLLMWithUsage` with the per-call
 *  timeout signal + token tracking. Returns the raw text or null on
 *  failure (caller picks the next model in the fallback chain). */
async function callPhaseLLM(
  state: PersonaJobState,
  modelV: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { temperature: number; maxTokens: number },
): Promise<string | null> {
  const r = await callPhaseLLMVerbose(state, modelV, messages, opts);
  return r ? r.text : null;
}

export interface PhaseLLMResult {
  text: string;
  finishReason: string | null;
}

/** Same as `callPhaseLLM` but also surfaces the upstream
 *  `finish_reason`. Callers that need to distinguish a clean
 *  completion from a `length`-truncated response (notably the
 *  profile pass, which has to detect OpenRouter mid-stream cuts to
 *  decide whether to retry with a larger token ceiling) use this
 *  variant. The plain helper above is preserved for all the other
 *  phases that don't care, so this change is a non-breaking add. */
async function callPhaseLLMVerbose(
  state: PersonaJobState,
  modelV: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { temperature: number; maxTokens: number },
): Promise<PhaseLLMResult | null> {
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
    if (r.usage) {
      const exceeded = bumpTokens(state, r.usage.promptTokens, r.usage.completionTokens);
      if (exceeded) {
        // Mark the abort with a clear reason so the caller surfaces
        // a useful error to the user.
        state.controller.abort();
        return null;
      }
    }
    return { text: r.text, finishReason: r.finishReason };
  } catch (e) {
    process.stderr.write(`[persona-builder] ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  } finally {
    t.cleanup();
  }
}

/** Plain extractJson helper · same shape as agent-spec.ts'. Walks the
 *  first balanced { … } in the text and JSON-parses it. */
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

/* ─────────── Public API ─────────── */

/** Kick a fresh persona build · creates the job row + the in-memory
 *  state, returns the jobId immediately, runs the pipeline async.
 *  Caller (the route) opens an SSE stream with the jobId to receive
 *  progress events. */
export function startPersonaBuild(opts: { description: string; locale?: "en" | "zh" | "ja" | "es" }): string {
  const description = opts.description.trim();
  const jobId = randomUUID();
  createPersonaJob({ id: jobId, description });
  const state: PersonaJobState = {
    id: jobId,
    description,
    locale: opts.locale ?? "en",
    startedAt: Date.now(),
    controller: new AbortController(),
    promptTokens: 0,
    outputTokens: 0,
    totalPromptTokens: 0,
    totalOutputTokens: 0,
    searchRounds: [],
    dimensionPlan: [],
    rawSourcesByDim: new Map<string, string>(),
    rawSourcesTopup: [],
    buildEvents: [],
    phaseStartedAt: new Map<number, number>(),
  };
  inFlightJobs.set(jobId, state);
  // Wall-clock kill · separate from per-call timeouts because the
  // pipeline can chain many calls and we want a hard ceiling on the
  // whole build, not just one LLM pass.
  const wallClockTimer = setTimeout(() => {
    if (inFlightJobs.has(jobId)) {
      state.controller.abort();
    }
  }, BUILD_WALL_CLOCK_MS);
  void runPipeline(state).finally(() => {
    clearTimeout(wallClockTimer);
    inFlightJobs.delete(jobId);
  });
  return jobId;
}

/** User cancelled · abort upstream LLM / fetch calls. The pipeline's
 *  catch-and-emit logic flips the job row to `aborted` and emits the
 *  terminal SSE event. */
export function abortPersonaBuild(jobId: string): boolean {
  const state = inFlightJobs.get(jobId);
  if (!state) return false;
  try { state.controller.abort(); }
  catch { /* idempotent */ }
  return true;
}

/** Used by the SSE route to decide whether a fresh subscriber should
 *  be told "in progress · here's the partial state" or "terminal ·
 *  here's the final spec". */
export function isPersonaJobRunning(jobId: string): boolean {
  return inFlightJobs.has(jobId);
}

/* ─────────── Pipeline ─────────── */

interface PartialBuild {
  spec?: PersonaSpecCore;          // updated v1 → v2 after phase 3
  knowledge?: PersonaKnowledge;
  rules?: PersonaRule[];
  fewShot?: PersonaFewShot[];
  reflectionChecklist?: string[];
  evalSet?: PersonaEvalEntry[];
  differentiationScore?: number | null;
  toolAccess?: { webSearch: boolean };
  /** v1 profile · the original AgentProfile shape from agent-spec.ts.
   *  Kept across phases so the planner + critique passes can read it. */
  profileV1?: AgentProfile;
  /** v2 profile · post-knowledge critique. */
  profileV2?: AgentProfile;
  /** Post-pipeline naming pass · LLM-generated display name for the
   *  save form. The handle is computed from the name on the client.
   *  Optional · the route layer falls back to a seed-words heuristic
   *  when missing (e.g. resumed jobs from before this pass existed). */
  guessName?: string;
  /** Snapshot of the build's structured event log + (eventually) the
   *  narrator's pitch summary. Mirrored into `partial_json` on every
   *  phase boundary so the SSE replay path can hydrate the build-log
   *  preview before save; populated with `narrative` after phase 7's
   *  narrator pass completes. */
  buildLog?: PersonaBuildLog;
}

async function runPipeline(state: PersonaJobState): Promise<void> {
  const partial: PartialBuild = {};
  const phaseLabels = [
    "Persona spec (v1)",
    "Knowledge context (research)",
    "Persona spec (refined)",
    "Behavioural rules",
    "Few-shot examples",
    "Reflection checklist",
    "Eval set + build report",
  ];
  const phaseEtas = [30, 280, 30, 45, 90, 30, 60]; // sec, rough — for UI ETA
  const totalEta = phaseEtas.reduce((a, b) => a + b, 0);

  let progressBaselinePct = 0;

  const recordEvent = (ev: BuildEvent): void => {
    state.buildEvents.push(ev);
  };

  /** Snapshot the structured event log onto `partial.buildLog` so the
   *  next `partialToPersona(partial)` / `updatePersonaJob` write
   *  preserves it across a server restart. Narrator's `narrative`
   *  stays empty until phase 7's post-pipeline narrator pass fills
   *  it in — until then the modal would render the timeline only. */
  const syncBuildLogSnapshot = (): void => {
    partial.buildLog = {
      narrative: partial.buildLog?.narrative ?? "",
      locale: state.locale,
      generatedAt: partial.buildLog?.generatedAt ?? 0,
      events: state.buildEvents.slice(),
      totalTokens: state.totalPromptTokens + state.totalOutputTokens,
    };
  };

  const startPhase = (phase: number): void => {
    const i = phase - 1;
    const now = Date.now();
    state.phaseStartedAt.set(phase, now);
    personaBus.emit(state.id, {
      type: "persona-phase-start",
      phase,
      label: phaseLabels[i],
      etaSec: phaseEtas[i],
    });
    recordEvent({ kind: "phase-start", ts: now, phase, label: phaseLabels[i] });
  };

  const finishPhase = (phase: number): number => {
    const i = phase - 1;
    progressBaselinePct = Math.round(((phaseEtas.slice(0, i + 1).reduce((a, b) => a + b, 0)) / totalEta) * 100);
    const startedAt = state.phaseStartedAt.get(phase) ?? Date.now();
    const finishedAt = Date.now();
    recordEvent({
      kind: "phase-end",
      ts: finishedAt,
      phase,
      durationMs: Math.max(0, finishedAt - startedAt),
    });
    syncBuildLogSnapshot();
    personaBus.emit(state.id, {
      type: "persona-phase-end",
      phase,
      partial: partialToPersona(partial),
      progressPct: progressBaselinePct,
    });
    updatePersonaJob(state.id, {
      currentPhase: phase + 1,
      progressPct: progressBaselinePct,
      partial: partialToPersona(partial),
      addPromptTokens: state.promptTokens, // gross totals · not ideal
      addOutputTokens: state.outputTokens,
    });
    // Reset locally-tracked counters so the next phase boundary
    // doesn't double-count them. The DB row carries the cumulative.
    state.promptTokens = 0;
    state.outputTokens = 0;
    return progressBaselinePct;
  };

  const reportProgress = (phase: number, detail: string, pctWithinPhase: number): void => {
    const phaseWeight = phaseEtas[phase - 1] / totalEta;
    const overall = Math.round(progressBaselinePct + phaseWeight * 100 * Math.max(0, Math.min(1, pctWithinPhase)));
    personaBus.emit(state.id, {
      type: "persona-phase-progress",
      phase,
      detail,
      progressPct: overall,
    });
  };

  const fail = (message: string): void => {
    personaBus.emit(state.id, { type: "persona-error", message });
    updatePersonaJob(state.id, { status: "failed", error: message });
    personaBus.drop(state.id);
  };

  const checkAbortOrCap = (): "ok" | "aborted" | "tokens" => {
    if (state.controller.signal.aborted) {
      // Distinguish wall-clock abort vs. user cancel · the wall-clock
      // timer aborted the same controller, so we can't tell after the
      // fact. The user-facing message says "abort" and is the same
      // either way; the build report card surfaces the elapsed time
      // for diagnosis.
      return "aborted";
    }
    if (state.promptTokens > PROMPT_TOKEN_CEILING || state.outputTokens > OUTPUT_TOKEN_CEILING) {
      return "tokens";
    }
    return "ok";
  };

  try {
    /* ─────────── Phase 1 · Persona spec v1 ─────────── */
    startPhase(1);
    reportProgress(1, "drafting initial persona", 0.1);
    const profileV1 = await runProfilePass(state, "Phase 1 (initial draft)");
    if (!profileV1) {
      const status = checkAbortOrCap();
      if (status === "aborted") return finalizeAbort(state);
      // Surface a more diagnostic message · names the candidate model
       // list so the user can tell whether the build failed because no
       // models were reachable, or because the reachable models couldn't
       // emit a parseable profile (often resolved by trying once more
       // or switching to a stronger flagship via the keys panel).
      const candidatesTried = flagshipCandidates();
      const hint = candidatesTried.length === 0
        ? "no flagship model is reachable with your current API key · open Preferences ▸ API Key and add a provider that exposes Claude / GPT / Gemini / Kimi / GLM"
        : `${candidatesTried.length === 1 ? "the only reachable model" : "all reachable flagship models"} (${candidatesTried.join(", ")}) returned an unparseable profile — try again, or switch to a stronger model via Preferences ▸ API Key`;
      return fail(`Phase 1 (persona spec) failed · ${hint}.`);
    }
    partial.profileV1 = profileV1;
    partial.spec = toCore(profileV1);
    finishPhase(1);
    {
      const status = checkAbortOrCap();
      if (status !== "ok") return finalizeFromCheck(state, status);
    }

    /* ─────────── Phase 2 · Knowledge ReAct loop ─────────── */
    startPhase(2);
    const knowledge = await runReActLoop(state, profileV1, reportProgress);
    if (!knowledge) {
      // Knowledge loop is ALLOWED to produce nothing (no Brave key,
      // search dead, planner gave up immediately). We continue with
      // an empty bundle rather than failing the whole build · the v2
      // critique still runs against the v1 profile and the user
      // gets a working agent.
      partial.knowledge = emptyKnowledge();
    } else {
      partial.knowledge = knowledge;
    }
    finishPhase(2);
    {
      const status = checkAbortOrCap();
      if (status !== "ok") return finalizeFromCheck(state, status);
    }

    /* ─────────── Phase 3 · Persona spec v2 (critique) ─────────── */
    startPhase(3);
    reportProgress(3, "refining persona with research findings", 0.1);
    // Feed the synthesised knowledge as `webContext` into the SAME
    // Stage A prompt so the second pass produces a richer profile
    // grounded in the loop's surfaced material.
    const knowledgeSummary = renderKnowledgeAsContext(partial.knowledge);
    const profileV2 = await runProfilePass(state, "Phase 3 (knowledge-informed)", knowledgeSummary);
    if (!profileV2) {
      // Fall back to v1 · having a v1 spec is better than failing
      // the whole build because the critique pass didn't parse.
      partial.profileV2 = profileV1;
      partial.spec = toCore(profileV1);
    } else {
      partial.profileV2 = profileV2;
      partial.spec = toCore(profileV2);
    }
    finishPhase(3);
    {
      const status = checkAbortOrCap();
      if (status !== "ok") return finalizeFromCheck(state, status);
    }

    /* ─────────── Phase 4 · Behavioural rules ─────────── */
    startPhase(4);
    reportProgress(4, "distilling rules from spec + knowledge", 0.2);
    partial.rules = await runRulesPhase(state, partial.profileV2!, knowledgeSummary);
    finishPhase(4);
    {
      const status = checkAbortOrCap();
      if (status !== "ok") return finalizeFromCheck(state, status);
    }

    /* ─────────── Phase 5 · Few-shot examples ─────────── */
    startPhase(5);
    reportProgress(5, "writing worked examples", 0.2);
    partial.fewShot = await runFewShotPhase(state, partial.profileV2!, partial.rules || []);
    finishPhase(5);
    {
      const status = checkAbortOrCap();
      if (status !== "ok") return finalizeFromCheck(state, status);
    }

    /* ─────────── Phase 6 · Reflection checklist ─────────── */
    startPhase(6);
    reportProgress(6, "writing per-turn self-check questions", 0.4);
    partial.reflectionChecklist = await runReflectionPhase(
      state,
      partial.profileV2!,
      partial.fewShot?.length ?? 0,
    );
    finishPhase(6);
    {
      const status = checkAbortOrCap();
      if (status !== "ok") return finalizeFromCheck(state, status);
    }

    /* ─────────── Phase 7 · Eval set + differentiation score ─────────── */
    startPhase(7);
    reportProgress(7, "generating eval prompts", 0.2);
    const evalSet = await runEvalPhase(state, partial.profileV2!);
    partial.evalSet = evalSet;
    if (evalSet && evalSet.length > 0) {
      reportProgress(7, "running build-time differentiation probes", 0.5);
      const scored = await runDifferentiationProbes(state, evalSet, partial);
      partial.evalSet = scored;
      const valid = scored.map((e) => e.divergenceScore).filter((s): s is number => s !== null);
      partial.differentiationScore = valid.length > 0
        ? valid.reduce((a, b) => a + b, 0) / valid.length
        : null;
      state.buildEvents.push({
        kind: "divergence",
        ts: Date.now(),
        score: partial.differentiationScore,
      });
    }
    // Tool access · derive from spec · webSearch ON if the persona
    // has an empirical / referent-set leaning OR if the user already
    // has a search key configured (cheap default).
    partial.toolAccess = { webSearch: hasWebSearchKey() };
    // Naming pass · cheap utility-tier LLM call uses the refined v2
    // profile to suggest a director name. Failure here is non-fatal:
    // the route layer falls back to a seed-words heuristic when
    // `partial.guessName` is absent. Runs inside Phase 7's slice so
    // we don't pay an extra phase-row in the UI for a 5-second call.
    reportProgress(7, "naming the director", 0.85);
    partial.guessName = await runNamePhase(state, partial.profileV2!) || undefined;
    // Narrator · the last thing phase 7 does. Writes a 200-400 word
    // pitch-style summary of the build in the user's locale, which
    // anchors the Build-log modal on the agent profile. Non-fatal:
    // on failure the narrative stays empty and the timeline still
    // renders. Sits inside phase 7's progress slice so the UI gets
    // one more sub-step indicator before the terminal event.
    reportProgress(7, "summarising the build", 0.92);
    try {
      const narrative = await runPersonaNarrator(state, {
        description: state.description,
        locale: state.locale,
        events: state.buildEvents,
        profileV2: partial.profileV2 ?? null,
        differentiationScore: partial.differentiationScore ?? null,
        guessName: partial.guessName ?? null,
      });
      partial.buildLog = {
        narrative: narrative || "",
        locale: state.locale,
        generatedAt: Date.now(),
        events: state.buildEvents.slice(),
        totalTokens: state.totalPromptTokens + state.totalOutputTokens,
      };
    } catch (e) {
      process.stderr.write(`[persona-builder/narrator] failed: ${e instanceof Error ? e.message : String(e)}\n`);
      partial.buildLog = {
        narrative: "",
        locale: state.locale,
        generatedAt: Date.now(),
        events: state.buildEvents.slice(),
        totalTokens: state.totalPromptTokens + state.totalOutputTokens,
      };
    }
    finishPhase(7);
    {
      const status = checkAbortOrCap();
      if (status !== "ok") return finalizeFromCheck(state, status);
    }

    /* ─────────── Done ─────────── */
    const finalSpec = partialToPersona(partial);
    if (!finalSpec) {
      return fail("Persona build completed but the final artifact failed validation.");
    }
    updatePersonaJob(state.id, {
      status: "done",
      progressPct: 100,
      partial: finalSpec,
    });
    personaBus.emit(state.id, { type: "persona-final", spec: finalSpec });
    personaBus.drop(state.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[persona-builder] uncaught: ${msg}\n`);
    fail(msg || "Persona build crashed.");
  }
}

function finalizeAbort(state: PersonaJobState): void {
  updatePersonaJob(state.id, { status: "aborted" });
  personaBus.emit(state.id, { type: "persona-aborted" });
  personaBus.drop(state.id);
}

function finalizeFromCheck(state: PersonaJobState, status: "aborted" | "tokens"): void {
  if (status === "tokens") {
    const msg = `Build hit the token ceiling (${PROMPT_TOKEN_CEILING.toLocaleString()} input · ${OUTPUT_TOKEN_CEILING.toLocaleString()} output). Aborted to prevent runaway spend.`;
    personaBus.emit(state.id, { type: "persona-error", message: msg });
    updatePersonaJob(state.id, { status: "failed", error: msg });
    personaBus.drop(state.id);
  } else {
    finalizeAbort(state);
  }
}

/* ─────────── Phase 1 / 3 helper · Stage A profile pass ─────────── */

async function runProfilePass(
  state: PersonaJobState,
  label: string,
  webContext?: string,
): Promise<AgentProfile | null> {
  const messages = buildAgentProfileMessages({ description: state.description, webContext: webContext ?? null });
  const candidates = flagshipCandidates();
  if (candidates.length === 0) {
    process.stderr.write(`[persona-builder/${label}] no reachable models for the active credential · cannot build profile\n`);
    return null;
  }
  // Per-model retries · the persona schema is fairly complex (nested
  // lineage / concepts / referents / failure modes) and LLMs do
  // occasionally emit a prose preamble OR get truncated by an
  // aggregator like OpenRouter mid-stream, so a single sample failing
  // isn't proof the model can't produce a valid spec. Under the
  // single-active-credential model the candidate list often collapses
  // to ONE entry (Kimi-only user sees only `kimi-k2-6`, GLM-only user
  // sees only `glm-5-1`); without per-model retries, one unlucky
  // sample killed the whole build with no fallback.
  //
  // Each retry tunes two knobs:
  //   · temperature   — bumped on attempt 2 to nudge the model off a
  //     failing sample (helps when the issue was prose preamble / wrong
  //     field name on a deterministic model).
  //   · maxTokens     — escalated when the prior attempt was truncated
  //     (`finishReason === "length"`) OR when extractJson sees an
  //     unbalanced `{` count (raw text starts with `{` but never
  //     closes). OpenRouter routes that go through slower or
  //     reasoning-heavy upstreams sometimes can't fit the JSON in the
  //     default ceiling — bumping it is the actual fix, not retrying
  //     at the same ceiling.
  const PROFILE_ATTEMPTS_PER_MODEL = 2;
  const PROFILE_MAX_TOKENS_BASE = 4096;
  const PROFILE_MAX_TOKENS_ESCALATED = 6500;
  for (const modelV of candidates) {
    if (state.controller.signal.aborted) return null;
    let truncatedLastAttempt = false;
    for (let attempt = 1; attempt <= PROFILE_ATTEMPTS_PER_MODEL; attempt++) {
      if (state.controller.signal.aborted) return null;
      const temperature = attempt === 1 ? 0.6 : 0.8;
      const maxTokens = truncatedLastAttempt ? PROFILE_MAX_TOKENS_ESCALATED : PROFILE_MAX_TOKENS_BASE;
      const result = await callPhaseLLMVerbose(state, modelV, messages, { temperature, maxTokens });
      if (!result || !result.text) {
        process.stderr.write(`[persona-builder/${label}] ${modelV} attempt ${attempt}/${PROFILE_ATTEMPTS_PER_MODEL} returned no text\n`);
        truncatedLastAttempt = false;
        continue;
      }
      const raw = result.text;
      const parsed = parseAgentProfile(raw);
      if (parsed) return parsed;
      // Diagnose why parsing failed · "length" finish reason or
      // unbalanced braces both mean the response was cut off and the
      // next retry should escalate the token ceiling.
      const truncated = result.finishReason === "length" || looksTruncated(raw);
      truncatedLastAttempt = truncated;
      const head = raw.slice(0, 200).replace(/\s+/g, " ");
      const tail = raw.length > 200 ? raw.slice(-160).replace(/\s+/g, " ") : "";
      process.stderr.write(
        `[persona-builder/${label}] ${modelV} attempt ${attempt}/${PROFILE_ATTEMPTS_PER_MODEL} returned unparseable profile · ` +
        `len=${raw.length} finish=${result.finishReason ?? "n/a"} maxTokens=${maxTokens}${truncated ? " TRUNCATED" : ""} · ` +
        `head: ${head}${tail ? ` … tail: ${tail}` : ""}\n`,
      );
    }
  }
  return null;
}

/** Heuristic · the raw text looks truncated when it opens a JSON
 *  object but never closes it. Used as a secondary signal alongside
 *  `finish_reason === "length"` because some carriers (notably some
 *  OpenRouter upstreams) don't reliably surface finish reasons even
 *  when they truncate. */
function looksTruncated(raw: string): boolean {
  if (!raw) return false;
  // Strip a possible ```json fence head so we look at the JSON body.
  const fenceMatch = /```(?:json)?\s*([\s\S]*)$/i.exec(raw);
  const body = fenceMatch ? fenceMatch[1] : raw;
  if (!body) return false;
  const start = body.indexOf("{");
  if (start === -1) return false;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
  }
  return depth > 0;
}

/* ─────────── Phase 2 · ReAct knowledge loop ─────────── */

async function runReActLoop(
  state: PersonaJobState,
  profileV1: AgentProfile,
  reportProgress: (phase: number, detail: string, pct: number) => void,
): Promise<PersonaKnowledge | null> {
  const creds = getActiveWebSearchCredentials();
  if (!creds) {
    // No search key · skip the loop entirely. Phase 3 critique still
    // runs against the v1 profile; the user gets a working agent
    // without the knowledge enrichment.
    reportProgress(2, "no web-search key configured · skipping research", 1.0);
    return emptyKnowledge();
  }

  const candidates = flagshipCandidates();
  const normalised = (q: string) => q.toLowerCase().replace(/[^a-z0-9\s一-鿿]/gi, " ").replace(/\s+/g, " ").trim();

  /* ─── Phase 2a · dimension planner ───
     One LLM call → 4-6 angles to investigate in parallel. On parse
     failure or empty output we fall back to a static plan derived
     from the v1 profile (living-figure vs historical heuristic).
     Progress slice: 0.00 → 0.05. */
  reportProgress(2, "planning research dimensions", 0.0);
  let plan = await planDimensions(state, profileV1, candidates);
  if (!plan || plan.length === 0) {
    plan = defaultDimensionFallback(profileV1);
    process.stderr.write("[persona-builder/dim-plan] planner failed · using fallback dimensions\n");
  }
  // Hard-clamp · the prompt asks for 4-6 but a misbehaving model
  // could emit 8. Take the first DIMENSION_TARGET_MAX entries.
  if (plan.length > DIMENSION_TARGET_MAX) plan = plan.slice(0, DIMENSION_TARGET_MAX);
  // Reject obviously-generic queries (under 3 words, or matching the
  // seed verbatim). Falls back to fallback if too few survive.
  const seedNorm = normalised(state.description);
  plan = plan.filter((d) => {
    const wc = d.query.split(/\s+/).filter((w) => w.length > 0).length;
    return wc >= 3 && normalised(d.query) !== seedNorm;
  });
  if (plan.length < DIMENSION_TARGET_MIN) {
    // Top up with fallback entries the planner didn't already pick.
    const seenDims = new Set(plan.map((d) => d.dimension));
    for (const f of defaultDimensionFallback(profileV1)) {
      if (plan.length >= DIMENSION_TARGET_MIN) break;
      if (!seenDims.has(f.dimension)) plan.push(f);
    }
  }
  state.dimensionPlan = plan;
  personaBus.emit(state.id, {
    type: "persona-dimension-plan",
    dimensions: plan.slice(),
  });
  state.buildEvents.push({
    kind: "dimension-plan",
    ts: Date.now(),
    dimensions: plan.map((d) => ({ dimension: d.dimension, query: d.query, why: d.why })),
  });
  reportProgress(2, `${plan.length} angles picked · searching in parallel`, 0.05);

  /* ─── Phase 2b · parallel dimension batch ───
     `Promise.allSettled` · one rate-limit failure shouldn't break the
     whole batch. Chunked to DIMENSION_PARALLEL_CHUNK with an inter-
     chunk gap so Brave's free-tier 1 req/sec limit doesn't 429 us.
     Progress slice: 0.05 → 0.55. */
  let doneCount = 0;
  for (let chunkStart = 0; chunkStart < plan.length; chunkStart += DIMENSION_PARALLEL_CHUNK) {
    if (state.controller.signal.aborted) return null;
    const chunk = plan.slice(chunkStart, chunkStart + DIMENSION_PARALLEL_CHUNK);
    const tasks = chunk.map((entry, idxInChunk) => runDimensionSearch(state, entry, creds, chunkStart + idxInChunk + 1));
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      doneCount += 1;
      if (r.status === "rejected") {
        process.stderr.write(`[persona-builder/dim-batch] dimension search rejected: ${String(r.reason)}\n`);
      }
      const pct = 0.05 + (doneCount / plan.length) * 0.50;
      reportProgress(2, `dimension ${doneCount}/${plan.length} complete`, pct);
    }
    // Inter-chunk gap · only sleep when there's another chunk to run.
    if (chunkStart + DIMENSION_PARALLEL_CHUNK < plan.length) {
      await sleep(DIMENSION_CHUNK_GAP_MS, state.controller.signal);
    }
  }

  /* ─── Phase 2c · ReAct top-up ───
     The planner sees `state.searchRounds` (already populated by 2b
     with `[dimension: X]` tags) and decides whether to fill any
     remaining gaps or stop. Capped at REACT_TOPUP_MAX_ROUNDS.
     Progress slice: 0.55 → 0.85. */
  for (let round = 1; round <= REACT_TOPUP_MAX_ROUNDS; round++) {
    if (state.controller.signal.aborted) return null;
    const baseSlice = 0.55;
    const sliceWidth = 0.30;
    reportProgress(2, `top-up ${round}/${REACT_TOPUP_MAX_ROUNDS} · planning gap query`, baseSlice + ((round - 1) / REACT_TOPUP_MAX_ROUNDS) * sliceWidth);

    const plannerMessages = buildPlannerMessages({
      description: state.description,
      profileV1,
      pastRounds: state.searchRounds.map((r) => ({
        ...r,
        notes: r.notes
          ? r.notes
          : (r.dimension ? `[dimension: ${r.dimension}]` : ""),
      })),
      roundsRemaining: REACT_TOPUP_MAX_ROUNDS - round + 1,
    });
    let decision: ReturnType<typeof parsePlannerDecision> | null = null;
    for (const modelV of candidates) {
      if (state.controller.signal.aborted) return null;
      const raw = await callPhaseLLM(state, modelV, plannerMessages, { temperature: 0.4, maxTokens: 400 });
      if (!raw) continue;
      decision = parsePlannerDecision(raw);
      if (decision) break;
    }
    if (!decision) {
      process.stderr.write("[persona-builder/topup] planner returned unparseable decision · stopping top-up\n");
      break;
    }
    if (decision.action === "stop") {
      reportProgress(2, `top-up stopped · ${decision.reason || "no gaps to fill"}`, baseSlice + sliceWidth);
      break;
    }
    const query = (decision.query || "").trim();
    if (!query) break;
    const norm = normalised(query);
    if (state.searchRounds.some((r) => normalised(r.query) === norm)) {
      // Duplicate · the planner's prompt told it not to do this, but
      // log + continue to the next round defensively.
      reportProgress(2, `top-up ${round} · duplicate query "${query}", skipping`, baseSlice + (round / REACT_TOPUP_MAX_ROUNDS) * sliceWidth);
      state.searchRounds.push({
        query,
        angle: decision.angle || "",
        resultsCount: 0,
        pagesRead: 0,
        notes: "duplicate of prior query · skipped",
        phase: "topup",
      });
      continue;
    }

    reportProgress(2, `top-up ${round} · searching: "${query}"`, baseSlice + ((round - 0.6) / REACT_TOPUP_MAX_ROUNDS) * sliceWidth);
    const t = signalWithTimeout(state.controller.signal, REACT_FETCH_BUDGET_MS);
    let results: Awaited<ReturnType<typeof runWebSearch>> = null;
    try {
      results = await runWebSearch(creds.backend, creds.apiKey, query, { count: 6, timeoutMs: 8000 });
    } catch { /* null below */ }
    finally { t.cleanup(); }
    const resultsArr = results || [];
    let pageExtracts: UrlExtract[] = [];
    if (resultsArr.length > 0) {
      reportProgress(2, `top-up ${round} · reading top ${REACT_PAGES_PER_ROUND} pages`, baseSlice + ((round - 0.3) / REACT_TOPUP_MAX_ROUNDS) * sliceWidth);
      const urls = resultsArr.slice(0, REACT_PAGES_PER_ROUND).map((r) => r.url);
      const fetchT = signalWithTimeout(state.controller.signal, REACT_FETCH_BUDGET_MS);
      try { pageExtracts = await fetchUrls(urls); }
      catch { pageExtracts = []; }
      finally { fetchT.cleanup(); }
    }

    const blockParts: string[] = [];
    if (resultsArr.length > 0) {
      blockParts.push(formatSearchResults(query, resultsArr));
    }
    for (const ext of pageExtracts) {
      if (ext.ok && ext.text) {
        blockParts.push(`─── PAGE · ${ext.title || ext.url}\nURL: ${ext.url}\n\n${ext.text}\n`);
      }
    }
    if (blockParts.length > 0) {
      state.rawSourcesTopup.push(blockParts.join("\n\n").slice(0, RAW_SOURCES_TOPUP_CAP));
    }

    const roundNum = plan.length + round;
    state.searchRounds.push({
      query,
      angle: decision.angle || "",
      resultsCount: resultsArr.length,
      pagesRead: pageExtracts.filter((e) => e.ok).length,
      notes: "",
      phase: "topup",
    });
    personaBus.emit(state.id, {
      type: "persona-search-round",
      round: roundNum,
      query,
      resultsCount: resultsArr.length,
      pagesRead: pageExtracts.filter((e) => e.ok).length,
      phase: "topup",
    });
    state.buildEvents.push({
      kind: "search",
      ts: Date.now(),
      query,
      resultsCount: resultsArr.length,
      pagesRead: pageExtracts.filter((e) => e.ok).length,
      round: roundNum,
      topup: true,
    });
  }

  /* ─── Phase 2d · synthesis ───
     Concat dim blocks (in plan order) + top-up blocks; final slice is
     the safety net. Progress slice: 0.85 → 1.00. */
  const merged = concatRawSources(state);
  if (!merged.trim()) {
    return emptyKnowledge();
  }
  reportProgress(2, "structuring research findings", 0.90);
  const synthMessages = buildKnowledgeSynthesisMessages({
    description: state.description,
    profileV1,
    rawSources: merged.slice(0, RAW_SOURCES_SYNTH_CAP),
  });
  let parsed: { keyThinkers?: PersonaKnowledgeEntry[]; foundationalWorks?: PersonaKnowledgeEntry[]; recentDevelopments?: PersonaKnowledgeEntry[]; contestedClaims?: PersonaKnowledgeEntry[] } | null = null;
  for (const modelV of candidates) {
    if (state.controller.signal.aborted) return null;
    const raw = await callPhaseLLM(state, modelV, synthMessages, { temperature: 0.4, maxTokens: 3000 });
    if (!raw) continue;
    parsed = extractJson(raw);
    if (parsed) break;
  }
  return {
    keyThinkers: parsed?.keyThinkers || [],
    foundationalWorks: parsed?.foundationalWorks || [],
    recentDevelopments: parsed?.recentDevelopments || [],
    contestedClaims: parsed?.contestedClaims || [],
    searchQueries: state.searchRounds.map((r) => ({
      query: r.query,
      resultsCount: r.resultsCount,
      pagesRead: r.pagesRead,
    })),
  };
}

/* ─────────── Phase 2 helpers · multi-dimensional research ─────────── */

/** Single LLM call asking the planner to pick 4-6 angles to fan out
 *  in parallel. Returns null on parse failure across all candidate
 *  models · caller falls back to `defaultDimensionFallback`. */
async function planDimensions(
  state: PersonaJobState,
  profileV1: AgentProfile,
  candidates: string[],
): Promise<Array<{ dimension: string; query: string; why: string }> | null> {
  const messages = buildDimensionPlannerMessages({
    description: state.description,
    profileV1,
  });
  for (const modelV of candidates) {
    if (state.controller.signal.aborted) return null;
    const raw = await callPhaseLLM(state, modelV, messages, { temperature: 0.5, maxTokens: 700 });
    if (!raw) continue;
    const parsed = parseDimensionPlan(raw);
    if (parsed && parsed.length > 0) return parsed;
  }
  return null;
}

/** Static fallback dimensions · used when the LLM dimension planner
 *  fails or returns too few entries. Picks a different mix for
 *  living-figure vs historical seeds based on whether the v1 profile
 *  has populated lineage / referent fields. The queries are derived
 *  from the seed via `<dim> <seed>` so they're at least named-entity-
 *  rich and not generic. Caller is expected to clamp to 6. */
function defaultDimensionFallback(profileV1: AgentProfile): Array<{ dimension: string; query: string; why: string }> {
  const seed = (profileV1.intellectualLineage?.influencedBy || []).slice(0, 1).join(" ")
    || (profileV1.referentSet?.[0]?.ref || "")
    || "";
  // Use the first influenced-by / referent as a seed token; if none,
  // the queries below stand alone (the calling code rejects ones
  // under 3 words, but the canonical dims always satisfy that).
  const tag = seed ? ` ${seed}` : "";
  return [
    { dimension: "biography", query: `biography life${tag} formative period`, why: "ground the persona in formative biographical detail" },
    { dimension: "lineage", query: `intellectual influences predecessors${tag}`, why: "surface the schools and predecessors the persona builds on" },
    { dimension: "key_works", query: `foundational works books papers${tag}`, why: "name the canonical artifacts the persona refers to" },
    { dimension: "signature_concepts", query: `signature ideas concepts coined${tag}`, why: "capture the named moves the persona is known for" },
    { dimension: "contested_claims", query: `criticism counterarguments controversies${tag}`, why: "expose the positions that draw pushback" },
    { dimension: "recent_developments", query: `recent developments 2024 2025${tag}`, why: "capture the last 1-3 years of activity" },
  ];
}

/** Run a single dimension's search → page-fetch → block-format
 *  pipeline. Stores the capped block in `state.rawSourcesByDim` and
 *  emits a `persona-search-round` so the UI can flip the checklist
 *  entry to `done`. Failures don't throw · they emit an empty-pages
 *  block + a 0-results round so the synthesizer knows the angle was
 *  attempted. */
async function runDimensionSearch(
  state: PersonaJobState,
  entry: { dimension: string; query: string; why: string },
  creds: NonNullable<ReturnType<typeof getActiveWebSearchCredentials>>,
  roundNum: number,
): Promise<void> {
  if (state.controller.signal.aborted) return;
  const t = signalWithTimeout(state.controller.signal, REACT_FETCH_BUDGET_MS);
  let results: Awaited<ReturnType<typeof runWebSearch>> = null;
  try {
    results = await runWebSearch(creds.backend, creds.apiKey, entry.query, { count: DIMENSION_RESULTS_PER_QUERY, timeoutMs: 8000 });
  } catch { /* null path below */ }
  finally { t.cleanup(); }
  const resultsArr = results || [];

  let pageExtracts: UrlExtract[] = [];
  if (resultsArr.length > 0) {
    const urls = resultsArr.slice(0, DIMENSION_PAGES).map((r) => r.url);
    const fetchT = signalWithTimeout(state.controller.signal, REACT_FETCH_BUDGET_MS);
    try { pageExtracts = await fetchUrls(urls); }
    catch { pageExtracts = []; }
    finally { fetchT.cleanup(); }
  }

  const blockHeader = `─── DIMENSION · ${entry.dimension} (${entry.query})`;
  const blockParts: string[] = [blockHeader];
  if (resultsArr.length > 0) {
    blockParts.push(formatSearchResults(entry.query, resultsArr));
  } else {
    blockParts.push("(no search results)");
  }
  let pageCount = 0;
  for (const ext of pageExtracts) {
    if (ext.ok && ext.text) {
      blockParts.push(`─── PAGE · ${ext.title || ext.url}\nURL: ${ext.url}\n\n${ext.text}\n`);
      pageCount += 1;
    }
  }
  if (pageCount === 0 && resultsArr.length > 0) {
    blockParts.push("(no readable pages)");
  }
  const block = blockParts.join("\n\n").slice(0, RAW_SOURCES_PER_DIM_CAP);
  state.rawSourcesByDim.set(entry.dimension, block);

  state.searchRounds.push({
    query: entry.query,
    angle: entry.dimension,
    resultsCount: resultsArr.length,
    pagesRead: pageCount,
    notes: `[dimension: ${entry.dimension}]`,
    dimension: entry.dimension,
    phase: "dimension",
  });
  personaBus.emit(state.id, {
    type: "persona-search-round",
    round: roundNum,
    query: entry.query,
    resultsCount: resultsArr.length,
    pagesRead: pageCount,
    dimension: entry.dimension,
    phase: "dimension",
  });
  state.buildEvents.push({
    kind: "search",
    ts: Date.now(),
    query: entry.query,
    resultsCount: resultsArr.length,
    pagesRead: pageCount,
    dimension: entry.dimension,
    round: roundNum,
  });
}

/** Concatenate all per-dim blocks (in plan order) + top-up blocks
 *  into the synthesizer's input. Per-dim blocks are already capped;
 *  the final slice in the caller is the cross-bucket safety net. */
function concatRawSources(state: PersonaJobState): string {
  const parts: string[] = [];
  for (const entry of state.dimensionPlan) {
    const block = state.rawSourcesByDim.get(entry.dimension);
    if (block) parts.push(block);
  }
  for (const block of state.rawSourcesTopup) {
    if (block) parts.push(`─── TOP-UP\n${block}`);
  }
  return parts.join("\n\n");
}

/** Abort-aware sleep · resolves early if the controller aborts so
 *  cancel-mid-batch doesn't have to wait for the inter-chunk gap. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function emptyKnowledge(): PersonaKnowledge {
  return {
    keyThinkers: [],
    foundationalWorks: [],
    recentDevelopments: [],
    contestedClaims: [],
    searchQueries: [],
  };
}

function renderKnowledgeAsContext(k: PersonaKnowledge | undefined): string {
  if (!k) return "";
  const out: string[] = [];
  const fmt = (label: string, entries: PersonaKnowledgeEntry[]) => {
    if (entries.length === 0) return;
    out.push(`## ${label}`);
    for (const e of entries) {
      out.push(`- **${e.title}** · ${e.summary}` + (e.citations.length > 0 ? ` (sources: ${e.citations.join(", ")})` : ""));
    }
    out.push("");
  };
  fmt("Key thinkers", k.keyThinkers);
  fmt("Foundational works", k.foundationalWorks);
  fmt("Recent developments", k.recentDevelopments);
  fmt("Contested claims", k.contestedClaims);
  return out.join("\n").trim();
}

/* ─────────── Phases 4-7 ─────────── */

async function runRulesPhase(
  state: PersonaJobState,
  profileV2: AgentProfile,
  knowledgeSummary: string,
): Promise<PersonaRule[]> {
  const messages = buildRulesMessages({ description: state.description, profileV2, knowledgeSummary });
  for (const modelV of flagshipCandidates()) {
    if (state.controller.signal.aborted) return [];
    const raw = await callPhaseLLM(state, modelV, messages, { temperature: 0.5, maxTokens: 1800 });
    if (!raw) continue;
    const parsed = extractJson<{ rules?: PersonaRule[] }>(raw);
    if (parsed?.rules && Array.isArray(parsed.rules)) {
      return parsed.rules
        .filter((r) => r && (r.kind === "always" || r.kind === "never" || r.kind === "conditional") && typeof r.rule === "string")
        .slice(0, 20);
    }
  }
  return [];
}

async function runFewShotPhase(
  state: PersonaJobState,
  profileV2: AgentProfile,
  rules: PersonaRule[],
): Promise<PersonaFewShot[]> {
  const messages = buildFewShotMessages({ description: state.description, profileV2, rules });
  for (const modelV of flagshipCandidates()) {
    if (state.controller.signal.aborted) return [];
    const raw = await callPhaseLLM(state, modelV, messages, { temperature: 0.65, maxTokens: 3000 });
    if (!raw) continue;
    const parsed = extractJson<{ examples?: PersonaFewShot[] }>(raw);
    if (parsed?.examples && Array.isArray(parsed.examples)) {
      return parsed.examples.filter((e) => e && typeof e.scenario === "string" && typeof e.personaResponse === "string").slice(0, 5);
    }
  }
  return [];
}

async function runReflectionPhase(
  state: PersonaJobState,
  profileV2: AgentProfile,
  fewShotCount: number,
): Promise<string[]> {
  const messages = buildReflectionMessages({ description: state.description, profileV2, fewShotCount });
  for (const modelV of flagshipCandidates()) {
    if (state.controller.signal.aborted) return [];
    const raw = await callPhaseLLM(state, modelV, messages, { temperature: 0.5, maxTokens: 800 });
    if (!raw) continue;
    const parsed = extractJson<{ checklist?: string[] }>(raw);
    if (parsed?.checklist && Array.isArray(parsed.checklist)) {
      return parsed.checklist.filter((s) => typeof s === "string" && s.trim().length > 0).slice(0, 8);
    }
  }
  return [];
}

/** Cheap post-pipeline naming pass · uses utility-tier first, falls
 *  back to flagship if the small model fails. ~30 output tokens; the
 *  per-call timeout is plenty. Returns null on failure (caller falls
 *  back to the route-layer's seed-words heuristic). */
async function runNamePhase(
  state: PersonaJobState,
  profileV2: AgentProfile,
): Promise<string | null> {
  const messages = buildPersonaNameMessages({
    description: state.description,
    profileV2,
  });
  const utility = utilityModelFor();
  const candidates: string[] = [];
  if (utility) candidates.push(utility);
  for (const m of flagshipCandidates()) {
    if (!candidates.includes(m)) candidates.push(m);
  }
  for (const modelV of candidates) {
    if (state.controller.signal.aborted) return null;
    const raw = await callPhaseLLM(state, modelV, messages, { temperature: 0.7, maxTokens: 120 });
    if (!raw) continue;
    const parsed = parsePersonaName(raw);
    if (parsed && parsed.name) return parsed.name;
  }
  return null;
}

async function runEvalPhase(
  state: PersonaJobState,
  profileV2: AgentProfile,
): Promise<PersonaEvalEntry[]> {
  const messages = buildEvalMessages({ description: state.description, profileV2 });
  for (const modelV of flagshipCandidates()) {
    if (state.controller.signal.aborted) return [];
    const raw = await callPhaseLLM(state, modelV, messages, { temperature: 0.5, maxTokens: 1500 });
    if (!raw) continue;
    const parsed = extractJson<{ prompts?: Array<{ prompt?: string; expectedSignature?: string }> }>(raw);
    if (parsed?.prompts && Array.isArray(parsed.prompts)) {
      return parsed.prompts
        .filter((p) => p && typeof p.prompt === "string" && p.prompt.trim().length > 0)
        .slice(0, 10)
        .map((p) => ({
          prompt: p.prompt!,
          expectedSignature: typeof p.expectedSignature === "string" ? p.expectedSignature : "",
          divergenceScore: null,
        }));
    }
  }
  return [];
}

/* ─────────── Phase 7 · differentiation probes ─────────── */

async function runDifferentiationProbes(
  state: PersonaJobState,
  evalSet: PersonaEvalEntry[],
  partial: PartialBuild,
): Promise<PersonaEvalEntry[]> {
  const utility = utilityModelFor();
  if (!utility || !partial.profileV2) {
    return evalSet; // can't probe · keep null scores
  }
  const personaSystem = renderProbeSystemPrompt(partial);
  const out: PersonaEvalEntry[] = [];
  for (const entry of evalSet) {
    if (state.controller.signal.aborted) {
      out.push(entry);
      continue;
    }
    let baseline: string | null = null;
    let withPersona: string | null = null;
    try {
      baseline = await callPhaseLLM(state, utility, buildProbeMessages({ prompt: entry.prompt }), { temperature: 0.7, maxTokens: 400 });
      withPersona = await callPhaseLLM(state, utility, buildProbeMessages({ prompt: entry.prompt, personaSystem }), { temperature: 0.7, maxTokens: 400 });
    } catch {
      // Probe failures are non-fatal · per-entry score stays null.
    }
    let score: number | null = null;
    if (baseline && withPersona) {
      score = lexicalDivergence(baseline, withPersona);
    }
    out.push({ ...entry, divergenceScore: score });
  }
  return out;
}

function renderProbeSystemPrompt(partial: PartialBuild): string {
  // Compact probe system · enough persona texture to differentiate
  // from the bare baseline, but small enough that the probe call
  // stays cheap. Pulls v2 spec + first 2 few-shot examples + the
  // checklist · same trio that ships into the per-turn director
  // system prompt.
  const lines: string[] = [];
  if (partial.profileV2) {
    lines.push("You are a board director. Your persona:");
    lines.push("");
    lines.push(JSON.stringify({
      intellectualLineage: partial.profileV2.intellectualLineage,
      contrarianTakes: partial.profileV2.contrarianTakes,
      failureModes: partial.profileV2.failureModes,
    }, null, 2));
  }
  if (partial.fewShot && partial.fewShot.length > 0) {
    lines.push("", "Two examples of how you respond:");
    for (const ex of partial.fewShot.slice(0, 2)) {
      lines.push("", `Scenario: ${ex.scenario}`, `You say: ${ex.personaResponse}`);
    }
  }
  if (partial.reflectionChecklist && partial.reflectionChecklist.length > 0) {
    lines.push("", "Before answering, silently check:");
    for (const q of partial.reflectionChecklist) lines.push(`- ${q}`);
  }
  lines.push("", "Now respond in your voice.");
  return lines.join("\n");
}

/** Lexical Jaccard distance · 1 - |intersection| / |union| over
 *  word sets. Cheap, no external deps, captures coarse-grained
 *  semantic divergence. NOT a real embedding distance — the build
 *  report labels this as "lexical divergence" so the user knows what
 *  they're looking at. */
function lexicalDivergence(a: string, b: string): number {
  const tokenize = (s: string) => new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s一-鿿]/gi, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
  const A = tokenize(a);
  const B = tokenize(b);
  const intersection = new Set<string>();
  for (const t of A) if (B.has(t)) intersection.add(t);
  const union = new Set([...A, ...B]);
  if (union.size === 0) return 0;
  return 1 - intersection.size / union.size;
}

/* ─────────── Helpers · synthesis ─────────── */

function toCore(p: AgentProfile): PersonaSpecCore {
  return {
    intellectualLineage: [
      ...(p.intellectualLineage?.influencedBy || []).map((s) => `Influenced by: ${s}`),
      ...(p.intellectualLineage?.opposedTo || []).map((s) => `Opposed to: ${s}`),
    ],
    loadBearingConcepts: (p.loadBearingConcepts || []).map((c) => `${c.name}: ${c.gloss}`),
    referentSet: (p.referentSet || []).map((r) => `${r.ref} — ${r.why}`),
    failureModes: p.failureModes || [],
    contrarianTakes: p.contrarianTakes || [],
  };
}

function partialToPersona(partial: PartialBuild): PersonaSpec {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    description: "", // filled in by caller (state.description) at save time
    spec: partial.spec || {
      intellectualLineage: [],
      loadBearingConcepts: [],
      referentSet: [],
      failureModes: [],
      contrarianTakes: [],
    },
    knowledge: partial.knowledge || emptyKnowledge(),
    rules: partial.rules || [],
    fewShot: partial.fewShot || [],
    reflectionChecklist: partial.reflectionChecklist || [],
    evalSet: partial.evalSet || [],
    differentiationScore: partial.differentiationScore ?? null,
    toolAccess: partial.toolAccess || { webSearch: false },
    ...(partial.guessName ? { guessName: partial.guessName } : {}),
    ...(partial.buildLog ? { buildLog: partial.buildLog } : {}),
  };
}

/** Read a job's current state · surfaced via the SSE replay path so
 *  a fresh subscriber that arrives mid-build sees the last completed
 *  phase's output before the next event arrives. */
export function getPartialPersona(jobId: string): PersonaSpec | null {
  const job = getPersonaJob(jobId);
  if (!job || !job.partial) return null;
  // The partial column carries either a full or partial PersonaSpec.
  // We trust the in-memory pipeline writes the full shape and degrade
  // to null gracefully on parse failure.
  const v = job.partial as Partial<PersonaSpec>;
  if (!v.spec) return null;
  return {
    version: 1,
    generatedAt: typeof v.generatedAt === "string" ? v.generatedAt : new Date(job.startedAt).toISOString(),
    description: typeof v.description === "string" ? v.description : job.description,
    spec: v.spec,
    knowledge: v.knowledge || emptyKnowledge(),
    rules: v.rules || [],
    fewShot: v.fewShot || [],
    reflectionChecklist: v.reflectionChecklist || [],
    evalSet: v.evalSet || [],
    differentiationScore: typeof v.differentiationScore === "number" ? v.differentiationScore : null,
    toolAccess: v.toolAccess || { webSearch: false },
    ...(typeof v.guessName === "string" && v.guessName ? { guessName: v.guessName } : {}),
    ...(v.buildLog ? { buildLog: v.buildLog } : {}),
  };
}
