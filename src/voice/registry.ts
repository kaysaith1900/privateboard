import { getKey } from "../storage/keys.js";
import { getPrefs } from "../storage/prefs.js";
import { getVoiceLabelMap } from "../storage/voice-labels.js";
import {
  getActiveVoiceKeyPlaintext,
  getActiveVoiceProvider,
  type VoiceProvider,
} from "../storage/voice-credentials.js";

export interface VoiceOption {
  provider: "openai" | "minimax" | "elevenlabs" | "browser";
  model: string;
  voiceId: string;
  label: string;
  language?: string;
  configured: boolean;
}

/** The shape `listAvailableVoices` returns · adds the active provider
 *  + configured flag so the frontend can render the right empty-state
 *  copy ("no active voice provider · open Settings") without making
 *  a second call to /api/prefs. */
export interface VoiceCatalog {
  voices: VoiceOption[];
  /** Active voice provider · null when no voice credential is configured. */
  provider: VoiceProvider | null;
  /** True when a usable voice key is on file (active credential decryptable).
   *  False means the picker should show "no voice provider configured". */
  configured: boolean;
}

/** Paginated catalogue · returned by `listVoicesPage`. Adds `nextCursor`
 *  + `hasMore` so the dropdown can fetch one chunk at a time and
 *  append on scroll-to-bottom. The cursor is opaque (base64-JSON
 *  encoded server-side); the client just round-trips it without
 *  parsing. */
export interface VoicePage {
  voices: VoiceOption[];
  nextCursor: string | null;
  hasMore: boolean;
  provider: VoiceProvider | null;
  configured: boolean;
  /** Structured upstream error · present when the provider's catalogue
   *  fetch failed in a way the user can act on (missing API-key scope,
   *  invalid key, rate limit). The frontend surfaces a clear hint
   *  instead of an empty-picker state. */
  error?: VoiceFetchError;
}

export interface VoiceFetchError {
  /** Stable code the frontend keys off (e.g. for an upgrade-overlay
   *  branch). `missing_permissions` is the headline case · ElevenLabs
   *  v2/voices requires the `voices_read` API-key scope and a key
   *  generated without it 401s with `status: missing_permissions`. */
  code: "missing_permissions" | "auth_failed" | "rate_limited" | "fetch_failed";
  /** Human-readable summary in English · the frontend i18n's the
   *  outer label via `code` and uses this string for the detail
   *  line, so non-English locales still get useful upstream text. */
  message: string;
  /** Optional URL the user can open to fix the issue · for
   *  missing-scope this is the ElevenLabs API-key management page. */
  fixUrl?: string;
  /** Provider that produced the error · so the frontend can label
   *  the CTA ("Update ElevenLabs API key permissions"). */
  provider: VoiceProvider;
}

function minimaxBaseUrl(): string {
  const region = getPrefs().minimaxRegion;
  return region === "intl"
    ? "https://api.minimax.io"
    : "https://api.minimaxi.com";
}

const OPENAI_VOICES: VoiceOption[] = [
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "marin", label: "Marin", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "cedar", label: "Cedar", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", label: "Alloy", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "nova", label: "Nova", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "onyx", label: "Onyx", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "shimmer", label: "Shimmer", configured: false },
];

// Built-in library voices · seed defaults so the picker has something
// the moment the user adds an ElevenLabs key, before the dynamic
// /v2/voices fetch round-trips (or when it fails / is blocked by the
// network). These are "premade" voices in ElevenLabs's catalogue —
// paid plans synthesize them fine; free-tier API hits return 402
// `paid_plan_required` which synthesizeElevenLabs translates into a
// human-readable "library voices need a paid plan" message. The picker
// stays populated regardless of plan tier; the failure surface is at
// preview/play time, where the error message is actionable.
const ELEVENLABS_DEFAULT_VOICES: VoiceOption[] = [
  {
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    label: "Rachel",
    language: "en",
    configured: false,
  },
  {
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    label: "George",
    language: "en",
    configured: false,
  },
];

