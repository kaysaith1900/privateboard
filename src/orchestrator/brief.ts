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

import { callLLMStream, callLLMWithUsage } from "../ai/adapter.js";
import { effectiveDefaultModel, utilityModelFor } from "../ai/availability.js";
import {
  buildExtractMessages,
  buildScaffoldMessages,
  buildContractRetryAddendum,
  buildWriteMessages,
  parseDirectorSignals,
  parseScaffold,
  validateBriefBody,
  type BriefScaffold,
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
import { insertBrief, updateBriefBody, updateBriefCompose, updateBriefSignals } from "../storage/briefs.js";
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

/** Stage 2 retry budget. Each retry bumps temperature so the LLM is
 *  more likely to break out of a malformed-JSON local minimum. */
const STAGE_2_RETRIES = 3;
const STAGE_2_TEMPERATURES = [0.2, 0.4, 0.6];

interface GenerateOpts {
  roomId: string;
  /** Retained for backwards compat with callers that still pass a style.
   *  v1 has one standard layout — the value is recorded but ignored. */
  style?: BriefStyle;
  /** Optional supplementary perspective the user asked the chair to
   *  weave into the regenerated report. Only stages 2 + 3 see it —
   *  stage 1's per-director extraction stays independent. */
  supplement?: string;
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
}
const inFlightBriefs = new Map<string, BriefGenerationState>();

export function isBriefGenerating(briefId: string): boolean {
  return inFlightBriefs.has(briefId);
}

/** Return the full pipeline snapshot for a brief currently being
 *  generated, or `null` if it isn't in flight. Used by
 *  `/api/briefs/:id/status` to let a freshly-loaded client rehydrate
 *  the loading UI mid-pipeline. */
export function getBriefGenerationState(briefId: string): BriefGenerationState | null {
  return inFlightBriefs.get(briefId) ?? null;
}

export async function generateBrief(opts: GenerateOpts): Promise<{ briefId: string }> {
  const { roomId } = opts;
  const style: BriefStyle = opts.style ?? "mckinsey";

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
  });

  // Capture the chair + room language up front so the rehydration
  // endpoint can hand them to a refreshed browser session even
  // before the first SSE event fires.
  const chairForState = getChairAgent();
  const inferredLang: "zh" | "en" = /[一-鿿]/.test(room.subject || "") ? "zh" : "en";
  inFlightBriefs.set(placeholder.id, {
    briefId: placeholder.id,
    roomId,
    style,
    chairName: chairForState?.name || "Chair",
    language: inferredLang,
    pipelineStartedAt: Date.now(),
    stages: {},
  });
  void runPipeline({
    briefId: placeholder.id,
    roomId,
    style,
    members,
    transcript,
    room,
    supplement: opts.supplement,
  }).finally(() => {
    inFlightBriefs.delete(placeholder.id);
  });

  return { briefId: placeholder.id };
}

interface PipelineArgs {
  briefId: string;
  roomId: string;
  style: BriefStyle;
  members: Agent[];
  transcript: ReturnType<typeof listMessages>;
  room: NonNullable<ReturnType<typeof getRoom>>;
  supplement?: string;
}

/** Stage labels that ship to the UI checklist. Frontend matches on
 *  `stage` and renders the canonical label. `compose` is the new
 *  Stage 1.5 — older clients that don't recognize it just skip the row. */
type StageKey = "extract" | "compose" | "scaffold" | "write";
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
 *     and mermaid blocks. Real-world ~25-30 tps.
 *   · Output token volumes grow super-linearly with section count once
 *     recommendations / pre-mortem / new questions all kick in.
 *   · Stage 2 retries up to 3× on parse failure — half of slow runs
 *     have at least one retry, so the upper bound carries a × 1.8
 *     factor to absorb that without lying to the user.
 *
 * To compensate for environment variance (provider routing, region,
 * OpenRouter vs direct), stage 2 and 3 ETAs are also scaled by an
 * observed calibration factor measured from stage 1's actual time vs
 * predicted. See `runPipeline` for the in-flight calibration. */
