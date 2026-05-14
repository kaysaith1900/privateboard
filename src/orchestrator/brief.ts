/**
 * Brief generation pipeline · 3-stage system-skill flow.
 *
 *   Stage 1 · per-director extract  · parallel haiku calls
 *   Stage 2 · chair cluster/scaffold · single sonnet call
 *   Stage 3 · chair final write     · streaming opus → sonnet fallback
 *
 * Triggered when a room is adjourned (or post-hoc via /brief). Streams
 * stage-3 tokens to the room SSE bus and writes the final markdown to
 * ~/.boardroom/briefs/{briefId}.md so users have a portable export.
 *
 * Emits SSE events on the room bus:
 *   brief-started · once, when stage 1 begins
 *   brief-token   · each delta during stage 3
 *   brief-final   · once, with { briefId, title }
 *   brief-error   · on unrecoverable failure
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { callLLMStream, type LLMMessage } from "../ai/adapter.js";
import { effectiveDefaultModel, utilityModelFor } from "../ai/availability.js";
import {
  assetsToSignals,
  buildMagazineMessages,
  buildNewspaperMessages,
  buildPptMessages,
  buildExtractMessages,
  buildScaffoldMessages,
  buildWriteMessages,
  countAssets,
  parseBento,
  parseDirectorAssets,
  parseScaffold,
  type BriefScaffold,
  type DirectorAssets,
  type DirectorSignals,
} from "../ai/prompts/brief-stages.js";
import {
  buildComposerMessages,
  defaultComposition,
  parseComposerOutput,
  type ComposerResult,
} from "../ai/prompts/composer.js";
import {
  extractBriefTitle,
  type BriefStyle,
} from "../ai/prompts/brief.js";
import { isModelV, type ModelV } from "../ai/registry.js";
import { getAgent, getChairAgent, incrementAgentTokens, type Agent } from "../storage/agents.js";
import { listMessages } from "../storage/messages.js";
import { getRoom, listRoomMembers } from "../storage/rooms.js";
import { insertBrief, setBriefTitle, updateBriefAssets, updateBriefBody, updateBriefBodyJson, updateBriefCompose, type BriefMode } from "../storage/briefs.js";
import { ensureBoardroomDir } from "../utils/paths.js";
import { estimateTokens } from "../utils/tokens.js";

import { roomBus } from "./stream.js";

/** Detect the user's question language from the room subject. CJK
 *  Unified Ideographs ⇒ Chinese ("zh"); else "en". Cheap heuristic — the
 *  user's product is currently bilingual zh / en, so this is sufficient
 *  to align report content language with how the question was asked. */
function detectLanguage(text: string): "zh" | "en" {
  return /[一-鿿]/.test(text || "") ? "zh" : "en";
}

/** Bill an LLM call's tokens to the chair. No-op if usage is null
 *  (provider didn't surface it) or chair is missing. */
function billChair(chairId: string | null, usage: { totalTokens: number } | null): void {
  if (!chairId || !usage || !usage.totalTokens) return;
  incrementAgentTokens(chairId, usage.totalTokens);
}

/** Models per stage · resolved against the user's currently-configured
 *  keys. Each pipeline stage tries the carrier-appropriate "cheap" or
 *  "flagship" model first, then falls back through the rest of the
 *  list. The lists were previously hardcoded to Anthropic IDs, which
 *  meant a user with only an OpenAI key got "no reachable model" on
 *  every stage. Resolved lazily (per call) so a key change mid-session
 *  is honoured.
 *
 *  Tier mapping:
 *    cheap (extraction / composition) · `utilityModelFor()` →
 *      haiku-4-5 (OR), sonnet-4-6 (Anthropic-direct), gpt-5-4-mini
 *      (OpenAI), gemini-3-1-flash (Google), grok-4-mini (xAI), …
 *    flagship (scaffolding / write-out) · `effectiveDefaultModel()` →
 *      opus-4-7 (OR), sonnet-4-6 (Anthropic), gpt-5-5 (OpenAI),
 *      gemini-3-1 (Google), grok-4 (xAI). */
function stageCheapList(): ModelV[] {
  // Cheap-first, with flagship as a safety net. Dedup so a single-
  // carrier user (where utility == flagship in degenerate cases)
  // doesn't waste a retry on the same model twice.
  const out: ModelV[] = [];
  const cheap = utilityModelFor();
  if (cheap) out.push(cheap);
  const flagship = effectiveDefaultModel();
  if (flagship && !out.includes(flagship)) out.push(flagship);
  return out;
}

function stageFlagshipList(): ModelV[] {
  // Flagship-first, with cheap as a safety net (Stage 2 scaffolding /
  // Stage 3 write-out can run on the cheap tier in a pinch — quality
  // dips but the pipeline still completes).
  const out: ModelV[] = [];
  const flagship = effectiveDefaultModel();
  if (flagship) out.push(flagship);
  const cheap = utilityModelFor();
  if (cheap && !out.includes(cheap)) out.push(cheap);
  return out;
}

/** Stage 2 retry budget. Two attempts per model at rising temperature ·
 *  the 35K-char system prompt + a wide scaffold JSON output puts opus /
 *  sonnet near their per-call latency budget; a single attempt was
 *  reliably falling back to the deterministic skeleton when the model
 *  hit the timeout mid-stream. Two attempts at 0.2 → 0.5 give the
 *  scaffold a real second swing without holding the pipeline hostage
 *  (timeout cap below already bounds total wait per model). */
const STAGE_2_RETRIES = 2;
const STAGE_2_TEMPERATURES = [0.2, 0.5];

const STAGE_1_CALL_TIMEOUT_MS = 75_000;
/** Bumped from 120s · opus-fast on a 35K-char system prompt + ~5K-char
 *  user message + 8K-token JSON output reliably ran past 120s and got
 *  killed mid-stream, dropping the whole brief to fallback. Match the
 *  Stage 3 budget (240s) so opus has a real chance to finish. */
const STAGE_2_CALL_TIMEOUT_MS = 240_000;
const STAGE_3_CALL_TIMEOUT_MS = 240_000;

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

interface GenerateOpts {
  roomId: string;
  /** Retained for backwards compat with callers that still pass a style.
   *  v1 has one standard layout — the value is recorded but ignored. */
  style?: BriefStyle;
  /** Optional supplementary perspective the user asked the chair to
   *  weave into the regenerated report. Only stages 2 + 3 see it —
   *  stage 1's per-director extraction stays independent. */
  supplement?: string;
  /** Output mode · 'research-note' (default · markdown report) or
   *  'bento' (single-page infographic with structured BentoScaffold
   *  JSON in body_json). The pipeline branches at Stage 2 based on
   *  this; Stage 1 (per-director extract) is shared. */
  mode?: BriefMode;
}

/** In-flight pipeline state, keyed by briefId. Lives for the duration
 *  of runPipeline (added before the pipeline kicks off, deleted in
 *  the finally block whether it succeeded, errored, or threw).
 *
 *  We store the full per-stage progress in here — not just the
 *  briefId — so a fresh browser session that lands mid-generation
 *  can rehydrate the loading UI (which stage is active right now,
 *  when did each stage start, what ETA window applies) instead of
 *  watching a frozen blank page until the pipeline finishes. The
 *  state is broadcast via the existing SSE events; this map just
 *  preserves the most recent snapshot so /api/briefs/:id/status can
 *  hand it back on demand. */
interface BriefStageSnapshot {
  status: StageStatus;
  startedAt: number;
  finishedAt: number | null;
  detail: string;
  progress: StageProgress | null;
  etaSec: StageEta | null;
}
interface BriefGenerationState {
  briefId: string;
  roomId: string;
  style: BriefStyle;
  chairName: string;
  language: "zh" | "en";
  pipelineStartedAt: number;
  /** Per-stage progress · seeded as undefined entries until the
   *  stage first transitions to active. The frontend treats absent
   *  keys as "still pending". */
  stages: Partial<Record<StageKey, BriefStageSnapshot>>;
  llmLogs: BriefLlmLog[];
  /** AbortController for in-flight cancellation. The pipeline plumbs
   *  `controller.signal` into every `callLLMStream` / `callLLMWithUsage`
   *  call so the underlying fetch dies the moment the user deletes
   *  the in-progress brief. Cooperative — stages still need to check
   *  `signal.aborted` between LLM calls to short-circuit cleanly. */
  controller: AbortController;
}
const inFlightBriefs = new Map<string, BriefGenerationState>();

interface BriefLlmLog {
  id: string;
  stage: StageKey;
  label: string;
  modelV: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  text: string;
  totalTokens: number | null;
  error: string | null;
}

const BRIEF_LLM_LOG_TEXT_LIMIT = 6000;

class BriefLlmTextError extends Error {
  partialText: string;

  constructor(message: string, partialText: string) {
    super(message);
    this.name = "BriefLlmTextError";
    this.partialText = partialText;
  }
}

function emitBriefLlmStart(
  roomId: string,
  briefId: string,
  log: BriefLlmLog,
): void {
  const state = inFlightBriefs.get(briefId);
  if (state) state.llmLogs.push(log);
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "brief-llm-start",
    payload: { briefId, log },
    createdAt: Date.now(),
  });
}

function emitBriefLlmToken(
  roomId: string,
  briefId: string,
  logId: string,
  delta: string,
): void {
  const state = inFlightBriefs.get(briefId);
  if (state) {
    const log = state.llmLogs.find((l) => l.id === logId);
    if (log && log.text.length < BRIEF_LLM_LOG_TEXT_LIMIT) {
      log.text = (log.text + delta).slice(0, BRIEF_LLM_LOG_TEXT_LIMIT);
    }
  }
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "brief-llm-token",
    payload: { briefId, logId, delta },
    createdAt: Date.now(),
  });
}

function emitBriefLlmEnd(
  roomId: string,
  briefId: string,
  logId: string,
  patch: Partial<Pick<BriefLlmLog, "status" | "totalTokens" | "error">>,
): void {
  const finishedAt = Date.now();
  const state = inFlightBriefs.get(briefId);
  let log: BriefLlmLog | null = null;
  if (state) {
    log = state.llmLogs.find((l) => l.id === logId) ?? null;
    if (log) {
      log.finishedAt = finishedAt;
      if (patch.status) log.status = patch.status;
      if (typeof patch.totalTokens === "number") log.totalTokens = patch.totalTokens;
      if (typeof patch.error === "string") log.error = patch.error;
    }
  }
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "brief-llm-end",
    payload: { briefId, logId, finishedAt, ...patch },
    createdAt: finishedAt,
  });
}

