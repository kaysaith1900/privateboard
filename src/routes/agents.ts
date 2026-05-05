/**
 * /api/agents · list / get / create directors.
 *
 *   GET  /              → directors only (chair excluded by listAgents)
 *   GET  /:id           → single agent (chair fetchable here for chat resolution)
 *   POST /              → create a new user-defined director from the
 *                         new-agent overlay
 */
import { Hono } from "hono";

import { isModelV } from "../ai/registry.js";
import { deleteAgent, getAgent, getAgentByHandle, getAgentStats, getChairAgent, insertAgent, listAgents, updateAgent } from "../storage/agents.js";
import {
  deleteMemory,
  getMemory,
  insertMemory,
  isMemoryKind,
  listMemoriesForAgent,
  updateMemory,
  type MemoryKind,
} from "../storage/memories.js";
import {
  countSkillsForAgent,
  deleteSkill,
  getSkill,
  getSkillBySlug,
  insertSkill,
  listSkillsForAgent,
} from "../storage/skills.js";
import { parseSkillMd } from "../skills/parse.js";
import { analyzeSkillAbility } from "../skills/analyze.js";
import { getSystemSkillsForAgent, isSystemSkillSlug } from "../skills/system-skills.js";
import { callLLM } from "../ai/adapter.js";
import { buildAgentSpecMessages, parseAgentSpec } from "../ai/prompts/agent-spec.js";
import { newId } from "../utils/id.js";

/** Caps from PRD-skills §4. Server-enforced; UI mirrors. */
const SKILL_CAP_CHAIR = 12;
const SKILL_CAP_DIRECTOR = 5;

const NAME_MIN = 2;
const NAME_MAX = 32;
const BIO_MIN = 8;
const BIO_MAX = 280;
const INSTR_MIN = 1;       // permissive — empty allowed too with generic fallback
const INSTR_MAX = 4000;
const HANDLE_MAX = 18;
// Allow data: URLs (the SVG-generated client-side avatars) and absolute
// paths under /avatars/. Anything else gets normalized to a default.
const AVATAR_DATA_URL_RE = /^data:image\/svg\+xml(;[^,]+)?,/i;
const AVATAR_PATH_RE = /^\/avatars\/[\w.-]+\.(svg|png|webp)$/i;

const ABILITY_AXES = [
  "dissent",
  "pattern_recall",
  "rigor",
  "empathy",
  "narrative",
  "decisiveness",
] as const;
type AbilityAxis = (typeof ABILITY_AXES)[number];

/** Validate + clamp an ability map sent in the request body. Returns
 *  null if input is empty or all-axis-equal (degenerate radar). */
function parseAbilityFromRequest(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const axis of ABILITY_AXES) {
    const v = obj[axis];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[axis] = Math.max(0, Math.min(10, Math.round(v)));
  }
  const values = Object.values(out);
  if (values.length < 4) return null;
  if (values.every((v) => v === values[0])) return null;
  return out;
}

/** Heuristic fallback · derives a non-uniform radar shape from text by
 *  keyword-matching axis-relevant terms. Always returns a profile with
 *  variance so the radar is never flat. */
function synthesizeAbility(text: string): Record<string, number> {
  const t = (text || "").toLowerCase();
  const matches: Record<AbilityAxis, RegExp[]> = {
    dissent: [/skeptic/, /challenge/, /push back/, /contrar/, /devil/, /question/, /interrogat/, /refus/, /disagree/],
    pattern_recall: [/history/, /pattern/, /precedent/, /analogue/, /analog/, /case stud/, /track record/, /memory/, /historic/, /horizon/, /long.cycle/, /investor/],
    rigor: [/rigor/, /precise/, /first principle/, /physic/, /logic/, /evidence/, /proof/, /quantit/, /math/, /scientif/, /numerical/],
    empathy: [/empath/, /user/, /customer/, /human/, /story/, /care/, /experience/, /persona/, /emotion/, /stakeholder/, /absent/],
    narrative: [/story/, /narrativ/, /scenario/, /arc/, /vision/, /imagin/, /metaphor/, /journey/, /craft/, /writer/],
    decisiveness: [/decid/, /decisive/, /commit/, /cut/, /force a call/, /executive/, /operator/, /ship/, /priorit/, /act/],
  };
  const out: Record<string, number> = {};
  // Each axis starts mid; a hit boosts +1, multiple hits +2-3.
  for (const axis of ABILITY_AXES) {
    let score = 5;
    let hits = 0;
    for (const re of matches[axis]) if (re.test(t)) hits++;
    if (hits >= 3)      score = 9;
    else if (hits === 2) score = 8;
    else if (hits === 1) score = 7;
    out[axis] = score;
  }
  // Ensure shape: pick the lowest-scoring axes and damp them so the
  // radar has clear weak points. Sort by current score asc.
  const sorted = ABILITY_AXES.slice().sort((a, b) => out[a] - out[b]);
  // Damp the bottom two axes that didn't get any hit.
  let damped = 0;
  for (const axis of sorted) {
    if (damped >= 2) break;
    if (out[axis] === 5) { out[axis] = 3; damped++; }
  }
  // Guarantee at least one peak — if everything ended at 5 (no keyword
  // hits at all), boost a deterministic axis based on the text length so
  // the radar still has variance.
  const peak = Math.max(...Object.values(out));
  if (peak <= 5) {
    const idx = (text || "").length % ABILITY_AXES.length;
    out[ABILITY_AXES[idx]] = 8;
  }
  return out;
}