const MINIMAX_SYSTEM_VOICES: VoiceOption[] = [
  // China mainland voiceIds (api.minimaxi.com)
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-qingse", label: "青涩青年", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-shaonv", label: "少女", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-yujie", label: "御姐", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-jingying", label: "精英青年", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-chengshu", label: "成熟女性", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-tianmei", label: "甜美女性", language: "zh", configured: false },
];

/** Synchronous seed list · routes through the ACTIVE voice credential
 *  only, so MiniMax + ElevenLabs voices never coexist in the same
 *  picker. OpenAI (still keyed via `provider_keys`) is included when
 *  configured · it lives in `provider_keys` because each user has at
 *  most one OpenAI account, so it never needed the multi-instance
 *  upgrade. Browser fallback is always last. */
export function listConfiguredVoices(): VoiceOption[] {
  const out: VoiceOption[] = [];
  const openaiReady = !!getKey("openai");
  if (openaiReady) out.push(...OPENAI_VOICES.map((v) => ({ ...v, configured: true })));

  const activeProvider = getActiveVoiceProvider();
  if (activeProvider === "minimax") {
    out.push(...MINIMAX_SYSTEM_VOICES.map((v) => ({ ...v, configured: true })));
  } else if (activeProvider === "elevenlabs") {
    out.push(...ELEVENLABS_DEFAULT_VOICES.map((v) => ({ ...v, configured: true })));
  }

  out.push({
    provider: "browser",
    model: "speechSynthesis",
    voiceId: "system-default",
    label: "Browser default",
    configured: true,
  });
  return out;
}

/* ───── Pagination cursor encoding ─────
 *
 * Opaque to the frontend · base64-JSON internally so the server can
 * carry either an ElevenLabs `next_page_token` (true API pagination)
 * or a MiniMax slice `offset` (cache + slice, since MiniMax's API is
 * single-shot) in the same field. */
interface ParsedCursor {
  /** "el" → ElevenLabs slice offset · "mm" → MiniMax slice offset.
   *  Both providers now use cache-and-slice rather than passing raw
   *  upstream tokens through · for ElevenLabs the cache merges three
   *  sources (v2 + /v1/shared-voices + seed floor) so a single
   *  upstream token can't represent the full position anyway. */
  src: "el" | "mm";
  offset?: number;
}

function encodeCursor(c: ParsedCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(s: string | null | undefined): ParsedCursor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as ParsedCursor;
    if (obj && (obj.src === "el" || obj.src === "mm")) return obj;
  } catch { /* fall through */ }
  return null;
}

/* ───── ElevenLabs v2 paged fetch ─────
 *
 * Walks every page of /v2/voices, accumulating into a flat list. The
 * endpoint replaces the legacy /v1/voices personal-library call, and
 * the v2 response shape (`voices`, `has_more`, `next_page_token`)
 * matches what we need for pagination. Used by `fetchAllElevenLabsVoices`
 * below as one of the three input sources (v2 + v1/shared + seeds). */
interface ElevenLabsFetchResult {
  voices: VoiceOption[];
  /** Structured error · null on success or when the network error
   *  isn't actionable (e.g. timeout · we just return the partial
   *  voices we got). */
  error: VoiceFetchError | null;
}

/** Inspect a non-2xx response body for ElevenLabs's structured error
 *  shape and translate to a `VoiceFetchError`. The 401 `missing_permissions`
 *  case is the headline one (API key was created without `voices_read`
 *  scope); other auth / rate-limit responses get coarser codes so the
 *  frontend can still render a useful hint. */