async function callBriefLLMText(args: {
  roomId: string;
  briefId: string;
  stage: StageKey;
  label: string;
  modelV: ModelV;
  messages: LLMMessage[];
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
  onText?: (delta: string, full: string) => void;
}): Promise<{ text: string; usage: { totalTokens: number } | null }> {
  const logId = `${args.stage}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  emitBriefLlmStart(args.roomId, args.briefId, {
    id: logId,
    stage: args.stage,
    label: args.label,
    modelV: args.modelV,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    text: "",
    totalTokens: null,
    error: null,
  });
  let text = "";
  let usage: { totalTokens: number } | null = null;
  try {
    for await (const chunk of callLLMStream({
      modelV: args.modelV,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
      signal: args.signal,
    })) {
      if (chunk.type === "text") {
        text += chunk.delta;
        emitBriefLlmToken(args.roomId, args.briefId, logId, chunk.delta);
        args.onText?.(chunk.delta, text);
      } else if (chunk.type === "usage") {
        usage = { totalTokens: chunk.totalTokens };
      } else if (chunk.type === "error") {
        throw new Error(chunk.message);
      }
    }
    emitBriefLlmEnd(args.roomId, args.briefId, logId, {
      status: "done",
      totalTokens: usage?.totalTokens ?? null,
    });
    return { text, usage };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emitBriefLlmEnd(args.roomId, args.briefId, logId, {
      status: "failed",
      error: message,
    });
    throw new BriefLlmTextError(message, text);
  }
}

export function isBriefGenerating(briefId: string): boolean {
  return inFlightBriefs.has(briefId);
}

/** Look up the in-flight brief id for a given room, if any. Used by
 *  the POST /api/rooms/:id/brief route as an idempotency check — if a
 *  generation is already running, the route returns the existing
 *  brief id instead of spawning a parallel pipeline. Without this,
 *  double-clicks across surfaces (header CTA + chat CTA + adjourn
 *  overlay) produce duplicate brief rows and the user sees two
 *  "generating…" tabs. The map is small (one entry per active
 *  pipeline), so a linear scan is cheap. */
export function inFlightBriefForRoom(roomId: string): string | null {
  for (const state of inFlightBriefs.values()) {
    if (state.roomId === roomId) return state.briefId;
  }
  return null;
}

/** Return the full pipeline snapshot for a brief currently being
 *  generated, or `null` if it isn't in flight. Used by
 *  `/api/briefs/:id/status` to let a freshly-loaded client rehydrate
 *  the loading UI mid-pipeline. */
export function getBriefGenerationState(briefId: string): BriefGenerationState | null {
  return inFlightBriefs.get(briefId) ?? null;
}

/** Abort an in-flight brief generation. Called by the DELETE route
 *  when the user explicitly deletes a brief that's still streaming.
 *  The controller's `abort()` propagates into every plumbed
 *  `callLLMStream` / `callLLMWithUsage` request — the upstream HTTP
 *  fetches die immediately, the streaming for-await loops see the
 *  abort exception and unwind, and the pipeline's `finally` block
 *  clears the in-flight map entry. Subsequent `updateBriefBody` calls
 *  on a deleted brief row are silent no-ops at the SQLite level. */
export function abortBriefGeneration(briefId: string): boolean {
  const state = inFlightBriefs.get(briefId);
  if (!state) return false;
  try {
    state.controller.abort();
  } catch { /* idempotent · already-aborted controllers throw on re-abort in some node versions */ }
  return true;
}

export async function generateBrief(opts: GenerateOpts): Promise<{ briefId: string }> {
  const { roomId } = opts;
  const style: BriefStyle = opts.style ?? "mckinsey";
  const mode: BriefMode = opts.mode === "magazine" || opts.mode === "newspaper" || opts.mode === "ppt"
    ? opts.mode
    : "research-note";

  const room = getRoom(roomId);
  if (!room) throw new Error(`room not found: ${roomId}`);

  const memberRows = listRoomMembers(roomId);
  const members: Agent[] = memberRows
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null);
  const transcript = listMessages(roomId).filter((m) => m.authorKind !== "system");

  const placeholder = insertBrief({
    roomId,
    style,
    title: room.subject,
    bodyMd: "",
    supplement: opts.supplement,
    mode,
  });

  // Capture the chair + room language up front so the rehydration
  // endpoint can hand them to a refreshed browser session even
  // before the first SSE event fires.
  const chairForState = getChairAgent();
  const inferredLang: "zh" | "en" = /[一-鿿]/.test(room.subject || "") ? "zh" : "en";
  // Per-brief AbortController · plumbed into every LLM call inside
  // the pipeline so a user-initiated DELETE (via `abortBriefGeneration`)
  // immediately kills the upstream fetches. Without this, deletion
  // mid-generation would leave the LLM calls running to completion
  // (burning tokens) even though the row is gone.
  const controller = new AbortController();
  inFlightBriefs.set(placeholder.id, {
    briefId: placeholder.id,
    roomId,
    style,
    chairName: chairForState?.name || "Chair",
    language: inferredLang,
    pipelineStartedAt: Date.now(),
    stages: {},
    llmLogs: [],
    controller,
  });
  void runPipeline({
    briefId: placeholder.id,
    roomId,
    style,
    mode,
    members,
    transcript,
    room,
    supplement: opts.supplement,
    signal: controller.signal,
  }).finally(() => {
    inFlightBriefs.delete(placeholder.id);
  });

  return { briefId: placeholder.id };
}

interface PipelineArgs {
  briefId: string;
  roomId: string;
  style: BriefStyle;
  /** Output mode · 'research-note' (default · markdown report through
   *  composer + scaffold + write) or 'bento' (single chair-LLM call
   *  that produces BentoScaffold JSON for client-side templating). */
  mode: BriefMode;
  members: Agent[];
  transcript: ReturnType<typeof listMessages>;
  room: NonNullable<ReturnType<typeof getRoom>>;
  supplement?: string;
  /** AbortController.signal · plumbed into every LLM call so a
   *  `abortBriefGeneration(briefId)` call kills upstream fetches
   *  immediately. The pipeline checks `signal.aborted` between
   *  stages to short-circuit cleanly when the user deletes mid-run. */
  signal?: AbortSignal;
}

/** Stage labels that ship to the UI checklist. Frontend matches on
 *  `stage` and renders the canonical label.
 *
 *  Sub-stage taxonomy:
 *  · `extract`  · per-director signal extract (parallel haiku)
 *  · `compose`  · spine + component selection (cheap call)
 *  · `scaffold-anchor`   · bottomLine + thesis · "what's the takeaway"
 *  · `scaffold-findings` · headlineFindings   · "what supports it"
 *  · `scaffold-cluster`  · convergence/divergence/positions · "consensus + dissent"
 *  · `scaffold-actions`  · recommendations + newQuestions + planningAssumption
 *  · `write`    · final report streaming (opus)
 *
 *  The 4 scaffold sub-stages replace the older single `scaffold` event.
 *  They're driven by JSON-key arrival in the streaming buffer (see
 *  runStage2), so each transition reflects a real moment in the model's
 *  output, not a faked timer. Older clients that don't recognize the
 *  new keys silently skip those rows. */
type StageKey =
  | "extract"
  | "compose"
  | "scaffold-anchor"
  | "scaffold-findings"
  | "scaffold-cluster"
  | "scaffold-actions"
  | "write";
type StageStatus = "active" | "done";

interface StageProgress {
  current: number;
  total: number;
}

interface StageEta {
  /** Lower bound seconds — happy-path completion. */
  lo: number;
  /** Upper bound seconds — slow-but-still-typical case. Beyond this the
   *  UI drops the ETA and shows just elapsed. */
  hi: number;
}

function emitStage(
  roomId: string,
  briefId: string,
  stage: StageKey,
  status: StageStatus,
  detail?: string,
  progress?: StageProgress,
  etaSec?: StageEta,
): void {
  // Mirror the event into the in-flight state so a refreshed client
  // can rehydrate the loading UI on page load. We capture startedAt
  // on the first transition to active and finishedAt when it flips
  // to done — same shape the frontend already builds from SSE.
  const state = inFlightBriefs.get(briefId);
  if (state) {
    const now = Date.now();
    const prev = state.stages[stage];
    if (status === "active") {
      state.stages[stage] = {
        status: "active",
        startedAt: prev && prev.status === "active" ? prev.startedAt : now,
        finishedAt: null,
        detail: detail ?? "",
        progress: progress ?? null,
        etaSec: etaSec ?? prev?.etaSec ?? null,
      };
    } else if (status === "done") {
      state.stages[stage] = {
        status: "done",
        startedAt: prev?.startedAt ?? now,
        finishedAt: now,
        detail: detail ?? prev?.detail ?? "",
        progress: progress ?? prev?.progress ?? null,
        etaSec: etaSec ?? prev?.etaSec ?? null,
      };
    }
  }
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "brief-stage",
    payload: { briefId, stage, status, detail, progress, etaSec },
    createdAt: Date.now(),
  });
}

/* ─────────────────────── ETA · token-based estimator ─────────────────────
 *
 * Wall-clock time for an LLM call decomposes into:
 *
 *   total ≈ base_overhead          (network, queue, cold start)
 *         + ttft_per_kt * input_kt (time-to-first-token scales with input)
 *         + output_tokens / tps    (streaming throughput)
 *
 * Calibration notes (after observing a stage-2 run that took ~200s vs an
 * earlier ETA of 24-50s):
 *
 *   · Sonnet generating STRUCTURED JSON runs at roughly half the speed
 *     of free-prose generation (constrained-decoding overhead). The
 *     useful tps for our scaffold output is ~40, not 100.
 *   · Opus is similarly slowed when producing rich markdown with tables
 *     and kami-chart blocks. Real-world ~25-30 tps.
 *   · Output token volumes grow super-linearly with section count once
 *     recommendations / risk-register / new questions all kick in.
 *   · Stage 2 retries up to 3× on parse failure — half of slow runs
 *     have at least one retry, so the upper bound carries a × 1.8
 *     factor to absorb that without lying to the user.
 *
 * To compensate for environment variance (provider routing, region,
 * OpenRouter vs direct), stage 2 and 3 ETAs are also scaled by an
 * observed calibration factor measured from stage 1's actual time vs
 * predicted. See `runPipeline` for the in-flight calibration. */
const TPS_BY_MODEL: Record<string, number> = {
  // All three numbers are tuned for STRUCTURED OUTPUT (JSON / markdown
  // with tables / fenced blocks), which is what every brief stage
  // actually produces. Constrained decoding runs ~30% slower than
  // free-prose generation in practice; numbers below already account
  // for that, so callers don't need to discount.
  haiku:   90,  // haiku-4-5 emitting 9-field asset bundle JSON. Was
                // 130, lowered after observing Stage 1 wall-clock ≈ 2×
                // the prediction on dense rooms (5+ directors with
                // long contributions). The 130 figure assumed the old
                // 2-4 flat-signal output; the asset bundle is 4-5× the
                // tokens.
  sonnet:  45,  // sonnet-4-6 — structured JSON output, not free prose
  opus:    28,  // opus-4-7 — rich markdown with tables / inline-svg charts
};
const BASE_OVERHEAD_S = 1.0;
const TTFT_S_PER_KT = 0.35;

function llmTimeSec(inputTokens: number, outputTokens: number, modelKey: keyof typeof TPS_BY_MODEL): number {
  const tps = TPS_BY_MODEL[modelKey];
  return BASE_OVERHEAD_S + TTFT_S_PER_KT * (inputTokens / 1000) + outputTokens / tps;
}

function asEta(seconds: number, loFactor = 0.75, hiFactor = 1.5): StageEta {
  return {
    lo: Math.max(2, Math.round(seconds * loFactor)),
    hi: Math.max(4, Math.round(seconds * hiFactor)),
  };
}

/** Pre-computed system-prompt token estimates. The actual text lives
 *  in brief-stages.ts; recomputing per call is cheap (~3000-char
 *  string) but caching keeps the hot path tidy. */
const SYS_TOKENS = {
  // Filled in lazily on first call so we don't import the prompt
  // strings here just for measurement.
  extract:  0,
  scaffold: 0,
  write:    0,
};

function ensureSysTokens(): void {
  if (SYS_TOKENS.scaffold > 0) return;
  // Defer the import to avoid an import cycle and keep startup cheap.
  // We approximate from typical sizes seen in measurement (chars × 0.27
  // for a mostly-English prompt with some structure punctuation).
  //
  // EXTRACT_SYSTEM grew significantly when it was rewritten to emit a
  // 9-field asset bundle (claims / evidence / tensions / assumptions /
  // risks / opportunities / actions / quotes / openQuestions) with
  // per-field examples + lens taxonomy + JSON example + constraints.
  // Was 450, bumped to 800 after observing Stage 1 wall-clock ≈ 2× the
  // prediction. Sources: brief-stages.ts EXTRACT_SYSTEM, ~3000 chars.
  // SCAFFOLD_SYSTEM ~9k chars, WRITE_SYSTEM ~7.7k chars (unchanged).
  SYS_TOKENS.extract  = 800;
  SYS_TOKENS.scaffold = 2300;
  SYS_TOKENS.write    = 1950;
}

interface Stage1EtaArgs {
  directors: Agent[];
  transcript: ReturnType<typeof listMessages>;
}
function estimateStage1Eta(args: Stage1EtaArgs): StageEta {
  ensureSysTokens();
  // Stage 1 runs in parallel; wall-clock ≈ slowest single call, plus a
  // small concurrency-overhead bump for ≥ 4 directors.
  let slowest = 0;
  for (const d of args.directors) {
    const own = args.transcript.filter(
      (m) => m.authorKind === "agent" && m.authorId === d.id,
    );
    if (!own.length) continue;
    const ownText = own.map((m) => m.body || "").join("\n\n");
    const inputTokens = SYS_TOKENS.extract + estimateTokens(ownText) + 80;
    // Output budget: the asset bundle has up to 30+ entries across 9
    // fields, capped server-side at maxTokens 1600. Average output
    // lands around 900-1100 tokens for a director with material to
    // surface; we use 1000 as the central estimate. Was 400 — that
    // assumed the legacy 2-4 flat-signal shape, which was retired.
    const outputTokens = 1000;
    const t = llmTimeSec(inputTokens, outputTokens, "haiku");
    if (t > slowest) slowest = t;
  }
  if (slowest === 0) return { lo: 2, hi: 5 }; // no speakers
  // Concurrency overhead grows with the parallel-call count. The 4+
  // bump was 1.15× — observed wall-clock on rooms with 5-7 directors
  // suggests provider rate limits + queueing add closer to 1.3-1.4×,
  // so the floor is now wider. Solo or 2-3 director rooms keep the
  // unscaled estimate.
  const speakers = args.directors.filter((d) =>
    args.transcript.some((m) => m.authorKind === "agent" && m.authorId === d.id),
  ).length;
  if (speakers >= 6) slowest *= 1.4;
  else if (speakers >= 4) slowest *= 1.2;
  return asEta(slowest);
}

interface Stage2EtaArgs {
  perDirectorSignals: DirectorSignals[];
  members: Agent[];
}
function estimateStage2Eta(args: Stage2EtaArgs): StageEta {
  ensureSysTokens();
  // Input: SCAFFOLD_SYSTEM + signals block + memberlist + room context.
  let signalChars = 0;
  let signalCount = 0;
  for (const d of args.perDirectorSignals) {
    for (const s of d.signals) {
      signalChars += (s.text || "").length;
      signalCount++;
    }
  }
  const inputTokens =
    SYS_TOKENS.scaffold +
    Math.ceil(signalChars * 0.4) /* signals · mixed-language average */ +
    signalCount * 30 /* lens tag + indices per signal */ +
    args.members.length * 50 /* memberlist */ +
    300; /* room ctx + framing + JSON example noise */
  // Output is the load-bearing piece. A 12-section scaffold for a
  // substantive room produces 5000-7000 tokens of structured JSON:
  //   3 headline findings × ~300 = 900
  //   5 recommendations × ~150  = 750
  //   3 positions × ~120        = 360
  //   2 convergence × ~150      = 300
  //   1 divergence (4 rows)     = 250
  //   5 risk-register × ~120    = 600
  //   3 new questions × ~80     = 240
  //   1 planning assumption     = 120
  //   bottom line + frame shift = 160
  //   visuals (~1.5 × 200)      = 300
  //   3 open questions × ~50    = 150
  //   misc framing / boilerplate ≈ 800
  //   ──── total ≈ 4600, plus signal-driven content
  const outputTokens = Math.max(3500, signalCount * 220 + 2500);
  const t = llmTimeSec(inputTokens, outputTokens, "sonnet");
  // Upper bound × 1.8 accounts for stage 2's retry-on-parse-failure
  // behaviour — when a retry fires, total wall time roughly doubles.
  return asEta(t, 0.65, 1.8);
}

interface Stage3EtaArgs {
  scaffold: BriefScaffold;
  perDirectorSignals: DirectorSignals[];
  members: Agent[];
}
function estimateStage3Eta(args: Stage3EtaArgs): StageEta {
  ensureSysTokens();
  // Input: WRITE_SYSTEM + scaffold dump + signals refs.
  // Scaffold dump size scales with section content. Estimate by
  // serialising it back to JSON and counting.
  const scaffoldText = JSON.stringify(args.scaffold);
  // Signals dump: ~80 tokens per signal in the rendered "[lens] director: text" form.
  let signalsTokens = 0;
  for (const d of args.perDirectorSignals) signalsTokens += d.signals.length * 80;
  const inputTokens =
    SYS_TOKENS.write +
    estimateTokens(scaffoldText) +
    signalsTokens +
    args.members.length * 50 +
    250;
  // Output: 12 sections; size roughly correlates with scaffold richness.
  const sectionsPresent =
    1 /* bottom line */ +
    1 /* frame shift */ +
    args.scaffold.headlineFindings.length +
    (args.scaffold.convergence.length ? 1 : 0) +
    (args.scaffold.divergence ? 1 : 0) +
    (args.scaffold.positions.length ? 1 : 0) +
    (args.scaffold.visuals.length ? 1 : 0) +
    (args.scaffold.recommendations.length ? 1 : 0) +
    (args.scaffold.newQuestions.length ? 1 : 0) +
    (args.scaffold.planningAssumption ? 1 : 0) +
    (args.scaffold.openQuestions.length ? 1 : 0) +
    1 /* closing · always rendered */;
  const outputTokens = Math.max(3500, sectionsPresent * 350 + 1500);
  // Opus is the primary writer (slower but stronger); fallback to sonnet.
  const t = llmTimeSec(inputTokens, outputTokens, "opus");
  return asEta(t, 0.7, 1.5);
}

async function runPipeline(args: PipelineArgs): Promise<void> {
  const { briefId, roomId, style, members, transcript, room, supplement } = args;

  const directors = members.filter((m) => m.roleKind === "director");
  const chair = members.find((m) => m.roleKind === "moderator") ?? null;
  const chairId = chair?.id ?? null;
  const chairName = chair?.name ?? "Chair";
  const language = detectLanguage(room.subject);

  // Surface "started" immediately so the UI can render the placeholder
  // card. Includes chairName + language so the UI can show "{Chair} is
  // preparing the minutes…" in the right language. The model used in
  // stage 3 is reported in brief-final. `mode` is critical for the
  // pip-rail: the bento pipeline only emits 2 stage events (extract +
  // write), while research-note emits 7 (extract → compose → 4 ×
  // scaffold-* → write). Without `mode` on the brief object the
  // client picks the 7-stage rail by default and bento jobs render
  // with 5 forever-pending pips between extract and write.
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "brief-started",
    payload: { briefId, style, chairName, language, mode: args.mode },
    createdAt: Date.now(),
  });

  let buf = "";
  let stage3Model: ModelV | null = null;
  let pipelineError: string | null = null;
  let scaffold: BriefScaffold | null = null;
  const provenance: PipelineProvenance = {
    composerModel: null,
    scaffoldModel: null,
    scaffoldRetries: 0,
  };

  try {
    // ── Stage 1 · per-director extract (parallel) ────────────────────────
    const totalDirectors = directors.filter(
      (d) =>
        transcript.some((m) => m.authorKind === "agent" && m.authorId === d.id),
    ).length;
    const stage1Eta = estimateStage1Eta({ directors, transcript });
    const stage1StartedAt = Date.now();
    emitStage(
      roomId,
      briefId,
      "extract",
      "active",
      `${totalDirectors} director${totalDirectors === 1 ? "" : "s"}`,
      { current: 0, total: totalDirectors },
      stage1Eta,
    );
    const perDirectorAssets = await runStage1(
      roomId,
      briefId,
      directors,
      transcript,
      room,
      language,
      chairId,
      (current, harvest) => {
        emitStage(
          roomId,
          briefId,
          "extract",
          "active",
          `${current}/${totalDirectors} director${totalDirectors === 1 ? "" : "s"}`,
          { current, total: totalDirectors },
          stage1Eta,
        );
        // Per-director harvest event · the loading UI uses these to
        // turn the placeholder "name only" chips into real "name · 7
        // signals · top: risk" chips with a hover breakdown. Skipped
        // when the director failed every model (harvest === null) —
        // the director just doesn't get a chip.
        if (harvest) {
          const byKind = {
            claims: harvest.claims.length,
            evidence: harvest.evidence.length,
            tensions: harvest.tensions.length,
            assumptions: harvest.assumptions.length,
            risks: harvest.risks.length,
            opportunities: harvest.opportunities.length,
            actions: harvest.actions.length,
            quotes: harvest.quotes.length,
            openQuestions: harvest.openQuestions.length,
          };
          let total = 0;
          let topKind: keyof typeof byKind | null = null;
          let topCount = 0;
          for (const [k, n] of Object.entries(byKind) as [keyof typeof byKind, number][]) {
            total += n;
            if (n > topCount) {
              topCount = n;
              topKind = k;
            }
          }
          roomBus.emit(roomId, {
            type: "config-event",
            kind: "brief-extract-harvest",
            payload: {
              briefId,
              directorId: harvest.directorId,
              directorName: harvest.directorName,
              total,
              byKind,
              topKind,
            },
            createdAt: Date.now(),
          });
        }
      },
      args.signal,
    );

    // Short-circuit if the user deleted the brief while Stage 1 ran.
    // The pipeline's `finally` block will clear the in-flight map
    // entry; we just skip the remaining work to avoid wasting tokens
    // on stages whose output will never be used.
    if (args.signal?.aborted) return;
    emitStage(roomId, briefId, "extract", "done");

    // Boundary adapter · Stage 2 / Stage 3 still consume the legacy
    // flat `DirectorSignals` shape (asset-kind tags encoded in text
    // prefixes). Composer below sees the rich asset bundle directly.
    const perDirectorSignals: DirectorSignals[] = perDirectorAssets.map(assetsToSignals);

    // Persist Stage-1 assets on the brief row so future follow-up
    // rooms can re-use them as named-by-lens prior context.
    try {
      updateBriefAssets(briefId, perDirectorAssets);
    } catch (e) {
      // Non-fatal · the brief is still valid without persisted assets.
      // Follow-ups that hit this brief later will fall back to brief
      // markdown alone.
      process.stderr.write(
        `[brief.stage1] persist assets failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }

    // ── Structured modes · magazine / newspaper / ppt ───────────────
    // All structured modes skip composer + Stage 2 scaffold + Stage 3
    // write. They share the BentoScaffold JSON shape (kept under
    // that name for historical reasons — it's the structured output
    // schema) and run through the SAME chair-LLM single-pass stage ·
    // only the prompt and the client-side renderer differ. The data
    // lands in body_json; magazine.html / newspaper.html / ppt.html
    // template the same fields into different layouts.
    if (args.mode === "magazine" || args.mode === "newspaper" || args.mode === "ppt") {
      const ok = await runBentoStage({
        roomId,
        briefId,
        chair,
        chairId,
        room,
        members,
        perDirectorSignals,
        language,
        supplement,
        mode: args.mode,
        signal: args.signal,
      });
      if (!ok) {
        const label = args.mode === "magazine" ? "Magazine"
          : args.mode === "ppt" ? "Slide deck"
          : "Newspaper";
        pipelineError =
          `${label} writer couldn't structure this room (3 retries failed). Try regenerating, or shorten the conversation.`;
      }
      return;
    }

    // In-flight calibration · compare stage 1's measured time to its
    // predicted mid-band. If the user's environment is slower (network,
    // OpenRouter routing, regional latency), stages 2 and 3 will be
    // similarly slower — multiply their ETAs by the same factor so the
    // displayed range matches reality. Clamped to [0.5, 3.0] to absorb
    // measurement noise without runaway scaling.
    const stage1ActualSec = (Date.now() - stage1StartedAt) / 1000;
    const stage1PredictedMid = (stage1Eta.lo + stage1Eta.hi) / 2;
    let calibration = stage1PredictedMid > 0.5 ? stage1ActualSec / stage1PredictedMid : 1;
    calibration = Math.max(0.5, Math.min(3, calibration));

    // ── Stage 1.5 · composer (cheap pick of spine + components) ──────────
    // Composer reads the rich `DirectorAssets` bundle directly (claims /
    // evidence / tensions / risks / etc.) so it can pick components based
    // on what KIND of material the room produced, not on a flattened
    // signal count.
    emitStage(roomId, briefId, "compose", "active", undefined, undefined, { lo: 1, hi: 4 });
    const composition = await runComposer({
      roomId,
      briefId,
      chairId,
      room,
      members,
      perDirectorAssets,
      language,
      supplement,
      signal: args.signal,
      provenance,
    });
    if (args.signal?.aborted) return;
    updateBriefCompose(briefId, {
      spine: composition.spine,
      components: composition.components,
      composerRationale: composition.rationale || null,
      subjectType: composition.subjectType,
      houseStyle: composition.houseStyle,
    });
    roomBus.emit(roomId, {
      type: "config-event",
      kind: "brief-compose",
      payload: {
        briefId,
        spine: composition.spine,
        components: composition.components,
        rationale: composition.rationale,
        subjectType: composition.subjectType,
        houseStyle: composition.houseStyle,
        fromComposer: composition.fromComposer,
      },
      createdAt: Date.now(),
    });
    emitStage(roomId, briefId, "compose", "done");
    const pickedKinds = composition.components.map((c) => c.kind);

    // ── Stage 2 · chair cluster + scaffold ───────────────────────────────
    // Quality over silent degradation · retry up to 3 times with rising
    // temperature. If the structured scaffold can't be produced, surface
    // a clear error rather than falling through to a flat 3-section brief.
    const stage2EtaRaw = estimateStage2Eta({ perDirectorSignals, members });
    const stage2Eta: StageEta = {
      lo: Math.max(2, Math.round(stage2EtaRaw.lo * calibration)),
      hi: Math.max(4, Math.round(stage2EtaRaw.hi * calibration)),
    };
    // Stage 2 is now self-emitting · runStage2 fires its own
    // `scaffold-anchor` → `scaffold-findings` → `scaffold-cluster` →
    // `scaffold-actions` events as JSON keys arrive in the stream
    // buffer. The total ETA budget gets carved across the 4 sub-stages
    // proportionally (see SCAFFOLD_FRACTIONS).
    scaffold = await runStage2({
      chair,
      chairId,
      room,
      members,
      perDirectorSignals,
      language,
      supplement,
      picked: pickedKinds,
      roomId,
      briefId,
      totalEta: stage2Eta,
      signal: args.signal,
      provenance,
    });
    if (args.signal?.aborted) return;

    if (!scaffold) {
      pipelineError =
        "Report writer couldn't structure this room — repeated attempts to build the JSON scaffold failed or produced invalid output. Try regenerating, or shorten the conversation. See server stderr for `[brief.stage2]` diagnostics.";
    } else {
      // ── Interim title update · use scaffold.bottomLine.judgement
      //    (or thesis.claim / workingHypothesis.hypothesis) as the
      //    brief's title BEFORE Stage 3 streams. Without this, a
      //    reader who opens report.html during streaming sees the
      //    placeholder (room.subject / the initial question) until
      //    Stage 3 completes and `brief-final` fires. Setting the
      //    title from the scaffold's claim sentence closes that gap;
      //    the final extractBriefTitle pass after Stage 3 may still
      //    refine it if the writer's rendered H2 turns out better. */
      const interimTitle = (
        scaffold.bottomLine?.judgement ||
        scaffold.thesis?.claim ||
        scaffold.workingHypothesis?.hypothesis ||
        ""
      ).trim();
      if (interimTitle.length >= 12) {
        setBriefTitle(briefId, interimTitle);
      }

      // ── Stage 3 · chair final write (streaming) ────────────────────────
      // Use the same calibration factor measured from stage 1 — the
      // scaling reflects the user's network / provider latency, which
      // applies to all stages.
      const stage3EtaRaw = estimateStage3Eta({ scaffold, perDirectorSignals, members });
      const stage3Eta: StageEta = {
        lo: Math.max(2, Math.round(stage3EtaRaw.lo * calibration)),
        hi: Math.max(4, Math.round(stage3EtaRaw.hi * calibration)),
      };
      emitStage(roomId, briefId, "write", "active", undefined, undefined, stage3Eta);
      const r3 = await runStage3Streaming({
        roomId,
        briefId,
        chairId,
        room,
        members,
        scaffold,
        perDirectorSignals,
        language,
        supplement,
        picked: pickedKinds,
        houseStyle: composition.houseStyle,
        signal: args.signal,
      });
      if (args.signal?.aborted) return;
      buf = r3.body;
      stage3Model = r3.model;
      if (!buf.length) {
        pipelineError = r3.error ?? "stage 3 produced no output";
      } else {
        // Append the auto-generated Methodology footer · this is
        // deterministic data (signal counts, lens distribution, models),
        // so we don't burn LLM tokens on it.
        const methodology = buildMethodologyFooter({
          perDirectorSignals,
          stage3Model,
          language,
          startedAt: Date.now(),  // approximate · acceptable for a footer
          provenance,
        });
        const sep = buf.endsWith("\n") ? "\n" : "\n\n";
        buf += sep + methodology;
        updateBriefBody(briefId, buf);
        roomBus.emit(roomId, {
          type: "config-event",
          kind: "brief-token",
          payload: { briefId, delta: sep + methodology },
          createdAt: Date.now(),
        });
        emitStage(roomId, briefId, "write", "done");
      }
    }
  } catch (e) {
    pipelineError = e instanceof Error ? e.message : String(e);
  }

  if (pipelineError && !buf.length) {
    roomBus.emit(roomId, {
      type: "config-event",
      kind: "brief-error",
      payload: { briefId, message: pipelineError },
      createdAt: Date.now(),
    });
    return;
  }

  // Normalise fenced-block openers · the LLM occasionally glues
  // `\`\`\`<lang>` onto the tail of a paragraph instead of placing
  // it on its own line, which kills the renderer's fence-extraction
  // pass (it requires `^\`\`\`<lang>$`). Fix at save time so the
  // export file + downstream re-renders all see the cleaned text.
  // The renderer also runs the same normalisation defensively for
  // older briefs already in the DB. Only opener fences are touched
  // (closing fences have no lang).
  buf = buf.replace(/([^\n])(\n?)```([\w-]+)\s*\n/g,
    (_m, before, _newline, lang) => `${before}\n\n\`\`\`${lang}\n`);

  const title = extractBriefTitle(
    buf,
    room.subject,
    scaffold?.bottomLine?.judgement || scaffold?.thesis?.claim || scaffold?.workingHypothesis?.hypothesis,
  );
  updateBriefBody(briefId, buf, title);

  try {
    const dirs = ensureBoardroomDir();
    const path = join(dirs.briefs, `${briefId}.md`);
    await writeFile(path, buf, "utf8");
  } catch (e) {
    process.stderr.write(`[brief] export failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  roomBus.emit(roomId, {
    type: "config-event",
    kind: "brief-final",
    payload: { briefId, title, modelV: stage3Model ?? undefined },
    createdAt: Date.now(),
  });
}

/* ─────────────────────────── Stage 1 ──────────────────────────────────── */

async function runStage1(
  roomId: string,
  briefId: string,
  directors: Agent[],
  transcript: ReturnType<typeof listMessages>,
  room: NonNullable<ReturnType<typeof getRoom>>,
  language: "zh" | "en",
  chairId: string | null,
  onDirectorComplete?: (current: number, harvest: DirectorAssets | null) => void,
  signal?: AbortSignal,
): Promise<DirectorAssets[]> {
  if (!directors.length) return [];

  const emptyAssets = (d: Agent): DirectorAssets => ({
    directorId: d.id, directorName: d.name,
    claims: [], evidence: [], tensions: [], assumptions: [],
    risks: [], opportunities: [], actions: [], quotes: [], openQuestions: [],
  });

  let completed = 0;
  /** Report completion of one director, optionally surfacing the
   *  parsed harvest. The harvest powers the per-director chip with
   *  real signal counts in the loading UI; null = director failed
   *  every model attempt (extracted nothing). */
  const reportComplete = (harvest: DirectorAssets | null) => {
    if (onDirectorComplete) {
      completed += 1;
      onDirectorComplete(completed, harvest);
    }
  };

  const tasks = directors.map(async (director) => {
    const ownMessages = transcript.filter(
      (m) => m.authorKind === "agent" && m.authorId === director.id,
    );
    const extractionMessages = selectExtractionMessages(ownMessages);
    if (!extractionMessages.length) {
      // Director didn't speak — don't count toward progress (the total
      // already excludes silent directors).
      return emptyAssets(director);
    }
    if (extractionMessages.length < ownMessages.length) {
      process.stderr.write(
        `[brief.stage1] ${director.handle} extraction input filtered ${ownMessages.length} -> ${extractionMessages.length} substantive messages\n`,
      );
    }
    const messages = buildExtractMessages({ director, ownMessages: extractionMessages, room, language });

    for (const modelV of stageCheapList()) {
      if (!isModelV(modelV)) continue;
      const timeout = signalWithTimeout(signal, STAGE_1_CALL_TIMEOUT_MS);
      try {
        // Asset extraction is structurally richer than the legacy 2-4
        // signal output. Keep a wide enough budget for the 9-field JSON
        // bundle; otherwise long rooms can truncate mid-object and parse
        // as an empty bundle.
        const { text: raw, usage } = await callBriefLLMText({
          roomId,
          briefId,
          stage: "extract",
          label: `${director.name} asset extraction`,
          modelV,
          messages,
          temperature: 0.2,
          // 4400 cap (was 2200) · 9-field asset bundle JSON · max 38
          // entries × ~150 chars per entry ≈ 5700 chars ≈ 2500-3500
          // output tokens for a dense director. 2200 was right at the
          // edge for terse models (Gemini Flash) but Anthropic Opus /
          // Sonnet emit verbose JSON and overflow, producing truncated
          // output → parser drops to empty assets → `heuristicDirectorAssets`
          // takes over with weaker signal recovery. Doubling the cap
          // gives the verbose providers headroom without affecting
          // the terse ones (they don't hit the cap).
          maxTokens: 4400,
          signal: timeout.signal,
        });
        if (timeout.timedOut()) throw new Error(`timed out after ${STAGE_1_CALL_TIMEOUT_MS / 1000}s`);
        billChair(chairId, usage);
        const result = parseDirectorAssets(raw, director);
        const harvested = countAssets(result);
        if (harvested === 0 && extractionMessages.length > 0) {
          process.stderr.write(
            `[brief.stage1] ${director.handle} on ${modelV} produced empty assets; ${diagnoseStage1Extraction(raw)}; trying fallback model\n`,
          );
          continue;
        }
        reportComplete(result);
        return result;
      } catch (e) {
        process.stderr.write(
          `[brief.stage1] ${director.handle} on ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      } finally {
        timeout.cleanup();
      }
    }
    // All models failed for this director — count it complete so the
    // bar still reaches its total. If the model kept returning empty
    // bundles for a speaking director, salvage deterministic assets
    // from the transcript so Stage 2 has material to structure.
    const fallback = heuristicDirectorAssets(director, extractionMessages);
    const harvested = countAssets(fallback);
    reportComplete(harvested > 0 ? fallback : null);
    if (harvested > 0) {
      process.stderr.write(
        `[brief.stage1] ${director.handle} salvaged ${harvested} heuristic assets\n`,
      );
      return fallback;
    }
    return emptyAssets(director);
  });

  const settled = await Promise.allSettled(tasks);
  return settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((x): x is DirectorAssets => x !== null);
}

