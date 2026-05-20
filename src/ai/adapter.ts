/**
 * LLM adapter · single typed surface for the rest of the codebase.
 *
 *   callLLMStream(req)  →  AsyncGenerator<LLMStreamChunk>
 *
 * Resolves modelV → direct provider key (preferred) → openrouter (fallback)
 * → throws NoKeyError. Wraps Vercel AI SDK's streamText, but the rest of
 * the app only sees our typed yields and never imports `ai` directly.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, streamText, type LanguageModel, type ProviderMetadata } from "ai";

import { getLlmCredentialKey, getLlmCredentialMeta } from "../storage/credentials.js";
import { getPrefs } from "../storage/prefs.js";

import { getModel, type ModelMeta, type ModelV, type Provider } from "./registry.js";

/** Carrier identity used by ResolvedModel and the fallback-retry logic.
 *  The narrow `Provider` from registry covers only model-creators
 *  (anthropic / openai / google / xai / deepseek); we widen it here so
 *  universal carriers (openrouter / bai) can also appear. */
type CarrierId = Provider | "openrouter" | "bai";

export type LLMRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

/** Carrier override for a single LLM call. Same shape / values as
 *  AgentCarrierPref in storage/agents.ts (kept structurally compatible
 *  rather than re-importing to avoid the storage→ai dep). When set,
 *  resolveModel routes via that carrier instead of the default
 *  precedence rules. NULL/undefined preserves the historical behavior. */
export type RequestCarrier = "openrouter" | "bai" | "anthropic" | "openai" | "google" | "xai" | "moonshot" | "zhipu";

export interface LLMRequest {
  modelV: ModelV;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Optional carrier override (per-agent or per-call). Falls back to
   *  the default precedence when null/undefined or when the requested
   *  carrier has no usable key. */
  carrier?: RequestCarrier | null;
}

export type LLMStreamChunk =
  | { type: "text"; delta: string }
  | { type: "served"; modelId: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "done"; finishReason?: string }
  | { type: "error"; message: string };

export class NoKeyError extends Error {
  constructor(public provider: Provider) {
    super(
      `No key configured for "${provider}", and no OpenRouter fallback is set. ` +
        `Add a key in Preference → API Key.`,
    );
    this.name = "NoKeyError";
  }
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const BAI_BASE = "https://api.b.ai/v1";

/** Header names whose values must NOT print verbatim — they carry the
 *  user's API key. Different providers use different header names; the
 *  list below covers the four we currently call:
 *    Authorization      · OpenAI / OpenRouter / xAI (Bearer scheme)
 *    x-api-key          · Anthropic
 *    x-goog-api-key     · Google Gemini direct
 *    api-key            · misc (Azure-style)
 *  Match is case-insensitive. Value is replaced with a short fingerprint
 *  (`****<last 4>`) so the user can still tell two keys apart in logs
 *  without leaking the secret. */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
]);

function redactHeaderValue(name: string, value: string): string {
  if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) return value;
  // Strip "Bearer " prefix when present so the fingerprint shows the
  // key tail rather than the scheme tail.
  const v = value.replace(/^Bearer\s+/i, "");
  const tail = v.slice(-4);
  return tail ? `****${tail}` : "****";
}

/**
 * fetch wrapper that prints every request/response to stderr — lets the
 * developer console verify exactly what `model`, `temperature`, etc. went
 * on the wire when debugging "selected X but got Y" or "no tokens" bugs.
 * Sensitive headers (Authorization / x-api-key / x-goog-api-key /
 * api-key) are redacted to a `****<last 4>` fingerprint so two keys can
 * still be told apart in logs without leaking secrets. SSE response
 * bodies are tee'd into stderr as they arrive — every chunk gets
 * forwarded through unchanged.
 */