function classifyElevenLabsError(status: number, body: string): VoiceFetchError {
  let parsed: { detail?: { status?: string; message?: string } } | null = null;
  try { parsed = JSON.parse(body); } catch { /* body wasn't JSON */ }
  const detail = parsed?.detail;
  const upstreamStatus = typeof detail?.status === "string" ? detail.status : "";
  const upstreamMessage = typeof detail?.message === "string"
    ? detail.message
    : body.slice(0, 200);

  if (status === 401 && upstreamStatus === "missing_permissions") {
    return {
      code: "missing_permissions",
      provider: "elevenlabs",
      message: upstreamMessage,
      // Direct link to the API-key management page · "Update key
      // permissions" is what the user needs to do, and ElevenLabs's
      // settings page surfaces the scope checkboxes prominently.
      fixUrl: "https://elevenlabs.io/app/settings/api-keys",
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: "auth_failed",
      provider: "elevenlabs",
      message: upstreamMessage,
      fixUrl: "https://elevenlabs.io/app/settings/api-keys",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      provider: "elevenlabs",
      message: upstreamMessage,
    };
  }
  return {
    code: "fetch_failed",
    provider: "elevenlabs",
    message: `HTTP ${status}: ${upstreamMessage}`,
  };
}

async function fetchAllElevenLabsV2Voices(apiKey: string): Promise<ElevenLabsFetchResult> {
  const out: VoiceOption[] = [];
  let token: string | null = null;
  let lastError: VoiceFetchError | null = null;
  // Cap at 20 pages × 100 = 2000 voices · plenty for any realistic
  // account, and the cap exists only as a runaway guard in case the
  // upstream API ever loops on tokens.
  for (let i = 0; i < 20; i++) {
    const url = new URL("https://api.elevenlabs.io/v2/voices");
    url.searchParams.set("page_size", "100");
    if (token) url.searchParams.set("next_page_token", token);
    try {
      const res = await fetch(url.toString(), {
        headers: { "xi-api-key": apiKey },
      });
      if (!res.ok) {
        const errText = await res.text();
        process.stderr.write(
          `[voice-registry] elevenlabs /v2/voices HTTP ${res.status}: ${errText.slice(0, 300)}\n`,
        );
        lastError = classifyElevenLabsError(res.status, errText);
        break;
      }
      const json = (await res.json()) as {
        voices?: unknown;
        has_more?: unknown;
        next_page_token?: unknown;
      };
      const rows = elevenLabsV2VoiceRows(json.voices);
      // Sort so user-owned voices (cloned / professional) land before
      // platform-supplied premade ones. ElevenLabs v2 returns them
      // mixed; the picker UX is much better when "your voices" are at
      // the top of the dropdown.
      rows.sort((a, b) => elevenLabsCategoryRank(a.category) - elevenLabsCategoryRank(b.category));
      for (const r of rows) {
        out.push({
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          voiceId: r.voiceId,
          label: r.label,
          language: r.category,
          configured: true,
        });
      }
      const nextToken =
        json.has_more === true && typeof json.next_page_token === "string"
          ? json.next_page_token
          : null;
      if (!nextToken) break;
      token = nextToken;
    } catch (e) {
      const cause = e instanceof Error ? (e as { cause?: { message?: string } }).cause : null;
      const detail = cause?.message ? `: ${cause.message}` : "";
      process.stderr.write(
        `[voice-registry] elevenlabs /v2/voices fetch failed${detail} · ${e instanceof Error ? e.message : String(e)}\n`,
      );
      lastError = {
        code: "fetch_failed",
        provider: "elevenlabs",
        message: e instanceof Error ? e.message : String(e),
      };
      break;
    }
  }
  process.stderr.write(
    `[voice-registry] elevenlabs /v2/voices · ${out.length} voices total across all pages\n`,
  );
  return { voices: out, error: lastError };
}

function elevenLabsCategoryRank(category: string): number {
  if (category === "cloned" || category === "professional") return 0;
  if (category === "generated") return 2;
  return 1; // premade / voice / unknown
}