function isLowSignalDirectorMessage(body: string): boolean {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return true;
  if (/^[.\-_\s。…]+$/.test(text)) return true;
  if (/^(空席|缺席|无发言|沉默|pass|skip|n\/a)[。.!！\s]*$/i.test(text)) return true;
  if (/^(结束|停止|不开第[一二三四五六七八九十\d]+轮|不再继续|桌子关了|本轮结束)[。.!！\s]*$/i.test(text)) return true;
  return text.length < 12 && !/[?？]|BLOCKER|MAJOR|风险|建议|必须|应该/i.test(text);
}

function extractionMessageScore(body: string): number {
  const text = body.replace(/\s+/g, " ").trim();
  let score = Math.min(text.length, 1200);
  if (/\*\*|BLOCKER|MAJOR|修复方向|建议|必须|应该|风险|反例|不同意|问题|结论|机会|假设/i.test(text)) score += 500;
  if (/[?？]/.test(text)) score += 120;
  if (/空席|不开第|本轮结束|不再继续/.test(text)) score -= 400;
  return score;
}

function selectExtractionMessages(
  ownMessages: ReturnType<typeof listMessages>,
): ReturnType<typeof listMessages> {
  const substantive = ownMessages.filter((m) => !isLowSignalDirectorMessage(m.body || ""));
  if (substantive.length <= 12) return substantive;
  return substantive
    .map((m, idx) => ({ m, idx, score: extractionMessageScore(m.body || "") }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, 12)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.m);
}

