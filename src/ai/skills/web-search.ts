/**
 * Web Search system skill · Brave Search and/or Tavily API clients.
 *
 * Used by the orchestrator (room.ts) before each agent speaks: when
 * the Pass-1 router decides the turn would benefit from fresh web
 * info, we hit the configured backend for the chosen query, distill
 * the top results into a SHARED MATERIALS block, and prepend it to the
 * agent's Pass-2 system prompt.
 *
 * Failures are non-fatal — a search timeout / 4xx / 5xx degrades to
 * "no search this turn", and the agent answers from its own
 * training without the panel ever showing an error to the user.
 */

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_RESULT_COUNT = 5;

export type WebSearchBackend = "brave" | "tavily";

export interface BraveResult {
  title: string;
  url: string;
  description: string;
  /** ISO 8601 publication date when Brave surfaces one. */
  age?: string;
}

export interface BraveSearchOpts {
  apiKey: string;
  query: string;
  /** Number of results to return (1-10). */
  count?: number;
  /** Country / language hint. ISO codes from Brave docs. */
  country?: string;
  searchLang?: string;
  timeoutMs?: number;
}

/** Run a Brave Search query. Returns up to `count` results, or null
 *  on any error (timeout / 4xx / 5xx / parse failure). The caller is
 *  expected to treat null as "no search this turn" and proceed. */
export async function runBraveSearch(opts: BraveSearchOpts): Promise<BraveResult[] | null> {
  const apiKey = opts.apiKey.trim();
  const query = opts.query.trim();
  if (!apiKey || !query) return null;

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(Math.max(opts.count ?? DEFAULT_RESULT_COUNT, 1), 10)),
    safesearch: "moderate",
  });
  if (opts.country) params.set("country", opts.country);
  if (opts.searchLang) params.set("search_lang", opts.searchLang);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${BRAVE_ENDPOINT}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      process.stderr.write(`[web-search] brave returned ${res.status}\n`);
      return null;
    }
    const json = await res.json() as { web?: { results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }> } };
    const raw = (json && json.web && json.web.results) || [];
    const out: BraveResult[] = [];
    for (const r of raw) {
      const title = (r.title || "").trim();
      const url = (r.url || "").trim();
      if (!title || !url) continue;
      out.push({
        title,
        url,
        description: stripHtml(r.description || "").trim(),
        age: r.age,
      });
      if (out.length >= (opts.count ?? DEFAULT_RESULT_COUNT)) break;
    }
    return out;
  } catch (e) {
    process.stderr.write(
      `[web-search] brave fetch failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface TavilySearchOpts {
  apiKey: string;
  query: string;
  maxResults?: number;
  timeoutMs?: number;
}

/** Run a Tavily Search query · same return shape as Brave for prompt formatters. */
export async function runTavilySearch(opts: TavilySearchOpts): Promise<BraveResult[] | null> {
  const apiKey = opts.apiKey.trim();
  const query = opts.query.trim();
  if (!apiKey || !query) return null;

  const maxResults = Math.min(Math.max(opts.maxResults ?? DEFAULT_RESULT_COUNT, 1), 10);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: maxResults,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      process.stderr.write(`[web-search] tavily returned ${res.status}\n`);
      return null;
    }
    const json = await res.json() as { results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      published_date?: string;
    }> };
    const raw = (json && json.results) || [];
    const out: BraveResult[] = [];
    for (const r of raw) {
      const title = (r.title || "").trim();
      const url = (r.url || "").trim();
      if (!title || !url) continue;
      const desc = stripHtml((r.content || "").replace(/\s+/g, " "));
      out.push({
        title,
        url,
        description: desc,
        age: r.published_date,
      });
      if (out.length >= maxResults) break;
    }
    return out;
  } catch (e) {
    process.stderr.write(
      `[web-search] tavily fetch failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Dispatch to Brave or Tavily based on the user's active search backend. */
export async function runWebSearch(
  backend: WebSearchBackend,
  apiKey: string,
  query: string,
  opts?: { count?: number; timeoutMs?: number },
): Promise<BraveResult[] | null> {
  if (backend === "tavily") {
    return runTavilySearch({
      apiKey,
      query,
      maxResults: opts?.count,
      timeoutMs: opts?.timeoutMs,
    });
  }
  return runBraveSearch({
    apiKey,
    query,
    count: opts?.count,
    timeoutMs: opts?.timeoutMs,
  });
}

/** Brave returns descriptions with `<strong>` highlighting. Keep them
 *  as plain text for prompt injection — strip tags + decode the few
 *  entity references that show up. */
function stripHtml(s: string): string {
  return s
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

/** Distill search results into the SHARED MATERIALS block injected
 *  into the agent's Pass-2 system prompt. The format mirrors the
 *  fetch-url skill so agents already know how to cite this. */
export function formatSearchResults(query: string, results: BraveResult[]): string {
  if (!results.length) return "";
  const lines: string[] = [];
  lines.push("─── SHARED MATERIALS · WEB SEARCH ───");
  lines.push("");
  lines.push(`Query: ${query}`);
  lines.push("");
  lines.push(
    "Cite sources by their bracketed number when you use a fact below " +
      "(e.g. \"...as reported in [2]\"). If a source contradicts your " +
      "training, prefer the search result — it's more recent.",
  );
  lines.push("");
  results.forEach((r, i) => {
    const n = i + 1;
    const age = r.age ? ` · ${r.age}` : "";
    lines.push(`[${n}] ${r.title}${age}`);
    lines.push(`    ${r.url}`);
    if (r.description) {
      const desc = r.description.length > 320
        ? r.description.slice(0, 317) + "…"
        : r.description;
      lines.push(`    ${desc}`);
    }
    lines.push("");
  });
  lines.push("─── END SHARED MATERIALS ───");
  return lines.join("\n");
}