function elevenLabsV2VoiceRows(
  raw: unknown,
): Array<{ voiceId: string; label: string; category: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ voiceId: string; label: string; category: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const voiceId = typeof obj.voice_id === "string" ? obj.voice_id : "";
    if (!voiceId) continue;
    const label = typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : voiceId;
    const category = typeof obj.category === "string" && obj.category.trim()
      ? obj.category.trim()
      : "voice";
    out.push({ voiceId, label, category });
  }
  return out;
}

/* ───── ElevenLabs cache · the canonical voice list comes solely from
 * /v2/voices. Older sources have known problems on current accounts:
 *   · /v1/shared-voices · Voice Library voices are NOT available to
 *     free tier accounts via the API (per ElevenLabs docs). Free-tier
 *     users were the dominant case where this returned empty, leaving
 *     only the seed floor on screen.
 *   · Hardcoded "Default voices" (Rachel / George) · ElevenLabs is
 *     phasing out the legacy Default voices on 2026-12-31. Default
 *     voices are only accessible to accounts created BEFORE 2026-03,
 *     so a brand-new account would see "Rachel / George" in the
 *     picker but synthesis would 404. We drop the seed mix-in so the
 *     picker reflects truth · empty when the account genuinely has
 *     no voices, populated when it does.
 * Cache is 5 minutes. Pagination at the route layer slices the cached
 * list. ELEVENLABS_DEFAULT_VOICES is still referenced by the synchronous
 * `listConfiguredVoices` path (used as a placeholder voiceId for agent
 * voice assignment); replacing those with newer IDs is a separate
 * upgrade. */
const ELEVENLABS_CACHE_TTL_MS = 5 * 60 * 1000;
interface ElevenLabsCacheEntry {
  voices: VoiceOption[];
  expiresAt: number;
}
const elevenLabsCache = new Map<string, ElevenLabsCacheEntry>();

function elevenLabsCacheKey(apiKey: string): string {
  return apiKey.slice(0, 8);
}

async function getElevenLabsVoicesCached(apiKey: string): Promise<ElevenLabsFetchResult> {
  const key = elevenLabsCacheKey(apiKey);
  const cached = elevenLabsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { voices: cached.voices, error: null };
  }
  const result = await fetchAllElevenLabsV2Voices(apiKey);
  process.stderr.write(
    `[voice-registry] elevenlabs catalogue · ${result.voices.length} voices from /v2/voices${result.error ? ` (error: ${result.error.code})` : ""}\n`,
  );
  // Only cache when the fetch succeeded · caching an error result
  // would force the user to wait the full TTL after they fix their
  // API-key permissions before the picker re-tries.
  if (!result.error) {
    elevenLabsCache.set(key, { voices: result.voices, expiresAt: Date.now() + ELEVENLABS_CACHE_TTL_MS });
  }
  return result;
}

/* ───── MiniMax cache · the /v1/get_voice endpoint is single-shot
 * (returns the full catalogue in one response), so we cache the
 * normalised list for 5 minutes and serve paged slices from memory.
 * Subsequent picker opens within the TTL window pay zero network.
 * Cache key is the first 8 chars of the API key so a credential
 * swap invalidates naturally without holding plaintext in memory. */
const MINIMAX_CACHE_TTL_MS = 5 * 60 * 1000;
interface MiniMaxCacheEntry {
  voices: VoiceOption[];
  expiresAt: number;
}
const miniMaxCache = new Map<string, MiniMaxCacheEntry>();

function miniMaxCacheKey(apiKey: string): string {
  return apiKey.slice(0, 8);
}