function extractJsonObject(raw: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function diagnoseStage1Extraction(raw: string): string {
  const len = raw.length;
  if (!raw.trim()) return "model returned empty text";
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") {
    const opens = (raw.match(/{/g) || []).length;
    const closes = (raw.match(/}/g) || []).length;
    const tail = raw.replace(/\s+/g, " ").trim().slice(-240);
    return `no parseable JSON object (chars=${len}, braces=${opens}/${closes}, tail="${tail}")`;
  }
  const obj = parsed as Record<string, unknown>;
  const fields = [
    "claims", "evidence", "tensions", "assumptions", "risks",
    "opportunities", "actions", "quotes", "openQuestions",
  ];
  const counts = fields.map((k) => `${k}:${Array.isArray(obj[k]) ? obj[k].length : "missing"}`).join(",");
  const sourceLike = fields.reduce((acc, k) => {
    const arr = Array.isArray(obj[k]) ? obj[k] : [];
    return acc + arr.filter((x) => x && typeof x === "object" && Array.isArray((x as Record<string, unknown>).sources)).length;
  }, 0);
  return `JSON parsed but parser kept 0 assets (chars=${len}, rawCounts=${counts}, entriesWithSources=${sourceLike})`;
}

function diagnoseStage2Scaffold(raw: string): string {
  if (!raw.trim()) return "model returned empty text";
  const opens = (raw.match(/{/g) || []).length;
  const closes = (raw.match(/}/g) || []).length;
  const keys = [
    "bottomLine", "headlineFindings", "recommendations", "openQuestions",
    "criticalAssumptions", "preMortem", "threatsToValidity",
  ].filter((k) => new RegExp(`"${k}"\\s*:`).test(raw));
  const parsed = extractJsonObject(raw);
  const parseState = parsed ? "balanced JSON found but schema rejected" : "no balanced parseable JSON object";
  const tail = raw.replace(/\s+/g, " ").trim().slice(-320);
  return `${parseState} (chars=${raw.length}, braces=${opens}/${closes}, keys=${keys.join("|") || "none"}, tail="${tail}")`;
}

