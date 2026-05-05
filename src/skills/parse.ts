/**
 * Parse + validate an uploaded Skill.md file.
 *
 * Format · YAML frontmatter delimited by `---` lines, followed by free
 * markdown body:
 *
 *   ---
 *   name: First-Principles Reasoning
 *   slug: first-principles
 *   version: 1.0
 *   description: Strips problems to physical primitives.
 *   when_to_use: When the question hides behind jargon.
 *   ability:
 *     rigor: 2
 *     depth: 3
 *     speed: -1
 *   tips:
 *     - "Best with concrete problems."
 *   ---
 *
 *   # Body
 *   ...
 *
 * Validation rules and limits live in PRD-skills.md §1.
 */
import { parse as parseYaml } from "yaml";

import { ABILITY_AXES, type AbilityAxis } from "./axes.js";

export interface ParsedSkill {
  name: string;
  slug: string;
  version: string;
  description: string;
  whenToUse: string;
  ability: Record<AbilityAxis, number>;
  tips: string[];
  bodyMd: string;
}

export interface ParseError {
  ok: false;
  error: string;
}

export interface ParseSuccess {
  ok: true;
  skill: ParsedSkill;
}

export type ParseResult = ParseSuccess | ParseError;

const NAME_MAX = 80;
const SLUG_MAX = 64;
// Description is what the Pass-1 router (and Claude Code-style skill
// inventory) reads to decide whether to invoke the skill — so it
// commonly runs several paragraphs in real-world skills. 4KB is a
// comfortable upper bound that still protects against accidents.
const DESC_MAX = 4 * 1024;
const WHEN_MAX = 2 * 1024;
const TIP_MAX = 500;
const TIPS_MAX_COUNT = 8;
// Body is the full instruction text injected into Pass-2's system
// prompt. 32KB is enough for a multi-page skill document while still
// catching pathological uploads.
const BODY_MAX_BYTES = 32 * 1024;
const ABILITY_MIN = -3;
const ABILITY_MAX = 3;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Convert a freeform display name into a kebab-case slug. Mirrors the
 *  Claude Code convention where `name` is both the identifier and the
 *  display label — when it's already slug-shaped (e.g. "first-principles")
 *  we keep it; when it's prose (e.g. "First Principles Reasoning") we
 *  lowercase + collapse non-alphanumerics to hyphens. */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

function err(msg: string): ParseError {
  return { ok: false, error: msg };
}

/** Split the source into [frontmatter, body]. Both can be empty
 *  strings — caller validates required fields. */
