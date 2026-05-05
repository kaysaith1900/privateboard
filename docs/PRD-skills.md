# PRD · Agent Skills (v1)

## Goal

Let the user equip an agent with **skills** — small, modular instruction
packs uploaded as `.md` files. When an agent answers in a room, it first
glances at its installed skills (the "toolbox") and decides which ones
to apply for this turn. The user sees both:
- A **radar chart** of the agent's resulting abilities (base + skill deltas).
- A **per-message badge** showing which skills the agent invoked, so the
  effect of installing a skill is visible turn-by-turn.

Inspired by Claude Code skills (progressive disclosure: index in the
prompt, full body loaded only when used).

---

## 1 · Skill.md format

Skills are single `.md` files with YAML frontmatter + free-markdown body.

```markdown
---
name: First-Principles Reasoning
slug: first-principles
version: 1.0
description: Strips problems to physical primitives, rebuilds from atoms.
when_to_use: When the question hides behind jargon, hand-waving, or borrowed framings.
ability:
  rigor: 2
  depth: 3
  speed: -1
tips:
  - "Best with concrete problems, not philosophical ones."
  - "Pairs well with empirical-grounding skill."
---

# Body

When invoked:
- Identify the smallest irreducible unit of the question.
- State each assumption being made.
- Rebuild the answer from those atoms upward.
```

### Frontmatter schema

Mirrors Claude Code's SKILL.md convention — only `name` + `description`
are mandatory. Everything else is optional with sensible defaults.

| field | required | type | notes |
|-------|----------|------|-------|
| `name` | yes | string | display name, ≤ 80 chars. Also used to derive `slug` when slug is omitted. |
| `slug` | no | string | `[a-z0-9-]+`, ≤ 64 chars. Derived from `name` (kebab-case slugify) when missing. Unique per agent. |
| `version` | no | string | freeform; default `"1.0"` |
| `description` | yes | string | what the skill does — read by the Pass-1 router. ≤ 4 KB (≈ 1000 words). |
| `when_to_use` | no | string | trigger conditions for the picker, ≤ 2 KB. Defaults to `description`. |
| `ability` | no | object | axis → integer delta in `[-3, 3]`. **Auto-inferred from the skill's name + description + body** when the field is omitted (cheap LLM call at install time). Manual values always win when present. |
| `tips` | no | string[] | ≤ 8 items, each ≤ 500 chars |

Body cap: 32 KB. Whole file cap: 128 KB.

