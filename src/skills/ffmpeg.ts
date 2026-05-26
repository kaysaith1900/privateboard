/**
 * ffmpeg wrapper · the audio-side helpers for the voice-distill
 * pipeline. Two operations:
 *
 * 1. `normalizeAudio` · take an mp3 of unknown sample rate / channels
 *    and re-encode to 16kHz mono mp3 — the format MiniMax voice-clone
 *    and the speaker-ID step both prefer.
 *
 * 2. `extractClips` · cut multiple time ranges out of one mp3 and
 *    concatenate them into a single output file (≤ MAX_CLIP_SEC).
 *
 * 3. `findLongestSpeechSegment` · fallback when the ASR step can't
 *    identify a target speaker. Uses ffmpeg's silencedetect filter to
 *    locate the longest contiguous non-silent stretch, which we then
 *    trim to a centred 60-second window. Heuristic but useful.
 *
 * All helpers honour an AbortSignal so the orchestrator can kill
 * stuck child processes when wall-clock fires.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const FFMPEG_BIN = "ffmpeg";

/** Voice cloning sweet spot · MiniMax recommends 30s-5min of clean
 *  speech. We aim for 60-240s after concatenation — longer training
 *  audio gives the clone more coverage of prosody, pauses, and
 *  register variation, which significantly improves how close the
 *  TTS output sounds to the real person. 4 min is well within
 *  MiniMax's 5-min ceiling and ASR / upload latency stays bounded. */
export const MIN_CLIP_SEC = 30;
export const MAX_CLIP_SEC = 240;
/** Output sample rate when normalizing audio · 24 kHz mono. 16 kHz
 *  (telephony-grade) is enough for ASR but throws away the upper
 *  harmonics that carry vocal timbre, which makes the resulting
 *  clone sound thinner / less personalised. 24 kHz captures most of
 *  the speech band (humans rarely use intelligible content above
 *  10–12 kHz) while keeping the upload size reasonable. */
export const NORMALIZE_SAMPLE_RATE = 24_000;

export interface AudioSegment {
  start: number;
  end: number;
}

export interface RunFfmpegOpts {
  args: string[];
  signal?: AbortSignal;
  ffmpegPath?: string;
  /** Optional stderr line callback · used by silencedetect. */
  onStderr?: (line: string) => void;
}

/** Run ffmpeg with the given args. Resolves on exit 0, rejects with
 *  a tail of stderr on non-zero. */
async function runFfmpeg(opts: RunFfmpegOpts): Promise<void> {
  const bin = opts.ffmpegPath ?? FFMPEG_BIN;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, opts.args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      const s = String(chunk);
      stderr += s;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
      if (opts.onStderr) {
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) opts.onStderr(line);
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(0, 800)}`));
    });
    if (opts.signal) {
      const onAbort = () => child.kill("SIGTERM");
      if (opts.signal.aborted) child.kill("SIGTERM");
      else opts.signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => opts.signal!.removeEventListener("abort", onAbort));
    }
  });
}

/** Re-encode a source audio file to mono mp3 at NORMALIZE_SAMPLE_RATE
 *  with a light filter chain that improves voice-clone fidelity:
 *
 *  · `highpass=f=80` removes sub-vocal rumble (HVAC, mic handling,
 *    YouTube compression artifacts) that would otherwise leak into the
 *    cloned voice as a "muffled" undercurrent.
 *  · `lowpass=f=10500` trims ultrasonic noise from poor recordings.
 *  · `loudnorm` (single-pass EBU R128) brings the speech up to a
 *    consistent loudness so the clone trains on a level signal
 *    instead of compensating for an under-recorded interview clip.
 *
 *  The encoder uses `-q:a 2` (≈190 kbps VBR) — significantly better
 *  than the previous `q:a 5` (~128 kbps) and still small enough to
 *  upload comfortably. */
export async function normalizeAudio(opts: {
  inputPath: string;
  outputPath: string;
  signal?: AbortSignal;
  ffmpegPath?: string;
}): Promise<void> {
  await mkdir(dirname(opts.outputPath), { recursive: true });
  await runFfmpeg({
    args: [
      "-y",
      "-i", opts.inputPath,
      "-ac", "1",                          // mono
      "-ar", String(NORMALIZE_SAMPLE_RATE), // higher fidelity than 16k
      "-af", "highpass=f=80,lowpass=f=10500,loudnorm=I=-18:TP=-2:LRA=11",
      "-c:a", "libmp3lame",
      "-q:a", "2",                          // ~190 kbps VBR · richer for clone
      opts.outputPath,
    ],
    signal: opts.signal,
    ffmpegPath: opts.ffmpegPath,
  });
}

/** Trim a segment list down to a cumulative duration budget. Pure
 *  function · exposed so tests can verify the budgeting without
 *  spawning ffmpeg. */
export function trimSegmentsToBudget(segments: AudioSegment[], maxSec: number): { segments: AudioSegment[]; totalSec: number } {
  const trimmed: AudioSegment[] = [];
  let total = 0;
  for (const seg of segments) {
    if (!Number.isFinite(seg.start) || !Number.isFinite(seg.end)) continue;
    const start = Math.max(0, seg.start);
    const end = Math.max(start, seg.end);
    const dur = end - start;
    if (dur <= 0.1) continue;
    const remaining = maxSec - total;
    if (remaining <= 0) break;
    const takeDur = Math.min(dur, remaining);
    trimmed.push({ start, end: start + takeDur });
    total += takeDur;
  }
  return { segments: trimmed, totalSec: total };
}

/** Build the ffmpeg `filter_complex` string for a clip-and-concat job.
 *  Pure function · exposed for tests. */
export function buildClipFilterChain(segments: AudioSegment[]): string {
  const filters: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    filters.push(
      `[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
    );
  }
  const concatInputs = segments.map((_, i) => `[a${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${segments.length}:v=0:a=1[out]`);
  return filters.join(";");
}

