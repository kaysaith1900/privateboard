/**
 * System skills · hardcoded skills the user cannot install, edit, or
 * delete. They are synthesized into AgentSkill objects on read so the
 * existing skills UI can display them as read-only cards.
 *
 * Currently:
 *   · report-writer · the chair's standard 3-stage brief pipeline
 *
 * System skills do not enter the agent_skills table and are never
 * routed by the turn-time Pass-1 picker. They run from purpose-built
 * orchestrator code paths (e.g. brief.ts).
 */
import type { Agent } from "../storage/agents.js";
import { hasBraveKey } from "../storage/keys.js";
import type { AgentSkill } from "../storage/skills.js";

export const REPORT_WRITER_SLUG = "report-writer";
export const FETCH_URL_SLUG = "fetch-url";
export const WEB_SEARCH_SLUG = "web-search";

const REPORT_WRITER_BODY_MD = `# Standard Report Writer

The chair's built-in pipeline for compiling a room's transcript into a
multi-director research note. Runs automatically when the room is
adjourned. As of v0.2 it's composer-driven: every report is assembled
from a library of components, and which components appear depends on
the topic and the directors' actual contributions.

## How a report gets composed

The pipeline runs in **four** stages:

1. **Per-director extract** · each director re-reads their own
   contributions and surfaces 2–4 signals (lens-tagged: \`data\` /
   \`dissent\` / \`narrative\` / \`structural\` / \`first-principle\`).
   Diversity is guaranteed at the source.
2. **Compose** · a cheap chair-level pass picks (a) a style spine and
   (b) a subset of components that fit the room's subject. The pick is
   recorded on the brief and visible on hover of the SPINE tag.
3. **Cluster + scaffold** · the chair builds a structured scaffold
   filling only the picked components. Retried up to 3× with rising
   temperature on parse failure.
4. **Final write** · the chair streams the markdown report rendering
   only the picked components, in the order the composer chose. The
   Methodology footer is appended programmatically.

## Component library (v2 · 19 kinds)

**Anchor** (composer picks exactly one):
  · \`bottom-line\`         Sentence judgement + confidence + rationale.
  · \`thesis\`              Single load-bearing claim, pull-statement style.
  · \`working-hypothesis\`  Essay opener: hypothesis + reasons it may be wrong.

**Findings** (pick exactly one):
  · \`headline-findings\`   Three pillar claims, MECE, with supporters / challengers / sub-findings.
  · \`big-ideas\`           Three numbered claims, each with a why. Lighter, punchier.

**Action** (pick exactly one):
  · \`recommendations\`     3–5 P0/P1/P2 actions with owner / horizon / success metric / risk.
  · \`the-bet\`             Conditions to back the call, plus kill criteria.
  · \`considerations\`      Same shape as recommendations; rendered in hedged, philosophical voice.

**Optional** (independent on/off):
  · \`frame-shift\`         How the question itself moved (or held).
  · \`convergence\`         Where directors aligned via independent reasoning paths.
  · \`divergence\`          The single hinge where directors split.
  · \`positions\`           2–3 named camps with a pull-quote per camp.
  · \`visuals\`             0–4 exhibits (comparison-table / quadrant-chart / force-field / strengths-cautions).
  · \`two-paths\`           Side-by-side trajectory panels (Path A vs Path B).
  · \`why-now\`             Window opened · window closes · what to bet on.
  · \`pre-mortem\`          Failure modes with leading indicators + mitigations.
  · \`new-questions\`       Questions that emerged in the room.
  · \`planning-assumption\` Forward-looking probabilistic statement with falsification test.
  · \`open-questions\`      Residual unresolved questions tagged P0/P1.

The composer enforces 5–9 components total — too few = thin, too many = noise.

## Style spines (all 6 active)

The renderer ships full CSS for every spine the composer can pick:
\`boardroom-dark\` (default · dark warm McKinsey discipline), \`a16z-thesis\`
(black cover · orange accent · pull-statement), \`anthropic-essay\` (warm
paper · serif · drop-cap), \`gartner-note\` (clinical white · navy ·
numbered chapters), \`mckinsey-deck\` (white deck · navy slabs · 3-pillar
grid), and \`openai-paper\` (minimal sans · teal · rounded panels).

## Why it can't be modified

The composer + component library IS the chair's source of truth. The
stable component vocabulary keeps briefs comparable within the same
spine; cross-spine comparison is intentionally degraded in exchange for
fit-to-topic. Per-room edits would fragment the catalogue and make
analytics across briefs unreliable.
`;

