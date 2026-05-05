/**
 * URL fetching utility for the chair's `fetch-url` system skill.
 *
 * Detects http/https URLs in recent user messages, fetches each one
 * with a tight timeout, strips HTML/scripts down to readable text,
 * and returns a compact prompt-ready block. Per-room cache keeps the
 * same URL from being fetched twice in a single session.
 *
 * v1 scope · best-effort. Failures (timeout, non-HTML content,
 * non-2xx) just emit a short note in the block; the chair can still
 * proceed without the page content. No browser-grade extraction —
 * we strip tags + collapse whitespace. Good enough for blog posts,
 * tweets/threads (after hydration is server-rendered), and most
 * news pages. Anything heavily JS-rendered will just look thin in
 * the extract; the chair sees that and asks the user to paste
 * relevant excerpts instead.
 */
import type { Message } from "../storage/messages.js";

/** Pulled out so we can stay agnostic to crawl latency · 6s gives us
 *  enough headroom for a slow CDN handshake without blocking the
 *  chair's turn. The chair's clarify call typically fits in ~10–15s
 *  end-to-end, so we want to spend at most ~half of that on a fetch. */
const FETCH_TIMEOUT_MS = 6_000;
/** Retry policy · transient failures (timeout, network reset, HTTP 5xx,
 *  HTTP 429) get retried up to this many times. Permanent failures
 *  (404, 401, 410, unsupported content-type, no readable text) bail
 *  immediately so we don't waste turn budget on hopeless URLs. */
const MAX_RETRIES = 2;
/** Backoff between attempts · short on the first retry (transient
 *  blip clears fast), longer on the second (server is genuinely
 *  slow / rate-limited and needs breathing room). */
const RETRY_BACKOFF_MS = [500, 1500];
/** Per-page text cap · the chair only needs the gist, not the
 *  pixel-perfect article. 6 KB ~ 1500 tokens, plenty for a useful
 *  excerpt while staying well under the chair's context budget even
 *  if the user shares two or three URLs. */
const MAX_TEXT_CHARS = 6_000;
/** Hard cap on URLs we'll fetch per turn so a user pasting a giant
 *  link dump doesn't fan out into a dozen parallel requests. */
const MAX_URLS_PER_TURN = 3;
/** Look back at most this many user messages for URLs · most rooms
 *  have at most one fresh URL drop per turn. */
const HISTORY_LOOKBACK = 6;

/** Conservative URL regex · http(s)://, then any non-whitespace, non-
 *  paren/bracket chars (so we don't capture trailing markdown). */
const URL_RE = /https?:\/\/[^\s<>()\[\]【】]+/gi;

const FETCH_USER_AGENT =
  "Boardroom/1.0 (+https://github.com/anthropics/boardroom · agent-research)";

/** Per-room URL → extract cache. The chair (and any future caller)
 *  pays the network cost ONCE per URL per process lifetime; subsequent
 *  fetches return the cached extract. Memory-bounded by URL count
 *  rather than time — a long-running room won't accumulate gigabytes
 *  because each entry is capped at MAX_TEXT_CHARS. */
const cache = new Map<string, string>();

export interface UrlExtract {
  url: string;
  ok: boolean;
  /** When ok=true: readable text excerpt. When ok=false: short error
   *  string the chair can surface to the user. */
  text: string;
  /** Page title when we could parse it; "" otherwise. */
  title: string;
}

/** Pull every http(s) URL from a string. Dedupes inside the string
 *  (keeps first occurrence) and trims trailing punctuation that
 *  often glues itself onto a URL in prose (`.`, `,`, `)`, `]`). */
function extractUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.match(URL_RE) || [];
  for (const raw of matches) {
    let u = raw;
    // Strip trailing punctuation that's almost never part of a URL.
    while (u.length > 0 && /[.,;:!?)\]'"》)】]/.test(u[u.length - 1])) {
      u = u.slice(0, -1);
    }
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Walk recent user messages and collect distinct URLs, newest-last.
 *  We skip non-user authors — the chair shouldn't auto-fetch its own
 *  output or a director's hallucinated URL. */
export function collectUrlsFromHistory(history: Message[]): string[] {
  const recent = history.slice(-HISTORY_LOOKBACK);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of recent) {
    if (m.authorKind !== "user" || !m.body) continue;
    for (const u of extractUrls(m.body)) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= MAX_URLS_PER_TURN) return out;
    }
  }
  return out;
}

/** Decode the basic HTML entities that sneak through tag-stripping.
 *  Not a full entity decoder — just the handful that show up in real
 *  prose (named + numeric for the common ASCII range). */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return "";
      try { return String.fromCodePoint(code); } catch { return ""; }
    });
}

/** Quick-and-dirty HTML → text · drops <script>/<style> blocks
 *  entirely (their content isn't reading material), strips remaining
 *  tags, decodes the common entities, and collapses whitespace.
 *  Picks up the page title from the first <title> tag we see. */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, " ") : "";
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Convert block-ish elements to newlines so the text still reads
    // like paragraphs after tag-stripping.
    .replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(cleaned);
  const text = decoded
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
  return { title, text };
}

/** Optional per-attempt notifier · the chair-turn flow uses this to
 *  surface "retrying example.com (2/3)…" state on the tool-use row
 *  while a flaky URL is being re-tried. Called BEFORE each retry,
 *  not before the first attempt. */
export type FetchAttemptHook = (info: {
  url: string;
  attempt: number;
  totalAttempts: number;
  reason: string;
  nextDelayMs: number;
}) => void;