/** Cut multiple time ranges from `inputPath`, concatenate them in
 *  order, and write the result to `outputPath`. Caps total output at
 *  MAX_CLIP_SEC. */
export async function extractClips(opts: {
  inputPath: string;
  outputPath: string;
  segments: AudioSegment[];
  signal?: AbortSignal;
  ffmpegPath?: string;
  maxClipSec?: number;
}): Promise<{ outputPath: string; clippedDurationSec: number }> {
  await mkdir(dirname(opts.outputPath), { recursive: true });
  const maxSec = opts.maxClipSec ?? MAX_CLIP_SEC;

  const { segments: trimmed, totalSec } = trimSegmentsToBudget(opts.segments, maxSec);
  if (trimmed.length === 0) {
    throw new Error("No usable segments to extract.");
  }

  const filterChain = buildClipFilterChain(trimmed);

  await runFfmpeg({
    args: [
      "-y",
      "-i", opts.inputPath,
      "-filter_complex", filterChain,
      "-map", "[out]",
      "-c:a", "libmp3lame",
      "-q:a", "2", // match normalizeAudio · ~190 kbps for clone fidelity
      opts.outputPath,
    ],
    signal: opts.signal,
    ffmpegPath: opts.ffmpegPath,
  });

  return { outputPath: opts.outputPath, clippedDurationSec: totalSec };
}

/** Fallback locator · find the longest contiguous non-silent stretch
 *  in `inputPath`. Returns the centred 60-second window inside that
 *  stretch (clamped if the stretch itself is shorter). Used by the
 *  orchestrator when the ASR / LLM speaker-ID step can't identify a
 *  target speaker but we still want SOMETHING usable to send to the
 *  cloning API.
 *
 *  Returns null when the file contains no detectable speech at all. */
export async function findLongestSpeechSegment(opts: {
  inputPath: string;
  signal?: AbortSignal;
  ffmpegPath?: string;
  /** Silence threshold in dB. -30 captures most music-free dialogue;
   *  noisy environments may need -25. */
  silenceDb?: number;
  /** Minimum silence duration to count as a break · default 0.6s. */
  minSilenceSec?: number;
}): Promise<AudioSegment | null> {
  const silenceDb = opts.silenceDb ?? -30;
  const minSilenceSec = opts.minSilenceSec ?? 0.6;

  const startMarkers: number[] = []; // silence_start times
  const endMarkers: number[] = [];   // silence_end times

  const onStderr = (line: string): void => {
    const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch) startMarkers.push(parseFloat(startMatch[1]));
    const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (endMatch) endMarkers.push(parseFloat(endMatch[1]));
  };

  // ffmpeg silencedetect prints results to stderr · we discard the
  // audio output (-f null /dev/null) and just scrape the markers.
  await runFfmpeg({
    args: [
      "-i", opts.inputPath,
      "-af", `silencedetect=noise=${silenceDb}dB:d=${minSilenceSec}`,
      "-f", "null",
      "-",
    ],
    signal: opts.signal,
    ffmpegPath: opts.ffmpegPath,
    onStderr,
  });

  // Reconstruct non-silent ranges between markers. We treat the
  // sequence as: [non-silent (0 → startMarkers[0]), silent, non-silent
  // (endMarkers[0] → startMarkers[1]), ...].
  const candidates: AudioSegment[] = [];
  let cursor = 0;
  const startsCopy = [...startMarkers];
  const endsCopy = [...endMarkers];
  while (startsCopy.length > 0) {
    const nextSilenceStart = startsCopy.shift()!;
    if (nextSilenceStart > cursor) {
      candidates.push({ start: cursor, end: nextSilenceStart });
    }
    const nextSilenceEnd = endsCopy.shift();
    if (nextSilenceEnd === undefined) break;
    cursor = nextSilenceEnd;
  }
  // Trailing speech after the last silence_end is captured by passing
  // a sentinel large number when no further silence is reported; we
  // skip this because we don't know the file duration here. Caller
  // can be content with the longest pre-final-silence run.

  if (candidates.length === 0) return null;
  let longest = candidates[0];
  for (const seg of candidates) {
    if (seg.end - seg.start > longest.end - longest.start) longest = seg;
  }

  // Centre a MAX_CLIP_SEC window inside the longest stretch.
  const targetWindow = MAX_CLIP_SEC;
  const longestDur = longest.end - longest.start;
  if (longestDur <= targetWindow) return longest;
  const mid = (longest.start + longest.end) / 2;
  return {
    start: Math.max(longest.start, mid - targetWindow / 2),
    end: Math.min(longest.end, mid + targetWindow / 2),
  };
}