function cleanAssetText(s: string, max = 260): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function firstUsefulSentence(body: string): string {
  const lines = body
    .split(/\n+/)
    .map((l) => cleanAssetText(l))
    .filter((l) => l.length > 12 && !/^[-*]\s*$/.test(l));
  const bold = /\*\*([^*]{12,260})\*\*/.exec(body);
  return cleanAssetText(bold?.[1] || lines[0] || body, 240);
}

function heuristicDirectorAssets(
  director: Agent,
  ownMessages: ReturnType<typeof listMessages>,
): DirectorAssets {
  const out: DirectorAssets = {
    directorId: director.id,
    directorName: director.name,
    claims: [],
    evidence: [],
    tensions: [],
    assumptions: [],
    risks: [],
    opportunities: [],
    actions: [],
    quotes: [],
    openQuestions: [],
  };
  for (let i = 0; i < ownMessages.length; i++) {
    const body = ownMessages[i]?.body || "";
    const text = firstUsefulSentence(body);
    if (!text) continue;
    if (out.claims.length < 6) {
      out.claims.push({
        text,
        lens: /反例|不同意|错|BLOCKER|MAJOR|但|but/i.test(body) ? "dissent" : "structural",
        sources: [i],
        confidence: /BLOCKER|必须|第一性|硬约束/i.test(body) ? "high" : "medium",
      });
    }
    const risk = /(?:BLOCKER|风险|失败|失控|不可逆|漏洞|wrong|fail)[^。.!?\n]{8,180}/i.exec(body);
    if (risk && out.risks.length < 4) {
      out.risks.push({ text: cleanAssetText(risk[0], 220), severity: "high", sources: [i] });
    }
    const action = /(?:修复方向|建议|必须|应该|下一步|去|加|写清)[：: ]?[^。.!?\n]{8,180}/i.exec(body);
    if (action && out.actions.length < 4) {
      out.actions.push({ text: cleanAssetText(action[0], 220), owner: "user", horizon: "next step", sources: [i] });
    }
    const question = /([^。.!?\n]{8,120}[?？])/.exec(body);
    if (question && out.openQuestions.length < 4) {
      out.openQuestions.push({ text: cleanAssetText(question[1], 180), priority: "P1", sources: [i] });
    }
    const quote = /[“"]([^”"]{16,140})[”"]/.exec(body);
    if (quote && out.quotes.length < 3) {
      out.quotes.push({ text: cleanAssetText(quote[1], 160), sources: [i] });
    }
    if (/@[a-zA-Z_/-]+/.test(body) && out.tensions.length < 4) {
      out.tensions.push({ text, with: [], sources: [i] });
    }
  }
  return out;
}

/* ─────────────────────────── Stage 1.5 · composer ───────────────────────
 *
 * Picks the spine and a subset of components based on the room's subject
 * + the per-director signals. Cheap haiku call. Falls back to the default
 * 12-section preset on any failure (no key, parse error, validation fail) —
 * so the rest of the pipeline always has a valid composition to work with.
 */
/** Stage-level provenance · mutable record threaded through stages
 *  so the Methodology footer can name which model handled each step.
 *  Each stage writes its successful model into the matching field
 *  when its LLM call returns. Null fields = stage didn't run or no
 *  model succeeded. Surfaced at render time as a small Provenance
 *  block under Methodology — turns the footer from a single line
 *  into a lab-report-grade reproducibility log. */
export interface PipelineProvenance {
  composerModel: ModelV | null;
  scaffoldModel: ModelV | null;
  scaffoldRetries: number;
}

interface ComposerArgs {
  roomId: string;
  briefId: string;
  chairId: string | null;
  room: NonNullable<ReturnType<typeof getRoom>>;
  members: Agent[];
  perDirectorAssets: DirectorAssets[];
  language: "zh" | "en";
  supplement?: string;
  signal?: AbortSignal;
  /** Mutable provenance · runComposer writes `composerModel` here on
   *  success. Optional so callers that don't care about provenance
   *  (tests, future paths) can omit it. */
  provenance?: PipelineProvenance;
}