const TPS_BY_MODEL: Record<string, number> = {
  haiku:  130,  // haiku-4-5 — was 180, brought down for realism
  sonnet:  45,  // sonnet-4-6 — structured JSON output, not free prose
  opus:    28,  // opus-4-7 — rich markdown with tables / mermaid
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
  // EXTRACT_SYSTEM is per-director (~1.5k chars), SCAFFOLD_SYSTEM ~9k
  // chars, WRITE_SYSTEM ~7.7k chars.
  SYS_TOKENS.extract  = 450;
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
    const outputTokens = 400; // 3-4 signals × ~120 tokens each
    const t = llmTimeSec(inputTokens, outputTokens, "haiku");
    if (t > slowest) slowest = t;
  }
  if (slowest === 0) return { lo: 2, hi: 5 }; // no speakers
  // Mild concurrency overhead when many directors run in parallel.
  const speakers = args.directors.filter((d) =>
    args.transcript.some((m) => m.authorKind === "agent" && m.authorId === d.id),
  ).length;
  if (speakers >= 4) slowest *= 1.15;
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
  //   3 pre-mortem × ~100       = 300
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
    (args.scaffold.preMortem.length ? 1 : 0) +
    (args.scaffold.newQuestions.length ? 1 : 0) +
    (args.scaffold.planningAssumption ? 1 : 0) +
    (args.scaffold.openQuestions.length ? 1 : 0);
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
  // stage 3 is reported in brief-final.
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "brief-started",
    payload: { briefId, style, chairName, language },
    createdAt: Date.now(),
  });

  let buf = "";
  let stage3Model: ModelV | null = null;
  let pipelineError: string | null = null;

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
    const perDirectorSignals = await runStage1(
      directors,
      transcript,
      room,
      language,
      chairId,
      (current) => {
        emitStage(
          roomId,
          briefId,
          "extract",
          "active",
          `${current}/${totalDirectors} director${totalDirectors === 1 ? "" : "s"}`,
          { current, total: totalDirectors },
          stage1Eta,
        );
      },
    );
    emitStage(roomId, briefId, "extract", "done");

    // Persist Stage-1 signals on the brief row so future follow-up
    // rooms can re-use them as named-by-lens prior context. Strip
    // each signal down to {text, lens, sources} for storage; the
    // full DirectorSignals shape carries director metadata that's
    // already implicit in the directorId / directorName fields.
    try {
      updateBriefSignals(
        briefId,
        perDirectorSignals.map((d) => ({
          directorId: d.directorId,
          directorName: d.directorName,
          signals: d.signals.map((s) => ({
            text: s.text,
            lens: s.lens,
            sources: Array.isArray(s.sources) ? s.sources : [],
          })),
        })),
      );
    } catch (e) {
      // Non-fatal · the brief is still valid without persisted signals.
      // Follow-ups that hit this brief later will fall back to brief
      // markdown alone.
      process.stderr.write(
        `[brief.stage1] persist signals failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
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
    emitStage(roomId, briefId, "compose", "active", undefined, undefined, { lo: 1, hi: 4 });
    const composition = await runComposer({
      chairId,
      room,
      members,
      perDirectorSignals,
      language,
      supplement,
    });
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
    emitStage(roomId, briefId, "scaffold", "active", undefined, undefined, stage2Eta);
    const scaffold = await runStage2({
      chair,
      chairId,
      room,
      members,
      perDirectorSignals,
      language,
      supplement,
      picked: pickedKinds,
    });
    emitStage(roomId, briefId, "scaffold", "done");

    if (!scaffold) {
      pipelineError =
        "Report writer couldn't structure this room (3 retries failed). Try regenerating, or shorten the conversation.";
    } else {
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
      });
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

  const title = extractBriefTitle(buf, room.subject);
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
  directors: Agent[],
  transcript: ReturnType<typeof listMessages>,
  room: NonNullable<ReturnType<typeof getRoom>>,
  language: "zh" | "en",
  chairId: string | null,
  onDirectorComplete?: (current: number) => void,
): Promise<DirectorSignals[]> {
  if (!directors.length) return [];

  let completed = 0;
  const reportComplete = () => {
    if (onDirectorComplete) {
      completed += 1;
      onDirectorComplete(completed);
    }
  };

  const tasks = directors.map(async (director) => {
    const ownMessages = transcript.filter(
      (m) => m.authorKind === "agent" && m.authorId === director.id,
    );
    if (!ownMessages.length) {
      // Director didn't speak — don't count toward progress (the total
      // already excludes silent directors).
      return { directorId: director.id, directorName: director.name, signals: [] };
    }
    const messages = buildExtractMessages({ director, ownMessages, room, language });

    for (const modelV of stageCheapList()) {
      if (!isModelV(modelV)) continue;
      try {
        const { text: raw, usage } = await callLLMWithUsage({
          modelV,
          messages,
          temperature: 0.2,
          maxTokens: 800,
        });
        billChair(chairId, usage);
        const result = parseDirectorSignals(raw, director);
        reportComplete();
        return result;
      } catch (e) {
        process.stderr.write(
          `[brief.stage1] ${director.handle} on ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
    // All models failed for this director — count it complete so the
    // bar still reaches its total, but emit empty signals.
    reportComplete();
    return { directorId: director.id, directorName: director.name, signals: [] };
  });

  const settled = await Promise.allSettled(tasks);
  return settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((x): x is DirectorSignals => x !== null);
}

