/**
 * Celebrity seed generator · invent ONE new famous-figure preset
 * to replenish the new-agent composer's seed pool.
 *
 * Called from `POST /api/agents/celebrity-seed` whenever the
 * client's localStorage-tracked pool dips below 12. Single short
 * LLM call, no streaming, no DB writes — the route returns the
 * fresh seed and the client persists it in localStorage.generated.
 *
 * Cheap model only (utilityModelFor) · this is a soft side path,
 * never blocks anything the user is actively doing. Failures are
 * swallowed client-side and tried again on the next save.
 */
import { callLLM } from "../ai/adapter.js";
import { utilityModelFor } from "../ai/availability.js";

export interface CelebritySeed {
  id: string;                // kebab-case slug; also the Avatar3DSnap seed
  name: string;              // verbatim, no i18n (proper noun)
  roleTag: string;           // short English mono tag
  intro: { en: string; zh: string };
  description: string;       // seed text for the persona-builder pipeline
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

function parseSeed(raw: string): CelebritySeed | null {
  // The LLM might wrap JSON in code fences · strip them.
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  let j: unknown;
  try { j = JSON.parse(s); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim().toLowerCase() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const roleTag = typeof o.roleTag === "string" ? o.roleTag.trim().toLowerCase() : "";
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const introRaw = o.intro && typeof o.intro === "object" ? (o.intro as Record<string, unknown>) : {};
  const introEn = typeof introRaw.en === "string" ? introRaw.en.trim() : "";
  const introZh = typeof introRaw.zh === "string" ? introRaw.zh.trim() : "";

  if (!SLUG_RE.test(id)) return null;
  if (name.length < 2 || name.length > 80) return null;
  if (roleTag.length < 2 || roleTag.length > 24) return null;
  if (description.length < 60 || description.length > 1200) return null;
  if (introEn.length < 8 || introEn.length > 200) return null;
  if (introZh.length < 4 || introZh.length > 200) return null;

  return {
    id,
    name,
    roleTag,
    intro: { en: introEn, zh: introZh },
    description,
  };
}

function buildPrompt(opts: { excludeIds: string[]; emphasizeNovelty: boolean }): string {
  const excludeBlock = opts.excludeIds.length === 0
    ? "(no exclusions)"
    : opts.excludeIds.slice(0, 200).map((id) => `· ${id}`).join("\n");
  const novelty = opts.emphasizeNovelty
    ? "CRITICAL: do NOT repeat any id from the exclusion list. Re-read it before answering. Pick a different person."
    : "";
  return [
    "You are inventing ONE famous-figure preset card for an app that lets users 'hire' historical or contemporary thinkers as AI directors.",
    "",
    "Pick a real, broadly recognisable person — a founder, scientist, philosopher, investor, artist, writer, or statesperson. Strong bias toward names a literate global audience would recognise instantly (Steve Jobs, Hannah Arendt, John von Neumann, Toni Morrison level).",
    "",
    "Output STRICT JSON with exactly these fields, nothing else (no prose before or after, no code fences):",
    "{",
    `  "id": "kebab-case-slug",          // lowercase, 2-40 chars, letters/digits/hyphen, starts with a letter`,
    `  "name": "Display Name",            // verbatim · keep their real name; CJK names stay CJK`,
    `  "roleTag": "founder",              // one short English noun · examples: founder | philosopher | physicist | essayist | investor | architect | mathematician | poet | director | dissident`,
    `  "intro": {`,
    `    "en": "one-line tagline · 8 to 30 words · captures the lens this person brings",`,
    `    "zh": "中文 8 到 30 字 · 与 en 同主旨"`,
    `  },`,
    `  "description": "60-400 word seed describing the persona in the second-person mold — 'A first-principles industrialist in the mold of X — strips problems to physics, ...'. Names the thinking style, the canonical reference points, what they refuse to do, what they always push for. Drives a downstream persona-builder pipeline so concrete is better than abstract."`,
    "}",
    "",
    "Avoid these ids (already in the pool):",
    excludeBlock,
    "",
    novelty,
  ].filter(Boolean).join("\n");
}

export async function generateCelebritySeed(opts: {
  excludeIds: string[];
}): Promise<CelebritySeed> {
  const modelV = utilityModelFor();
  if (!modelV) throw new Error("no utility model available");

  const excludeSet = new Set(opts.excludeIds);

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildPrompt({
      excludeIds: opts.excludeIds,
      emphasizeNovelty: attempt > 0,
    });
    let raw: string;
    try {
      raw = await callLLM({
        modelV,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.85,
        maxTokens: 900,
      });
    } catch (e) {
      // Surface the underlying error · the route maps it to 502.
      if (attempt === 1) throw e;
      continue;
    }
    const parsed = parseSeed(raw);
    if (!parsed) continue;
    if (excludeSet.has(parsed.id)) continue;
    return parsed;
  }
  throw new Error("celebrity-seed · model failed to produce a valid novel entry");
}