function slugifyHandle(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")     // strip diacritics
      .replace(/[^a-z0-9_]+/g, "_")        // non-alnum → _
      .replace(/^_+|_+$/g, "")             // trim leading/trailing _
      .slice(0, HANDLE_MAX) || "new_agent"
  );
}

/** Find a unique handle by appending _2, _3 … if the base is taken. */
function uniqueHandle(base: string): string {
  let h = "/" + base;
  if (!getAgentByHandle(h)) return h;
  for (let i = 2; i < 1000; i++) {
    const candidate = `/${base}_${i}`;
    if (!getAgentByHandle(candidate)) return candidate;
  }
  // Last-resort suffix · effectively never hits.
  return "/" + base + "_" + Math.floor(Math.random() * 9999);
}

export function agentsRouter(): Hono {
  const r = new Hono();

  // Director list. The chair (moderator) is bundled separately so the
  // client can surface it in the sidebar with special treatment without
  // pulling it into the regular `agents` array (which is iterated for
  // pickers, room rosters, custom-vs-core grouping, etc.).
  r.get("/", (c) => c.json({ agents: listAgents(), chair: getChairAgent() }));

  r.get("/:id", (c) => {
    const a = getAgent(c.req.param("id"));
    if (!a) return c.json({ error: "not found" }, 404);
    return c.json(a);
  });

  // ── AI-generated agent spec · accepts a free-text description and
  //    returns a fully-formed director spec (name, handle, role tag,
  //    bio, cover quote, instruction, model). The frontend's new-agent
  //    composer renders this as a preview the user can edit + save.
  //    Tries opus-4-7 first, falls back to sonnet-4-6.
  r.post("/generate-spec", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const b = (body ?? {}) as { description?: unknown };
    const description = typeof b.description === "string" ? b.description.trim() : "";
    if (description.length < 4) {
      return c.json({ error: "describe the director in at least a few words" }, 400);
    }
    if (description.length > 1200) {
      return c.json({ error: "description too long (max 1200 chars)" }, 400);
    }
    const messages = buildAgentSpecMessages({ description });
    const candidates = ["opus-4-7", "sonnet-4-6"] as const;
    for (const modelV of candidates) {
      if (!isModelV(modelV)) continue;
      try {
        const raw = await callLLM({ modelV, messages, temperature: 0.55, maxTokens: 1800 });
        const spec = parseAgentSpec(raw);
        if (spec) {
          // Guarantee a non-flat ability profile in the preview · if the
          // LLM omitted or flattened it, synthesize from bio + roleTag
          // + description so the radar always shows real personality.
          if (!spec.ability || Object.keys(spec.ability).length === 0) {
            spec.ability = synthesizeAbility(`${spec.bio} ${spec.roleTag} ${description}`);
          }
          return c.json({ spec });
        }
      } catch (e) {
        process.stderr.write(`[agent-spec] ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    return c.json({ error: "couldn't generate an agent spec — try a more concrete description, or configure manually" }, 502);
  });

  // ── Create a user-defined director.
  r.post("/", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const b = (body ?? {}) as Record<string, unknown>;

    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      return c.json({ error: `name must be ${NAME_MIN}–${NAME_MAX} chars` }, 400);
    }

    const bio = typeof b.bio === "string" ? b.bio.trim() : "";
    if (bio.length < BIO_MIN || bio.length > BIO_MAX) {
      return c.json({ error: `description must be ${BIO_MIN}–${BIO_MAX} chars` }, 400);
    }

    const instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
    if (instruction.length > INSTR_MAX) {
      return c.json({ error: `instruction must be ≤ ${INSTR_MAX} chars` }, 400);
    }
    // If the user didn't write a system prompt, derive a plain one from
    // the bio so the agent still has voice instructions.
    const finalInstruction = instruction.length >= INSTR_MIN
      ? instruction
      : [
          `You are ${name}, a board director. Your role and approach are:`,
          "",
          bio,
          "",
          "Voice: opinionated, specific, concise. Use *italics* for the word you're interrogating; **bold** for the load-bearing claim. Don't preface, don't summarize — just speak.",
        ].join("\n");

    const modelV = typeof b.modelV === "string" ? b.modelV.trim() : "";
    if (!isModelV(modelV)) {
      return c.json({ error: `unknown model: ${modelV}` }, 400);
    }

    // Avatar — accept either a data: URL or an /avatars/ path. Anything
    // weird falls back to a generic SVG so the agent still renders.
    const rawAvatar = typeof b.avatarPath === "string" ? b.avatarPath : "";
    const avatarPath =
      rawAvatar && (AVATAR_DATA_URL_RE.test(rawAvatar) || AVATAR_PATH_RE.test(rawAvatar))
        ? rawAvatar
        : "/avatars/socrates.svg";

    // Optional roleTag — if missing, derive from the bio's first noun-ish
    // token, falling back to a generic "custom".
    let roleTag = typeof b.roleTag === "string" ? b.roleTag.trim() : "";
    if (!roleTag) {
      const firstWord = bio.split(/\s+/)[0]?.toLowerCase() || "";
      roleTag = firstWord.length >= 3 && firstWord.length <= 14 ? firstWord : "custom";
    }
    if (roleTag.length > 32) roleTag = roleTag.slice(0, 32);

    const handle = uniqueHandle(slugifyHandle(name));
    const id = newId();

    // Ability axes · accept from the request (set by the AI-spec
    // pipeline) and clamp to 0..10. If the caller didn't send one (e.g.
    // legacy manual overlay) we synthesize a varied profile from the
    // bio so the radar is never flat.
    const ability = parseAbilityFromRequest(b.ability) || synthesizeAbility(bio + " " + roleTag);

    const created = insertAgent({
      id,
      name,
      handle,
      roleTag,
      roleKind: "director",
      bio,
      coverQuote: typeof b.coverQuote === "string" ? b.coverQuote.slice(0, 200) : null,
      instruction: finalInstruction,
      modelV,
      avatarPath,
      ability,
      isPinned: false,
      isSeed: false,
    });

    return c.json(created, 201);
  });

  // ── Update fields on an agent. v1 only supports avatarPath
  //    (the profile menu's "regenerate avatar" action posts here).
  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getAgent(id);
    if (!existing) return c.json({ error: "not found" }, 404);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const b = (body ?? {}) as Record<string, unknown>;
    const patch: {
      avatarPath?: string;
      modelV?: string;
      carrierPref?: "openrouter" | "anthropic" | "openai" | "google" | "xai" | null;
      bio?: string;
      webSearchEnabled?: boolean;
    } = {};

    if (typeof b.avatarPath === "string") {
      // The chair's identity is structural — same face across rooms is
      // part of their recognisability, so we lock the avatar at the
      // server. UI also hides the regenerate option for the chair, but
      // we enforce here too in case anyone hits the route directly.
      if (existing.roleKind === "moderator") {
        return c.json({ error: "the chair's avatar is fixed and cannot be changed" }, 403);
      }
      const raw = b.avatarPath;
      if (!AVATAR_DATA_URL_RE.test(raw) && !AVATAR_PATH_RE.test(raw)) {
        return c.json({ error: "invalid avatarPath" }, 400);
      }
      patch.avatarPath = raw;
    }

    if (typeof b.modelV === "string") {
      const v = b.modelV.trim();
      if (!isModelV(v)) {
        return c.json({ error: `unknown model: ${v}` }, 400);
      }
      patch.modelV = v;
    }

    // carrierPref · explicit `null` clears the override; an enum value
    // pins the carrier; key absence leaves the field untouched. The
    // adapter falls back to default routing when the carrier is not
    // reachable, so we don't reject pins for currently-missing keys —
    // the user might be about to add that key, or might want the pin
    // to take effect later.
    if ("carrierPref" in b) {
      if (b.carrierPref === null) {
        patch.carrierPref = null;
      } else if (typeof b.carrierPref === "string") {
        const v = b.carrierPref.trim();
        const allowed = new Set(["openrouter", "anthropic", "openai", "google", "xai"]);
        if (!allowed.has(v)) {
          return c.json({ error: `unknown carrier: ${v}` }, 400);
        }
        patch.carrierPref = v as "openrouter" | "anthropic" | "openai" | "google" | "xai";
      }
    }

    if (typeof b.bio === "string") {
      const trimmed = b.bio.trim();
      if (trimmed.length < BIO_MIN || trimmed.length > BIO_MAX) {
        return c.json({ error: `description must be ${BIO_MIN}–${BIO_MAX} chars` }, 400);
      }
      patch.bio = trimmed;
    }

    if (typeof b.webSearchEnabled === "boolean") {
      patch.webSearchEnabled = b.webSearchEnabled;
    }

    const updated = updateAgent(id, patch);
    return c.json(updated);
  });

  // ── Permanently delete a custom (user-created) director.
  //    Seed directors and the chair are structural — server refuses
  //    to delete either. Cascades clean up room memberships, skills,
  //    and long-term memories; past messages keep their author_id but
  //    resolve to "unknown agent" in the UI.
  r.delete("/:id", (c) => {
    const id = c.req.param("id");
    const existing = getAgent(id);
    if (!existing) return c.json({ error: "not found" }, 404);
    if (existing.roleKind === "moderator") {
      return c.json({ error: "the chair is structural and cannot be deleted" }, 403);
    }
    if (existing.isSeed) {
      return c.json({ error: "seeded directors are core to the boardroom and cannot be deleted" }, 403);
    }
    const ok = deleteAgent(id);
    if (!ok) return c.json({ error: "delete failed" }, 500);
    return c.json({ ok: true });
  });

  // ── Profile counters surfaced under "Track Record":
  //    rooms joined, rounds spoken, cumulative tokens consumed.
  r.get("/:id/stats", (c) => {
    const id = c.req.param("id");
    const existing = getAgent(id);
    if (!existing) return c.json({ error: "not found" }, 404);
    return c.json(getAgentStats(id));
  });

  // ── Long-term memory · per-agent notes about the user that flow
  //    across every room. Read by the agent profile's Memory tab and
  //    by the prompt builder for context injection.
  r.get("/:id/memories", (c) => {
    const id = c.req.param("id");
    if (!getAgent(id)) return c.json({ error: "not found" }, 404);
    return c.json({ memories: listMemoriesForAgent(id) });
  });

  // Manual add · user types a note into the Memory tab.
  r.post("/:id/memories", async (c) => {
    const id = c.req.param("id");
    if (!getAgent(id)) return c.json({ error: "not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const b = (body ?? {}) as { content?: unknown; kind?: unknown; pinned?: unknown };
    const content = typeof b.content === "string" ? b.content.trim() : "";
    if (content.length < 4 || content.length > 280) {
      return c.json({ error: "content must be 4–280 chars" }, 400);
    }
    const kind: MemoryKind = (typeof b.kind === "string" && isMemoryKind(b.kind)) ? b.kind : "fact";
    const pinned = b.pinned === true;
    const memory = insertMemory({
      agentId: id,
      content,
      kind,
      source: "user_added",
      sourceRoom: null,
      confidence: 1,
      pinned,
    });
    return c.json(memory);
  });

  // Edit content / kind / pin state on an existing memory.
  r.patch("/:id/memories/:memId", async (c) => {
    const memId = c.req.param("memId");
    const existing = getMemory(memId);
    if (!existing) return c.json({ error: "not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const b = (body ?? {}) as { content?: unknown; kind?: unknown; pinned?: unknown };
    const patch: { content?: string; kind?: MemoryKind; pinned?: boolean } = {};
    if (typeof b.content === "string") {
      const trimmed = b.content.trim();
      if (trimmed.length < 4 || trimmed.length > 280) {
        return c.json({ error: "content must be 4–280 chars" }, 400);
      }
      patch.content = trimmed;
    }
    if (typeof b.kind === "string") {
      if (!isMemoryKind(b.kind)) return c.json({ error: `unknown kind: ${b.kind}` }, 400);
      patch.kind = b.kind;
    }
    if (typeof b.pinned === "boolean") {
      patch.pinned = b.pinned;
    }
    const updated = updateMemory(memId, patch);
    return c.json(updated);
  });

  // Delete a single memory.
  r.delete("/:id/memories/:memId", (c) => {
    const memId = c.req.param("memId");
    const ok = deleteMemory(memId);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // ── Skills · per-agent .md uploads. PRD-skills §5. ──────────────────
  // System skills (e.g. the chair's report-writer) are prepended to the
  // DB-backed list; they're synthesized at read time and cannot be
  // installed, edited, or deleted by the user.
  r.get("/:id/skills", (c) => {
    const id = c.req.param("id");
    const agent = getAgent(id);
    if (!agent) return c.json({ error: "not found" }, 404);
    const systemSkills = getSystemSkillsForAgent(agent);
    const userSkills = listSkillsForAgent(id);
    return c.json({ skills: [...systemSkills, ...userSkills] });
  });

  // Install · POST { md: "<full Skill.md text>" }. We parse + validate
  // server-side (caller can send raw file contents from the drop-zone
  // without needing multipart). Caps enforced before insert.
  r.post("/:id/skills", async (c) => {
    const id = c.req.param("id");
    const agent = getAgent(id);
    if (!agent) return c.json({ error: "not found" }, 404);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const b = (body ?? {}) as { md?: unknown };
    if (typeof b.md !== "string") {
      return c.json({ error: "missing `md` (string with full Skill.md contents)" }, 400);
    }

    const parsed = parseSkillMd(b.md);
    if (!parsed.ok) return c.json({ error: `invalid skill.md: ${parsed.error}` }, 400);

    if (isSystemSkillSlug(parsed.skill.slug)) {
      return c.json({ error: `slug '${parsed.skill.slug}' is reserved for a system skill and cannot be installed` }, 409);
    }

    if (getSkillBySlug(id, parsed.skill.slug)) {
      return c.json({ error: `slug '${parsed.skill.slug}' already installed` }, 409);
    }

    const cap = agent.roleKind === "moderator" ? SKILL_CAP_CHAIR : SKILL_CAP_DIRECTOR;
    const used = countSkillsForAgent(id);
    if (used >= cap) {
      return c.json({ error: `cap reached (${used}/${cap}). Uninstall a skill to make room.` }, 409);
    }

    // Auto-analyze ability axes when the user didn't provide them in
    // frontmatter. Manual `ability:` always wins; the analyzer is a
    // best-effort fallback (returns {} on any failure, in which case
    // the skill installs with no deltas — same as before this feature).
    let ability: Record<string, number> = parsed.skill.ability;
    if (!ability || Object.keys(ability).length === 0) {
      try {
        ability = await analyzeSkillAbility({
          name: parsed.skill.name,
          description: parsed.skill.description,
          whenToUse: parsed.skill.whenToUse,
          bodyMd: parsed.skill.bodyMd,
        });
      } catch {
        ability = {};
      }
    }

    const skill = insertSkill({
      agentId: id,
      slug: parsed.skill.slug,
      name: parsed.skill.name,
      version: parsed.skill.version,
      description: parsed.skill.description,
      whenToUse: parsed.skill.whenToUse,
      bodyMd: parsed.skill.bodyMd,
      ability,
      tips: parsed.skill.tips,
    });
    return c.json({ skill });
  });

  r.delete("/:id/skills/:skillId", (c) => {
    const id = c.req.param("id");
    const skillId = c.req.param("skillId");
    if (!getAgent(id)) return c.json({ error: "agent not found" }, 404);
    if (skillId.startsWith("system:")) {
      return c.json({ error: "system skills cannot be uninstalled" }, 403);
    }
    const sk = getSkill(skillId);
    if (!sk || sk.agentId !== id) return c.json({ error: "skill not found" }, 404);
    const ok = deleteSkill(skillId);
    if (!ok) return c.json({ error: "delete failed" }, 500);
    return c.json({ ok: true });
  });

  return r;
}
