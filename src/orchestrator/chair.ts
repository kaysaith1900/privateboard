/**
 * Chair (moderator) orchestration. The chair is a special agent
 * (role_kind = 'moderator') that fires on lifecycle events rather than
 * the round-robin queue:
 *
 *   • clarify (room-opened)        — one question or SKIP
 *   • round-end                    — 1-sentence ping + 3 key points
 *   • settings-changed             — template-driven, no LLM call
 *   • adjourn                      — handled in brief.ts
 *
 * Implementations stream into a single placeholder message just like a
 * director turn, but they don't enter the queue — they're invoked
 * directly from routes / room.ts.
 */
import { callLLMStream } from "../ai/adapter.js";
import { isModelV } from "../ai/registry.js";
import { runWebSearch, formatSearchResults } from "../ai/skills/web-search.js";
import { getAgent, getChairAgent, incrementAgentTokens, type Agent } from "../storage/agents.js";
import { insertKeyPoint } from "../storage/key_points.js";
import { getActiveWebSearchCredentials, hasWebSearchKey } from "../storage/keys.js";
import {
  deleteMessage,
  getMessage,
  insertMessage,
  listMessages,
  listRecentMessages,
  updateMessageBody,
} from "../storage/messages.js";
import { getPrefs } from "../storage/prefs.js";
import {
  reachableModelVs,
  reconcileAgentModels,
} from "../storage/reconcile-models.js";
import {
  getRoom,
  listRoomMembers,
  setAwaitingClarify,
  setAwaitingContinue,
} from "../storage/rooms.js";

import {
  buildChairClarifyMessages,
  buildChairConveningMessages,
  buildChairDirectMessages,
  buildChairRoundEndMessages,
  detectRoomLang,
  parseRoundEndOutput,
} from "./prompt.js";
import { pickChairClarifyDecision, pickChairWebSearch } from "./skill-picker.js";
import { extractNegativeSpace } from "./negative-space-extract.js";
import { runRoundEndSummarization } from "./summarize.js";
import { insertNegativeSpaceAngles } from "../storage/negative-space.js";
import { collectUrlsFromHistory, fetchOne, renderUrlContextBlock, type FetchAttemptHook, type UrlExtract } from "../skills/url-fetch.js";
import { roomBus } from "./stream.js";
import { waitForVoicePlayback } from "./room.js";
import { withTimeout, TimeoutError } from "./timeouts.js";
import { emitAutoSkipped } from "./auto-skip.js";
import { SentenceChunker } from "../voice/sentence-splitter.js";
import { synthesizeSpeechStream, tryExtractTtsBillingError, voiceProfileForAgent } from "../voice/tts.js";

/** Hard cap on chair clarification turns to prevent runaway loops. */
const MAX_CLARIFY_TURNS = 3;

/** Translate a raw LLM / network error into a chat-friendly one-liner.
 *  Keeps the chair's failure visible in the room instead of swallowing
 *  it in stderr. The most common failure modes:
 *   · NoKeyError → user has the wrong / no key for the chair's model
 *   · "model not found" / "does not exist" → chair model picked but the
 *     direct API doesn't ship that id (e.g. viaUniversalOnly model
 *     against the direct OpenAI SDK)
 *   · network / timeout → transient, suggest retry */
/** Thrown by `streamChairMessage` when the chair's LLM call errors and
 *  no body was produced. Callers (the convene flow, clarify flow,
 *  etc.) catch this to short-circuit the rest of the pipeline rather
 *  than dispatching directors that will fail with the same key. */
export class ChairStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChairStreamError";
  }
}

function friendlyChairError(chair: Agent, raw: string): string {
  const msg = (raw || "").trim();
  const lower = msg.toLowerCase();
  const modelLabel = chair.modelV ? `\`${chair.modelV}\`` : "the chair model";
  if (!msg) {
    return `chair couldn't reach ${modelLabel}. Check API keys in Preferences → API Key.`;
  }
  if (lower.includes("nokey") || lower.includes("no api key")) {
    return `chair model ${modelLabel} needs a provider key. Add one in Preferences → API Key.`;
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("does not exist") || lower.includes("unknown") || lower.includes("invalid"))) {
    return `model ${modelLabel} isn't reachable with the current keys (often: a preview model that needs OpenRouter). Switch the chair to a model your provider supports, or add an OpenRouter key.`;
  }
  if (lower.includes("timeout") || lower.includes("network") || lower.includes("fetch")) {
    return `network blip while calling ${modelLabel} — try again, or switch model.`;
  }
  // Generic fallback · include the upstream message so the user can
  // diagnose without checking server logs.
  return `${modelLabel} call failed: ${msg.slice(0, 240)}`;
}

/** Emit a "chair is preparing" hint over SSE so the UI can render a
 *  transient placeholder during silent server-side phases (haiku
 *  discipline gate, tool pre-fetch, LLM startup before first token).
 *  Phase comes from the chair message kind so the placeholder can
 *  label correctly. The frontend clears it on any subsequent chair
 *  message-appended, on clarify-ready, or after a short timeout. */
export function emitChairPending(roomId: string, phase: unknown): void {
  const phaseStr = typeof phase === "string" && phase ? phase : "chair";
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "chair-pending",
    payload: { phase: phaseStr },
    createdAt: Date.now(),
  });
}

/** Trim a URL to a host + 32-char tail for display in the tool-use
 *  row · so a 200-char tracking-laden URL doesn't blow out the row's
 *  width while still being recognisable. */
function shortenUrl(url: string, max = 64): string {
  if (url.length <= max) return url;
  try {
    const u = new URL(url);
    const host = u.host;
    const tail = (u.pathname + u.search + u.hash).slice(0, max - host.length - 1);
    return `${host}${tail.length ? "/" + tail.replace(/^\//, "") : ""}…`;
  } catch {
    return url.slice(0, max - 1) + "…";
  }
}

/** Format a byte count as a tight "KB" string for the tool-use row's
 *  done state. Caps at the size we actually keep (≤6 KB). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Detect user-language for the chair's tool announcements. Returns
 *  "zh" if any recent user message contains CJK, else "en". The chair
 *  matches the user's language in its other turns; the preamble copy
 *  follows the same convention. */
function detectChairLang(history: ReturnType<typeof listRecentMessages>): "zh" | "en" {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.authorKind === "user" && m.body) {
      if (/[一-鿿]/.test(m.body)) return "zh";
      return "en";
    }
  }
  return "en";
}

/**
 * Run the chair's `fetch-url` tool · for each URL detected in the
 * recent user history, post:
 *   1. A short chair "preamble" speech message announcing the tool
 *      use (with avatar / name, like a normal chair turn) so the
 *      tool-use rows below it have a clear "the chair is doing this"
 *      anchor — without it, the rows visually float between the user
 *      bubble and the chair's reply, reading as if they belonged to
 *      the user.
 *   2. One tool-use status row per URL (compact mono micro-strip).
 * Then fire the fetches in parallel, flip each row to done|failed
 * when the fetch resolves, and finally return the concatenated
 * SHARED MATERIALS block to inject into the chair's system prompt.
 *
 * Returns "" when no URLs were found — the chair's prompt simply
 * doesn't get a shared-materials section in that case.
 */