async function fetchAllMiniMaxVoices(apiKey: string): Promise<VoiceOption[]> {
  try {
    const res = await fetch(`${minimaxBaseUrl()}/v1/get_voice`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ voice_type: "all" }),
    });
    if (!res.ok) {
      return MINIMAX_SYSTEM_VOICES.map((v) => ({ ...v, configured: true }));
    }
    const json = (await res.json()) as Record<string, unknown>;
    // Cloned voices first so the user's recently-added customs land at
    // the top of the picker (we re-render this catalogue right after a
    // successful clone). System voices follow; generated stays last.
    const rows = [
      ...voiceRows(json.voice_cloning, "clone"),
      ...voiceRows(json.system_voice, "system"),
      ...voiceRows(json.voice_generation, "generated"),
    ];
    if (rows.length === 0) {
      return MINIMAX_SYSTEM_VOICES.map((v) => ({ ...v, configured: true }));
    }
    return rows.map((r) => ({
      provider: "minimax" as const,
      model: "speech-2.8-hd",
      voiceId: r.voiceId,
      label: r.label,
      language: r.kind,
      configured: true,
    }));
  } catch {
    return MINIMAX_SYSTEM_VOICES.map((v) => ({ ...v, configured: true }));
  }
}

async function getMiniMaxVoicesCached(apiKey: string): Promise<VoiceOption[]> {
  const key = miniMaxCacheKey(apiKey);
  const cached = miniMaxCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.voices;
  const voices = await fetchAllMiniMaxVoices(apiKey);
  miniMaxCache.set(key, { voices, expiresAt: Date.now() + MINIMAX_CACHE_TTL_MS });
  return voices;
}

const BROWSER_FALLBACK: VoiceOption = {
  provider: "browser",
  model: "speechSynthesis",
  voiceId: "system-default",
  label: "Browser default",
  configured: true,
};

/* ───── Paged catalogue ─────
 *
 * Returns one chunk of the catalogue plus a cursor for the next.
 * The FIRST page (cursor === null) leads with the static OpenAI
 * voices (if configured) so the user always has fast, cheap defaults
 * even before the network round-trip for ElevenLabs / MiniMax. The
 * browser fallback is appended on the LAST page so it sits at the
 * very bottom of the list regardless of provider pagination depth. */
export async function listVoicesPage(
  cursorStr: string | null,
  pageSize: number,
): Promise<VoicePage> {
  const size = Math.min(Math.max(pageSize | 0 || 30, 5), 100);
  const cursor = decodeCursor(cursorStr);
  const isFirstPage = cursor === null;

  const activeProvider = getActiveVoiceProvider();
  const fixed: VoiceOption[] = [];
  if (isFirstPage && getKey("openai")) {
    fixed.push(...OPENAI_VOICES.map((v) => ({ ...v, configured: true })));
  }

  // No active provider · only fixed + browser, one page total.
  if (!activeProvider) {
    return {
      voices: [...fixed, BROWSER_FALLBACK],
      nextCursor: null,
      hasMore: false,
      provider: null,
      configured: false,
    };
  }

  const activeKey = getActiveVoiceKeyPlaintext();
  if (!activeKey) {
    // Provider configured but key undecryptable · single fast page.
    return {
      voices: [...fixed, BROWSER_FALLBACK],
      nextCursor: null,
      hasMore: false,
      provider: activeProvider,
      configured: false,
    };
  }

  if (activeProvider === "elevenlabs") {
    const { voices: all, error } = await getElevenLabsVoicesCached(activeKey);
    const offset = cursor && cursor.src === "el" ? (cursor.offset ?? 0) : 0;
    const slice = mergeCustomLabels(all.slice(offset, offset + size));
    const next = offset + slice.length;
    const hasMore = next < all.length;
    const nextCursor = hasMore ? encodeCursor({ src: "el", offset: next }) : null;
    const voices = [...fixed, ...slice];
    if (!hasMore) voices.push(BROWSER_FALLBACK);
    return {
      voices,
      nextCursor,
      hasMore,
      provider: "elevenlabs",
      configured: true,
      // Only attach the error to the FIRST page response · subsequent
      // pages (offset > 0) won't fire if the first page errored
      // (voices is empty so hasMore is false), but defensive.
      ...(error && offset === 0 ? { error } : {}),
    };
  }

  if (activeProvider === "minimax") {
    const all = await getMiniMaxVoicesCached(activeKey);
    const offset = cursor && cursor.src === "mm" ? (cursor.offset ?? 0) : 0;
    const slice = mergeCustomLabels(all.slice(offset, offset + size));
    const next = offset + slice.length;
    const hasMore = next < all.length;
    const nextCursor = hasMore ? encodeCursor({ src: "mm", offset: next }) : null;
    const voices = [...fixed, ...slice];
    if (!hasMore) voices.push(BROWSER_FALLBACK);
    return { voices, nextCursor, hasMore, provider: "minimax", configured: true };
  }

  // Unknown provider (future addition) · degrade gracefully.
  return {
    voices: [...fixed, BROWSER_FALLBACK],
    nextCursor: null,
    hasMore: false,
    provider: activeProvider,
    configured: true,
  };
}

