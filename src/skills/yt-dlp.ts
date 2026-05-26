/**
 * yt-dlp wrapper · download the audio track of a public video to a
 * local mp3 file. Used by the voice-distill pipeline as step 1.
 *
 * Discipline:
 * - Cap input duration via `--match-filter` to keep ASR + cloning cost
 *   bounded. 30 minutes is the hard ceiling.
 * - Force mp3 extraction (yt-dlp + ffmpeg) so downstream steps don't
 *   have to deal with platform-specific containers (mp4, webm, m3u8).
 * - Abort-aware · accepts an AbortSignal so the orchestrator can kill
 *   a stuck download when the wall-clock fires.
 * - No shell interpolation · args go via execFile so URLs with
 *   ampersands / quotes never get reinterpreted.
 */
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Hard cap on input video length. Anything longer is rejected
 *  outright. We allow up to 3 hours so user-supplied URLs for a
 *  long keynote / interview don't get rejected — when the input is
 *  longer than the desired training window, ASR + speaker-ID picks
 *  the relevant segments, or the silence-detect fallback clips a
 *  centred window. Beyond 3 hours, ASR + transcript cost grows
 *  faster than clone quality so we still reject. */
export const YT_DLP_MAX_DURATION_SEC = 3 * 60 * 60;

export interface DownloadAudioOpts {
  url: string;
  /** Absolute path where the mp3 should land. Parent dir is created
   *  if missing. yt-dlp will write to `<outputPath>` directly. */
  outputPath: string;
  /** AbortSignal · when aborted, the yt-dlp child process is killed. */
  signal?: AbortSignal;
  /** Override the duration ceiling for tests · prod path uses default. */
  maxDurationSec?: number;
  /** Override the binary path · prod path lets PATH resolution find
   *  the binary, tests can point at a stub. */
  ytDlpPath?: string;
}

export interface DownloadAudioResult {
  /** Absolute path to the downloaded mp3. */
  audioPath: string;
  /** Original video duration in seconds (per yt-dlp metadata). */
  durationSec: number;
  /** Video title (used for the eventual voice_credential label). */
  title: string;
}

/** Resolved-format metadata yt-dlp emits when called with --dump-json.
 *  We only read the fields we need; the actual payload is much bigger. */
interface YtDlpInfo {
  title?: string;
  duration?: number;
  is_live?: boolean;
  webpage_url?: string;
  view_count?: number;
  upload_date?: string;          // YYYYMMDD
  channel?: string;
  uploader?: string;
  description?: string;
}

export interface VideoSearchCandidate {
  url: string;
  title: string;
  durationSec: number;
  viewCount: number | null;
  uploadDate: string | null;
  uploader: string | null;
  channel: string | null;
  description: string | null;
}

const YT_DLP_BIN = "yt-dlp";

/** YouTube periodically gates yt-dlp behind a "Sign in to confirm you're
 *  not a bot" check, especially when many requests come from the same IP
 *  in a short window. Reading cookies from the user's actual logged-in
 *  Chrome session is the cheapest workaround — yt-dlp's `--cookies-from-
 *  browser` flag handles the export inline. The browser name is read from
 *  `YTDLP_COOKIE_BROWSER` (chrome | firefox | safari | edge | brave); falls
 *  back to chrome which is the most common.
 *
 *  Setting the env var to "off" disables cookie injection entirely (useful
 *  in CI / headless environments where no browser is available). */
function cookieFlags(): string[] {
  const v = (process.env.YTDLP_COOKIE_BROWSER ?? "chrome").toLowerCase().trim();
  if (!v || v === "off" || v === "none" || v === "false") return [];
  return ["--cookies-from-browser", v];
}

/** Probe the video metadata first · cheap call (no actual download)
 *  that fails fast on private / geo-blocked / live videos. Returns
 *  duration + title so the caller can enforce the ceiling BEFORE
 *  spending bandwidth on the audio download. */