async function runChairUrlTool(
  roomId: string,
  chair: Agent,
  history: ReturnType<typeof listRecentMessages>,
): Promise<string> {
  const candidateUrls = collectUrlsFromHistory(history);
  if (candidateUrls.length === 0) return "";

  // Skip URLs already covered by a previous chair tool-use turn ·
  // otherwise every follow-up message in a room re-triggers the
  // preamble + tool-use rows for the same link, which the user sees
  // as a duplicate "I'll fetch X" announcement on every turn.
  const alreadyHandled = new Set<string>();
  for (const m of history) {
    const meta = m.meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const r = meta as Record<string, unknown>;
      if (r.kind === "tool-use" && r.tool === "fetch-url" && typeof r.target === "string") {
        alreadyHandled.add(r.target);
      }
    }
  }
  const urls = candidateUrls.filter((u) => !alreadyHandled.has(u));
  const reusedUrls = candidateUrls.filter((u) => alreadyHandled.has(u));

  // For URLs we've already fetched, pull from the per-process cache
  // (fetchOne returns instantly without a network hit) so the chair
  // still has their content in its system prompt this turn — without
  // posting any new UI. Failed-previously URLs end up with ok=false
  // here too; we drop those silently.
  const reusedExtracts: UrlExtract[] = [];
  for (const url of reusedUrls) {
    try {
      const extract = await fetchOne(url);
      if (extract.ok) reusedExtracts.push(extract);
    } catch { /* swallow · silent silent */ }
  }

  // No fresh URLs to fetch · just reinject the cached content (if
  // any) and return. No preamble, no tool-use rows.
  if (urls.length === 0) {
    return renderUrlContextBlock(reusedExtracts);
  }

  // 1. Chair preamble · plain templated speech announcing the tool
  //    use. Carries the chair's avatar in the chat so authorship is
  //    unambiguous. Adapts to the user's language (zh/en).
  const lang = detectChairLang(history);
  const preambleBody = lang === "zh"
    ? (urls.length === 1
        ? "我注意到你分享了一个链接 — 现在用 fetch-url 技能拉取页面内容。"
        : `我注意到你分享了 ${urls.length} 个链接 — 现在用 fetch-url 技能拉取页面内容。`)
    : (urls.length === 1
        ? "I noticed a URL in your message — reading it with my fetch-url tool."
        : `I noticed ${urls.length} URLs in your message — reading them with my fetch-url tool.`);
  const preamble = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body: preambleBody,
    meta: {
      kind: "tool-preamble",
      tool: "fetch-url",
      urlCount: urls.length,
      streaming: false,
      speakerStatus: "final",
    },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: preamble.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: preamble.body,
    meta: preamble.meta,
    roundNum: preamble.roundNum,
    createdAt: preamble.createdAt,
  });

  // 2. Insert one tool-use row per URL with status=running, capture
  //    the message ids so we can update them when each fetch finishes.
  type Pending = { messageId: string; url: string; startedAt: number };
  const pending: Pending[] = [];
  for (const url of urls) {
    const m = insertMessage({
      roomId,
      authorKind: "agent",
      authorId: chair.id,
      body: lang === "zh" ? `读取 ${shortenUrl(url)}…` : `Reading ${shortenUrl(url)}…`,
      meta: {
        kind: "tool-use",
        tool: "fetch-url",
        status: "running",
        target: url,
        streaming: true,
      },
    });
    pending.push({ messageId: m.id, url, startedAt: Date.now() });
    roomBus.emit(roomId, {
      type: "message-appended",
      messageId: m.id,
      authorKind: "agent",
      authorId: chair.id,
      replyToId: null,
      body: m.body,
      meta: m.meta,
      roundNum: m.roundNum,
      createdAt: m.createdAt,
    });
  }

  // Fire all fetches in parallel · update each tool-use row as it
  // resolves so the user sees fast pages finish first. The onAttempt
  // hook fires between retries · we use it to flip the running row's
  // body to "Retrying X (2/3)…" so the user sees that the chair is
  // re-trying rather than stuck.
  const extracts: UrlExtract[] = [];
  await Promise.all(
    pending.map(async (p) => {
      const onAttempt: FetchAttemptHook = ({ attempt, totalAttempts, reason }) => {
        const retryBody = lang === "zh"
          ? `重试 ${shortenUrl(p.url)} (${attempt + 1}/${totalAttempts}) · ${reason}`
          : `Retrying ${shortenUrl(p.url)} (${attempt + 1}/${totalAttempts}) · ${reason}`;
        const retryMeta = {
          kind: "tool-use",
          tool: "fetch-url",
          status: "running",
          target: p.url,
          attempt: attempt + 1,
          totalAttempts,
          lastError: reason,
          streaming: true,
        };
        updateMessageBody(p.messageId, retryBody, retryMeta);
        roomBus.emit(roomId, {
          type: "message-updated",
          messageId: p.messageId,
          body: retryBody,
          meta: retryMeta,
        });
      };
      let extract: UrlExtract;
      try {
        extract = await fetchOne(p.url, onAttempt);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        extract = { url: p.url, ok: false, title: "", text: reason.slice(0, 120) };
      }
      const elapsedMs = Date.now() - p.startedAt;
      const sizeBytes = extract.ok ? Buffer.byteLength(extract.text, "utf8") : 0;
      const body = extract.ok
        ? (lang === "zh"
            ? `已读取 ${shortenUrl(p.url)}${sizeBytes ? " · " + formatSize(sizeBytes) : ""}`
            : `Read ${shortenUrl(p.url)}${sizeBytes ? " · " + formatSize(sizeBytes) : ""}`)
        : (lang === "zh"
            ? `读取 ${shortenUrl(p.url)} 失败 · ${extract.text}`
            : `Couldn't read ${shortenUrl(p.url)} · ${extract.text}`);
      const newMeta = {
        kind: "tool-use",
        tool: "fetch-url",
        status: extract.ok ? "done" : "failed",
        target: p.url,
        title: extract.ok ? extract.title : "",
        size: sizeBytes,
        elapsedMs,
        error: extract.ok ? null : extract.text,
        streaming: false,
      };
      updateMessageBody(p.messageId, body, newMeta);
      roomBus.emit(roomId, {
        type: "message-updated",
        messageId: p.messageId,
        body,
        meta: newMeta,
      });
      extracts.push(extract);
    }),
  );

  // Merge cached extracts (re-used URLs) with the freshly-fetched
  // ones so the chair's prompt sees every URL the user has shared in
  // this thread, not just the new ones from this turn.
  return renderUrlContextBlock([...reusedExtracts, ...extracts]);
}

/**
 * Run the chair's `web-search` tool · cheap haiku call decides whether
 * the latest user message would benefit from fresh web results, and if
 * so, runs a Brave Search query before the chair's reply streams.
 *
 * Tool-use UI mirrors `fetch-url`:
 *   1. Chair "preamble" speech message announcing the search.
 *   2. One tool-use status row (kind=tool-use, tool=web-search,
 *      status=running) holding the query string.
 *   3. After Brave returns (~6 s timeout), flip the row to
 *      done|failed and emit a `message-updated` SSE event.
 *
 * Returns a `formatSearchResults` block to inject as SHARED MATERIALS
 * in the chair's clarify prompt, or `""` when no search ran (gating
 * failed, picker said null, or already searched this user message).
 *
 * Dedup · skip if any prior `tool: "web-search"` row exists between
 * the latest user message and now. The chair re-runs runChairUrlTool
 * on every turn (which uses an in-memory cache for already-fetched
 * URLs); web-search dedups by message rather than by query because
 * the query is regenerated by the picker each turn.
 */