async function runComposer(args: ComposerArgs): Promise<ComposerResult> {
  // No assets → no compose. Fall back to the default preset so
  // Stage 2/3 still try to produce something (legacy behaviour).
  const totalAssets = args.perDirectorAssets.reduce(
    (acc, d) => acc + countAssets(d),
    0,
  );
  if (totalAssets === 0) return defaultComposition("no assets — fallback preset");

  const messages = buildComposerMessages({
    room: args.room,
    members: args.members,
    perDirectorAssets: args.perDirectorAssets,
    language: args.language,
    supplement: args.supplement,
  });

  // Coverage inputs · feed the validatePicks coverage matrix the
  // per-field totals so it can reject picks that ignored available
  // material (tensions surfaced but no divergence, risks surfaced but
  // no risk-register, etc.).
  const coverage = {
    tensions: args.perDirectorAssets.reduce((n, d) => n + d.tensions.length, 0),
    risks: args.perDirectorAssets.reduce((n, d) => n + d.risks.length, 0),
    openQuestions: args.perDirectorAssets.reduce((n, d) => n + d.openQuestions.length, 0),
    actions: args.perDirectorAssets.reduce((n, d) => n + d.actions.length, 0),
    dataAvailable: args.perDirectorAssets.reduce(
      (n, d) =>
        n +
        d.claims.filter((c) => c.lens === "data").length +
        d.evidence.filter((e) => e.kind === "data").length,
      0,
    ),
  };

  for (const modelV of stageCheapList()) {
    if (!isModelV(modelV)) continue;
    try {
      // 600 tokens was tuned for the legacy compact JSON output. The
      // new tone+budget+coverage block can grow rationale + components
      // beyond that envelope occasionally; bump to 800 to keep
      // truncation off the table.
      const { text: raw, usage } = await callBriefLLMText({
        roomId: args.roomId,
        briefId: args.briefId,
        stage: "compose",
        label: "Composer picks report spine",
        modelV,
        messages,
        temperature: 0.2,
        maxTokens: 800,
        signal: args.signal,
      });
      billChair(args.chairId, usage);
      const parsed = parseComposerOutput(raw, coverage);
      if (parsed) {
        if (args.provenance) args.provenance.composerModel = modelV;
        return parsed;
      }
      process.stderr.write(`[brief.compose] ${modelV} produced unusable composition; trying next model\n`);
    } catch (e) {
      process.stderr.write(
        `[brief.compose] ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  return defaultComposition("composer call failed — fallback preset");
}

/* ─────────────────────────── Stage 2 ──────────────────────────────────── */

interface Stage2Args {
  chair: Agent | null;
  chairId: string | null;
  room: NonNullable<ReturnType<typeof getRoom>>;
  members: Agent[];
  perDirectorSignals: DirectorSignals[];
  language: "zh" | "en";
  supplement?: string;
  /** Composer's component picks (Stage 1.5). When empty, Stage 2 falls
   *  back to filling all 12 sections — preserves legacy behaviour. */
  picked?: readonly string[];
  /** Identifiers for the sub-stage emitStage calls runStage2 makes
   *  internally · `scaffold-anchor` → `scaffold-findings` →
   *  `scaffold-cluster` → `scaffold-actions` as JSON keys arrive in
   *  the stream buffer. */
  roomId: string;
  briefId: string;
  /** Per-sub-stage ETA window. Shared by all 4 sub-stages — runStage2
   *  apportions across them in fractions that sum to 1.0. */
  totalEta: StageEta;
  signal?: AbortSignal;
  /** Mutable provenance · runStage2 writes `scaffoldModel` and the
   *  retry count here when the scaffold parses successfully. */
  provenance?: PipelineProvenance;
}

/** Sub-stage progression for Stage 2 streaming. The frontend renders
 *  these 4 keys as separate pips in the loading rail, lighting up as
 *  the streamed JSON crosses each boundary. Order is the visual
 *  progression — anchor → findings → cluster → actions. */
const SCAFFOLD_SUB_STAGES = [
  "scaffold-anchor",
  "scaffold-findings",
  "scaffold-cluster",
  "scaffold-actions",
] as const;

/** First-occurrence triggers · regex matched against the streaming
 *  buffer. When a regex first matches, the previous sub-stage is
 *  flipped done and this one becomes active. The model's JSON-emit
 *  order matches the prompt's example template (title → bottomLine →
 *  frameShift → headlineFindings → convergence → divergence → ...
 *  → recommendations → newQuestions → planningAssumption), so these
 *  triggers reflect the real arrival sequence — not a synthetic timer. */
const SCAFFOLD_TRIGGERS: Partial<Record<StageKey, RegExp>> = {
  "scaffold-findings": /"headlineFindings"\s*:/,
  "scaffold-cluster":  /"convergence"\s*:|"divergence"\s*:|"positions"\s*:/,
  "scaffold-actions":  /"recommendations"\s*:|"theBet"\s*:|"considerations"\s*:|"newQuestions"\s*:/,
};

/** Fractional ETA budgets across the 4 sub-stages. Sum to 1.0. The
 *  longest blocks are findings (the heart of the report) and actions
 *  (recommendations + new questions + risk-register all live there). */
const SCAFFOLD_FRACTIONS: Record<typeof SCAFFOLD_SUB_STAGES[number], number> = {
  "scaffold-anchor":   0.20,
  "scaffold-findings": 0.30,
  "scaffold-cluster":  0.20,
  "scaffold-actions":  0.30,
};

async function runStage2(args: Stage2Args): Promise<BriefScaffold | null> {
  const totalSignals = args.perDirectorSignals.reduce(
    (acc, d) => acc + d.signals.length,
    0,
  );
  if (totalSignals === 0) return null;

  const messages = buildScaffoldMessages({
    chair: args.chair,
    room: args.room,
    members: args.members,
    perDirectorSignals: args.perDirectorSignals,
    language: args.language,
    supplement: args.supplement,
    picked: args.picked,
  });

  // Carve the total Stage 2 ETA budget across the 4 sub-stages. Each
  // gets its own visible ETA window in the UI.
  const subEta = (frac: number): StageEta => ({
    lo: Math.max(2, Math.round(args.totalEta.lo * frac)),
    hi: Math.max(3, Math.round(args.totalEta.hi * frac)),
  });

  // Track which sub-stages have been triggered across attempts. Once
  // a sub-stage has been seen as active in any attempt's buffer, we
  // never go backward — even if a retry restarts from scratch, the UI
  // doesn't whiplash. The retry's stream will hit the same triggers
  // again; we just don't re-emit them.
  const triggered = new Set<StageKey>();

  // Anchor is active from the moment Stage 2 begins. (No regex trigger
  // for it — it's the implicit start state.)
  emitStage(
    args.roomId,
    args.briefId,
    "scaffold-anchor",
    "active",
    undefined,
    undefined,
    subEta(SCAFFOLD_FRACTIONS["scaffold-anchor"]),
  );
  triggered.add("scaffold-anchor");

  /** Inspect the buffer · for each not-yet-triggered sub-stage with a
   *  regex match, flip the previous done and this one active. */
  const advanceOnBuffer = (buf: string): void => {
    for (let i = 1; i < SCAFFOLD_SUB_STAGES.length; i++) {
      const subKey = SCAFFOLD_SUB_STAGES[i];
      if (triggered.has(subKey)) continue;
      const re = SCAFFOLD_TRIGGERS[subKey];
      if (!re || !re.test(buf)) continue;
      const prev = SCAFFOLD_SUB_STAGES[i - 1];
      if (triggered.has(prev)) {
        emitStage(args.roomId, args.briefId, prev, "done");
      }
      emitStage(
        args.roomId,
        args.briefId,
        subKey,
        "active",
        undefined,
        undefined,
        subEta(SCAFFOLD_FRACTIONS[subKey]),
      );
      triggered.add(subKey);
    }
  };

  /** Close out any sub-stages still pending or active. Called on a
   *  successful parse so the loading rail ends in an all-done state
   *  even when the model omitted a section the composer didn't pick. */
  const finishAllSubStages = (): void => {
    for (const subKey of SCAFFOLD_SUB_STAGES) {
      if (!triggered.has(subKey)) {
        emitStage(
          args.roomId,
          args.briefId,
          subKey,
          "active",
          undefined,
          undefined,
          subEta(SCAFFOLD_FRACTIONS[subKey]),
        );
        triggered.add(subKey);
      }
      emitStage(args.roomId, args.briefId, subKey, "done");
    }
  };

  // Active director count drives the "directorPerspectives is mandatory"
  // gate · ≥ 2 active directors means the views-compared section MUST
  // appear in the brief. If the LLM omits it (common on long rooms /
  // dense scaffolds), we retry; on final attempt we synthesize a
  // minimal backstop from existing signals so the section always
  // ships rather than silently disappearing.
  const activeDirectorCount = args.perDirectorSignals.filter(
    (d) => d.signals.length > 0,
  ).length;
  const requiresPerspectives = activeDirectorCount >= 2;

  // Track whether the most recent attempt was rejected for missing
  // directorPerspectives · used to augment the next attempt's user
  // message with a corrective note. Plumbed via a closure so we
  // don't have to thread a flag through buildScaffoldMessages.
  let priorAttemptMissedPerspectives = false;

  // Build the messages once · prepend a corrective note when we're
  // retrying because of a missing mandatory section. The base messages
  // remain the same; we just push an additional user-side reminder
  // before the LLM call so the previous attempt's failure mode is
  // explicitly addressed.
  const messagesForAttempt = (): typeof messages => {
    if (!priorAttemptMissedPerspectives) return messages;
    const correction: typeof messages[number] = {
      role: "user",
      content:
        "RETRY · your previous JSON omitted `directorPerspectives` (or returned it as null). " +
        `That field is MANDATORY for this room — there are ${activeDirectorCount} active directors with signals, so the views-compared block MUST be filled. ` +
        "Include it this time: object with `intro`, `alignment` (≥0 groups), `divergence` (≥0 entries), `perspectives` (one entry per active director · directorId from the room's member list, stance ≤60 chars, position ≤300 chars, optional quote ≤40 words, lens), `chairSynthesis` (≤400 chars). " +
        "Do NOT skip it again — every active director gets a row.",
    };
    return [...messages, correction];
  };

  // Try each model up to STAGE_2_RETRIES times with rising temperature.
  for (const modelV of stageFlagshipList()) {
    if (!isModelV(modelV)) continue;
    for (let attempt = 0; attempt < STAGE_2_RETRIES; attempt++) {
      const timeout = signalWithTimeout(args.signal, STAGE_2_CALL_TIMEOUT_MS);
      try {
        const { text: buf, usage } = await callBriefLLMText({
          roomId: args.roomId,
          briefId: args.briefId,
          stage: "scaffold-anchor",
          label: `Scaffold JSON attempt ${attempt + 1}`,
          modelV,
          messages: messagesForAttempt(),
          temperature: STAGE_2_TEMPERATURES[attempt] ?? 0.6,
          // 16k cap (was 8k) · the structured scaffold JSON for a dense
          // room (≥3 directors with rich signals, full visuals + risk
          // register + perspectives) regularly lands at 10–14k output
          // tokens. Opus 4.6 Fast hit the 8k ceiling mid-`directorPerspectives`
          // and emitted truncated JSON · parseScaffold then returned
          // null and the pipeline dropped to deterministic fallback,
          // which has no visuals / divergence / risk — wiping every
          // chart from the brief. Gemini 3 Flash is more terse on the
          // same prompt so it cleared 8k on most rooms; Anthropic
          // models reliably overflow. 16k matches Anthropic's max
          // output cap for the Sonnet/Opus class.
          maxTokens: 16000,
          signal: timeout.signal,
          onText: (_delta, full) => advanceOnBuffer(full),
        });
        if (timeout.timedOut()) throw new Error(`timed out after ${STAGE_2_CALL_TIMEOUT_MS / 1000}s`);
        if (usage?.totalTokens) billChair(args.chairId, { totalTokens: usage.totalTokens });
        const scaffold = parseScaffold(
          buf,
          args.room.subject,
          args.room.subject,
        );
        if (scaffold) {
          // Mandatory-section gate · the prompt marks
          // `directorPerspectives` as MANDATORY for ≥ 2 active
          // directors, but the LLM occasionally drops it on long /
          // dense rooms. parseScaffold accepts the missing field
          // (it's optional in the schema for single-director rooms);
          // we enforce the requirement here at the orchestrator layer.
          const missingPerspectives =
            requiresPerspectives && !scaffold.directorPerspectives;
          // We have one more attempt available · retry with a
          // corrective note prepended.
          const isLastAttempt =
            attempt === STAGE_2_RETRIES - 1 &&
            modelV === stageFlagshipList()[stageFlagshipList().length - 1];
          if (missingPerspectives && !isLastAttempt) {
            priorAttemptMissedPerspectives = true;
            process.stderr.write(
              `[brief.stage2] ${modelV} attempt ${attempt + 1}/${STAGE_2_RETRIES} parsed OK but missed mandatory directorPerspectives — retrying with correction\n`,
            );
            continue;
          }
          // Last attempt · accept the scaffold. If perspectives are
          // still missing, synthesize a minimal backstop from the
          // signals we already have so the section always renders.
          if (missingPerspectives && isLastAttempt) {
            scaffold.directorPerspectives = synthesizeDirectorPerspectivesFallback(
              args.perDirectorSignals,
              args.members,
            );
            process.stderr.write(
              `[brief.stage2] ${modelV} final attempt still missed directorPerspectives — synthesized minimal backstop from signals (${activeDirectorCount} active directors)\n`,
            );
          }
          if (attempt > 0) {
            process.stderr.write(
              `[brief.stage2] ${modelV} succeeded on retry ${attempt + 1}\n`,
            );
          }
          if (args.provenance) {
            args.provenance.scaffoldModel = modelV;
            args.provenance.scaffoldRetries = attempt;
          }
          finishAllSubStages();
          return scaffold;
        }
        process.stderr.write(
          `[brief.stage2] ${modelV} attempt ${attempt + 1}/${STAGE_2_RETRIES} produced unusable scaffold: ${diagnoseStage2Scaffold(buf)}\n`,
        );
      } catch (e) {
        const partial = e instanceof BriefLlmTextError ? e.partialText : "";
        const suffix = partial ? `; partial: ${diagnoseStage2Scaffold(partial)}` : "";
        process.stderr.write(
          `[brief.stage2] ${modelV} attempt ${attempt + 1}/${STAGE_2_RETRIES} failed: ${e instanceof Error ? e.message : String(e)}${suffix}\n`,
        );
      } finally {
        timeout.cleanup();
      }
    }
  }
  const fallback = buildFallbackScaffold(args);
  process.stderr.write(
    `[brief.stage2] falling back to deterministic scaffold (${fallback.headlineFindings.length} findings)\n`,
  );
  finishAllSubStages();
  if (args.provenance) {
    args.provenance.scaffoldModel = null;
    args.provenance.scaffoldRetries = STAGE_2_RETRIES;
  }
  return fallback;
}

function buildFallbackScaffold(args: Stage2Args): BriefScaffold {
  const allSignals = args.perDirectorSignals.flatMap((d) =>
    d.signals.map((s, i) => ({ ...s, ref: `${d.directorId}#${i}`, directorId: d.directorId, directorName: d.directorName })),
  );
  const claims = allSignals.filter((s) => /\[claim\]/.test(s.text)).slice(0, 6);
  const risks = allSignals.filter((s) => /\[risk/.test(s.text)).slice(0, 3);
  const actions = allSignals.filter((s) => /\[action/.test(s.text)).slice(0, 3);
  const questions = allSignals.filter((s) => /\[open-q/.test(s.text)).slice(0, 4);
  const baseClaims = (claims.length ? claims : allSignals).slice(0, 3);
  const clean = (s: string) =>
    s
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  const title = args.language === "zh"
    ? "Agent 产品矩阵不会通吃，而会按权限、反馈闭环与控制层分化"
    : "Agent product matrices split by permissions, feedback loops, and control";
  const headlineFindings = baseClaims.map((s, idx) => ({
    title: clean(s.text).slice(0, 80) || `Finding ${idx + 1}`,
    claim: clean(s.text) || title,
    confidence: "medium" as const,
    supporters: [s.directorId],
    challengers: [],
    supporting: [{
      text: clean(s.text) || title,
      evidenceRefs: [s.ref],
    }],
    lensesPresent: [s.lens],
    strategicImplication: args.language === "zh"
      ? "这条判断来自自动兜底骨架；应在最终报告中作为可复核假设，而不是定论。"
      : "This came from the deterministic fallback scaffold and should be read as an auditable hypothesis.",
  }));
  while (headlineFindings.length < 1) {
    headlineFindings.push({
      title,
      claim: title,
      confidence: "low",
      supporters: [],
      challengers: [],
      supporting: [{ text: args.room.subject, evidenceRefs: [] }],
      lensesPresent: ["structural"],
    });
  }
  return {
    title,
    bottomLine: {
      judgement: title,
      confidence: "medium",
      rationale: args.language === "zh"
        ? "模型结构化 JSON 未完成，系统改用已抽取 signals 生成最小骨架，保留可读报告而不丢失讨论材料。"
        : "The JSON scaffold did not complete, so the system used extracted signals to preserve the report.",
    },
    thesis: null,
    workingHypothesis: null,
    frameShift: {
      shifted: true,
      original: args.room.subject,
      reframed: args.language === "zh"
        ? "问题从通用/垂直二分，转为哪些层拥有不可压缩差异。"
        : "The question shifts from universal versus vertical to which layers hold irreducible differences.",
      trigger: args.language === "zh"
        ? "董事发言反复指向权限、反馈闭环、编辑回路与终止权。"
        : "The directors repeatedly surfaced permissions, feedback loops, edit loops, and stop rights.",
    },
    headlineFindings,
    bigIdeas: null,
    convergence: [],
    divergence: null,
    positions: [],
    directorPerspectives: null,
    visuals: [],
    twoPaths: null,
    whyNow: null,
    recommendations: (actions.length ? actions : risks).slice(0, 3).map((s, idx) => ({
      priority: idx === 0 ? "P0" : "P1",
      action: clean(s.text) || (args.language === "zh" ? "用具体产品案例压力测试框架。" : "Stress-test the framework against concrete product cases."),
      rationale: args.language === "zh" ? "这是房间中被反复提出的下一步。" : "This was repeatedly raised as the next step.",
      ownerType: "user",
      horizon: "next step",
      successMetric: args.language === "zh" ? "能筛掉或保留 2-3 个具体 agent 机会。" : "It keeps or rejects 2-3 concrete agent opportunities.",
      riskIfSkipped: args.language === "zh" ? "理论继续扩张，无法落到产品判断。" : "The theory keeps expanding without product judgment.",
    })),
    theBet: null,
    considerations: null,
    preMortem: risks.map((s) => ({
      scenario: clean(s.text),
      leadingIndicator: args.language === "zh" ? "同类风险在具体案例中重复出现。" : "The same risk repeats in concrete cases.",
      mitigation: args.language === "zh" ? "把风险转成可观测指标和停止条件。" : "Turn it into observable metrics and stop conditions.",
    })),
    newQuestions: [],
    planningAssumption: null,
    strategicOutlook: null,
    criticalAssumptions: null,
    scenarioTree: null,
    leadingIndicators: null,
    threatsToValidity: null,
    riskRegister: null,
    decisionOptions: null,
    pathComparison: null,
    metricStrip: null,
    appendices: null,
    openQuestions: questions.map((s, idx) => ({
      text: clean(s.text),
      priority: idx === 0 ? "P0" : "P1",
    })),
  };
}

/* ─────────────────────────── Bento mode · single-stage ────────────────
 *
 * Bento collapses Stage 2 + Stage 3 into one chair-LLM call. The output
 * is the BentoScaffold JSON · no separate "write" stage because the
 * renderer is deterministic client-side templating. The function
 * persists the scaffold on the brief row's body_json and fires the
 * brief-final SSE event so the UI flips from "generating" to "filed".
 *
 * Returns true on success, false when all retries failed (caller sets
 * pipelineError, the outer tail block fires brief-error). Throws only
 * on abort / catastrophic LLM-adapter errors.
 */
interface BentoStageArgs {
  roomId: string;
  briefId: string;
  chair: Agent | null;
  chairId: string | null;
  room: NonNullable<ReturnType<typeof getRoom>>;
  members: Agent[];
  perDirectorSignals: DirectorSignals[];
  language: "zh" | "en";
  supplement?: string;
  /** 'magazine', 'newspaper', or 'ppt'. All three modes share the
   *  BentoScaffold JSON output · only the system prompt differs.
   *  Magazine biases toward 5-card editorial · newspaper toward
   *  broadsheet front-page sectioning · ppt toward slide-friendly
   *  short-line bullets and one-claim-per-slide content. */
  mode: BriefMode;
  signal?: AbortSignal;
}

async function runBentoStage(args: BentoStageArgs): Promise<boolean> {
  const totalSignals = args.perDirectorSignals.reduce(
    (acc, d) => acc + d.signals.length,
    0,
  );
  if (totalSignals === 0) return false;

  // Auto-fill fallbacks · used when the LLM omits source / footerTag.
  // Today's date is "{YYYY-MM-DD}" in the room's locale.
  const today = new Date().toISOString().slice(0, 10);
  const chairName = args.chair?.name || "Chair";
  const fallbackSource = `From ${chairName} · ${today}`;
  const subjectShort = (args.room.subject || "").slice(0, 60);
  const fallbackFooterTag = subjectShort ? `${subjectShort} · ${today}` : today;

  const buildMessages = args.mode === "newspaper" ? buildNewspaperMessages
    : args.mode === "ppt" ? buildPptMessages
    : buildMagazineMessages;
  const messages = buildMessages({
    chair: args.chair,
    room: args.room,
    members: args.members,
    perDirectorSignals: args.perDirectorSignals,
    language: args.language,
    supplement: args.supplement,
    fallbackSource,
    fallbackFooterTag,
  });

  // Use the same flagship-first retry strategy as Stage 2 scaffold ·
  // bento is structurally similar (chair LLM producing strict JSON
  // from the same SIGNALS block). Same retry budget + temperature
  // ladder + maxTokens — bento JSON also overflowed 8k on Anthropic
  // Opus (same failure mode as the scaffold stage), so we now share
  // the 16k cap.
  emitStage(args.roomId, args.briefId, "write", "active", undefined, undefined, { lo: 8, hi: 24 });

  for (const modelV of stageFlagshipList()) {
    if (!isModelV(modelV)) continue;
    for (let attempt = 0; attempt < STAGE_2_RETRIES; attempt++) {
      try {
        let buf = "";
        let totalTokens = 0;
        for await (const chunk of callLLMStream({
          modelV,
          messages,
          temperature: STAGE_2_TEMPERATURES[attempt] ?? 0.6,
          maxTokens: 16000,
          signal: args.signal,
        })) {
          if (chunk.type === "text") {
            buf += chunk.delta;
            // Stream the buffer to the client as bento-token events ·
            // lets the loading UI eventually preview the headline /
            // milestones as they arrive (deferred · see bento.html).
            roomBus.emit(args.roomId, {
              type: "config-event",
              kind: "brief-token",
              payload: { briefId: args.briefId, delta: chunk.delta },
              createdAt: Date.now(),
            });
          } else if (chunk.type === "usage") {
            totalTokens = chunk.totalTokens;
          } else if (chunk.type === "error") {
            throw new Error(chunk.message);
          }
        }
        if (totalTokens > 0) billChair(args.chairId, { totalTokens });

        const bento = parseBento(buf, args.room.subject, fallbackSource, fallbackFooterTag);
        if (bento) {
          if (attempt > 0) {
            process.stderr.write(
              `[brief.${args.mode}] ${modelV} succeeded on retry ${attempt + 1}\n`,
            );
          }
          updateBriefBodyJson(args.briefId, bento, bento.title);
          emitStage(args.roomId, args.briefId, "write", "done");
          roomBus.emit(args.roomId, {
            type: "config-event",
            kind: "brief-final",
            payload: { briefId: args.briefId, title: bento.title, modelV },
            createdAt: Date.now(),
          });
          return true;
        }
        process.stderr.write(
          `[brief.${args.mode}] ${modelV} attempt ${attempt + 1}/${STAGE_2_RETRIES} produced unparseable bento\n`,
        );
      } catch (e) {
        if (args.signal?.aborted) throw e;
        process.stderr.write(
          `[brief.${args.mode}] ${modelV} attempt ${attempt + 1}/${STAGE_2_RETRIES} failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  }
  return false;
}

/** Backstop · synthesize a minimal `directorPerspectives` block when
 *  the scaffold writer keeps omitting it. Uses each active director's
 *  first signal (if any) as their position so every director still
 *  shows up in the social-map view. Loses the alignment / divergence
 *  groupings (those need cross-signal reasoning the LLM does well
 *  but we don't replicate here) — those just render as empty groups,
 *  which the views-compared renderer handles gracefully with
 *  "No clear convergence" / "No central fork" placeholders. The
 *  important thing is that EVERY ACTIVE DIRECTOR gets a row, which
 *  is the section's load-bearing function. */
function synthesizeDirectorPerspectivesFallback(
  perDirectorSignals: DirectorSignals[],
  members: Agent[],
): NonNullable<BriefScaffold["directorPerspectives"]> {
  const memberById = new Map(members.map((m) => [m.id, m]));
  const VALID_LENSES: ReadonlySet<string> = new Set([
    "data", "dissent", "narrative", "structural", "first-principle",
  ]);
  const perspectives = perDirectorSignals
    .filter((d) => d.signals.length > 0)
    .map((d) => {
      const first = d.signals[0];
      const lensRaw = String(first.lens || "structural");
      const lens = (VALID_LENSES.has(lensRaw) ? lensRaw : "structural") as
        | "data" | "dissent" | "narrative" | "structural" | "first-principle";
      const text = String(first.text || "").trim();
      // Trim the position to the schema's ≤300 char ceiling at the
      // nearest sentence boundary so the backstop reads as a clean
      // paraphrase rather than a mid-sentence cutoff.
      const position = text.length <= 300
        ? text
        : text.slice(0, 300).replace(/[\s,，;。.!?！？]+\S*$/, "") + "…";
      const member = memberById.get(d.directorId);
      const stanceSeed = member?.roleTag || member?.bio || "Their angle on this room.";
      const stance = stanceSeed.length <= 60 ? stanceSeed : stanceSeed.slice(0, 57) + "…";
      return {
        directorId: d.directorId,
        stance,
        position,
        quote: "",
        lens,
      };
    });
  return {
    intro: "Each active director's read on the room — drawn from the signals they surfaced.",
    alignment: [],
    divergence: [],
    perspectives,
    chairSynthesis: "",
  };
}

/* ─────────────────────────── Stage 3 ──────────────────────────────────── */

interface Stage3Args {
  roomId: string;
  briefId: string;
  chairId: string | null;
  room: NonNullable<ReturnType<typeof getRoom>>;
  members: Agent[];
  scaffold: BriefScaffold;
  perDirectorSignals: DirectorSignals[];
  language: "zh" | "en";
  supplement?: string;
  /** Composer's component picks (Stage 1.5). When empty, Stage 3 renders
   *  whatever's filled in the scaffold — preserves legacy behaviour. */
  picked?: readonly string[];
  /** Composer-picked house-style preset slug. Drives section vocabulary
   *  + voice register at write time. Defaults to `boardroom-default`. */
  houseStyle?: string;
  signal?: AbortSignal;
}

interface Stage3Result {
  body: string;
  model: ModelV | null;
  error?: string;
}

/** Heuristic + provider-explicit detection that the writer's stream
 *  was truncated mid-output (model hit its own max-tokens cap before
 *  finishing the report). When this returns true, we issue a
 *  continuation request to pick up where the buffer cut off.
 *
 *  Provider-explicit signals (preferred when available):
 *    · OpenAI / OpenRouter · `length`
 *    · Anthropic           · `max_tokens`
 *    · Google              · `MAX_TOKENS`
 *    · xAI                 · `length`
 *
 *  Heuristic fallback (when finishReason isn't surfaced — some
 *  providers' stream endings don't carry it reliably): the buffer's
 *  last non-whitespace line doesn't look like a "complete" terminator.
 *  Complete = ends with a section heading line, a closing punctuation
 *  mark (CJK or Latin), a closing fenced-block triple-backtick, or a
 *  closing bracket. Anything else (mid-word / mid-sentence / orphan
 *  bullet marker) is assumed to be a cut. False-positives just trigger
 *  a single redundant continuation call — cost is small. */
function isStage3Truncated(finishReason: string | undefined, buf: string): boolean {
  if (finishReason) {
    const fr = finishReason.toLowerCase();
    if (fr === "length" || fr === "max_tokens" || fr === "max-tokens") return true;
  }
  const tail = buf.trimEnd();
  if (!tail) return false;
  const lastLine = (tail.split("\n").pop() || "").trim();
  // Last line is a markdown heading → ok if heading is followed by content
  // (we'd be cut off WAITING for content). Treat "heading-only ending" as
  // truncated since the next section's body is what got cut.
  if (/^#{1,4}\s+\S+/.test(lastLine)) return true;
  // Closing punctuation (Latin or CJK) at end of buffer = ok.
  if (/[.。！？!?…)）」』】]\s*$/.test(tail)) return false;
  // Code-fence / blockquote / closing bracket = ok.
  if (/```\s*$/.test(tail)) return false;
  if (/[)\]}]\s*$/.test(tail)) return false;
  // Otherwise the writer was probably mid-thought when the stream
  // ended — treat as truncated.
  return true;
}

async function runStage3Streaming(args: Stage3Args): Promise<Stage3Result> {
  const { roomId, briefId, chairId, room, members, scaffold, perDirectorSignals, language, supplement, picked, houseStyle } = args;

  const messages = buildWriteMessages({
    room, members, scaffold, perDirectorSignals, language,
    supplement, picked, houseStyle, briefId,
  });

  /** Stream a single LLM call (initial OR continuation) into the
   *  brief's buffer · returns the new buf + the finishReason +
   *  whether the call errored. Caller decides whether to continue
   *  generation based on truncation detection. */
  async function streamOnce(
    modelV: ModelV,
    msgs: LLMMessage[],
    initialBuf: string,
  ): Promise<{ buf: string; finishReason: string | undefined; errored: boolean; error?: string }> {
    let buf = initialBuf;
    let finishReason: string | undefined;
    let errored = false;
    let error: string | undefined;
    const timeout = signalWithTimeout(args.signal, STAGE_3_CALL_TIMEOUT_MS);
    const logId = `write-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    let totalTokens: number | null = null;
    emitBriefLlmStart(roomId, briefId, {
      id: logId,
      stage: "write",
      label: initialBuf ? "Writer continuation" : "Final report writer",
      modelV,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      text: "",
      totalTokens: null,
      error: null,
    });
    try {
      for await (const chunk of callLLMStream({
        modelV,
        messages: msgs,
        temperature: 0.4,
        maxTokens: 20000,
        signal: timeout.signal,
      })) {
        if (chunk.type === "text") {
          buf += chunk.delta;
          emitBriefLlmToken(roomId, briefId, logId, chunk.delta);
          updateBriefBody(briefId, buf);
          roomBus.emit(roomId, {
            type: "config-event",
            kind: "brief-token",
            payload: { briefId, delta: chunk.delta },
            createdAt: Date.now(),
          });
        } else if (chunk.type === "usage") {
          totalTokens = chunk.totalTokens;
          billChair(chairId, { totalTokens: chunk.totalTokens });
        } else if (chunk.type === "done") {
          finishReason = chunk.finishReason;
        } else if (chunk.type === "error") {
          errored = true;
          error = chunk.message;
          break;
        }
      }
      if (timeout.timedOut()) {
        errored = true;
        error = `timed out after ${STAGE_3_CALL_TIMEOUT_MS / 1000}s`;
      }
    } catch (e) {
      errored = true;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      timeout.cleanup();
      emitBriefLlmEnd(roomId, briefId, logId, {
        status: errored ? "failed" : "done",
        totalTokens,
        error: errored ? error ?? "writer failed" : null,
      });
    }
    return { buf, finishReason, errored, error };
  }

  /** Hard cap on continuation rounds · in the wild we've seen ≥ 2
   *  rounds get the report to a clean ending. Beyond that, the model
   *  is probably stuck in a loop — bail and accept whatever we have
   *  rather than burning tokens forever. */
  const MAX_CONTINUATIONS = 3;

  let lastError = "no model attempted";
  for (const modelV of stageFlagshipList()) {
    if (!isModelV(modelV)) continue;

    // First pass · stream the writer prompt.
    let pass = await streamOnce(modelV, messages, "");
    if (pass.errored) {
      lastError = pass.error || lastError;
      continue; // try next flagship model
    }
    if (pass.buf.length === 0) {
      lastError = "writer produced empty output";
      continue;
    }

    // Continuation loop · keep streaming with `assistant: <buf>` +
    // `user: continue` turns until the model produces a clean ending
    // or we hit MAX_CONTINUATIONS / the abort signal fires.
    for (let i = 0; i < MAX_CONTINUATIONS; i++) {
      if (args.signal?.aborted) break;
      if (!isStage3Truncated(pass.finishReason, pass.buf)) break;
      process.stderr.write(
        `[brief.stage3] ${modelV} appears truncated (finishReason=${pass.finishReason || "n/a"}, ` +
          `buf=${pass.buf.length} chars) · continuation ${i + 1}/${MAX_CONTINUATIONS}\n`,
      );
      const continuationMessages: LLMMessage[] = [
        ...messages,
        { role: "assistant", content: pass.buf },
        {
          role: "user",
          content:
            "Continue writing from EXACTLY where you left off above. Do NOT repeat any prior content. Do NOT restart sections you've already opened. If you cut mid-word, finish the word; if mid-sentence, finish the sentence; if mid-section, finish the section. Then continue with whatever sections remain in the required structure. Markdown only — same format as before. Pick up from the last character.",
        },
      ];
      const next = await streamOnce(modelV, continuationMessages, pass.buf);
      if (next.errored) {
        // Continuation errored · accept the partial buffer rather
        // than discarding all of pass 1's work. The user gets a
        // somewhat-truncated brief, which is strictly better than
        // none (and the warning is logged for diagnosis).
        process.stderr.write(
          `[brief.stage3] continuation ${i + 1} failed: ${next.error || "unknown"} · accepting partial output\n`,
        );
        break;
      }
      // The continuation pass started its `buf` from the previous
      // pass's end (initialBuf), so `next.buf` already includes
      // everything up to + including the new chunks.
      pass = next;
    }

    return { body: pass.buf, model: modelV };
  }
  return { body: "", model: null, error: lastError };
}

/* ─────────────────────────── Methodology footer ───────────────────────── */

interface MethodologyArgs {
  perDirectorSignals: DirectorSignals[];
  stage3Model: ModelV | null;
  language: "zh" | "en";
  startedAt: number;
  /** Stage-by-stage model + retry record. When present, the footer
   *  appends a small lab-report-style Provenance block listing the
   *  composer / scaffold / writer models and the scaffold retry
   *  count — turns the footer from a single line into a real
   *  reproducibility log. */
  provenance?: PipelineProvenance;
}

/**
 * Auto-generated Methodology section appended to every report. Listed
 * after stage-3 streams so the user sees how the report was made:
 * how many signals, lens distribution, models used, time stamp. This
 * is deterministic data — we don't burn LLM tokens on it.
 */
function buildMethodologyFooter(args: MethodologyArgs): string {
  const { perDirectorSignals, stage3Model, language, provenance } = args;

  const totalSignals = perDirectorSignals.reduce((acc, d) => acc + d.signals.length, 0);
  const directorsActive = perDirectorSignals.filter((d) => d.signals.length > 0).length;
  const directorsTotal = perDirectorSignals.length;

  // Lens distribution.
  const lensCounts: Record<string, number> = {};
  for (const d of perDirectorSignals) {
    for (const s of d.signals) {
      lensCounts[s.lens] = (lensCounts[s.lens] || 0) + 1;
    }
  }
  const lensRow = (["data", "dissent", "narrative", "structural", "first-principle"] as const)
    .map((l) => `${l} ${lensCounts[l] || 0}`)
    .join(" · ");

  // Provenance · model name per stage + scaffold retry count. Listed
  // as a compact mono caption beneath the main pipeline line, so a
  // reader auditing the brief can name what produced what.
  const provenanceLine = (() => {
    if (!provenance) return null;
    const composer = provenance.composerModel || "—";
    const scaffold = provenance.scaffoldModel || "—";
    const writer = stage3Model || "—";
    const retries = provenance.scaffoldRetries;
    if (language === "zh") {
      const retryNote = retries > 0 ? ` · 骨架重试 ${retries} 次` : "";
      return `**模型链：** composer ${composer} · scaffold ${scaffold} · writer ${writer}${retryNote}`;
    }
    const retryNote = retries > 0 ? ` · scaffold retried ${retries}×` : "";
    return `**Model chain:** composer ${composer} · scaffold ${scaffold} · writer ${writer}${retryNote}`;
  })();

  if (language === "zh") {
    const writerLine = stage3Model ? `主写模型：${stage3Model}` : "主写模型：—";
    return [
      "## Methodology",
      "",
      `本报告基于 ${directorsActive}/${directorsTotal} 位董事的发言抽取出 **${totalSignals} 条 signal**，按五种证据视角分布：${lensRow}。`,
      "",
      `Pipeline：每位董事独立抽取 → chair 聚类成骨架 → chair 撰写最终报告。${writerLine}。`,
      ...(provenanceLine ? ["", provenanceLine] : []),
      "",
      "_本报告不擅长评估的领域：定量预测、近期市场数据、合规与法律边界。涉及这些维度时建议另启专业渠道复核。_",
    ].join("\n");
  }
  const writerLine = stage3Model ? `Writer model: ${stage3Model}` : "Writer model: —";
  return [
    "## Methodology",
    "",
    `Compiled from **${totalSignals} signals** extracted across ${directorsActive}/${directorsTotal} active directors. Lens distribution: ${lensRow}.`,
    "",
    `Pipeline: per-director independent extraction → chair clustering into a scaffold → chair final write. ${writerLine}.`,
    ...(provenanceLine ? ["", provenanceLine] : []),
    "",
    "_Domains this writer is not equipped to assess: quantitative forecasting, near-real-time market data, legal/compliance boundaries. Verify those through specialist channels._",
  ].join("\n");
}