export async function probeVideo(opts: {
  url: string;
  signal?: AbortSignal;
  ytDlpPath?: string;
}): Promise<YtDlpInfo> {
  const bin = opts.ytDlpPath ?? YT_DLP_BIN;
  return new Promise<YtDlpInfo>((resolve, reject) => {
    const child = execFile(
      bin,
      [
        "--dump-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        ...cookieFlags(),
        opts.url,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as YtDlpInfo;
          resolve(parsed);
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
    if (opts.signal) {
      const onAbort = () => child.kill("SIGTERM");
      if (opts.signal.aborted) child.kill("SIGTERM");
      else opts.signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => opts.signal!.removeEventListener("abort", onAbort));
    }
  });
}

/** Download the audio track of a public video to `outputPath`.
 *  Throws on any non-zero exit, missing file, or duration-cap breach.
 *  Caller is expected to clean up the directory on failure. */
export async function downloadAudio(opts: DownloadAudioOpts): Promise<DownloadAudioResult> {
  const maxDuration = opts.maxDurationSec ?? YT_DLP_MAX_DURATION_SEC;
  const bin = opts.ytDlpPath ?? YT_DLP_BIN;

  await mkdir(dirname(opts.outputPath), { recursive: true });

  // Probe first · cheap fail-fast for live streams + over-long inputs.
  // If the metadata call itself fails (private video, network), let
  // the error bubble — the orchestrator surfaces it as the phase error.
  const info = await probeVideo({ url: opts.url, signal: opts.signal, ytDlpPath: bin });
  if (info.is_live) {
    throw new Error("Live streams are not supported · use a recorded video instead.");
  }
  const dur = typeof info.duration === "number" ? info.duration : 0;
  if (dur > 0 && dur > maxDuration) {
    throw new Error(
      `Video too long · ${Math.round(dur / 60)} min exceeds the ${Math.round(maxDuration / 60)}-min ceiling.`,
    );
  }

  // Section-only download for long videos · for inputs longer than
  // `LONG_VIDEO_THRESHOLD_SEC`, we only need ~6 minutes of audio for
  // ASR + speaker-ID to find a clean 240s training clip. Use yt-dlp's
  // `--download-sections` to instruct ffmpeg to pull only that range
  // via HTTP range requests, so a 140-min keynote becomes a ~30s
  // download instead of 15 min. Skip the first 10% to avoid host
  // intros / theme music / sponsor reads.
  const LONG_VIDEO_THRESHOLD_SEC = 30 * 60; // 30 min
  const SECTION_WINDOW_SEC = 6 * 60;        // 6 min — enough for 240s clean clip
  const useSectionDownload = dur > LONG_VIDEO_THRESHOLD_SEC;
  let sectionStart = 0;
  let sectionEnd = 0;
  if (useSectionDownload) {
    sectionStart = Math.max(0, Math.round(dur * 0.1)); // skip intro
    sectionEnd = Math.min(dur, sectionStart + SECTION_WINDOW_SEC);
  }

  await new Promise<void>((resolve, reject) => {
    // Use the highest-quality audio stream yt-dlp can find; encode to
    // mp3 at quality 0 (yt-dlp's best · ~245 kbps VBR). The normalize
    // step downsamples to 24 kHz mono afterwards, but giving it a
    // less-degraded source preserves more of the original timbre.
    const args = [
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "--format",
      "bestaudio/best",
      "--no-warnings",
      "--no-playlist",
      ...cookieFlags(),
      "--output",
      opts.outputPath,
      "--force-overwrites",
    ];
    if (useSectionDownload) {
      // yt-dlp's section syntax: *START-END (seconds). The asterisk
      // requests ffmpeg HTTP-range downloads instead of full-file +
      // post-trim, which is what makes this fast.
      args.push("--download-sections", `*${sectionStart}-${sectionEnd}`);
      args.push("--force-keyframes-at-cuts");
    }
    args.push(opts.url);
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      // Bound stderr capture to 64KB so a misbehaving yt-dlp can't
      // OOM the orchestrator's job state.
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim().slice(0, 800)}`));
    });
    if (opts.signal) {
      const onAbort = () => child.kill("SIGTERM");
      if (opts.signal.aborted) child.kill("SIGTERM");
      else opts.signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => opts.signal!.removeEventListener("abort", onAbort));
    }
  });

  return {
    audioPath: opts.outputPath,
    durationSec: dur,
    title: (info.title || "").trim() || "Untitled video",
  };
}

export interface SearchVideosOpts {
  /** The search keyword string passed to yt-dlp's `ytsearchN:` prefix. */
  query: string;
  /** How many results to fetch (yt-dlp ranks by YouTube relevance). */
  limit?: number;
  signal?: AbortSignal;
  ytDlpPath?: string;
}

/** Query YouTube for public videos matching the keyword string. Uses
 *  yt-dlp's built-in `ytsearchN:` prefix · no API key required. Returns
 *  candidate metadata (URL, title, duration, view count, upload date)
 *  so the orchestrator can rank + pick the best clip source. */
export async function searchVideos(opts: SearchVideosOpts): Promise<VideoSearchCandidate[]> {
  const bin = opts.ytDlpPath ?? YT_DLP_BIN;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 25);
  const query = opts.query.trim();
  if (!query) return [];

  return new Promise<VideoSearchCandidate[]>((resolve, reject) => {
    const args = [
      "--dump-json",
      "--skip-download",
      "--no-warnings",
      "--default-search", "ytsearch",
      "--flat-playlist", // returns one JSON line per result without diving into related videos
      ...cookieFlags(),
      `ytsearch${limit}:${query}`,
    ];
    const child = execFile(
      bin,
      args,
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // yt-dlp returns non-zero when the search failed entirely
          // (network, captcha, geo block). Surface a useful message.
          const tail = (stderr || "").trim().slice(-400);
          reject(new Error(`yt-dlp search failed · ${tail || (err.message || "unknown error")}`));
          return;
        }
        const candidates: VideoSearchCandidate[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const info = JSON.parse(trimmed) as YtDlpInfo & { url?: string; id?: string };
            const url = (info.webpage_url || info.url || "").trim();
            const title = (info.title || "").trim();
            if (!url || !title) continue;
            candidates.push({
              url,
              title,
              durationSec: typeof info.duration === "number" ? info.duration : 0,
              viewCount: typeof info.view_count === "number" ? info.view_count : null,
              uploadDate: typeof info.upload_date === "string" ? info.upload_date : null,
              uploader: typeof info.uploader === "string" ? info.uploader : null,
              channel: typeof info.channel === "string" ? info.channel : null,
              description: typeof info.description === "string" ? info.description.slice(0, 600) : null,
            });
          } catch {
            // skip · yt-dlp occasionally emits a non-json status line on stdout
          }
        }
        resolve(candidates);
      },
    );
    if (opts.signal) {
      const onAbort = () => child.kill("SIGTERM");
      if (opts.signal.aborted) child.kill("SIGTERM");
      else opts.signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => opts.signal!.removeEventListener("abort", onAbort));
    }
  });
}

/** Heuristic penalty list · titles matching any of these are almost
 *  always parody, reactions, fan compilations, entertainment shows,
 *  or impersonation videos. Cloning from these gives you the WRONG
 *  voice (a short / common public-figure name often matches a
 *  high-view parody where someone else mimics them). -60 is large
 *  enough to push such a hit below even a low-view legitimate
 *  keynote. */
const TITLE_BLACKLIST_RE = /笑柄|话术|玩壞|玩坏|惡搞|恶搞|模仿秀|大合體|脱口秀|脫口秀|搞笑|reaction|reactions|二创|二創|偶像|mango|@艺人|@藝人|cover\b|\bMV\b|话术被玩|妙語錄|妙语录|大咖秀|混剪|合辑|合輯|混音|remix|compilation|shorts|tiktok|trolling|imitation|spoof|parody|funniest|fail/i;

/** Heuristic boost list · titles matching any of these signal a
 *  legitimate keynote / interview / lecture from the real subject.
 *  +25 lifts a low-view but high-quality talk above mid-view
 *  entertainment content. */
const TITLE_WHITELIST_RE = /TED|公开课|公開課|大学|大學|演讲|演講|keynote|发布会|發布會|年度演讲|年度演講|访谈|訪談|采访|採訪|interview|talk|lecture|宣讲|宣講|创业|創業|分享/i;

/** Tokenise a name string into search-comparable atoms. Splits on any
 *  whitespace; lowercases. Empty input → empty array. Used so a
 *  multi-token query (name + company + role keyword) can match titles
 *  that contain every token in any order. */
function tokenizeNeedle(needle: string): string[] {
  return needle
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Rank a set of search candidates by suitability for voice cloning.
 *  Prefers: titles containing every token from the celebrity needle;
 *  long-form talks (10–30 min); recent uploads; many views; pro
 *  conference / lecture markers. Penalises parody / reaction /
 *  entertainment / mashup content (a major source of wrong-voice
 *  clones). Pure heuristic · returns sorted best-first. */
export function rankSearchCandidates(
  candidates: VideoSearchCandidate[],
  opts: { celebrity: string; maxDurationSec?: number },
): VideoSearchCandidate[] {
  const maxDur = opts.maxDurationSec ?? YT_DLP_MAX_DURATION_SEC;
  const needle = opts.celebrity.trim().toLowerCase();
  const needleTokens = tokenizeNeedle(needle);
  const score = (c: VideoSearchCandidate): number => {
    let s = 0;
    const title = c.title.toLowerCase();

    // Name match · ALL tokens present (order-agnostic) is the strong
    // signal. The legacy strict substring match (+15 extra) gets us
    // back to the original behaviour for single-token queries.
    if (needleTokens.length > 0 && needleTokens.every((t) => title.includes(t))) {
      s += 40;
      if (needle.length > 0 && title.includes(needle)) s += 15;
    }

    // Duration · prefer long-form talks where the clone gets >2 min
    // of training audio without us having to stitch many segments.
    if (c.durationSec > 0) {
      if (c.durationSec >= 600 && c.durationSec <= 1800) {
        s += 30; // 10–30 min · sweet spot for a full keynote
      } else if (c.durationSec > 1800 && c.durationSec <= maxDur) {
        s += 22; // 30 min – cap · still great, just longer
      } else if (c.durationSec >= 180 && c.durationSec < 600) {
        s += 15; // 3–10 min · usable shorter talk
      } else if (c.durationSec >= 30 && c.durationSec < 180) {
        s += 5;  // 30s–3 min · barely usable
      } else if (c.durationSec > maxDur) {
        s -= 30; // exceeds the 30-min download cap upstream
      } else if (c.durationSec < 30) {
        s -= 25; // shorts · usually too little speech
      }
    }

    if (c.viewCount && c.viewCount > 10_000) s += 10;
    if (c.viewCount && c.viewCount > 1_000_000) s += 5;
    if (c.uploadDate) {
      const year = parseInt(c.uploadDate.slice(0, 4), 10);
      if (Number.isFinite(year)) {
        const age = new Date().getFullYear() - year;
        if (age <= 2) s += 8;
        else if (age <= 5) s += 4;
        else if (age >= 10) s -= 4;
      }
    }

    // Whitelist signals · a keynote / interview / lecture marker in
    // the title is strong evidence we're looking at a real talk.
    if (TITLE_WHITELIST_RE.test(c.title)) s += 25;

    // Blacklist signals · parody / entertainment / mashup content.
    // Heavy penalty so even high-view parody can't outrank a real
    // low-view keynote.
    if (TITLE_BLACKLIST_RE.test(c.title)) s -= 60;

    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a));
}