async function runChairWebSearchTool(
  roomId: string,
  chair: Agent,
  history: ReturnType<typeof listRecentMessages>,
  signal?: AbortSignal,
): Promise<string> {
  // Single gate · global Brave key. The per-agent webSearchEnabled
  // flag exists so users can keep specific DIRECTORS out of search
  // (e.g. a "first-principles only" voice). The chair's role is
  // moderation + grounding — disabling search for the chair would
  // make every time-sensitive question fail silently. Always allow
  // when a search API key is configured.
  if (!hasWebSearchKey()) return "";

  // Find the latest user message; skip if none.
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].authorKind === "user" && history[i].body) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return "";

  // Dedup · if any web-search tool-use already ran AFTER the latest
  // user message, this turn is a re-render of an in-flight clarify
  // call; don't re-search. (The prior chair turn already digested
  // the results into the assistant transcript.)
  for (let i = lastUserIdx + 1; i < history.length; i++) {
    const meta = history[i].meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const r = meta as Record<string, unknown>;
      if (r.kind === "tool-use" && r.tool === "web-search") return "";
    }
  }

  // Decide search-or-not via the chair-side picker (haiku call).
  const query = await pickChairWebSearch({ history, signal });
  if (!query) return "";

  const creds = getActiveWebSearchCredentials();
  if (!creds) return ""; // race · key was wiped between gating and here

  const lang = detectChairLang(history);

  // Tiny pacing helper · ensures the user perceives the loading
  // sequence as deliberate stages (preamble → tool row appears →
  // searching → done). Brave on a hot connection often returns in
  // < 400 ms, which makes the "running" pulse flash by before the
  // user even sees it. We stage with small awaits so the chair feels
  // like it's working through the steps.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // 1. Preamble · plain chair speech, carries the avatar so
  //    authorship is unambiguous. Held alone for ~400ms so the
  //    user reads the chair's intent before the tool row appears.
  const preambleBody = lang === "zh"
    ? `这个问题需要联网查一下 — 用 web-search 技能搜：${query}`
    : `This needs fresh info — running a web-search query: ${query}`;
  const preamble = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body: preambleBody,
    meta: {
      kind: "tool-preamble",
      tool: "web-search",
      streaming: false,
      speakerStatus: "final",
    },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: preamble.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: preamble.body,
    meta: preamble.meta,
    roundNum: preamble.roundNum,
    createdAt: preamble.createdAt,
  });
  await sleep(400);

  // 2. Tool-use row · status=running with the query as `target`.
  const startedAt = Date.now();
  const toolMsg = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body: lang === "zh" ? `搜索 "${query}"…` : `Searching "${query}"…`,
    meta: {
      kind: "tool-use",
      tool: "web-search",
      status: "running",
      target: query,
      streaming: true,
    },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: toolMsg.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: toolMsg.body,
    meta: toolMsg.meta,
    roundNum: toolMsg.roundNum,
    createdAt: toolMsg.createdAt,
  });

  // 3. Run search · timeout-bounded. Floor the visible "running"
  //    duration at 900ms so even a sub-200ms hot cache hit registers.
  let results: Awaited<ReturnType<typeof runWebSearch>> = null;
  try {
    [results] = await Promise.all([
      runWebSearch(creds.backend, creds.apiKey, query).catch((e) => {
        process.stderr.write(`[chair-web-search] error: ${e instanceof Error ? e.message : String(e)}\n`);
        return null;
      }),
      sleep(900),
    ]);
  } catch (e) {
    process.stderr.write(`[chair-web-search] error: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  const elapsedMs = Date.now() - startedAt;

  if (!results || results.length === 0) {
    const failBody = lang === "zh"
      ? `搜索 "${query}" 无结果`
      : `No results for "${query}"`;
    const failMeta = {
      kind: "tool-use",
      tool: "web-search",
      status: "failed",
      target: query,
      elapsedMs,
      streaming: false,
    };
    updateMessageBody(toolMsg.id, failBody, failMeta);
    roomBus.emit(roomId, {
      type: "message-updated",
      messageId: toolMsg.id,
      body: failBody,
      meta: failMeta,
    });
    return "";
  }

  // Body text is just the action + query · the result count + elapsed
  // time live in the card's banner stamp on the frontend, so we don't
  // duplicate them here.
  const doneBody = lang === "zh"
    ? `已搜 "${query}"`
    : `Searched "${query}"`;
  const doneMeta = {
    kind: "tool-use",
    tool: "web-search",
    status: "done",
    target: query,
    sources: results.map((r) => ({ title: r.title, url: r.url, description: r.description })),
    elapsedMs,
    streaming: false,
  };
  updateMessageBody(toolMsg.id, doneBody, doneMeta);
  roomBus.emit(roomId, {
    type: "message-updated",
    messageId: toolMsg.id,
    body: doneBody,
    meta: doneMeta,
  });

  return formatSearchResults(query, results);
}

interface DispatchArgs {
  roomId: string;
  meta: Record<string, unknown>;
}

async function streamChairMessage(args: DispatchArgs & {
  buildMessages: (opts: {
    chair: Agent;
    cast: Agent[];
    room: NonNullable<ReturnType<typeof getRoom>>;
    prefs: ReturnType<typeof getPrefs>;
    history: ReturnType<typeof listRecentMessages>;
    sharedMaterials?: string;
  }) => ReturnType<typeof buildChairClarifyMessages>;
  onComplete?: (body: string, messageId: string) => void;
  /** Override the default 320-token cap. Most chair turns (clarify,
   *  round-end, convening) are short and the default holds; the
   *  moderator's note at adjourn needs more headroom for 2 paragraphs. */
  maxTokens?: number;
}): Promise<void> {
  const { roomId, meta, buildMessages, onComplete, maxTokens } = args;

  let chair = getChairAgent();
  if (!chair) return;
  // Self-heal · if the chair's stored modelV isn't reachable with the
  // CURRENT key set (e.g. user just added their first key but reconcile
  // never ran, or the boot reconcile got skipped), re-run the
  // reconciler and re-fetch the chair so its modelV swings to the
  // active carrier's primary before we attempt the LLM call. Without
  // this, a fresh-onboarded user with only Gemini configured would see
  // "chair model `opus-4-7` needs a provider key" because the seed
  // chair shipped on opus-4-7.
  if (!isModelV(chair.modelV) || !reachableModelVs().has(chair.modelV)) {
    try {
      reconcileAgentModels();
      const refreshed = getChairAgent();
      if (refreshed) chair = refreshed;
    } catch (e) {
      process.stderr.write(`[chair] reconcile-on-stale failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  if (!isModelV(chair.modelV)) return;

  const room = getRoom(roomId);
  if (!room) return;

  const memberRows = listRoomMembers(roomId);
  // Director-only cast for the chair's prompt context.
  const cast: Agent[] = memberRows
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null && a.roleKind === "director");

  const prefs = getPrefs();
  const history = listRecentMessages(roomId, 30);

  // Loading hint to the UI · the chair has work to do (tools + LLM)
  // before any visible bubble lands. Frontend shows a "preparing…"
  // placeholder until a chair message-appended replaces it. Phase comes
  // from meta.kind so the UI can label correctly (clarify / chair-direct
  // / round-end / convening). Idempotent — multiple emits just refresh
  // the placeholder.
  emitChairPending(roomId, (meta as { kind?: unknown })?.kind);

  // Chair's two pre-stream tools, run in parallel:
  //
  //  · fetch-url  · pulls every http(s) URL the user shared in recent
  //    history, posts a per-URL tool-use row, returns SHARED MATERIALS.
  //  · web-search · cheap haiku decides if the latest user message
  //    needs fresh web context; if yes, posts a tool-use row + runs
  //    Brave; if no, returns "" (zero-cost decision).
  //
  // Web search only runs for clarify turns — convening / round-end /
  // round-open are chair-driven structural moves, not user-question
  // answering, so they don't need fresh web context. Gating on
  // `meta.kind === "clarify"` keeps the cost bounded and the
  // tool-use UI from showing up in the wrong contexts.
  const isClarify = meta && (meta as { kind?: unknown }).kind === "clarify";
  const [urlMaterials, searchMaterials] = await Promise.all([
    runChairUrlTool(roomId, chair, history),
    isClarify ? runChairWebSearchTool(roomId, chair, history) : Promise.resolve(""),
  ]);
  const sharedMaterials = [urlMaterials, searchMaterials].filter(Boolean).join("\n\n");

  const llmMessages = buildMessages({ chair, cast, room, prefs, history, sharedMaterials });

  const placeholder = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body: "",
    meta: { ...meta, speakerStatus: "streaming", streaming: true },
  });

  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: placeholder.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: "",
    meta: placeholder.meta,
    roundNum: placeholder.roundNum,
    createdAt: placeholder.createdAt,
  });

  let buf = "";
  let errored = false;
  let errorMessage = "";

  // Voice mode support for chair messages
  const voiceMode = room.deliveryMode === "voice";
  const voiceChunker = voiceMode ? new SentenceChunker({ maxChars: 120 }) : null;
  // Round-end voice gating · the chair's round-end body is a
  // one-sentence ping followed by `POINTS:` + 3 bullet items. The
  // ping is a recap the user already heard via the round-prompt
  // voice, and the literal text "POINTS:" / dash-prefixed bullets
  // sound mechanical when read aloud. We feed only the bullet
  // CONTENT to the voice chunker for round-end · everything before
  // `POINTS:` (the ping) and the structural tokens (the marker,
  // the dashes, blank lines) are stripped.
  const metaKind = (meta as { kind?: unknown })?.kind;
  const isRoundEndVoice = voiceMode && metaKind === "round-end";
  // Tracker for the round-end voice path · `pingDone` flips true
  // when we cross the `POINTS:` boundary; `voiceBuf` accumulates
  // post-boundary text that hasn't been pushed to the chunker yet
  // (we strip leading dashes / whitespace / cross-bullet line
  // breaks before pushing).
  let pingDone = false;
  let voiceBuf = "";
  const voiceProfile = voiceMode ? voiceProfileForAgent(chair) : null;
  let voiceSeq = 0;

  async function emitChairVoice(text: string): Promise<void> {
    if (!voiceMode || !voiceProfile || !text.trim()) return;
    try {
      for await (const chunk of synthesizeSpeechStream(text, voiceProfile)) {
        roomBus.emit(roomId, {
          type: "voice-chunk",
          messageId: placeholder.id,
          seq: voiceSeq++,
          text: chunk.text,
          provider: chunk.provider,
          model: chunk.model,
          voiceId: chunk.voiceId,
          ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
          ...(chunk.audioBase64 ? { audioBase64: chunk.audioBase64 } : {}),
        });
      }
    } catch (e) {
      // Billing failure · forward to the frontend so the upgrade
      // overlay surfaces. Other errors fall through to the stderr
      // log path · they're either transient (network / TTS provider
      // hiccup) or already-surfaced via the message stream.
      const billing = tryExtractTtsBillingError(e);
      if (billing) {
        roomBus.emit(roomId, {
          type: "voice-error",
          messageId: placeholder.id,
          code: billing.code,
          provider: billing.provider,
          message: billing.message,
          upgradeUrl: billing.upgradeUrl,
        });
      }
      process.stderr.write(`[tts-chair] ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  try {
    for await (const chunk of callLLMStream({
      modelV: chair.modelV as never,
      // Chair carrier pin — same semantics as director carrier override.
      carrier: chair.carrierPref ?? null,
      messages: llmMessages,
      // Chair output is short + structural — low temperature keeps the
      // SKIP token + POINTS: format reliable. Most chair turns fit in
      // 320 tokens; longer-form primitives can pass a higher maxTokens.
      temperature: 0.3,
      maxTokens: maxTokens ?? 320,
    })) {
      if (chunk.type === "text") {
        buf += chunk.delta;
        updateMessageBody(placeholder.id, buf, {
          ...meta,
          speakerStatus: "streaming",
          streaming: true,
        });
        roomBus.emit(roomId, {
          type: "message-token",
          messageId: placeholder.id,
          delta: chunk.delta,
        });
        if (voiceChunker) {
          if (isRoundEndVoice) {
            // Skip ping · accumulate the streaming buffer until we
            // see "POINTS:" (case-insensitive). Once crossed, push
            // post-boundary text into the chunker minus the structural
            // markers (dash-bullets, blank lines).
            voiceBuf += chunk.delta;
            if (!pingDone) {
              const idx = voiceBuf.search(/POINTS\s*:/i);
              if (idx >= 0) {
                pingDone = true;
                // Drop everything up through the POINTS: marker.
                const after = voiceBuf.slice(voiceBuf.search(/POINTS\s*:/i));
                voiceBuf = after.replace(/POINTS\s*:/i, "");
              }
            }
            if (pingDone && voiceBuf) {
              // Strip leading bullet markers and surrounding
              // whitespace so the chunker sees flat sentences.
              // Replace dash-bullets with sentence boundary so each
              // point reads as its own utterance.
              const cleaned = voiceBuf.replace(/(^|\n)\s*[-*]\s*/g, ". ");
              voiceBuf = "";
              for (const spoken of voiceChunker.push(cleaned)) {
                await emitChairVoice(spoken);
              }
            }
          } else {
            for (const spoken of voiceChunker.push(chunk.delta)) {
              await emitChairVoice(spoken);
            }
          }
        }
      } else if (chunk.type === "usage") {
        // Chair turns are short but still bill tokens; track on the
        // chair agent so its profile reflects total spend, AND persist
        // on the message meta so the post-adjourn session-analytics
        // card can sum tokens across every speaker (chair + directors)
        // without a separate per-room ledger. Mutates the local `meta`
        // object so the next streaming updateMessageBody and the final
        // write at the bottom of this function spread it through.
        incrementAgentTokens(chair.id, chunk.totalTokens);
        (meta as Record<string, unknown>).tokens = {
          prompt: chunk.promptTokens,
          completion: chunk.completionTokens,
          total: chunk.totalTokens,
        };
        (meta as Record<string, unknown>).modelV = chair.modelV;
      } else if (chunk.type === "error") {
        errored = true;
        errorMessage = chunk.message || errorMessage;
        roomBus.emit(roomId, {
          type: "message-error",
          messageId: placeholder.id,
          message: chunk.message,
        });
      }
    }
  } catch (e) {
    errored = true;
    errorMessage = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[chair] stream error: ${errorMessage}\n`);
    // Surface the failure in the chat bubble. Without this, the empty
    // placeholder gets deleted below and the user sees no signal at
    // all that the chair tried + failed (the most common case: a
    // chair model that can't be reached with the configured keys).
    roomBus.emit(roomId, {
      type: "message-error",
      messageId: placeholder.id,
      message: errorMessage,
    });
  }

  if (!buf.trim()) {
    if (errored) {
      // Keep the placeholder · paint a human-readable error in the
      // bubble so the user understands why the chair didn't speak.
      // Common failure modes: model unreachable with current keys,
      // direct provider API rejected the model id (e.g. an
      // viaUniversalOnly model called against the direct SDK that
      // hasn't shipped it). The chair model name is included so the
      // user can see exactly which slot needs attention.
      const friendly = friendlyChairError(chair, errorMessage);
      const errorBody = `[chair stream error] ${friendly}`;
      updateMessageBody(placeholder.id, errorBody, {
        ...meta,
        speakerStatus: "final",
        streaming: false,
        error: true,
        errorReason: errorMessage,
      });
      roomBus.emit(roomId, {
        type: "message-updated",
        messageId: placeholder.id,
        body: errorBody,
        meta: {
          ...meta,
          speakerStatus: "final",
          streaming: false,
          error: true,
          errorReason: errorMessage,
        },
      });
      roomBus.emit(roomId, { type: "message-final", messageId: placeholder.id });
      // Re-throw so the caller (room creation flow / clarify / etc.)
      // knows the chair didn't speak. Without this throw, the convene
      // flow proceeds to dispatch directors anyway — every director
      // hits the same broken key and the user sees a wall of empty
      // bubbles flashing past after the chair error. Pausing the
      // room is the caller's responsibility.
      throw new ChairStreamError(errorMessage || "chair stream failed");
    }
    deleteMessage(placeholder.id);
    roomBus.emit(roomId, { type: "message-removed", messageId: placeholder.id, reason: "empty" });
    return;
  }

  // Flush remaining voice chunks and signal playback end.
  // Skip voice playback for pure control tokens (READY/SKIP) — these are
  // not real speech; they get deleted immediately after onComplete.
  const bareToken = buf.trim().replace(/^[\s`*"'(\[{]+|[\s`*"'.)\]}]+$/g, "").toUpperCase();
  const isControlToken = bareToken === "READY" || bareToken === "SKIP";
  if (voiceChunker && !errored && !isControlToken) {
    const tail = voiceChunker.flush();
    if (tail) await emitChairVoice(tail);
    roomBus.emit(roomId, { type: "voice-final", messageId: placeholder.id });
    // Wait for the frontend to finish playing all audio before returning.
    // This ensures the chair's speech finishes before directors start talking.
    await waitForVoicePlayback(roomId, placeholder.id);
  }

  if (errored) {
    updateMessageBody(placeholder.id, buf, {
      ...meta,
      speakerStatus: "final",
      streaming: false,
      error: true,
    });
  } else {
    updateMessageBody(placeholder.id, buf, {
      ...meta,
      speakerStatus: "final",
      streaming: false,
    });
  }

  // Run onComplete BEFORE emitting message-final. onComplete persists
  // side-effects (key points, awaiting_continue) and emits its own
  // config-event SSE — we want those to land on the client *first* so
  // the frontend's button gating sees the new state by the time
  // message-final arrives. Otherwise the user can double-click End
  // round in the gap and the backend rejects with "already in round-end".
  if (onComplete && !errored) {
    try { onComplete(buf, placeholder.id); }
    catch (e) { process.stderr.write(`[chair] onComplete: ${e instanceof Error ? e.message : String(e)}\n`); }
  }

  roomBus.emit(roomId, { type: "message-final", messageId: placeholder.id });
}

export interface ClarifyResult {
  /** True if the chair asked a (new) clarifying question — keep waiting. */
  asked: boolean;
  /** True if the chair is ready to release the directors. */
  ready: boolean;
  /** True if we hit the MAX_CLARIFY_TURNS cap and forced ready. */
  exhausted: boolean;
}

/**
 * Run one chair clarification turn. Multi-turn capable — each user reply
 * during the clarification phase invokes this again, until the chair
 * responds READY (or we hit MAX_CLARIFY_TURNS and force ready).
 *
 * The READY token is a control signal, not a chat utterance — when the
 * chair returns READY we delete the placeholder message so the user
 * never sees "READY" in the bubble.
 *
 * Side effects: sets `awaiting_clarify` on the room to track the
 * soft-pause state across requests.
 */
export async function runChairClarify(roomId: string): Promise<ClarifyResult> {
  // Count prior clarify turns in this room — the chair sees its
  // turn-of-budget in the prompt.
  const history = listRecentMessages(roomId, 50);
  const priorClarify = history.filter(
    (m) =>
      m.authorKind === "agent" &&
      m.meta &&
      (m.meta as { kind?: unknown }).kind === "clarify",
  ).length;
  const turnNumber = priorClarify + 1;

  // Hit the cap → don't even call the LLM. Just release directors.
  if (turnNumber > MAX_CLARIFY_TURNS) {
    setAwaitingClarify(roomId, false);
    roomBus.emit(roomId, {
      type: "config-event",
      kind: "clarify-ready",
      payload: { exhausted: true },
      createdAt: Date.now(),
    });
    return { asked: false, ready: true, exhausted: true };
  }

  // Loading hint to the UI · streamChairMessage emits the same event
  // later, but the haiku discipline-gate (pickChairClarifyDecision)
  // and the pre-gate URL/search tools run BEFORE that and can take a
  // few seconds with no chat-visible feedback. Emitting here bridges
  // the silent window with a "preparing…" placeholder.
  emitChairPending(roomId, "clarify");

  // Pre-gate tools · run URL fetch + web search BEFORE the discipline
  // gate decides whether to clarify. Two reasons:
  //   · When the gate skips clarify (subject is self-sufficient), the
  //     tools would otherwise never fire — they live inside
  //     streamChairMessage. Hoisting them here ensures the chair always
  //     grounds time-sensitive topics before directors take over.
  //   · When the gate decides to ask, streamChairMessage's internal
  //     URL/search calls dedup against the visible tool-use bubbles
  //     posted here (no double-fetch, no double UI).
  // Only on turn 1 — follow-up turns let streamChairMessage handle
  // tools, since it already wires them to clarify turns.
  const chairForTools = getChairAgent();
  if (turnNumber === 1 && chairForTools) {
    try {
      await Promise.all([
        runChairUrlTool(roomId, chairForTools, history),
        runChairWebSearchTool(roomId, chairForTools, history),
      ]);
    } catch (e) {
      process.stderr.write(
        `[chair-clarify] pre-gate tools failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // Discipline lever · on the FIRST clarify turn only, run a cheap
  // haiku gate that decides whether the user's subject is already
  // self-sufficient. When it says skip, we release directors without a
  // chair LLM round-trip — the room opens fast and the chair stays out
  // of the way. Follow-up turns (turnNumber > 1) bypass the gate
  // because the user is mid-conversation with the chair already.
  //
  // 15s timeout · the haiku gate is supposed to be cheap (1–3s typical)
  // but if it hangs we'd block the entire clarify phase silently. On
  // timeout we treat the decision as "skip clarify" so directors start
  // immediately, and emit auto-skipped so the user sees a toast
  // explaining why the chair didn't ask.
  if (turnNumber === 1) {
    // Emit a phase signal so the round-table bubble can label the
    // silent window as "Considering clarify" instead of generic
    // "Thinking". emitChairPending above already painted a generic
    // chair-pending; this refines it.
    emitChairPending(roomId, "clarify-deciding");
    let decision: { shouldAsk: boolean; rationale?: string } | null = null;
    try {
      decision = await withTimeout(
        pickChairClarifyDecision({ history }),
        15_000,
        "chair-clarify-decision",
      );
    } catch (e) {
      if (e instanceof TimeoutError) {
        process.stderr.write(`[chair-clarify] decision timeout — skipping clarify\n`);
        emitAutoSkipped(roomId, "clarify", "clarify-timeout");
        decision = { shouldAsk: false, rationale: "timeout" };
      } else {
        // Non-timeout failure already silent-skipped before — preserve that.
        process.stderr.write(
          `[chair-clarify] decision error: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        decision = { shouldAsk: false, rationale: "error" };
      }
    }
    if (!decision || !decision.shouldAsk) {
      setAwaitingClarify(roomId, false);
      roomBus.emit(roomId, {
        type: "config-event",
        kind: "clarify-ready",
        payload: { skipped: true, rationale: decision?.rationale },
        createdAt: Date.now(),
      });
      return { asked: false, ready: true, exhausted: false };
    }
  }

  let asked = false;
  let readyMessageId: string | null = null;

  await streamChairMessage({
    roomId,
    meta: { kind: "clarify", turnNumber },
    buildMessages: (opts) =>
      buildChairClarifyMessages({ ...opts, turnNumber, maxTurns: MAX_CLARIFY_TURNS }),
    onComplete: (body, id) => {
      // Two acceptance shapes for the release path:
      //   1. Ack + READY · the new follow-up format. Body has prose
      //      paragraph(s) followed by `READY` on its own line. The ack
      //      stays as the visible chair message; READY is the control
      //      token we strip + use to flip awaiting_clarify.
      //   2. Bare READY (or SKIP) · legacy / first-turn shorthand. No
      //      visible message — placeholder gets deleted.
      // Anything else is treated as "asked another question" → keep
      // the bubble, leave awaiting_clarify on.
      const trimmed = body.trim();
      // Stripped bare-token check: noise-tolerant ("**READY**", "READY.")
      const bareUpper = trimmed.replace(/^[\s`*"'(\[{]+|[\s`*"'.)\]}]+$/g, "").toUpperCase();
      const isBareReady = bareUpper === "READY" || bareUpper === "SKIP";

      // Ack + READY check: split into trimmed non-empty lines, last
      // line is the token (with same noise tolerance).
      let isAckReady = false;
      let ackBody = "";
      if (!isBareReady) {
        const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          const lastLine = lines[lines.length - 1] || "";
          const lastUpper = lastLine.replace(/^[\s`*"'(\[{]+|[\s`*"'.)\]}]+$/g, "").toUpperCase();
          if (lastUpper === "READY" || lastUpper === "SKIP") {
            isAckReady = true;
            ackBody = lines.slice(0, -1).join("\n\n").trim();
          }
        }
      }

      const isReady = isBareReady || isAckReady;
      asked = !isReady;
      if (isBareReady) {
        readyMessageId = id;
      } else if (isAckReady && ackBody) {
        // Strip the READY token from the visible message — keep just
        // the acknowledgment. updateMessageBody + emit message-updated
        // so the frontend's ack reads cleanly.
        const newMeta = {
          kind: "clarify",
          turnNumber,
          ready: true,
          speakerStatus: "final" as const,
          streaming: false,
        };
        updateMessageBody(id, ackBody, newMeta);
        roomBus.emit(roomId, {
          type: "message-updated",
          messageId: id,
          body: ackBody,
          meta: newMeta,
        });
      }
    },
  });

  if (readyMessageId) {
    deleteMessage(readyMessageId);
    roomBus.emit(roomId, {
      type: "message-removed",
      messageId: readyMessageId,
      reason: "chair-ready",
    });
  }

  // Persist soft-pause: still clarifying if a question was asked, ready otherwise.
  setAwaitingClarify(roomId, asked);

  // Tell the frontend explicitly when we drop out of the clarify phase
  // so its local awaitingClarify mirror flips and the queue preview
  // gives way to the orchestrator's real director queue. The asked path
  // doesn't need a notice — the chair message already lands as a
  // kind=clarify chat message and the flag stays true.
  if (!asked) {
    roomBus.emit(roomId, {
      type: "config-event",
      kind: "clarify-ready",
      payload: {},
      createdAt: Date.now(),
    });
  }

  return { asked, ready: !asked, exhausted: false };
}

/**
/**
 * Stream the chair's convening speech · 3-4 sentence introduction of
 * the auto-picked cast in the chair's voice. Posted right after the
 * picker has seated directors, before the chair runs its clarify
 * turn. Replaces the templated "chair convened: A · B · C" milestone
 * marker with a real speech that explains WHY each director was
 * picked for this specific subject.
 *
 * `picksWithReasons` carries the per-director rationale captured by
 * the picker's haiku call so the chair can quote / reference each
 * pick's specific angle, not generic flattery.
 */
export async function runChairConvening(
  roomId: string,
  picksWithReasons: Array<{ agent: Agent; reason: string }>,
  pickerRationale: string,
): Promise<void> {
  await streamChairMessage({
    roomId,
    meta: {
      kind: "convening",
      picks: picksWithReasons.map((p) => ({ agentId: p.agent.id, reason: p.reason })),
      rationale: pickerRationale,
    },
    buildMessages: (opts) =>
      buildChairConveningMessages({ ...opts, picksWithReasons, pickerRationale }),
  });
}

/**
 * Run the chair's direct response to a user @chair message. The
 * message-route forks here when chair is mentioned, abort-pausing the
 * director queue so the chair speaks alone, briefly, then directors
 * resume. Strictly scoped to META observations about the discussion
 * (convergence · divergence · who hasn't engaged · contested terms);
 * NOT substantive content. Posted with meta.kind = "chair-direct"
 * so the frontend can style it as a "responding to you" bubble.
 */
export async function runChairDirectResponse(roomId: string): Promise<void> {
  await streamChairMessage({
    roomId,
    meta: { kind: "chair-direct" },
    buildMessages: buildChairDirectMessages,
    // 3-4 sentences ~ 60-100 words. 320 default fits English; CJK is
    // also under 320 tokens at this length. No override needed.
  });
}

/**
 * Run the chair's end-of-round close. Persists the parsed key points,
 * sets awaiting_continue on the room, and emits a config event so the
 * UI can lock the input + show the Continue / Adjourn affordance.
 */
export async function runChairRoundEnd(roomId: string, roundNum: number): Promise<void> {
  await streamChairMessage({
    roomId,
    meta: { kind: "round-end", roundNum },
    buildMessages: buildChairRoundEndMessages,
    onComplete: (body, messageId) => {
      // CRITICAL · the round-ended SSE event MUST fire no matter what
      // happens during parsing or persistence. Without it, the frontend
      // never re-renders the chair's round-end card and the skeleton
      // (with its "Chair is drafting key points…" text painted during
      // streaming) sits on screen forever. Wrap every step in
      // try/catches so a single throw can't block the emit.
      let points: string[] = [];
      let modeShift: { to: string; because: string } | null = null;
      try {
        const parsed = parseRoundEndOutput(body);
        points = parsed.points;
        modeShift = parsed.modeShift;
      } catch (e) {
        process.stderr.write(`[chair] round-end parse: ${e instanceof Error ? e.message : String(e)}\n`);
      }

      let persisted: Array<{ id: string; body: string; position: number; vote: string | null }> = [];
      try {
        persisted = points.slice(0, 3).map((text, i) => {
          const kp = insertKeyPoint({
            roomId,
            messageId,
            roundNum,
            body: text,
            position: i,
          });
          return { id: kp.id, body: kp.body, position: kp.position, vote: kp.vote };
        });
      } catch (e) {
        process.stderr.write(`[chair] round-end persist: ${e instanceof Error ? e.message : String(e)}\n`);
      }

      // Tone-shift proposal · advisory only. Persisted on the chair
      // message's meta so a page reload can re-render the affordance.
      // Wrapped in try/catch — a DB hiccup on this step must not stop
      // the round-ended SSE from firing, otherwise the user is stuck
      // on the loading skeleton.
      let advisory: { to: string; because: string } | null = null;
      try {
        if (modeShift) {
          const room = getRoom(roomId);
          if (room && modeShift.to !== (room.mode || "").toLowerCase()) {
            advisory = modeShift;
            const existing = getMessage(messageId);
            if (existing) {
              updateMessageBody(messageId, existing.body, {
                ...existing.meta,
                modeShiftProposal: modeShift,
              });
            }
          }
        }
      } catch (e) {
        process.stderr.write(`[chair] round-end modeShift: ${e instanceof Error ? e.message : String(e)}\n`);
      }

      try { setAwaitingContinue(roomId, true); }
      catch (e) {
        process.stderr.write(`[chair] round-end awaitingContinue: ${e instanceof Error ? e.message : String(e)}\n`);
      }

      // The emit itself is the load-bearing exit — runs regardless of
      // upstream failures so the frontend always advances out of the
      // streaming skeleton. With empty keyPoints the frontend renders
      // a degraded card (no vote chips, just continue/adjourn) rather
      // than staying stuck on "drafting key points…".
      roomBus.emit(roomId, {
        type: "config-event",
        kind: "round-ended",
        payload: {
          messageId,
          roundNum,
          keyPoints: persisted,
          modeShiftProposal: advisory,
        },
        createdAt: Date.now(),
      });
    },
  });

  // Hierarchical summarization · runs after the chair's round-end (and
  // its key-point persistence) so the L1 generator can pull this round's
  // key points as anchor material. Fire-and-forget · summarisation is
  // best-effort, the room shouldn't block on it. Errors are logged
  // inside runRoundEndSummarization.
  void runRoundEndSummarization(roomId, roundNum);

  // Layer 3.2 · negative-space extraction. Fire-and-forget. Extracts
  // 1-3 angles this round did NOT touch and persists them so the
  // next round's director prompts can show "UNEXPLORED ANGLES" as
  // positive-space breadcrumbs alongside the frame-break negative-
  // space rules. Errors logged but never block the room.
  void (async () => {
    try {
      const room = getRoom(roomId);
      if (!room) return;
      const allMsgs = listMessages(roomId);
      const roundMsgs = allMsgs.filter((m) => m.roundNum === roundNum);
      if (roundMsgs.length === 0) return;
      const angles = await extractNegativeSpace({
        roundMessages: roundMsgs,
        roomSubject: room.subject || "",
      });
      if (angles.length > 0) {
        insertNegativeSpaceAngles(roomId, roundNum, angles);
      }
    } catch (e) {
      process.stderr.write(
        `[chair] negative-space extract failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  })();
}

/**
 * After a round of director turns drains, the chair drops a chat
 * message with the round-end prompt — End round (open vote) or
 * Continue (next round). Template-driven, no LLM call: the buttons
 * carry the action, the body is the procedural ping.
 *
 * When the caller passes a `recommendation`, the chair's body adapts
 * to surface it (the haiku-level Synthesis primitive). The user still
 * picks End vs Continue from the UI buttons; the chair's job is to
 * make the better choice obvious with a one-line rationale. The meta
 * also carries `recommendation` so the frontend can highlight the
 * recommended button.
 *
 * Idempotency: caller (room.ts pumpQueue) only invokes this when the
 * cap was reached and no awaiting flag is set — so each round wraps
 * with at most one prompt.
 */

/** Synthesize voice for a templated chair announcement and emit the
 *  same `voice-chunk` / `voice-final` SSE pair that streamChairMessage
 *  emits for live LLM turns. Two templated chair messages need voice:
 *  `announceRoundPrompt` (vote prompt at round wrap) and
 *  `announceIntervention` (chair note between speakers). The other
 *  announce* templates (research-hint, billing, round-open, adjourn-
 *  no-brief, member-change, settings-change) stay silent — they're
 *  structural notices not worth narrating.
 *
 *  Strict speaking order: this function awaits `waitForVoicePlayback`
 *  for its own message AFTER emitting voice-final, so the caller
 *  blocks until the chair's audio has finished playing on the
 *  frontend. The orchestrator's pumpQueue already awaits each
 *  director's voice playback (room.ts:820) before advancing, so
 *  awaiting this helper inside `announceIntervention` /
 *  `announceRoundPrompt` slots the chair's audio cleanly between
 *  director turns without overlap. Failures log to stderr and
 *  resolve immediately — never block the room indefinitely. */
async function emitChairAnnouncementVoice(
  roomId: string,
  messageId: string,
  body: string,
): Promise<void> {
  const room = getRoom(roomId);
  if (!room || room.deliveryMode !== "voice") return;
  const chair = getChairAgent();
  if (!chair) return;
  const profile = voiceProfileForAgent(chair);
  if (!profile) return;
  const trimmed = body.trim();
  if (!trimmed) return;
  let seq = 0;
  try {
    for await (const chunk of synthesizeSpeechStream(trimmed, profile)) {
      roomBus.emit(roomId, {
        type: "voice-chunk",
        messageId,
        seq: seq++,
        text: chunk.text,
        provider: chunk.provider,
        model: chunk.model,
        voiceId: chunk.voiceId,
        ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
        ...(chunk.audioBase64 ? { audioBase64: chunk.audioBase64 } : {}),
      });
    }
    roomBus.emit(roomId, { type: "voice-final", messageId });
    // Block until the frontend confirms playback complete (POST
    // /voice-done resolves the waiter). 60s timeout protects
    // against a stuck audio path so the room never deadlocks.
    await waitForVoicePlayback(roomId, messageId, 60_000);
  } catch (e) {
    const billing = tryExtractTtsBillingError(e);
    if (billing) {
      roomBus.emit(roomId, {
        type: "voice-error",
        messageId,
        code: billing.code,
        provider: billing.provider,
        message: billing.message,
        upgradeUrl: billing.upgradeUrl,
      });
    }
    process.stderr.write(`[tts-chair-announce] ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** Variation pools for the templated round-prompt body. The chair
 *  rotates phrasing across rounds so the wrap-up doesn't read as a
 *  fixed template — picked deterministically by `roundNum` so a page
 *  refresh shows the same line. Keep variants tight (≤ ~10 words for
 *  tails); the LLM-generated rationale carries the substance.
 *  Each pool has parallel `_EN` (default) and `_ZH` (Chinese)
 *  variants; the rendering function picks the right pool per
 *  `detectRoomLang(room)`. */
const ROUND_OPENERS_EN = [
  "Round done.",
  "That closes the round.",
  "End of round.",
  "Round wrapped.",
] as const;
const ROUND_OPENERS_ZH = [
  "本轮结束。",
  "这一轮告一段落。",
  "刚才这一轮结束。",
  "本轮收尾。",
] as const;
const END_TAILS_WITH_RATIONALE_EN = [
  "Ready to file — or push once more.",
  "I'd wrap here. Another sweep is fair.",
  "Enough to file. Continue if there's more.",
  "File now, or run another round.",
] as const;
const END_TAILS_WITH_RATIONALE_ZH = [
  "可以归档了 — 或者再来一轮。",
  "我倾向收尾，但再讨论一轮也合理。",
  "够归档了。如果还有要补的就继续。",
  "现在归档，或者再讨论一轮。",
] as const;
const END_TAILS_BARE_EN = [
  "Looks ready to file — or another sweep.",
  "Vote and wrap, or push for more.",
  "Ready to file. Continue if you want.",
  "Wrap here, or another round.",
] as const;
const END_TAILS_BARE_ZH = [
  "看来可以归档了 — 或再讨论一轮。",
  "投票收尾，或继续推进。",
  "可以归档了。要继续就继续。",
  "这里收尾，或再来一轮。",
] as const;
const CONTINUE_TAILS_WITH_RATIONALE_EN = [
  "Worth another pass — or call it.",
  "I'd push once more, or end here.",
  "One more sweep earns its keep — or wrap.",
  "Another round, or file now.",
] as const;
const CONTINUE_TAILS_WITH_RATIONALE_ZH = [
  "值得再讨论一轮 — 或者就此打住。",
  "我倾向再推一轮，或者就此结束。",
  "再讨论一轮是值得的 — 或者收尾。",
  "再来一轮，或现在归档。",
] as const;
const CONTINUE_TAILS_BARE_EN = [
  "Worth another pass — or call it.",
  "One more sweep, or wrap.",
  "Push another round, or end here.",
  "Another pass, or file now.",
] as const;
const CONTINUE_TAILS_BARE_ZH = [
  "值得再讨论一轮 — 或就此打住。",
  "再讨论一轮，或者收尾。",
  "推进下一轮，或在这里结束。",
  "再来一轮，或现在归档。",
] as const;
const NEUTRAL_TAILS_EN = [
  "Vote a point, or roll on.",
  "Weight a point with a vote, or continue.",
  "Vote to bias the next round — or skip.",
  "Vote, or continue without one.",
] as const;
const NEUTRAL_TAILS_ZH = [
  "为关键点投票，或继续。",
  "用投票给某个点加权，或直接继续。",
  "投票影响下一轮 — 或跳过。",
  "投票，或不投票直接继续。",
] as const;
const pickByRound = <T>(arr: readonly T[], seed: number): T =>
  arr[((seed % arr.length) + arr.length) % arr.length] as T;
/** Pool selector · returns the language-appropriate pool for the
 *  given English-default pool. Centralises the zh / en swap so the
 *  rendering function stays clean. */
function poolFor<T>(en: readonly T[], zh: readonly T[], lang: "zh" | "en"): readonly T[] {
  return lang === "zh" ? zh : en;
}

export async function announceRoundPrompt(
  roomId: string,
  roundNum: number,
  recommendation?: { kind: "end" | "continue"; rationale: string },
): Promise<void> {
  const chair = getChairAgent();
  if (!chair) return;
  // Language lock · pick zh / en pool based on the room's initial
  // question. Chinese rooms get the Chinese opener + tail variants
  // so the templated round-prompt doesn't break the room's working
  // language. The rationale comes from `pickRoundWrap` which already
  // has its own LANGUAGE LOCK so it's in the right language too.
  const room = getRoom(roomId);
  const roomLang = detectRoomLang(room || {});
  // Body shape: when a recommendation is supplied, lead with the chair's
  // call so the user reads it before pressing a button. When omitted
  // (recommendation undefined / haiku unavailable), fall back to a
  // templated ping. Opener + tail are picked from rotating pools so
  // the chair doesn't sound like a stuck cron job.
  const opener = pickByRound(poolFor(ROUND_OPENERS_EN, ROUND_OPENERS_ZH, roomLang), roundNum);
  let body: string;
  if (recommendation) {
    const rationale = recommendation.rationale.trim();
    if (recommendation.kind === "end") {
      body = rationale
        ? `${opener} ${rationale} ${pickByRound(poolFor(END_TAILS_WITH_RATIONALE_EN, END_TAILS_WITH_RATIONALE_ZH, roomLang), roundNum)}`
        : `${opener} ${pickByRound(poolFor(END_TAILS_BARE_EN, END_TAILS_BARE_ZH, roomLang), roundNum)}`;
    } else {
      body = rationale
        ? `${opener} ${rationale} ${pickByRound(poolFor(CONTINUE_TAILS_WITH_RATIONALE_EN, CONTINUE_TAILS_WITH_RATIONALE_ZH, roomLang), roundNum)}`
        : `${opener} ${pickByRound(poolFor(CONTINUE_TAILS_BARE_EN, CONTINUE_TAILS_BARE_ZH, roomLang), roundNum)}`;
    }
  } else {
    body = `${opener} ${pickByRound(poolFor(NEUTRAL_TAILS_EN, NEUTRAL_TAILS_ZH, roomLang), roundNum)}`;
  }
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body,
    meta: {
      kind: "round-prompt",
      roundNum,
      // Carry the chair's call into meta so the UI can highlight the
      // recommended button. Absent when no recommendation was made.
      recommendation: recommendation
        ? { kind: recommendation.kind, rationale: recommendation.rationale }
        : null,
      speakerStatus: "final",
      streaming: false,
    },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  // Voice mode · synthesize chair audio and BLOCK until playback
  // completes before firing message-final. Mirrors the ordering in
  // streamChairMessage (voice-final before message-final) so the
  // pump's awaiter doesn't release until the chair's audio has been
  // heard. Caller must await this function for ordering to hold.
  await emitChairAnnouncementVoice(roomId, m.id, m.body);
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/**
 * Mid-round chair intervention · template-driven (no LLM call here · the
 * picker has already produced the body). The chair drops a one-sentence
 * frame note BEFORE the next director speaks when the picker detects
 * substantive misalignment in the prior turns (talking past each other,
 * undefined load-bearing term, hidden trade-off, circling).
 *
 * Bias-to-skip lives in the picker: if you reach this function, the
 * intervention is already vetted. Posted with kind=intervention so the
 * UI can style it as a moderator note rather than a turn.
 */
export async function announceIntervention(
  roomId: string,
  body: string,
  rationale?: string,
): Promise<void> {
  const chair = getChairAgent();
  if (!chair) return;
  const text = body.trim();
  if (!text) return;
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body: text,
    meta: {
      kind: "intervention",
      rationale: rationale || "",
      speakerStatus: "final",
      streaming: false,
    },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  // Voice mode · BLOCK on playback before firing message-final so
  // the pump's awaiter holds until the chair's audio has been
  // heard. Caller must `await announceIntervention(...)`.
  await emitChairAnnouncementVoice(roomId, m.id, m.body);
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/**
 * Research-mode hint · when a research-mode room opens but the user
 * has no Brave Search API key configured, the chair posts a single
 * non-blocking notice explaining that the room will work without web
 * search but is significantly more useful with it. Doesn't gate
 * convening; doesn't repeat (caller is responsible for one-shot).
 *
 *   meta.kind = "research-hint"
 */
export function announceResearchHint(roomId: string, lang: "en" | "zh" = "en"): void {
  const chair = getChairAgent();
  if (!chair) return;
  const body = lang === "zh"
    ? "这是一间 **research room** —— 我会让每位 director 默认用 web search 去外部材料里挖事实。\n\n" +
      "目前你还没配置 **Brave Search API key**，房间会照常运行（directors 会从已有上下文+他们的训练知识里讨论），但接不上外部 fact-finding，效果会差不少。\n\n" +
      "建议在 **Preference → API Key → Brave Search** 里配一个（约 $5 / 1000 次查询，隐私友好），然后这间房就能用了。"
    : "This is a **research room** — I'll have every director default to web search for outside fact-finding.\n\n" +
      "You haven't configured a **Brave Search API key** yet, so the room will run on directors' training knowledge + the conversation context only — workable, but materially less useful for a research session.\n\n" +
      "Open **Preference → API Key → Brave Search** to configure one (≈ $5 per 1,000 queries, privacy-respecting). The room will use it from the next turn onward.";
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body,
    meta: {
      kind: "research-hint",
      speakerStatus: "final",
      streaming: false,
    },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/**
 * Drop a chair-authored notice when an upstream API returns a quota /
 * billing / credit-exhausted error. Replaces the silent placeholder-
 * deletion path · the user sees the chair (in-character, in the chat
 * stream) explain why the directors stopped speaking, rather than
 * having a turn vanish without trace.
 *
 *   meta.kind = "billing-notice"
 *
 * The frontend can target this kind for a yellow / warning render
 * treatment. Provider hint (e.g. "OpenAI") gets folded into the body
 * when we can extract it; otherwise the message stays generic.
 */
export function announceBillingNotice(
  roomId: string,
  opts: { providerHint: string | null; rawError: string; agentName?: string },
): void {
  const chair = getChairAgent();
  if (!chair) return;
  const carrier = opts.providerHint ?? "上游模型";
  const speaker = opts.agentName ? `（${opts.agentName} 那边收到 ${carrier} 返回的额度耗尽错误）\n\n` : "";
  const body =
    `${speaker}先停一下 · ${carrier} 账户当前额度不足，无法继续这轮发言。\n\n` +
    `请到 Preference → API Key 检查计费状态：\n` +
    `· 给当前 carrier 充值后重试，或\n` +
    `· 删除该 key、换一个有余额的 carrier（OpenRouter / Anthropic / Google / xAI），系统会自动把所有 agent 切到新 carrier 的旗舰模型。`;
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body,
    meta: {
      kind: "billing-notice",
      providerHint: opts.providerHint,
      rawError: opts.rawError,
      speakerStatus: "final",
      streaming: false,
    },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/**
 * Announce the start of a fresh director round. Two flavours:
 *   · opening sweep · directors speak in PARALLEL from their own
 *     lenses (they don't see each other's drafts in this round) —
 *     prevents the "first speaker anchors everyone" convergence
 *     problem.
 *   · reactive sweep · directors react to one another's prior
 *     contributions (Continue clicked, normal cross-pollination).
 *
 * Persists as a chair message with `meta.kind === "round-open"` so the
 * client can render it as a milestone marker (chip + flanking lines)
 * making the mode-shift legible to the user. Skipped when the round
 * is a single forced speaker (e.g., user @-mention reply).
 */
export function announceRoundOpen(
  roomId: string,
  roundNum: number,
  opening: boolean,
): void {
  const chair = getChairAgent();
  if (!chair) return;
  const body = opening
    ? `Round ${roundNum} · directors speak in parallel — independent perspectives from each lens.`
    : `Round ${roundNum} · directors react to one another now — extending, pushing back, and sharpening.`;
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body,
    meta: { kind: "round-open", roundNum, opening },
    roundNum,
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/**
 * Announce that the room is adjourning without filing a brief. Chair-
 * authored, template-driven, persists in the message store so it
 * survives reload and renders as the closing marker card in chat.
 * The client renders this as a milestone card (not a bubble) using
 * `meta.kind === "no-brief"`.
 */
export function announceAdjournNoBrief(roomId: string): void {
  const chair = getChairAgent();
  if (!chair) return;
  const body =
    "Session adjourned without a report. If you'd like one later, use *Generate report* in the room header.";
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body,
    meta: { kind: "no-brief" },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/**
 * Announce members joining or leaving the room. Template-driven so the
 * announcement is instant; the chair voice keeps continuity with the
 * other lifecycle pings. Caller passes `added` / `removed` agent ids;
 * we resolve names + role tags from the agents store. No-op if both
 * lists are empty.
 */
export function announceMemberChange(
  roomId: string,
  added: string[],
  removed: string[],
): void {
  const chair = getChairAgent();
  if (!chair) return;
  if (added.length === 0 && removed.length === 0) return;

  function namesAndRoles(ids: string[]): string {
    return ids
      .map((id) => {
        const a = getAgent(id);
        if (!a) return null;
        const role = a.roleTag ? ` *(${a.roleTag})*` : "";
        return `**${a.name}**${role}`;
      })
      .filter((s): s is string => s !== null)
      .join(", ");
  }

  const lines: string[] = [];
  if (added.length > 0) {
    const list = namesAndRoles(added);
    if (list) {
      lines.push(
        added.length === 1
          ? `Welcome ${list} to the room. Joining the rotation now.`
          : `Welcoming ${list} to the room. Joining the rotation now.`,
      );
    }
  }
  if (removed.length > 0) {
    const list = namesAndRoles(removed);
    if (list) {
      lines.push(
        removed.length === 1
          ? `${list} has left the room.`
          : `${list} have left the room.`,
      );
    }
  }
  if (lines.length === 0) return;

  const body = lines.join(" ");
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body,
    meta: { kind: "members", added, removed },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/**
 * Announce a settings change in chat as a chair message. Template-driven
 * (no LLM call) so it's instant and free; the chair persona keeps the
 * voice consistent with their other turns. Output language follows the
 * room subject: CJK characters → Chinese marker, otherwise English.
 * Hardcoded English used to read out-of-character in CN rooms.
 */
export function announceSettingsChange(
  roomId: string,
  changes: Record<string, { from: unknown; to: unknown }>,
): void {
  const chair = getChairAgent();
  if (!chair) return;

  const room = getRoom(roomId);
  const isZh = !!(room && room.subject && /[一-鿿]/.test(room.subject));

  const lines: string[] = [];
  if (changes.mode) {
    lines.push(isZh
      ? `语气：${String(changes.mode.from)} → **${String(changes.mode.to)}**。`
      : `Tone: ${String(changes.mode.from)} → **${String(changes.mode.to)}**.`);
  }
  if (changes.intensity) {
    lines.push(isZh
      ? `强度:${String(changes.intensity.from)} → **${String(changes.intensity.to)}**。`
      : `Intensity: ${String(changes.intensity.from)} → **${String(changes.intensity.to)}**.`);
  }
  if (changes.briefStyle) {
    lines.push(isZh
      ? `报告风格:${String(changes.briefStyle.from)} → **${String(changes.briefStyle.to)}**。`
      : `Report style: ${String(changes.briefStyle.from)} → **${String(changes.briefStyle.to)}**.`);
  }
  if (lines.length === 0) return;

  const body = lines.join(" ") + (isZh ? " 继续。" : " Continuing.");
  const m = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: chair.id,
    body,
    meta: { kind: "settings", changes },
  });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "agent",
    authorId: chair.id,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}