/** Overlay user-typed voice labels (from the `voice_labels` table)
 *  onto the catalogue rows. Provider-side names win when distinct
 *  from voice_id (user renamed in MiniMax / ElevenLabs dashboard);
 *  otherwise the persisted label from our clone modal takes over so
 *  the picker shows "Chloe" instead of `Chloe_l5xqf0`. */
function mergeCustomLabels(voices: VoiceOption[]): VoiceOption[] {
  // Lazy import to avoid a top-level dep cycle (registry ← labels ← db).
  // Returning the same array shape lets callers stay agnostic.
  const ids = voices.map((v) => v.voiceId).filter((id): id is string => !!id);
  if (ids.length === 0) return voices;
  const labelMap = getVoiceLabelMap(ids);
  if (labelMap.size === 0) return voices;
  return voices.map((v) => {
    const custom = v.voiceId ? labelMap.get(v.voiceId) : undefined;
    if (!custom) return v;
    // Provider-side rename wins · their label is distinct from
    // voice_id and the user clearly edited it on the dashboard.
    if (v.label && v.label !== v.voiceId) return v;
    return { ...v, label: custom };
  });
}

/** Manually drop cached voice catalogues · called when a credential is
 *  added / swapped / removed so the next picker open re-fetches. Clears
 *  both ElevenLabs and MiniMax caches; harmless if either is already
 *  empty. */
export function invalidateVoicesCache(): void {
  miniMaxCache.clear();
  elevenLabsCache.clear();
}

/* ───── Full-list catalogue (legacy / non-paged callers) ─────
 *
 * `voice-replay.js` + `app.js _prefetchVoiceLabels` both want a
 * complete snapshot for label-resolution / availability gating, not
 * paginated UI. Walk every page until `nextCursor === null` and
 * concatenate. The page size is 100 to minimise round-trips on
 * accounts with many voices · with MiniMax's cache + ElevenLabs v2
 * paging, this completes in one or a few HTTP calls. */
export async function listAvailableVoices(): Promise<VoiceCatalog> {
  const voices: VoiceOption[] = [];
  let cursor: string | null = null;
  let provider: VoiceProvider | null = null;
  let configured = false;
  // Hard cap · 50 pages × 100 = 5000 voices ceiling. Far above any
  // realistic ElevenLabs / MiniMax account; the cap exists only as
  // a runaway guard in case the upstream API ever loops on tokens.
  for (let i = 0; i < 50; i++) {
    const page: VoicePage = await listVoicesPage(cursor, 100);
    voices.push(...page.voices);
    provider = page.provider;
    configured = page.configured;
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { voices, provider, configured };
}

function voiceRows(raw: unknown, kind: string): Array<{ voiceId: string; label: string; kind: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ voiceId: string; label: string; kind: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const voiceId = typeof obj.voice_id === "string" ? obj.voice_id : "";
    if (!voiceId) continue;
    const label = typeof obj.voice_name === "string" && obj.voice_name.trim()
      ? obj.voice_name.trim()
      : voiceId;
    out.push({ voiceId, label, kind });
  }
  return out;
}

export function defaultVoiceForProvider(provider: string): VoiceOption | null {
  return listConfiguredVoices().find((v) => v.provider === provider) ?? listConfiguredVoices()[0] ?? null;
}