/** Internal · single attempt at fetching a URL. Returns either a full
 *  extract on success or a structured failure with a `retryable` flag
 *  that the outer retry loop uses to decide whether to try again. */
type AttemptResult =
  | { kind: "ok"; extract: UrlExtract }
  | { kind: "fail"; reason: string; retryable: boolean };

async function attemptFetch(url: string): Promise<AttemptResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "user-agent": FETCH_USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
    });
    if (!r.ok) {
      // 5xx / 429 → retry. Other 4xx (404, 401, 410, …) are permanent.
      const retryable = r.status >= 500 || r.status === 408 || r.status === 425 || r.status === 429;
      return { kind: "fail", reason: `HTTP ${r.status}`, retryable };
    }
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct && !/text\/html|text\/plain|application\/xhtml/.test(ct)) {
      return {
        kind: "fail",
        reason: `unsupported content-type: ${ct.split(";")[0]}`,
        retryable: false,
      };
    }
    const raw = await r.text();
    const { title, text } = ct.includes("text/plain")
      ? { title: "", text: raw.trim() }
      : htmlToText(raw);
    if (!text) {
      // No readable text · could be a JS-rendered SPA. Retrying won't
      // change the response, so flag as permanent.
      return { kind: "fail", reason: "page returned no readable text", retryable: false };
    }
    const clipped = text.length > MAX_TEXT_CHARS
      ? text.slice(0, MAX_TEXT_CHARS).trim() + "\n\n[…truncated]"
      : text;
    return { kind: "ok", extract: { url, ok: true, title, text: clipped } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /aborted|timeout/i.test(msg);
    // Network-layer errors (timeout, ECONNRESET, EAI_AGAIN, fetch
    // failed) are all transient enough to retry. Anything else falls
    // through to the same retryable bucket since fetch() throws
    // asymmetrically across runtimes.
    return {
      kind: "fail",
      reason: isTimeout ? "timed out" : msg.slice(0, 120),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a single URL with a hard timeout + bounded retry on transient
 *  failure. Returns the extract on success, or an `ok: false` shape
 *  with a short reason on permanent failure / exhausted retries.
 *  `onAttempt` (optional) fires before each retry so callers can
 *  surface a "retrying X (N/M)…" indicator while a flaky URL bounces.
 *  Exported so the chair-turn flow can run per-URL fetches with
 *  their own message-updated SSE events (one tool-use row per URL). */
export async function fetchOne(url: string, onAttempt?: FetchAttemptHook): Promise<UrlExtract> {
  const cached = cache.get(url);
  if (cached) {
    // Cached entries already passed extraction — split title back out.
    const sep = cached.indexOf("\n\n");
    if (sep > 0) {
      return { url, ok: true, title: cached.slice(0, sep), text: cached.slice(sep + 2) };
    }
    return { url, ok: true, title: "", text: cached };
  }

  const totalAttempts = MAX_RETRIES + 1;
  let lastReason = "";
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const result = await attemptFetch(url);
    if (result.kind === "ok") {
      cache.set(url, `${result.extract.title}\n\n${result.extract.text}`);
      return result.extract;
    }
    lastReason = result.reason;
    // Bail immediately on permanent failures (404, unsupported MIME,
    // empty body) — retrying won't change the answer.
    if (!result.retryable) break;
    // Out of attempts → bail.
    if (attempt === totalAttempts) break;
    const nextDelayMs = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1];
    if (onAttempt) {
      try {
        onAttempt({ url, attempt, totalAttempts, reason: result.reason, nextDelayMs });
      } catch { /* hook errors must not break the retry loop */ }
    }
    await new Promise((res) => setTimeout(res, nextDelayMs));
  }
  return { url, ok: false, title: "", text: lastReason || "fetch failed" };
}

/** Fetch every URL in a list, in parallel, capped at MAX_URLS_PER_TURN
 *  (we trim before calling so the cap is enforced upstream too). */
export async function fetchUrls(urls: string[]): Promise<UrlExtract[]> {
  const trimmed = urls.slice(0, MAX_URLS_PER_TURN);
  if (trimmed.length === 0) return [];
  return Promise.all(trimmed.map((u) => fetchOne(u)));
}

/** Render the extracts as a system-prompt block · titled, paginated
 *  by URL, ready to paste into the chair's system message. Empty
 *  string when there are no extracts (so callers can `if (block)`). */
export function renderUrlContextBlock(extracts: UrlExtract[]): string {
  if (extracts.length === 0) return "";
  const parts: string[] = [
    "─── SHARED MATERIALS · URLS THE USER LINKED ───",
    "These are excerpts the chair fetched from URLs the user shared. Treat as user-supplied context — quote sparingly, cite by URL, and don't speculate beyond what the excerpt actually says.",
    "",
  ];
  extracts.forEach((e, i) => {
    parts.push(`### [${i + 1}] ${e.title || e.url}`);
    parts.push(`Source: ${e.url}`);
    if (e.ok) {
      parts.push("");
      parts.push(e.text);
    } else {
      parts.push(`(fetch failed: ${e.text})`);
    }
    parts.push("");
    parts.push("───");
    parts.push("");
  });
  return parts.join("\n");
}

/** Convenience wrapper · scan history → fetch → render. Returns the
 *  empty string when no URLs were found or every fetch failed without
 *  producing content. The chair calls this once per turn before
 *  building its system prompt. */
export async function buildSharedMaterialsBlock(history: Message[]): Promise<string> {
  const urls = collectUrlsFromHistory(history);
  if (urls.length === 0) return "";
  const extracts = await fetchUrls(urls);
  return renderUrlContextBlock(extracts);
}