const FETCH_URL_BODY_MD = `# Fetch URL

The chair's built-in capability for reading URLs the user shares. Whenever
the user drops an http/https link into the room, the chair fetches the page
in the background and inlines a readable excerpt into its own context — so
the chair (and, by reference, the directors) can ground their questions in
the actual source instead of guessing from the title.

## How it runs

1. **Detect** · scan the recent user messages for http(s) URLs (up to 3 per
   turn, capped to keep the chair's prompt budget healthy).
2. **Fetch** · 6-second timeout per URL, with a polite user agent. Failures
   surface as a one-line note (timeout, 404, unsupported content type)
   rather than blocking the turn.
3. **Extract** · strip HTML/scripts, decode entities, collapse whitespace,
   keep the page title and the first ~6 KB of readable text. Per-room cache
   means the same URL is only fetched once per session.
4. **Inject** · the chair sees a "SHARED MATERIALS" block in its system
   prompt with each URL's title + excerpt. Quotes are short and always
   cited by URL.

## Limits & boundaries

- HTML / plaintext only — PDFs, images, JSON APIs, and JS-heavy single-page
  apps come back thin or empty. When extraction is sparse, the chair asks
  the user to paste the relevant excerpt directly instead of speculating.
- The chair never invents page content. If a fetch fails, the prompt
  includes the error reason; the chair will say so to the user instead of
  inventing what the page might have said.
- This is a chair-only capability in v1 — directors don't auto-fetch. The
  chair surfaces what it found into its summary so directors get the
  excerpt second-hand through the room transcript.

## Why it can't be modified

Network behaviour, timeouts, and content limits are tuned to keep turn
latency predictable. Editing them per-room would make latency unpredictable
across the boardroom; if you need different fetch policy, do it at the
process level rather than per-chair.
`;

function buildFetchUrlSkill(agent: Agent): AgentSkill {
  const now = Date.now();
  return {
    id: `system:${FETCH_URL_SLUG}:${agent.id}`,
    agentId: agent.id,
    slug: FETCH_URL_SLUG,
    name: "Fetch URL",
    version: "1.0.0",
    description:
      "Fetches URLs the user shares in the room — strips HTML to readable " +
      "text, decodes entities, and inlines the excerpt into the chair's " +
      "context so clarifying questions and summaries are grounded in the " +
      "actual page content rather than the link's title.",
    whenToUse:
      "Always-on. Whenever the user includes an http(s) URL in a message, " +
      "the chair fetches it before its next turn (clarification or " +
      "round-end summary). Up to 3 URLs per turn, 6 KB per page.",
    bodyMd: FETCH_URL_BODY_MD,
    ability: {
      // No turn-time ability deltas — this skill runs implicitly before
      // the chair speaks, not via the Pass-1 router.
      pattern_recall: 1,
      rigor: 1,
    },
    tips: [
      "URLs are auto-detected; the user doesn't have to do anything special.",
      "Per-room cache means the same URL won't be re-fetched within a session.",
      "Failed fetches (timeout / 404 / unsupported content) surface as a one-line note instead of blocking the turn.",
      "When a page is JS-heavy and the extract looks thin, ask the user to paste the relevant excerpt directly.",
    ],
    createdAt: now,
    updatedAt: now,
    system: true,
  };
}

function buildReportWriterSkill(agent: Agent): AgentSkill {
  const now = Date.now();
  return {
    id: `system:${REPORT_WRITER_SLUG}:${agent.id}`,
    agentId: agent.id,
    slug: REPORT_WRITER_SLUG,
    name: "Standard Report Writer",
    version: "2.0.0",
    description:
      "Composes the room's transcript into a research note. A composer " +
      "stage picks the style spine and component subset that fits the " +
      "topic; the chair then fills only those components, drawing on " +
      "the directors' lens-tagged signals.",
    whenToUse:
      "Always. Runs automatically when the room is adjourned with a report.",
    bodyMd: REPORT_WRITER_BODY_MD,
    ability: {
      // No turn-time ability deltas — this skill never runs at turn time.
      // Listed for parity with other skills' shape.
      rigor: 2,
      narrative: 2,
    },
    tips: [
      "The composer picks 5–9 components from a library of 15 — empty sections are dropped.",
      "Diversity is enforced at extract time, not write time — directors surface their own signals first.",
      "Findings without ≥ 2 evidence lenses are merged or dropped at scaffold stage.",
      "Anchor / Findings / Action are substitute groups — only one variant from each is rendered per brief.",
    ],
    createdAt: now,
    updatedAt: now,
    system: true,
  };
}