function makeLoggedFetch(tag: string): typeof fetch {
  return function loggedFetch(input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));

    const headerLines: string[] = [];
    headers.forEach((v, k) => {
      headerLines.push(`  ${k}: ${redactHeaderValue(k, v)}`);
    });

    let bodyPretty = "";
    if (init?.body && typeof init.body === "string") {
      try {
        bodyPretty = JSON.stringify(JSON.parse(init.body), null, 2);
      } catch {
        bodyPretty = init.body.length > 2000 ? init.body.slice(0, 2000) + "…" : init.body;
      }
    }

    const sep = "─".repeat(60);
    // Request log · explicit "headers:" / "body:" sub-labels make the
    // sections legible at a glance. Empty headers (which happens when
    // an SDK builds the request in a way Headers.forEach doesn't see)
    // get an explicit "(no headers)" line rather than going silent.
    const headerBlock = headerLines.length > 0
      ? `│   headers:\n` + headerLines.map((l) => `│ ${l}`).join("\n")
      : `│   headers: (none observed at fetch layer)`;
    const bodyBlock = bodyPretty
      ? `│\n│   body:\n` + bodyPretty.split("\n").map((l) => `│   ${l}`).join("\n")
      : `│\n│   body: (empty)`;
    process.stderr.write(
      `\n┌${sep}\n│ [${tag} →] ${method} ${url}\n` +
        headerBlock +
        `\n` +
        bodyBlock +
        `\n└${sep}\n`,
    );

    const t0 = Date.now();
    return fetch(input, init).then(async (res) => {
      const ms = Date.now() - t0;
      const resHeaderLines: string[] = [];
      res.headers.forEach((v, k) => resHeaderLines.push(`  ${k}: ${v}`));
      const ct = res.headers.get("content-type") ?? "";
      const isStream = /event-stream/i.test(ct);

      // Response logging policy · headers + status always print so the
      // user can confirm the request landed at the right endpoint with
      // the right model. Body printing is selective:
      //   · non-streaming · pretty-print (typical 4xx error JSON shape).
      //   · streaming · SKIP. Tee'ing every SSE chunk made the logs
      //     unreadable (each call dumped hundreds of `text-delta` lines).
      //     The request body already shows what we sent; the visible
      //     stream output ends up in the chat itself; that's enough
      //     for verification. If we ever need raw stream forensics,
      //     re-enable behind a debug flag.
      let resBodyPretty = "";
      if (!isStream) {
        try {
          const text = await res.clone().text();
          if (text) {
            try {
              resBodyPretty = JSON.stringify(JSON.parse(text), null, 2);
            } catch {
              resBodyPretty = text.length > 2000 ? text.slice(0, 2000) + "…" : text;
            }
          }
        } catch {
          // best-effort log — never let logging break the call
        }
      }
      const resHeaderBlock = resHeaderLines.length > 0
        ? `│   headers:\n` + resHeaderLines.map((l) => `│ ${l}`).join("\n")
        : `│   headers: (none)`;
      const resBodyBlock = isStream
        ? `│\n│   body: (text/event-stream · stream content not logged)`
        : resBodyPretty
          ? `│\n│   body:\n` + resBodyPretty.split("\n").map((l) => `│   ${l}`).join("\n")
          : `│\n│   body: (empty)`;
      process.stderr.write(
        `\n┌${sep}\n│ [${tag} ←] ${res.status} · ${ms}ms\n` +
          resHeaderBlock +
          `\n` +
          resBodyBlock +
          `\n└${sep}\n`,
      );

      // Stream body is forwarded unchanged · we no longer tee it. The
      // SDK's own consumer reads it and emits `text-delta` parts that
      // surface to the orchestrator, which is the better seam for any
      // stream-shape diagnostics.
      return res;
    });
  };
}

const loggedFetch = makeLoggedFetch("openrouter");

/**
 * Format an upstream error so the verify modal (and any other caller) sees
 * the actual provider response — not just "HTTP 400". OpenRouter's body
 * carries the real diagnostic ("model not found", "no allowed providers",
 * quota messages, …); without surfacing it the user just sees a status
 * code and has to dig through the OR Activity tab.
 */