function splitFrontmatter(src: string): { fm: string; body: string } | null {
  // Allow optional UTF-8 BOM and leading whitespace before the first `---`.
  const trimmed = src.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  if (!m) return null;
  return { fm: m[1] ?? "", body: m[2] ?? "" };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseSkillMd(src: string): ParseResult {
  if (typeof src !== "string" || src.trim().length === 0) {
    return err("file is empty");
  }
  if (Buffer.byteLength(src, "utf8") > 128 * 1024) {
    return err("file too large (max 128 KB)");
  }
  const split = splitFrontmatter(src);
  if (!split) {
    return err("missing YAML frontmatter delimited by '---' lines");
  }
  const { fm, body } = split;

  let raw: unknown;
  try {
    raw = parseYaml(fm);
  } catch (e) {
    return err(`invalid YAML frontmatter: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(raw)) {
    return err("frontmatter must be a YAML mapping (key: value pairs)");
  }

  // ── name ──────────────────────────────────────────
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return err("`name` is required (string)");
  }
  const nameTrim = name.trim();
  if (nameTrim.length > NAME_MAX) return err(`\`name\` too long (max ${NAME_MAX})`);

  // ── slug ──────────────────────────────────────────
  // Slug is optional · if missing we derive it from `name` (Claude Code
  // convention — `name` is both display and identifier). When provided,
  // it must be kebab-case.
  let slug: string;
  if (raw.slug === undefined || raw.slug === null) {
    slug = slugifyName(nameTrim);
    if (!slug) return err("couldn't derive slug from `name` — provide a `slug:` explicitly (lowercase letters, digits, hyphens)");
  } else {
    if (typeof raw.slug !== "string" || raw.slug.trim().length === 0) {
      return err("`slug` must be a non-empty string when provided");
    }
    slug = raw.slug.trim();
    if (slug.length > SLUG_MAX) return err(`\`slug\` too long (max ${SLUG_MAX})`);
    if (!SLUG_RE.test(slug)) {
      return err("`slug` must be lowercase letters, digits, and hyphens (start with letter/digit)");
    }
  }

  // ── description ──────────────────────────────────
  const description = raw.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    return err("`description` is required (string)");
  }
  const descriptionTrim = description.trim();
  if (descriptionTrim.length > DESC_MAX) return err(`\`description\` too long (max ${DESC_MAX})`);

  // ── when_to_use ──────────────────────────────────
  // Optional · falls back to `description` when omitted (Claude Code
  // skills typically use `description` for both purposes).
  let whenToUse: string;
  if (raw.when_to_use === undefined || raw.when_to_use === null) {
    whenToUse = descriptionTrim;
  } else {
    if (typeof raw.when_to_use !== "string" || raw.when_to_use.trim().length === 0) {
      return err("`when_to_use` must be a non-empty string when provided");
    }
    whenToUse = raw.when_to_use.trim();
    if (whenToUse.length > WHEN_MAX) return err(`\`when_to_use\` too long (max ${WHEN_MAX})`);
  }

  // ── version (optional) ───────────────────────────
  const version = raw.version === undefined ? "1.0" : String(raw.version).trim();
  if (version.length === 0) return err("`version` cannot be empty if provided");

  // ── ability (optional) ───────────────────────────
  const ability: Record<AbilityAxis, number> = {} as Record<AbilityAxis, number>;
  if (raw.ability !== undefined) {
    if (!isPlainObject(raw.ability)) {
      return err("`ability` must be a mapping of axis → integer delta");
    }
    for (const [k, v] of Object.entries(raw.ability)) {
      if (!ABILITY_AXES.includes(k as AbilityAxis)) {
        return err(`unknown ability axis '${k}'. Allowed: ${ABILITY_AXES.join(", ")}`);
      }
      if (typeof v !== "number" || !Number.isInteger(v)) {
        return err(`ability '${k}' must be an integer (got ${JSON.stringify(v)})`);
      }
      if (v < ABILITY_MIN || v > ABILITY_MAX) {
        return err(`ability '${k}' out of range [${ABILITY_MIN}, ${ABILITY_MAX}] (got ${v})`);
      }
      ability[k as AbilityAxis] = v;
    }
  }

  // ── tips (optional) ──────────────────────────────
  const tips: string[] = [];
  if (raw.tips !== undefined) {
    if (!Array.isArray(raw.tips)) {
      return err("`tips` must be an array of strings");
    }
    if (raw.tips.length > TIPS_MAX_COUNT) {
      return err(`too many tips (max ${TIPS_MAX_COUNT})`);
    }
    for (const t of raw.tips) {
      if (typeof t !== "string") return err("each tip must be a string");
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length > TIP_MAX) return err(`tip too long (max ${TIP_MAX})`);
      tips.push(trimmed);
    }
  }

  // ── body ─────────────────────────────────────────
  const bodyTrimmed = body.replace(/\s+$/g, "").replace(/^\s*\n/, "");
  if (Buffer.byteLength(bodyTrimmed, "utf8") > BODY_MAX_BYTES) {
    return err(`body too long (max ${BODY_MAX_BYTES} bytes)`);
  }

  return {
    ok: true,
    skill: {
      name: nameTrim,
      slug,
      version,
      description: descriptionTrim,
      whenToUse,
      ability,
      tips,
      bodyMd: bodyTrimmed,
    },
  };
}