**Minimum valid skill** (matches Claude Code's format exactly):

```yaml
---
name: bare-skill
description: One-line summary of what this skill does.
---

# body
```

### Body

Free markdown, ≤ 4 KB. Injected into Pass-2 system prompt only when
the skill is picked by Pass-1.

---

### Auto-analyzer

When the uploaded `.md` doesn't include an `ability:` block, the
server runs a cheap analyzer at install time to estimate axis deltas
from the skill's name + description + when_to_use + first 2KB of body.

Implementation: `src/skills/analyze.ts` calls a fast model
(`haiku-4-5`) with a strict-JSON schema:

```
{"dissent": N, "pattern_recall": N, "rigor": N, "empathy": N,
 "narrative": N, "decisiveness": N}
```

Each `N` is an integer in `[-3, 3]`. Zero values are dropped before
storage. Best-effort: if the analyzer fails (no key, parse error,
network), the skill installs with empty `ability` and the radar simply
doesn't move — same as before this feature.

Manual `ability:` in frontmatter is the explicit override and bypasses
the analyzer entirely.

## 2 · Ability radar (6 axes)

Boardroom-specific, fixed:

`dissent · pattern-recall · rigor · empathy · narrative · decisiveness`

Each axis ranges 0–10. Each agent has a **base profile** (its natural
tendencies — set in seed for core agents, defaults to 5/all for custom).
Each installed skill adds its `ability` deltas. Stacking is additive
(no cap from multiple skills, but each axis is clamped to `[0, 10]` for
display).

The radar shows two layered shapes:
- **Base** — faint outline (the agent without skills).
- **Current** — filled, lime — base + sum of installed skill deltas.

---

## 3 · Two-pass orchestrator

When a director (or chair) is asked to speak AND has ≥1 installed skill:

**Pass 1 · skill picker** (cheap model, e.g. `haiku-4-5` or `gpt-5-mini`):

System prompt:
```
You are {agent.name}'s skill router.

Available skills (toolbox):
- first-principles · "Strips problems to physical primitives." · USE WHEN: the question hides behind jargon...
- value-investor · "Pattern recognition trained on 20yr market history." · USE WHEN: the question is about durability or moats...

The user's question:
{prompt}

Reply with strict JSON: {"use": ["slug1", "slug2"], "reason": "≤100 chars"}.
Pick at most 2 skills; if none apply, return {"use": [], "reason": "..."}.
```

**Pass 2 · main answer** (the agent's configured model):

Standard system prompt + appended for each picked skill:

```
─── ACTIVE SKILL: {name} ───
{when_to_use}

{body}
─── END SKILL ───
```

Skill picks are persisted on the message row (`meta.skills_used:
[slug, ...]`) so the chat UI can render the badge.

If the agent has **no** installed skills, Pass-1 is skipped — single
call, current behavior preserved.

### Cost / latency budget

- Pass-1 ~150–400 tokens in / ~80 tokens out, cheap model: ≈ 0.5–1.5s.
- Pass-2 unchanged from today.
- Net overhead per turn: ≈ +1s + 0.001 USD (haiku/flash class).

---

## 4 · Caps

| role | installed skill cap |
|------|--------------------:|
| chair | 12 |
| director | 5 |

Server enforces on POST. UI hides the install drop-zone when full.

---

## 5 · API

```
GET    /api/agents/:id/skills              → { skills: Skill[] }
POST   /api/agents/:id/skills              → { skill }                 // body: { md: "<full .md text>" }
DELETE /api/agents/:id/skills/:skillId     → { ok: true }
```

`Skill` shape returned by GET / POST:

```ts
{
  id: string;
  agentId: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  whenToUse: string;
  ability: Record<string, number>;   // axis → delta
  tips: string[];
  bodyMd: string;
  createdAt: number;
  updatedAt: number;
}
```

Errors:
- 400 `invalid skill.md: <reason>` — frontmatter / body validation
- 409 `slug already installed`
- 409 `cap reached (chair=12 / director=5)`

---

## 6 · Storage

New SQLite table:

```sql
CREATE TABLE agent_skills (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '1.0',
  description TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  body_md     TEXT NOT NULL,
  ability_json TEXT NOT NULL DEFAULT '{}',
  tips_json   TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (agent_id, slug),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_skills_agent ON agent_skills (agent_id);
```

Per-agent (no shared library in v1).

---

## 7 · UI

### Skills block (replaces the 3×3 slot grid)

```
┌─ // SKILLS ──────────── 3 / 5 installed · drop .md ─┐
│                                                     │
│            [ ability radar SVG · 6 axes ]           │
│            base outline (faint)                     │
│            current filled (lime)                    │
│                                                     │
│  ─────────────────────────────────────────────      │
│  ◆ first-principles    rigor +2 · depth +3   (i)  ✕ │
│  ◆ value-investor      recall +3 · speed -1  (i)  ✕ │
│  ◆ user-empathy        empathy +3 · narr +1  (i)  ✕ │
│  ─────────────────────────────────────────────      │
│  ⊕ install skill (drop a .md file or click)         │
└─────────────────────────────────────────────────────┘
```

- Drop-zone accepts `.md`. Click opens file picker. Reads file, POSTs to
  the API, on success re-renders the block.
- Each row: lime mark + slug-style name + delta chips (lime for +,
  amber for -) + info icon (popover with `tips` on hover/click) + ✕
  uninstall.
- When cap reached, drop-zone is replaced by `cap reached · uninstall
  to make room`.

### Per-message badge

When `message.meta.skills_used` is non-empty, the chat bubble's meta
line gains a small pill:

```
SOCRATES // skeptic · model: opus 4.7 · 🛠 first-principles, value-investor
```

Hovering shows the `reason` from Pass-1. Clicking is a no-op for v1.

---

## 8 · Out of scope (v1)

- Shared skill library / discovery
- Editing a skill in-place (delete + re-upload instead)
- Skill conflict warnings (user can install conflicting skills; the
  picker may pick neither, or both — let the model resolve)
- Marketplace / rating / signing
- Skill-driven tool calls (we're still in pure-text chat)

---

## 9 · Test plan

- Upload valid skill.md → installs, radar updates, list shows row.
- Upload malformed skill.md → 400 with reason; UI shows error toast.
- Upload duplicate slug → 409.
- Install up to cap, attempt one more → 409.
- Director with 0 skills speaks → single-pass (no Pass-1 call observed).
- Director with skills speaks → Pass-1 fires, Pass-2 fires, message has
  `meta.skills_used` and chat shows badge.
- Uninstall → row gone, radar reverts.