function formatStreamError(e: unknown): string {
  if (APICallError.isInstance(e)) {
    const parts: string[] = [];
    if (e.statusCode != null) parts.push(`HTTP ${e.statusCode}`);
    const data = e.data as
      | { error?: { message?: string; type?: string; code?: string | number } }
      | undefined;
    const inner = data?.error;
    if (inner?.message) {
      parts.push(inner.message);
      const meta = [
        inner.type,
        inner.code != null ? `code=${inner.code}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (meta) parts.push(`(${meta})`);
    } else if (e.responseBody) {
      // Cap raw body to keep an HTML error page from blowing up the modal.
      const trimmed =
        e.responseBody.length > 800
          ? e.responseBody.slice(0, 800) + "…"
          : e.responseBody;
      parts.push(trimmed);
    } else {
      parts.push(e.message);
    }
    return parts.join("\n");
  }
  if (e instanceof Error) return e.message;
  // Plain-object error shape · this is what the Responses API SSE
  // `error` event becomes after the SDK parses it (a value, not an
  // exception). Looks like:
  //   { type: "error", error: { type, code, message, param }, sequence_number }
  // Pull `error.message` first; fall back to `message` at the top level
  // so we never silently devolve to `String(obj) = "[object Object]"`.
  if (e && typeof e === "object") {
    const obj = e as {
      error?: { message?: string; type?: string; code?: string | number };
      message?: string;
      type?: string;
      code?: string | number;
    };
    const inner = obj.error;
    if (inner?.message) {
      const meta = [inner.type, inner.code != null ? `code=${inner.code}` : null]
        .filter(Boolean)
        .join(" · ");
      return meta ? `${inner.message} (${meta})` : inner.message;
    }
    if (obj.message) {
      const meta = [obj.type, obj.code != null ? `code=${obj.code}` : null]
        .filter(Boolean)
        .join(" · ");
      return meta ? `${obj.message} (${meta})` : obj.message;
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return String(e);
}

interface ResolvedModel {
  model: LanguageModel;
  providerOptions?: ProviderMetadata;
  /** Which carrier this resolution chose · used by `callLLMStream` to
   *  exclude the failing carrier on fallback retry when the upstream
   *  rejects with an access-denied / payment-required error. */
  carrier: CarrierId;
}

/** Resolve which model + which credentials to use right now.
 *
 *  Under the single-active-LLM-provider invariant, the user has exactly
 *  one configured LLM provider. Routing is deterministic:
 *
 *    1. multi-model active (openrouter / bai) → that carrier, provided
 *       the model carries the matching carrier id.
 *    2. single-model active (anthropic / openai / google / xai) →
 *       direct SDK, provided the model's family matches.
 *    3. no key configured → NoKeyError.
 *
 *  The `carrier` parameter is accepted but ignored under single-active
 *  — there's no other carrier to switch to. Older `agent.carrierPref`
 *  values are no-ops here; reconcileAgentModels() clears them on the
 *  next reconcile pass.
 *
 *  The `excludeCarriers` parameter is also accepted-but-ignored — the
 *  carrier-rotation retry it once supported has been removed (there's
 *  only one carrier under single-active; rotation is meaningless).
 */
function resolveModel(
  modelV: ModelV,
  _carrier?: RequestCarrier | null,
  _excludeCarriers?: Set<CarrierId>,
): ResolvedModel {
  void _carrier; void _excludeCarriers;
  const meta = getModel(modelV);
  // Multi-instance credentials · the user's prefs name an active
  // credential id; resolve through it to the provider + key in one
  // step. Stale prefs (credential deleted out-from-under) fall
  // through to NoKeyError so the orchestrator can surface a clean
  // "configure a key" message.
  const credId = getPrefs().activeLlmCredentialId;
  if (!credId) throw new NoKeyError(meta.provider);
  const credMeta = getLlmCredentialMeta(credId);
  const key = getLlmCredentialKey(credId);
  if (!credMeta || !key) throw new NoKeyError(meta.provider);
  const p = credMeta.provider;

  if (p === "openrouter") {
    if (!meta.openrouterId) throw new NoKeyError(meta.provider);
    process.stderr.write(`[adapter] modelV=${modelV} → openrouter:${meta.openrouterId} (cred:${credMeta.label})\n`);
    return openRouterResolved(meta, key);
  }
  if (p === "bai") {
    if (!meta.baiId) throw new NoKeyError(meta.provider);
    process.stderr.write(`[adapter] modelV=${modelV} → bai:${meta.baiId} (cred:${credMeta.label})\n`);
    return baiResolved(meta, key);
  }
  // Single-model active provider · the model's family must match. xAI
  // currently has no MODELS rows so this branch never executes for it,
  // but the check stays so a future Grok entry routes cleanly.
  if (meta.provider !== p || meta.viaUniversalOnly) {
    throw new NoKeyError(meta.provider);
  }
  process.stderr.write(`[adapter] modelV=${modelV} → direct:${meta.provider}/${meta.directApiId} (cred:${credMeta.label})\n`);
  return directResolved(meta, key);
}

function directResolved(meta: ModelMeta, apiKey: string): ResolvedModel {
  switch (meta.provider) {
    case "anthropic":
      // fetch: makeLoggedFetch("anthropic") · uniform request/response
      // logging across every direct provider (matches openai / google /
      // xai / openrouter). Auth header (`x-api-key`) is redacted by
      // SENSITIVE_HEADER_NAMES in the logger.
      return {
        model: createAnthropic({ apiKey, fetch: makeLoggedFetch("anthropic") })(meta.directApiId),
        carrier: "anthropic",
      };
    case "openai":
      // Route OpenAI direct calls through the Responses API
      // (`/v1/responses`), not the legacy Chat Completions endpoint.
      // Per OpenAI's own docs, GPT-5 and o-series reasoning models
      // "perform better and demonstrate higher intelligence when used
      // with the Responses API". The SDK adapts our messages[] shape
      // into the Responses `input` shape internally — caller surface
      // is unchanged. OpenRouter (OpenAI-compatible chat-completions
      // protocol) is unaffected; this only switches the direct path.
      //
      // reasoningEffort: "none" · the GPT-5.x family defaults to
      // `reasoning.effort = "medium"`, which spends a sizable chunk of
      // `max_output_tokens` on internal reasoning before emitting any
      // visible text. With our picker calls capped at 100-320 tokens
      // and director turns at 4000, a medium-effort reasoning trace
      // routinely consumes the entire budget — finishing with zero
      // output_text and an empty placeholder that gets dropped. We
      // want chat-style responses, not extended reasoning, so pin
      // effort to "none" across all OpenAI direct calls. Increase
      // per-callsite if a specific surface needs deeper thinking.
      //
      // Vocabulary note · GPT-5.5 / 5.4 / 5.4-mini accept
      // `none | low | medium | high | xhigh`. The legacy `minimal`
      // value (which the older `gpt-5` accepted) is rejected here —
      // hence "none". If we ever bring back a model on the old
      // vocabulary, swap per-model based on a registry flag rather
      // than per-call.
      //
      // fetch: makeLoggedFetch("openai") · same SSE-teeing logger as
      // the OpenRouter path. Direct OpenAI was previously a black box;
      // we now print every request body + response chunks to stderr
      // for diagnosability ("no tokens" / "wrong model" / 4xx errors).
      return {
        model: createOpenAI({ apiKey, fetch: makeLoggedFetch("openai") }).responses(meta.directApiId),
        providerOptions: {
          openai: { reasoningEffort: "none" },
        },
        carrier: "openai",
      };
    case "google":
      // Gemini 2.5+ ships as a reasoning model (built-in "thinking"
      // mode). Like GPT-5's reasoning.effort, the thinking trace
      // consumes the same `maxOutputTokens` budget the visible reply
      // draws from — at default settings the model burns ~1-3k tokens
      // on internal thoughts before any text-delta emerges. Picker
      // calls capped at 100-320 tokens get truncated mid-thought
      // (zero visible output), and director turns at 4000 produce
      // a few words before hitting the cap.
      //
      // thinkingBudget: 0 disables thinking entirely (chat-style
      // fast responses). Per the SDK schema this is the documented
      // way to opt out — passing it as `providerOptions.google
      // .thinkingConfig.thinkingBudget`. Bump per-callsite if a
      // surface needs reasoning.
      //
      // fetch: makeLoggedFetch("google") · same SSE-teeing logger
      // as OpenAI / OpenRouter — every request body + stream chunk
      // hits stderr for "no tokens" / "wrong model" diagnostics.
      return {
        model: createGoogleGenerativeAI({ apiKey, fetch: makeLoggedFetch("google") })(meta.directApiId),
        providerOptions: {
          google: { thinkingConfig: { thinkingBudget: 0 } },
        },
        carrier: "google",
      };
    case "xai": {
      // xAI's current frontier (Grok 4.x) is served on the Responses
      // API at https://api.x.ai/v1/responses — the SAME shape as
      // OpenAI's Responses API (model + input + output_text deltas),
      // just a different host. The legacy `@ai-sdk/xai` package only
      // hits `/v1/chat/completions`, so direct Grok 4.x calls were
      // failing with model-not-found / 4xx. We bypass the xAI SDK and
      // reuse `@ai-sdk/openai`'s Responses client with xAI's baseURL.
      //
      // No reasoningEffort here · xAI's reasoning is toggled via a
      // model-ID suffix (e.g. `grok-4.3-reasoning`) per their docs,
      // not via the OpenAI-style `reasoning.effort` parameter. Setting
      // it on xAI calls would either be ignored or rejected. Pick
      // reasoning vs non-reasoning by editing the registry's
      // `directApiId` if a particular model needs it.
      //
      // fetch: makeLoggedFetch("xai") · uniform request/response
      // logging across every direct provider.
      return {
        model: createOpenAI({
          apiKey,
          baseURL: "https://api.x.ai/v1",
          fetch: makeLoggedFetch("xai"),
        }).responses(meta.directApiId),
        carrier: "xai",
      };
    }
    case "moonshot": {
      // Moonshot Kimi · OpenAI-compatible chat-completions endpoint.
      // CN endpoint is api.moonshot.cn/v1 (where mainland Moonshot
      // keys auth); intl users on api.moonshot.ai/v1 are a follow-up
      // if region-mismatch errors show up in the wild. CN is the
      // correct default for this user base (per project CLAUDE.md
      // language preference). Uses createOpenAICompatible.chatModel
      // (same shape as B.AI / OpenRouter), NOT the Responses API
      // — Moonshot exposes chat-completions only.
      const compat = createOpenAICompatible({
        name: "moonshot",
        apiKey,
        baseURL: "https://api.moonshot.cn/v1",
        fetch: makeLoggedFetch("moonshot"),
      });
      return {
        model: compat.chatModel(meta.directApiId),
        carrier: "moonshot",
      };
    }
    case "zhipu": {
      // Zhipu GLM · OpenAI-compatible chat-completions at the global
      // bigmodel.cn endpoint. Single endpoint · no region split.
      const compat = createOpenAICompatible({
        name: "zhipu",
        apiKey,
        baseURL: "https://open.bigmodel.cn/api/paas/v4/",
        fetch: makeLoggedFetch("zhipu"),
      });
      return {
        model: compat.chatModel(meta.directApiId),
        carrier: "zhipu",
      };
    }
    default:
      throw new NoKeyError(meta.provider);
  }
}

/** B.AI carrier · OpenAI-compatible aggregator at https://api.b.ai/v1.
 *  Behaves like OpenRouter (universal carrier reaching many providers
 *  through one key), but distinct base URL + auth scheme is the bare
 *  Bearer convention without OpenRouter's `provider.allow_fallbacks`
 *  knob — so we don't pin allow_fallbacks here. The compat adapter
 *  handles SSE / chat completions / usage tally without provider-
 *  specific tweaks. */
function baiResolved(meta: ModelMeta, apiKey: string): ResolvedModel {
  const baiId = meta.baiId;
  if (!baiId) {
    // No B.AI mapping for this model · fall through so the caller can
    // pick another carrier. This is a defensive guard: resolveModel
    // already filters by baiId before routing here.
    throw new NoKeyError(meta.provider);
  }
  const compat = createOpenAICompatible({
    name: "bai",
    apiKey,
    baseURL: BAI_BASE,
    fetch: baiLoggedFetch,
  });
  return {
    model: compat.chatModel(baiId),
    carrier: "bai",
  };
}
const baiLoggedFetch = makeLoggedFetch("bai");

function openRouterResolved(meta: ModelMeta, apiKey: string): ResolvedModel {
  const compat = createOpenAICompatible({
    name: "openrouter",
    apiKey,
    baseURL: OPENROUTER_BASE,
    fetch: loggedFetch,
    headers: {
      "HTTP-Referer": "https://boardroom.local",
      "X-OpenRouter-Title": "Boardroom",
    },
  });
  return {
    model: compat.chatModel(meta.openrouterId),
    // Pin OpenRouter to the exact requested model id. Without this,
    // OR silently substitutes a different model when the requested
    // id is unavailable on the user's account / region — which is
    // why "select Opus 4.7, get back Sonnet" happens. The openai-
    // compatible adapter spreads providerMetadata["openrouter"]
    // into the request body, so this becomes `provider.allow_fallbacks:
    // false` on the wire (OpenRouter's documented opt-out).
    providerOptions: {
      openrouter: {
        provider: { allow_fallbacks: false },
      },
    },
    carrier: "openrouter",
  };
}

/* ──────────────── Transient-failure retry ────────────────
 *
 * OpenRouter (and to a lesser extent direct providers) return brief
 * 5xx / "no instances available" / overload errors when their pool is
 * routing-saturated — typically on the heaviest requests (brief Stage
 * 3's ~5–8k input + 20k maxTokens). Director turns dodge this because
 * they're tiny; brief generation hits it disproportionately often.
 *
 * Without a retry layer, a single transient blip becomes a hard
 * failure the user has to manually retry (or switch models). We retry
 * up to RETRY_MAX_ATTEMPTS - 1 times, but ONLY in the safe window —
 * before any text-delta has been yielded to the caller. Once a chunk
 * has streamed, retry would corrupt the body, so mid-stream errors
 * surface as-is.
 *
 * Permanent errors (4xx auth, model-not-found, quota exhausted) are
 * NOT retried — `isTransientStreamError` keeps the regex tight to
 * avoid burning user budget on unrecoverable failures.
 */
const RETRY_MAX_ATTEMPTS = 3;

function isTransientStreamError(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // 5xx HTTP families · upstream is unhealthy or capacity-blocking.
  if (/\bhttp\s*5\d\d\b/.test(m)) return true;
  if (/\b5\d\d\s+(?:internal|service|bad\s+gateway|gateway\s+timeout)/.test(m)) return true;
  // OpenRouter-specific capacity / routing messages (allow_fallbacks=false
  // means OR returns these instead of silently swapping).
  if (/no\s+instances?\s+available/.test(m)) return true;
  if (/all\s+providers?\s+(?:returned\s+errors|are\s+down|busy)/.test(m)) return true;
  if (/provider\s+returned\s+error/.test(m)) return true;
  // Generic capacity / overload language used across providers.
  if (/overloaded|capacity|temporarily\s+unavailable|service\s+unavailable/.test(m)) return true;
  // Rate limits · usually recover within seconds. Worth one retry.
  if (/rate[\s-]?limit|too\s+many\s+requests|\b429\b/.test(m)) return true;
  // Network-layer errors (dropped sockets, DNS hiccups). The Node
  // runtime surfaces these via the error code; the message text
  // varies by adapter.
  if (/\becon(?:n|nreset|nrefused)\b|\betimedout\b|\benotfound\b|\beai_/.test(m)) return true;
  if (/socket\s+hang\s+up|fetch\s+failed|network\s+error|aborted\s+by\s+upstream/.test(m)) return true;
  // Upstream timeout / reset signaling from gateways.
  if (/upstream\s+(?:timeout|reset|connect|disconnect)/.test(m)) return true;
  return false;
}

function backoffDelay(retryNumber: number): number {
  // retryNumber = 1 → ~800ms; retryNumber = 2 → ~2400ms.
  // ±20% jitter so concurrent retries don't synchronise into a thundering
  // herd against the same upstream that just rate-limited us.
  const base = retryNumber === 1 ? 800 : 2400;
  const jitter = base * 0.2 * (Math.random() - 0.5);
  return Math.round(base + jitter);
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Stream a single LLM response. Yields chunked text, then a final 'done' or
 * 'error' chunk. Generator is async-iterable in callers (orchestrator, brief
 * writer).
 *
 * Internally retries on transient upstream failures (HTTP 5xx, OpenRouter
 * "no instances", network drops) — but only before any text-delta has
 * been yielded. See the RETRY block above for the rationale and the
 * permanent-vs-transient classification.
 */
export async function* callLLMStream(req: LLMRequest): AsyncGenerator<LLMStreamChunk> {
  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(req.modelV, req.carrier ?? null);
  } catch (e) {
    yield { type: "error", message: formatStreamError(e) };
    return;
  }

  let attempt = 0;
  let lastTransientMessage = "";
  let yieldedText = false;
  // Carrier-rotation removed · under the single-active-LLM-provider
  // invariant there's only one carrier, nothing to rotate to. Access-
  // denied / payment-required errors from upstream now surface directly
  // to the user (which is the correct behaviour — the user needs to
  // know their card was declined, not see the boardroom paper over it).

  while (attempt < RETRY_MAX_ATTEMPTS) {
    attempt++;
    if (req.signal?.aborted) {
      yield { type: "done", finishReason: "aborted" };
      return;
    }
    if (attempt > 1) {
      const delayMs = backoffDelay(attempt - 1);
      process.stderr.write(
        `[adapter] transient upstream failure · retry ${attempt - 1}/${RETRY_MAX_ATTEMPTS - 1} ` +
          `for modelV=${req.modelV} after ${delayMs}ms · last: ${lastTransientMessage}\n`,
      );
      await sleepWithSignal(delayMs, req.signal);
      if (req.signal?.aborted) {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
    }

    const result = streamText({
      model: resolved.model,
      providerOptions: resolved.providerOptions,
      messages: req.messages,
      temperature: req.temperature,
      // Vercel SDK names this maxOutputTokens in v4+; tolerate both.
      maxTokens: req.maxTokens,
      abortSignal: req.signal,
    });

    // Drain `fullStream` (NOT `textStream`) · streamText's textStream
    // silently filters out `error` parts (only text-delta passes through),
    // so an upstream SSE `error` event — e.g. OpenAI's `insufficient_quota`
    // mid-stream rejection — would end the iterator without throwing AND
    // without yielding anything visible. We'd see "no tokens" instead of
    // a real error, the orchestrator's billing detection would never fire,
    // and the chair never gets to post the explainer. fullStream surfaces
    // every part type (text-delta / error / finish / …); we project to
    // our own typed yields below.
    let sawError = false;
    let retriableErrorMessage: string | null = null;
    try {
      for await (const part of result.fullStream) {
        if (req.signal?.aborted) break;
        if (part.type === "text-delta") {
          yieldedText = true;
          yield { type: "text", delta: part.textDelta };
        } else if (part.type === "error") {
          const msg = formatStreamError(part.error);
          // Retry only when no text has streamed AND the error looks
          // transient AND we have attempts left. Otherwise surface
          // the error as-is.
          if (!yieldedText && attempt < RETRY_MAX_ATTEMPTS && isTransientStreamError(msg)) {
            retriableErrorMessage = msg;
            break; // exit the for-await; outer while will retry
          }
          // Carrier-rotation removed · access-denied / payment-required
          // errors now surface directly. Only one carrier under the
          // single-active invariant.
          sawError = true;
          yield { type: "error", message: msg };
          // Don't break on terminal errors · let the SDK finish draining
          // its internal stream so usage / finishReason promises settle
          // (avoids leaking the background read). One error chunk is
          // enough for the caller.
        }
        // text-delta / error are the only part types we surface; finish,
        // tool-call, response-metadata, etc. are handled below via the
        // SDK's resolved promises (usage / finishReason / response).
      }
      if (retriableErrorMessage) {
        lastTransientMessage = retriableErrorMessage;
        continue; // retry the outer loop with a fresh streamText() call
      }
      if (sawError) {
        // Skip post-stream usage/served/done · the request was rejected
        // upstream, those promises may hang or resolve with stale values.
        return;
      }
      // Abort short-circuit · when the for-await broke because the
      // user-supplied AbortSignal fired (hard pause / "stop immediately"
      // / chair interrupt), bail out without awaiting the SDK's
      // response / usage / finishReason promises. Some providers never
      // resolve OR reject these once the underlying fetch is severed
      // mid-stream — the generator hangs forever, the orchestrator's
      // `for await (const chunk of callLLMStream)` never gets a final
      // chunk, and streamSpeakerTurn's cleanup at the bottom never
      // runs. The visible symptom: pause → "stop immediately" →
      // director's loading bubble stays on screen with no signal to
      // clear it. Yielding a `done` chunk lets the orchestrator's
      // streamSpeakerTurn fall through to its finalize-or-delete
      // cleanup with `streaming: false`.
      if (req.signal?.aborted) {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      // Capture the *actually-served* model id from the upstream
      // response. OpenRouter echoes this in the OpenAI-compatible
      // response body — if it differs from req.modelV's resolved id,
      // OR did a silent reroute. The loggedFetch wrapper above also
      // dumps the raw response so this stays auditable from the console.
      const responseMeta = await result.response.catch(() => null);
      const servedId =
        (responseMeta && typeof (responseMeta as { modelId?: unknown }).modelId === "string"
          ? (responseMeta as { modelId: string }).modelId
          : "");
      if (servedId) {
        yield { type: "served", modelId: servedId };
      }
      // Token usage · the SDK resolves usage once the upstream response
      // wraps up. Caller (orchestrator) hooks this to bump per-agent
      // cumulative token counters surfaced on the agent profile.
      const usage = await result.usage.catch(() => null);
      if (usage) {
        const promptTokens = typeof usage.promptTokens === "number" ? usage.promptTokens : 0;
        const completionTokens = typeof usage.completionTokens === "number" ? usage.completionTokens : 0;
        const totalTokens = typeof (usage as { totalTokens?: number }).totalTokens === "number"
          ? (usage as { totalTokens: number }).totalTokens
          : promptTokens + completionTokens;
        if (totalTokens > 0) {
          yield { type: "usage", promptTokens, completionTokens, totalTokens };
        }
      }
      const finishReason = await result.finishReason.catch(() => undefined);
      yield { type: "done", finishReason: typeof finishReason === "string" ? finishReason : undefined };
      return;
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        yield { type: "done", finishReason: "aborted" };
        return;
      }
      const msg = formatStreamError(e);
      // SDK threw before any chunks · same retry rules as above.
      if (!yieldedText && attempt < RETRY_MAX_ATTEMPTS && isTransientStreamError(msg)) {
        lastTransientMessage = msg;
        continue;
      }
      // Carrier-rotation removed · single-active invariant means no
      // alternate carrier to try. Surface the upstream error directly.
      yield { type: "error", message: msg };
      return;
    }
  }

  // Retries exhausted · surface a more honest message so the brief-
  // error UI / chair-error explainer can tell the user "transient
  // routing pressure, try again or switch models" instead of just the
  // raw HTTP code (which reads as "broken" rather than "wait + retry").
  yield {
    type: "error",
    message:
      `Upstream provider unavailable after ${RETRY_MAX_ATTEMPTS} attempts. ` +
      `This usually means the routing pool (OpenRouter / direct provider) is ` +
      `under transient load. Try again in a moment, or switch the model in ` +
      `Preferences.\n\nLast upstream error: ${lastTransientMessage}`,
  };
}

/**
 * Convenience: drain a stream into a single string. Used for non-streaming
 * call sites (e.g. memory extraction, the moderator decision in M4).
 */
export async function callLLM(req: LLMRequest): Promise<string> {
  let buf = "";
  for await (const chunk of callLLMStream(req)) {
    if (chunk.type === "text") buf += chunk.delta;
    else if (chunk.type === "error") throw new Error(chunk.message);
  }
  return buf;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Drain a stream and return both the text and the SDK-reported usage.
 * Callers that need to bill tokens to a specific agent (e.g. the brief
 * pipeline attributing all report-generation tokens to the chair) use
 * this rather than the plain callLLM. Usage may be null if the upstream
 * provider didn't surface it.
 */
export async function callLLMWithUsage(
  req: LLMRequest,
): Promise<{ text: string; usage: LLMUsage | null; finishReason: string | null }> {
  let buf = "";
  let usage: LLMUsage | null = null;
  let finishReason: string | null = null;
  for await (const chunk of callLLMStream(req)) {
    if (chunk.type === "text") buf += chunk.delta;
    else if (chunk.type === "error") throw new Error(chunk.message);
    else if (chunk.type === "usage") {
      usage = {
        promptTokens: chunk.promptTokens,
        completionTokens: chunk.completionTokens,
        totalTokens: chunk.totalTokens,
      };
    } else if (chunk.type === "done") {
      // Surface the upstream finish_reason · callers use this to
      // distinguish "model completed cleanly" from "truncated at
      // maxTokens" (`length`) or "stopped by stop sequence" / "content
      // filter". The OpenRouter path in particular benefits — its
      // upstream route is opaque, so without finishReason the only
      // signal is unparseable JSON, which looks the same whether the
      // model misformatted the output or the response was cut off.
      if (typeof chunk.finishReason === "string" && chunk.finishReason.length > 0) {
        finishReason = chunk.finishReason;
      }
    }
  }
  return { text: buf, usage, finishReason };
}
