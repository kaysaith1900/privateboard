/**
 * Voice-distill pipeline orchestrator.
 *
 * Takes a public video URL + the name of a target speaker and walks
 * through a 9-step pipeline to produce a cloned MiniMax voice_id that
 * can immediately be used by `/v1/t2a_v2`. The new voice_id is also
 * persisted to the user's agent (when `agentId` is supplied) so a
 * freshly-built director can use the cloned voice as its default.
 *
 * Step list (matches the SSE phase numbers):
 *   1. download   · yt-dlp grabs the audio track
 *   2. normalize  · ffmpeg → 16kHz mono mp3
 *   3. transcribe · MiniMax ASR (with optional graceful degradation)
 *   4. identify   · utility-tier LLM picks target speaker's segments
 *   5. extract    · ffmpeg slice+concat into a clean 30-120s clip
 *   6. upload     · MiniMax /v1/files/upload → file_id
 *   7. clone      · MiniMax /v1/voice_clone → voice_id confirmed
 *   8. persist    · update agent.voice if agentId, write build log
 *   9. cleanup    · remove the /tmp/voice-distill/<jobId>/ scratch dir
 *
 * Failures are surfaced via the `voiceDistillBus` `*-error` event and
 * the DB row's `error` column. Wall-clock hard cap is 15 minutes; the
 * controller's signal is honoured by every step.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callLLM, NoKeyError, type LLMMessage } from "../ai/adapter.js";
import { utilityModelFor } from "../ai/availability.js";
import { transcribeAudio, type AsrSegment } from "../ai/skills/minimax-asr.js";
import {
  registerVoiceClone,
  uploadVoiceFile,
} from "../ai/skills/minimax-voice-clone.js";
import {
  extractClips,
  findLongestSpeechSegment,
  MAX_CLIP_SEC,
  MIN_CLIP_SEC,
  normalizeAudio,
  type AudioSegment,
} from "../skills/ffmpeg.js";
import {
  downloadAudio,
  rankSearchCandidates,
  searchVideos,
  YT_DLP_MAX_DURATION_SEC,
  type VideoSearchCandidate,
} from "../skills/yt-dlp.js";
import { getAgent, updateAgent, type AgentVoiceProfile } from "../storage/agents.js";
import {
  createVoiceDistillJob,
  getVoiceDistillJob,
  updateVoiceDistillJob,
  type VoiceDistillEvent as PersistedDistillEvent,
  type VoiceDistillPartial,
} from "../storage/voice-distill-jobs.js";
import { voiceDistillBus } from "./voice-distill-stream.js";

/** Wall-clock kill switch · 15 min covers a slow yt-dlp + worst-case
 *  ASR latency on a 30-min input. Anything longer is almost always
 *  stuck on a hung HTTP call. */
const WALL_CLOCK_MS = 15 * 60_000;

/** Min characters of transcript text we ask the LLM to consider. Below
 *  this we skip the identification step entirely and fall back to the
 *  silence-heuristic clipper. */
const MIN_TRANSCRIPT_CHARS_FOR_LLM = 200;

interface JobState {
  id: string;
  videoUrl: string;
  celebrity: string;
  agentId: string | null;
  workDir: string;
  controller: AbortController;
  partial: VoiceDistillPartial;
}

const inFlightJobs = new Map<string, JobState>();

export interface StartVoiceDistillOpts {
  /** Optional · when omitted, the pipeline runs an auto-search phase
   *  to find a candidate video for the named celebrity. When present,
   *  the search step is skipped and the URL is downloaded directly. */
  videoUrl?: string;
  celebrity: string;
  /** Optional · when present, the agent's voice profile is updated to
   *  use the cloned voice_id on success. */
  agentId?: string | null;
}

/** Kick off a voice-distill job. Returns the jobId immediately; the
 *  pipeline runs async and emits progress on `voiceDistillBus`. */