/* ─────────────────────────── Stage 1.5 · composer ───────────────────────
 *
 * Picks the spine and a subset of components based on the room's subject
 * + the per-director signals. Cheap haiku call. Falls back to the default
 * 12-section preset on any failure (no key, parse error, validation fail) —
 * so the rest of the pipeline always has a valid composition to work with.
 */
interface ComposerArgs {
  chairId: string | null;
  room: NonNullable<ReturnType<typeof getRoom>>;
  members: Agent[];
  perDirectorSignals: DirectorSignals[];
  language: "zh" | "en";
  supplement?: string;
}

async function runComposer(args: ComposerArgs): Promise<ComposerResult> {
  // Mode is the primary axis · the composer's parser/validator + the
  // safety-net default both branch on it. Reading once at entry and
  // threading the value through means a malformed mode string can't
  // smuggle decision-grade kinds into a brainstorm brief.
  const mode = args.room.mode || "constructive";

  // No signals → no compose. Fall back to the mode-appropriate preset
  // so Stage 2/3 still try to produce something (legacy behaviour).
  const totalSignals = args.perDirectorSignals.reduce(
    (acc, d) => acc + d.signals.length,
    0,
  );
  if (totalSignals === 0) return defaultComposition("no signals — fallback preset", mode);

  const messages = buildComposerMessages({
    room: args.room,
    members: args.members,
    perDirectorSignals: args.perDirectorSignals,
    language: args.language,
    supplement: args.supplement,
  });

  for (const modelV of stageCheapList()) {
    if (!isModelV(modelV)) continue;
    try {
      const { text: raw, usage } = await callLLMWithUsage({
        modelV,
        messages,
        temperature: 0.2,
        maxTokens: 600,
      });
      billChair(args.chairId, usage);
      const parsed = parseComposerOutput(raw, mode);
      if (parsed) return parsed;
      process.stderr.write(`[brief.compose] ${modelV} produced unusable composition; trying next model\n`);
    } catch (e) {
      process.stderr.write(
        `[brief.compose] ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  return defaultComposition("composer call failed — fallback preset", mode);
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
}

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

  // Try each model up to STAGE_2_RETRIES times with rising temperature.
  for (const modelV of stageFlagshipList()) {
    if (!isModelV(modelV)) continue;
    for (let attempt = 0; attempt < STAGE_2_RETRIES; attempt++) {
      try {
        const { text: raw, usage } = await callLLMWithUsage({
          modelV,
          messages,
          temperature: STAGE_2_TEMPERATURES[attempt] ?? 0.6,
          maxTokens: 8000,
        });
        billChair(args.chairId, usage);
        const scaffold = parseScaffold(
          raw,
          args.room.subject,
          args.room.subject,
          args.room.mode,
        );
        if (scaffold) {
          if (attempt > 0) {
            process.stderr.write(
              `[brief.stage2] ${modelV} succeeded on retry ${attempt + 1}\n`,
            );
          }
          return scaffold;
        }
        process.stderr.write(
          `[brief.stage2] ${modelV} attempt ${attempt + 1}/${STAGE_2_RETRIES} produced unusable scaffold\n`,
        );
      } catch (e) {
        process.stderr.write(
          `[brief.stage2] ${modelV} attempt ${attempt + 1}/${STAGE_2_RETRIES} failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  }
  return null;
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
}

interface Stage3Result {
  body: string;
  model: ModelV | null;
  error?: string;
}

async function runStage3Streaming(args: Stage3Args): Promise<Stage3Result> {
  const { roomId, briefId, chairId, room, members, scaffold, perDirectorSignals, language, supplement, picked, houseStyle } = args;

  // One internal pass · streams to the client and returns the body.
  // Called twice at most — once with no retryAddendum (first attempt),
  // once with the addendum (after contract validation flags violations).
  const runOnePass = async (retryAddendum?: string): Promise<Stage3Result> => {
    const messages = buildWriteMessages({
      room, members, scaffold, perDirectorSignals, language,
      supplement, picked, houseStyle, briefId, retryAddendum,
    });

    let lastError = "no model attempted";
    for (const modelV of stageFlagshipList()) {
      if (!isModelV(modelV)) continue;
      let buf = "";
      let errored = false;
      try {
        for await (const chunk of callLLMStream({
          modelV,
          messages,
          temperature: 0.4,
          maxTokens: 12000,
        })) {
          if (chunk.type === "text") {
            buf += chunk.delta;
            updateBriefBody(briefId, buf);
            roomBus.emit(roomId, {
              type: "config-event",
              kind: "brief-token",
              payload: { briefId, delta: chunk.delta },
              createdAt: Date.now(),
            });
          } else if (chunk.type === "usage") {
            billChair(chairId, {
              totalTokens: chunk.totalTokens,
            });
          } else if (chunk.type === "error") {
            errored = true;
            lastError = chunk.message;
            break;
          }
        }
      } catch (e) {
        errored = true;
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (!errored && buf.length > 0) return { body: buf, model: modelV };
    }
    return { body: "", model: null, error: lastError };
  };

  // First pass.
  const first = await runOnePass();
  if (!first.body) return first;

  // Mode-contract validator · brainstorm rooms can't carry decision-
  // defense language ("the bet", "the moat", "must hold"); critique
  // rooms must carry visible severity tags. Other modes have no
  // contract — validateBriefBody returns [] for them. On violation,
  // retry ONCE with a stricter system addendum naming the violations.
  const violations = validateBriefBody(first.body, room.mode);
  if (violations.length === 0) return first;

  const tags = violations.map((v) => v.tag).join(", ");
  process.stderr.write(
    `[brief.stage3] mode-contract violations in ${room.mode} brief: ${tags} · retrying once with corrective addendum\n`,
  );

  const addendum = buildContractRetryAddendum(violations, room.mode);
  const second = await runOnePass(addendum);
  // If the retry STILL violates the contract, log it and return the
  // retry's body anyway — a single retry is the cap so we don't loop
  // burning tokens. The brief lands; downstream analytics can flag
  // repeat violators.
  if (second.body) {
    const stillBad = validateBriefBody(second.body, room.mode);
    if (stillBad.length > 0) {
      process.stderr.write(
        `[brief.stage3] retry still has violations: ${stillBad.map((v) => v.tag).join(", ")} · accepting anyway (retry cap)\n`,
      );
    }
    return second;
  }
  // Retry failed to produce output · fall back to the first pass body.
  // It violates the contract, but it's better than no brief at all.
  return first;
}

/* ─────────────────────────── Methodology footer ───────────────────────── */

interface MethodologyArgs {
  perDirectorSignals: DirectorSignals[];
  stage3Model: ModelV | null;
  language: "zh" | "en";
  startedAt: number;
}

/**
 * Auto-generated Methodology section appended to every report. Listed
 * after stage-3 streams so the user sees how the report was made:
 * how many signals, lens distribution, models used, time stamp. This
 * is deterministic data — we don't burn LLM tokens on it.
 */
function buildMethodologyFooter(args: MethodologyArgs): string {
  const { perDirectorSignals, stage3Model, language } = args;

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

  if (language === "zh") {
    const writerLine = stage3Model ? `主写模型：${stage3Model}` : "主写模型：—";
    return [
      "## Methodology",
      "",
      `本报告基于 ${directorsActive}/${directorsTotal} 位董事的发言抽取出 **${totalSignals} 条 signal**，按五种证据视角分布：${lensRow}。`,
      "",
      `Pipeline：每位董事独立抽取 → chair 聚类成骨架 → chair 撰写最终报告。${writerLine}。`,
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
    "",
    "_Domains this writer is not equipped to assess: quantitative forecasting, near-real-time market data, legal/compliance boundaries. Verify those through specialist channels._",
  ].join("\n");
}