const WEB_SEARCH_BODY_MD = `# Web Search

A live link to fresh information beyond the model's training cutoff.
When a director (or the chair) is about to speak and the question
hinges on something current — a price, a release, a recent news event,
a published number — the orchestrator quietly runs a Brave Search,
distills the top 3–5 results, and prepends them to the agent's
context as a SHARED MATERIALS block. The agent then answers using
those sources and cites them inline as \`[1] [2] [3]\`.

## How it runs

1. **Pass-1 router** (the same haiku call that already decides which
   installed .md skills to apply) is asked one extra question:
   *"Does this turn need fresh web info? If yes, give me one search
   query."* When the answer is no, nothing happens — no Brave call,
   no extra latency, no cost.
2. When a query comes back, we hit Brave Search (~$0.005 per query
   on the standard plan, ~$5 per 1000) with a 6 s timeout.
3. Top 5 results — title, url, short description — are formatted
   into the SHARED MATERIALS block.
4. The agent's Pass-2 prompt receives the block. The director cites
   sources by their bracketed number; the message persists a
   \`web_search_used\` meta so the chat UI can surface a 🔍 indicator
   under the bubble.

## Configuration

This skill is **disabled by default**. Two switches in series:

- **Global key**: User Settings → API Key → *Skill Services* →
  *Brave Search*. Without this key, no agent can ever search.
- **Per-agent toggle**: each director's profile has a Web Search row
  that flips on/off independently. Useful when you want one director
  to stay strictly inside its training (a "first principles only"
  voice) while others reach for fresh sources.

When the global key is missing, the per-agent toggle disables itself
visually and links back to Preferences.

## When this skill helps

- Recent events, releases, deaths, partnerships
- Live prices / market caps / round sizes
- Specific named entities ("what is X's most recent annual letter")
- Domain-specific news the model can't have seen

## When this skill hurts

- First-principles philosophical reasoning (search becomes noise)
- Personal context only the user has (search is the wrong tool)
- Highly synthesized / opinion-driven prompts (the agent's training
  has the synthesis; search adds raw inputs that derail)

The Pass-1 router is conservative — it's biased toward NOT searching
unless the question genuinely needs an external fact.

## Cost & privacy

Each search hits Brave's API directly with the user's own key. No
queries pass through Boardroom infrastructure. Brave's privacy policy
applies — Brave doesn't sell or profile users from API calls
according to their published terms.

`;

function buildWebSearchSkill(agent: Agent): AgentSkill {
  const now = Date.now();
  return {
    id: `system:${WEB_SEARCH_SLUG}:${agent.id}`,
    agentId: agent.id,
    slug: WEB_SEARCH_SLUG,
    name: "Web Search",
    version: "1.0.0",
    description:
      "Live web search via the Brave Search API — used when a turn " +
      "hinges on information beyond the model's training cutoff. " +
      "The Pass-1 router decides whether to search; results are " +
      "injected into the agent's prompt as cited sources.",
    whenToUse:
      "Per-turn. The router asks the agent's draft prompt whether " +
      "fresh web info would help, and only then does Brave get a query.",
    bodyMd: WEB_SEARCH_BODY_MD,
    ability: {
      pattern_recall: 2,
      empirical: 2,
      rigor: 1,
    },
    tips: [
      "Disabled until you add a Brave Search API key in User Settings → API Key.",
      "Each agent has its own toggle on its profile page — useful for keeping a 'first-principles only' director out of search.",
      "The Pass-1 router is conservative: it skips search unless the question genuinely needs an external fact.",
      "Citations appear inline as bracketed numbers; the chat bubble shows a small 🔍 indicator when search ran.",
    ],
    createdAt: now,
    updatedAt: now,
    system: true,
    state: {
      enabled: agent.webSearchEnabled,
      keyConfigured: hasBraveKey(),
      requiresKey: { provider: "brave", label: "Brave Search" },
    },
  };
}

/**
 * Synthesize the system skills installed on a given agent. v1.1:
 * - chair gets fetch-url + report-writer + web-search
 * - directors get web-search
 *
 * The web-search skill is always *listed* (so the agent profile
 * surfaces it even when the user hasn't configured a Brave key yet);
 * the orchestrator checks the actual gates (key present + per-agent
 * toggle) before running it.
 */
export function getSystemSkillsForAgent(agent: Agent): AgentSkill[] {
  if (agent.roleKind === "moderator") {
    return [
      buildFetchUrlSkill(agent),
      buildReportWriterSkill(agent),
      buildWebSearchSkill(agent),
    ];
  }
  return [buildWebSearchSkill(agent)];
}

/** True if a slug is a reserved system slug. Used by install/delete
 *  routes to refuse user attempts to write over a system skill. */
export function isSystemSkillSlug(slug: string): boolean {
  return (
    slug === REPORT_WRITER_SLUG ||
    slug === FETCH_URL_SLUG ||
    slug === WEB_SEARCH_SLUG
  );
}