export function startVoiceDistill(opts: StartVoiceDistillOpts): string {
  const videoUrl = (opts.videoUrl || "").trim();
  const celebrity = opts.celebrity.trim();
  if (!celebrity) throw new Error("celebrity name is required");

  const jobId = randomUUID();
  createVoiceDistillJob({
    id: jobId,
    videoUrl: videoUrl || `auto-search:${celebrity}`,
    celebrity,
    agentId: opts.agentId ?? null,
  });

  const workDir = join(tmpdir(), "voice-distill", jobId);
  const state: JobState = {
    id: jobId,
    videoUrl,
    celebrity,
    agentId: opts.agentId ?? null,
    workDir,
    controller: new AbortController(),
    partial: { events: [] },
  };
  inFlightJobs.set(jobId, state);

  const wallClockTimer = setTimeout(() => {
    if (inFlightJobs.has(jobId)) {
      state.controller.abort();
    }
  }, WALL_CLOCK_MS);

  void runPipeline(state).finally(() => {
    clearTimeout(wallClockTimer);
    inFlightJobs.delete(jobId);
    // Always attempt cleanup of the scratch dir, even on failure.
    rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  return jobId;
}

export function abortVoiceDistill(jobId: string): boolean {
  const state = inFlightJobs.get(jobId);
  if (!state) return false;
  try { state.controller.abort(); }
  catch { /* idempotent */ }
  return true;
}

export function isVoiceDistillJobRunning(jobId: string): boolean {
  return inFlightJobs.has(jobId);
}

export interface WaitForVoiceDistillResult {
  status: "done" | "failed" | "aborted" | "timeout";
  voiceId?: string;
  error?: string;
}

/** Block until a voice-distill job reaches a terminal state, or until
 *  `timeoutMs` elapses. Used by persona-builder Phase 5 so the clone
 *  step can run in parallel with few-shot generation but still surface
 *  the voice_id to the save handler. */
export async function waitForVoiceDistillResult(
  jobId: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<WaitForVoiceDistillResult> {
  return new Promise<WaitForVoiceDistillResult>((resolve) => {
    let settled = false;
    const finish = (r: WaitForVoiceDistillResult): void => {
      if (settled) return;
      settled = true;
      try { off(); } catch { /* */ }
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = (): void => finish({ status: "aborted" });
    const timer = setTimeout(() => finish({ status: "timeout" }), opts.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) {
        finish({ status: "aborted" });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    // If the job already terminated before we subscribed, read DB once
    // up front.
    const row = getVoiceDistillJob(jobId);
    if (row && row.status !== "running") {
      finish({
        status: row.status === "done" ? "done" : (row.status as "failed" | "aborted"),
        voiceId: row.voiceId ?? undefined,
        error: row.error ?? undefined,
      });
      return;
    }
    const off = voiceDistillBus.subscribe(jobId, (event) => {
      if (event.type === "voice-distill-final") {
        finish({ status: "done", voiceId: event.voiceId });
      } else if (event.type === "voice-distill-error") {
        finish({ status: "failed", error: event.message });
      } else if (event.type === "voice-distill-aborted") {
        finish({ status: "aborted" });
      }
    });
  });
}

async function runPipeline(state: JobState): Promise<void> {
  const phaseLabels = [
    "Search candidate video", // 1 · skipped when caller supplied a URL
    "Download audio",         // 2
    "Normalize audio",        // 3
    "Transcribe speech",      // 4
    "Identify target speaker",// 5
    "Extract clean clip",     // 6
    "Upload to MiniMax",      // 7
    "Register voice clone",   // 8
    "Persist + link agent",   // 9
    "Cleanup",                // 10
  ];

  const startPhase = (phase: number): void => {
    appendEvent(state, { kind: "phase-start", ts: Date.now(), phase, label: phaseLabels[phase - 1] });
    voiceDistillBus.emit(state.id, {
      type: "voice-distill-phase-start",
      phase,
      label: phaseLabels[phase - 1],
    });
    updateVoiceDistillJob(state.id, {
      currentPhase: phase,
      progressPct: Math.round(((phase - 1) / phaseLabels.length) * 100),
      partial: state.partial,
    });
  };

  const endPhase = (phase: number): void => {
    appendEvent(state, { kind: "phase-end", ts: Date.now(), phase, label: phaseLabels[phase - 1] });
    const pct = Math.round((phase / phaseLabels.length) * 100);
    voiceDistillBus.emit(state.id, { type: "voice-distill-phase-end", phase, progressPct: pct });
    updateVoiceDistillJob(state.id, {
      currentPhase: phase + 1,
      progressPct: pct,
      partial: state.partial,
    });
  };

  const reportProgress = (phase: number, detail: string, pctWithinPhase: number): void => {
    const base = Math.round(((phase - 1) / phaseLabels.length) * 100);
    const span = 100 / phaseLabels.length;
    const overall = Math.round(base + span * Math.max(0, Math.min(1, pctWithinPhase)));
    voiceDistillBus.emit(state.id, {
      type: "voice-distill-phase-progress",
      phase,
      detail,
      progressPct: overall,
    });
  };

  const warn = (phase: number, message: string): void => {
    appendEvent(state, { kind: "warning", ts: Date.now(), phase, label: phaseLabels[phase - 1], detail: message });
    voiceDistillBus.emit(state.id, { type: "voice-distill-warning", phase, message });
  };

  try {
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 1 · search candidate video (when no URL supplied) ─────
    startPhase(1);
    let resolvedUrl = state.videoUrl;
    if (!resolvedUrl) {
      reportProgress(1, `Searching YouTube for "${state.celebrity}" 演讲 / 访谈 / interview`, 0.1);
      const picked = await pickBestSearchCandidate({
        celebrity: state.celebrity,
        signal: state.controller.signal,
      });
      if (!picked) {
        throw new Error(
          `No usable video found for "${state.celebrity}" · try pasting a specific URL instead.`,
        );
      }
      resolvedUrl = picked.url;
      state.videoUrl = picked.url;
      state.partial.resolvedTitle = picked.title;
      state.partial.resolvedUrl = picked.url;
      updateVoiceDistillJob(state.id, { partial: state.partial });
      appendEvent(state, {
        kind: "note",
        ts: Date.now(),
        phase: 1,
        label: phaseLabels[0],
        detail: `Picked "${picked.title}" (${Math.round(picked.durationSec / 60)} min)`,
      });
      reportProgress(1, `Picked "${picked.title.slice(0, 80)}"`, 0.9);
    } else {
      reportProgress(1, "URL supplied by caller · skipping search", 1.0);
    }
    endPhase(1);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 2 · download ─────────────────────────────────────
    startPhase(2);
    reportProgress(2, `Fetching audio from ${resolvedUrl}`, 0.1);
    const raw = await downloadAudio({
      url: resolvedUrl,
      outputPath: join(state.workDir, "raw.mp3"),
      signal: state.controller.signal,
    });
    state.partial.rawAudioPath = raw.audioPath;
    state.partial.durationSec = raw.durationSec;
    endPhase(2);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 3 · normalize ────────────────────────────────────
    startPhase(3);
    const normPath = join(state.workDir, "audio.mp3");
    await normalizeAudio({
      inputPath: raw.audioPath,
      outputPath: normPath,
      signal: state.controller.signal,
    });
    state.partial.normalizedAudioPath = normPath;
    endPhase(3);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 4 · transcribe ───────────────────────────────────
    startPhase(4);
    let transcript: AsrSegment[] | null = null;
    try {
      transcript = await transcribeAudio({
        filePath: normPath,
        signal: state.controller.signal,
        enableDiarization: true,
      });
    } catch (e) {
      warn(4, `ASR call failed (${errMsg(e)}) · falling back to silence detection.`);
      transcript = null;
    }
    state.partial.transcriptSegmentCount = transcript ? transcript.length : 0;
    if (!transcript || transcript.length === 0) {
      warn(4, "MiniMax ASR returned no usable transcript; using silence heuristic.");
    }
    endPhase(4);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 5 · identify target speaker ──────────────────────
    startPhase(5);
    let targetSegments: AudioSegment[] = [];
    if (transcript && transcript.length > 0 && joinTranscript(transcript).length >= MIN_TRANSCRIPT_CHARS_FOR_LLM) {
      try {
        targetSegments = await identifyTargetSegments({
          transcript,
          celebrity: state.celebrity,
          signal: state.controller.signal,
        });
      } catch (e) {
        warn(5, `Speaker identification failed (${errMsg(e)}) · using silence heuristic.`);
        targetSegments = [];
      }
    }
    if (targetSegments.length === 0) {
      // Heuristic fallback · longest non-silent stretch.
      const longest = await findLongestSpeechSegment({
        inputPath: normPath,
        signal: state.controller.signal,
      });
      if (longest) {
        targetSegments = [longest];
        appendEvent(state, {
          kind: "fallback",
          ts: Date.now(),
          phase: 5,
          label: phaseLabels[4],
          detail: `Used silence heuristic · centred ${Math.round(longest.end - longest.start)}s window`,
        });
      }
    }
    if (targetSegments.length === 0) {
      throw new Error(
        "Could not locate any usable speech in the video. Try a clearer recording of the target speaker.",
      );
    }

    // Floor on training audio · clones from 30-60s samples sound thin
    // and "wrong-gendered". If the LLM speaker-ID step came back with
    // only a short stretch, expand it (and/or stitch in surrounding
    // silence-detected speech) until we have at least MIN_CLIP_TARGET
    // seconds — anchored to where the LLM thought the target was, but
    // padded outward symmetrically when needed.
    const MIN_CLIP_TARGET_SEC = 90;
    const segmentsTotal = (segs: AudioSegment[]): number =>
      segs.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    if (segmentsTotal(targetSegments) < MIN_CLIP_TARGET_SEC) {
      const before = segmentsTotal(targetSegments);
      const audioDuration = state.partial.durationSec || 0;
      // Anchor: the midpoint of the (currently chosen) segments.
      const lo = Math.min(...targetSegments.map((s) => s.start));
      const hi = Math.max(...targetSegments.map((s) => s.end));
      const anchor = (lo + hi) / 2;
      // Expand symmetrically around the anchor up to MIN_CLIP_TARGET_SEC.
      const halfWindow = MIN_CLIP_TARGET_SEC / 2;
      let expStart = Math.max(0, anchor - halfWindow);
      let expEnd = expStart + MIN_CLIP_TARGET_SEC;
      if (audioDuration > 0 && expEnd > audioDuration) {
        expEnd = audioDuration;
        expStart = Math.max(0, expEnd - MIN_CLIP_TARGET_SEC);
      }
      targetSegments = [{ start: expStart, end: expEnd }];
      appendEvent(state, {
        kind: "fallback",
        ts: Date.now(),
        phase: 5,
        label: phaseLabels[4],
        detail: `Expanded clip from ${Math.round(before)}s to ${Math.round(expEnd - expStart)}s (min training audio = ${MIN_CLIP_TARGET_SEC}s)`,
      });
    }

    state.partial.identifiedSegments = targetSegments;
    endPhase(5);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 6 · extract clip ─────────────────────────────────
    startPhase(6);
    const clipPath = join(state.workDir, "clip.mp3");
    const extracted = await extractClips({
      inputPath: normPath,
      outputPath: clipPath,
      segments: targetSegments,
      signal: state.controller.signal,
    });
    if (extracted.clippedDurationSec < MIN_CLIP_SEC * 0.5) {
      // Slightly relaxed lower bound · MiniMax accepts shorter
      // training audio, but quality degrades.
      warn(6, `Only ${Math.round(extracted.clippedDurationSec)}s of clean speech · clone quality may be limited.`);
    }
    state.partial.clipPath = clipPath;
    state.partial.clipDurationSec = extracted.clippedDurationSec;
    endPhase(6);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 7 · upload ───────────────────────────────────────
    startPhase(7);
    const uploaded = await uploadVoiceFile({
      filePath: clipPath,
      signal: state.controller.signal,
    });
    state.partial.fileId = uploaded.fileId;
    endPhase(7);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 8 · register clone ───────────────────────────────
    startPhase(8);
    const voiceId = generateVoiceId(state.celebrity);
    // Bias the clone toward the celebrity's likely language so MiniMax
    // tunes its phoneme alignment correctly. Heuristic: CJK characters
    // in the name → Chinese; everything else → auto (MiniMax decides).
    const languageBoost = /[一-鿿]/.test(state.celebrity) ? "Chinese" : "auto";
    const cloneRes = await registerVoiceClone({
      fileId: uploaded.fileId,
      voiceId,
      signal: state.controller.signal,
      needNoiseReduction: true,
      needVolumeNormalization: true,
      languageBoost,
    });
    state.partial.voiceId = cloneRes.voiceId;
    state.partial.voiceClonedAt = Date.now();
    updateVoiceDistillJob(state.id, { voiceId: cloneRes.voiceId, partial: state.partial });
    endPhase(8);
    if (state.controller.signal.aborted) return finalizeAbort(state);

    // ── Phase 9 · persist + link agent ─────────────────────────
    startPhase(9);
    const agentVoiceLabel = await persistAndLinkAgent({
      jobId: state.id,
      agentId: state.agentId,
      voiceId: cloneRes.voiceId,
      celebrity: state.celebrity,
    });
    endPhase(9);

    // ── Phase 10 · cleanup ─────────────────────────────────────
    startPhase(10);
    reportProgress(10, "Removing temporary files", 0.5);
    await rm(state.workDir, { recursive: true, force: true });
    endPhase(10);

    updateVoiceDistillJob(state.id, {
      status: "done",
      progressPct: 100,
      partial: state.partial,
    });
    voiceDistillBus.emit(state.id, {
      type: "voice-distill-final",
      voiceId: cloneRes.voiceId,
      agentId: state.agentId,
      credentialLabel: agentVoiceLabel,
    });
    voiceDistillBus.drop(state.id);
  } catch (e) {
    if (state.controller.signal.aborted) {
      return finalizeAbort(state);
    }
    const msg = errMsg(e);
    appendEvent(state, { kind: "warning", ts: Date.now(), phase: getVoiceDistillJob(state.id)?.currentPhase ?? 0, label: "error", detail: msg });
    updateVoiceDistillJob(state.id, {
      status: "failed",
      partial: state.partial,
      error: msg,
    });
    voiceDistillBus.emit(state.id, { type: "voice-distill-error", message: msg });
    voiceDistillBus.drop(state.id);
  }
}

function finalizeAbort(state: JobState): void {
  updateVoiceDistillJob(state.id, {
    status: "aborted",
    partial: state.partial,
    error: "Cancelled before completion.",
  });
  voiceDistillBus.emit(state.id, { type: "voice-distill-aborted" });
  voiceDistillBus.drop(state.id);
}

function appendEvent(state: JobState, ev: PersistedDistillEvent): void {
  state.partial.events = state.partial.events || [];
  state.partial.events.push(ev);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function generateVoiceId(celebrity: string): string {
  // MiniMax requires a string slug · ASCII letters/digits/underscore.
  const slug = celebrity
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const root = slug || "voice";
  return `pb_${root}_${suffix}`;
}

function joinTranscript(segments: AsrSegment[]): string {
  return segments.map((s) => s.text).join(" ").trim();
}

interface IdentifyOpts {
  transcript: AsrSegment[];
  celebrity: string;
  signal?: AbortSignal;
}

/** Ask a utility-tier LLM to pick which transcript segments are the
 *  named celebrity speaking. Returns an empty array on parse failure
 *  or no-key — caller falls back to the silence heuristic. */
async function identifyTargetSegments(opts: IdentifyOpts): Promise<AudioSegment[]> {
  const routerModel = utilityModelFor();
  if (!routerModel) return [];

  // Pack the transcript with stable indices so the model can reference
  // segments by number instead of by text (which it might paraphrase).
  const lines = opts.transcript
    .map((seg, i) => {
      const speakerTag = seg.speaker ? `[${seg.speaker}] ` : "";
      const stamp = `(${seg.startSec.toFixed(1)}s-${seg.endSec.toFixed(1)}s)`;
      return `${i}. ${stamp} ${speakerTag}${seg.text.replace(/\s+/g, " ").slice(0, 200)}`;
    })
    .join("\n");

  const sys: LLMMessage = {
    role: "system",
    content: [
      "You are picking transcript segments from a public video for use as voice-cloning training audio.",
      `The target speaker is: ${opts.celebrity}`,
      "",
      "Identify ONLY segments where the target speaker is the one talking. Skip:",
      "- Interviewer / host segments where the target speaker is being addressed but not yet replying.",
      "- Audience questions.",
      "- Background voiceover / narration.",
      "- Music or applause segments (often have very short or no text).",
      "",
      "Use textual signals: self-introduction (\"I'm <name>\"), the host saying \"<name>, you've said...\" followed by a reply,",
      "consistent first-person voice that matches the target's known views, or speaker diarization labels when present.",
      "",
      "Return STRICT JSON only:",
      "{ \"segments\": [<integer indices from the transcript above>], \"reason\": \"≤120 chars\" }",
      "If no segment is clearly the target speaker, return { \"segments\": [], \"reason\": \"...\" }.",
      "",
      `Aim for ${MIN_CLIP_SEC}-${MAX_CLIP_SEC} seconds of cumulative speech. Skip very short fragments (<2 seconds).`,
    ].join("\n"),
  };
  const user: LLMMessage = {
    role: "user",
    content: `Transcript:\n${lines}\n\nReturn the JSON.`,
  };

  let raw = "";
  try {
    raw = await callLLM({
      modelV: routerModel,
      messages: [sys, user],
      temperature: 0,
      maxTokens: 400,
      signal: opts.signal,
    });
  } catch (e) {
    if (!(e instanceof NoKeyError)) {
      process.stderr.write(`[voice-distill/identify] LLM failed: ${errMsg(e)}\n`);
    }
    return [];
  }

  const parsed = extractJson(raw) as { segments?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.segments)) return [];
  const out: AudioSegment[] = [];
  for (const idx of parsed.segments) {
    if (typeof idx !== "number" || !Number.isInteger(idx)) continue;
    const seg = opts.transcript[idx];
    if (!seg) continue;
    const start = Math.max(0, seg.startSec);
    const end = Math.max(start + 0.5, seg.endSec);
    if (end - start < 2) continue;
    out.push({ start, end });
  }
  // Merge adjacent segments to reduce concat seams.
  return mergeAdjacentSegments(out, 1.5);
}

function mergeAdjacentSegments(segments: AudioSegment[], gapSec: number): AudioSegment[] {
  if (segments.length <= 1) return segments;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: AudioSegment[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start - last.end <= gapSec) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function extractJson(text: string): unknown | null {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(s); }
  catch { /* fall through */ }
  const open = s.indexOf("{");
  const close = s.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try { return JSON.parse(s.slice(open, close + 1)); }
    catch { return null; }
  }
  return null;
}

interface PersistOpts {
  jobId: string;
  agentId: string | null;
  voiceId: string;
  celebrity: string;
}

/** Stamp the new voice onto the linked agent (when present). Returns
 *  the display label used so the SSE final event can surface it. */
async function persistAndLinkAgent(opts: PersistOpts): Promise<string> {
  const label = `${opts.celebrity} (cloned)`;
  if (opts.agentId) {
    const agent = getAgent(opts.agentId);
    if (agent) {
      const nextVoice: AgentVoiceProfile = {
        ...(agent.voice ?? { provider: "minimax", model: "speech-2.8-hd", voiceId: "" }),
        provider: "minimax",
        model: agent.voice?.model || "speech-2.8-hd",
        voiceId: opts.voiceId,
      };
      updateAgent(opts.agentId, { voice: nextVoice });
    }
  }
  return label;
}

interface PickSearchOpts {
  celebrity: string;
  signal?: AbortSignal;
}

/** Search YouTube for the named celebrity and pick the best candidate
 *  video to clone from. We try two query variants (chinese + english
 *  speech / interview keywords) and rank the merged results so a
 *  short / common-name request lands on a real interview rather than
 *  a parody or fan compilation. Returns null when nothing usable
 *  surfaces. */
async function pickBestSearchCandidate(opts: PickSearchOpts): Promise<VideoSearchCandidate | null> {
  const name = opts.celebrity.trim();
  if (!name) return null;
  const hasCjk = /[一-鿿]/.test(name);
  const queries = hasCjk
    ? [`${name} 演讲`, `${name} 访谈`, `${name} 采访`]
    : [`${name} interview`, `${name} talk`, `${name} keynote`];
  const seen = new Set<string>();
  const merged: VideoSearchCandidate[] = [];
  for (const q of queries) {
    if (opts.signal?.aborted) return null;
    try {
      const found = await searchVideos({ query: q, limit: 6, signal: opts.signal });
      for (const c of found) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        merged.push(c);
      }
    } catch (e) {
      process.stderr.write(
        `[voice-distill/search] "${q}" failed: ${errMsg(e)}\n`,
      );
    }
  }
  if (merged.length === 0) return null;
  const ranked = rankSearchCandidates(merged, {
    celebrity: name,
    maxDurationSec: YT_DLP_MAX_DURATION_SEC,
  });
  // Reject the top candidate if it's outside the duration window — the
  // orchestrator can't use a 3-hour podcast or a 12-second short.
  for (const candidate of ranked) {
    if (candidate.durationSec === 0) continue;          // unknown · let it through downstream
    if (candidate.durationSec < 30) continue;            // too short to extract a clip from
    if (candidate.durationSec > YT_DLP_MAX_DURATION_SEC) continue;
    return candidate;
  }
  return ranked[0] || null;
}
