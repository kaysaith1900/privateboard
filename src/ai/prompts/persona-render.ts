/**
 * Persona artifact renderers.
 *
 * Two surfaces:
 *
 *   1. `synthesizePersonaInstruction` — compiles a `PersonaSpec` into
 *      the 8-section instruction template the rest of the codebase
 *      reads (brief Stage 1, chair flows, voice meetings). Stored on
 *      `agents.instruction` at save time so consumers don't need to
 *      learn the new persona shape — they keep reading `instruction`
 *      verbatim. The few-shot + reflection blocks are NOT in here —
 *      they're injected at per-turn render time so they only cost
 *      tokens for active speakers, not for every read.
 *
 *   2. `renderPersonaMarkdown` — renders the same artifact as a
 *      downloadable Markdown doc. The save-screen "Download persona.md"
 *      button + the agent-profile button both hit
 *      `GET /api/agents/:id/persona.md` which calls this.
 */
import type {
  Agent,
  PersonaKnowledge,
  PersonaKnowledgeEntry,
  PersonaRule,
  PersonaSpec,
  PersonaSpecCore,
} from "../../storage/agents.js";

const INSTRUCTION_MAX = 6000; // mirror INSTR_MAX in routes/agents.ts

/** Compile a PersonaSpec into the 8-section instruction template the
 *  rest of the codebase already understands. The shape matches what
 *  `agent-spec.ts`'s Stage B produces for Signal-mode agents — every
 *  reader of `agent.instruction` (brief Stage 1 extract, chair, room
 *  orchestration, voice meetings) keeps working unchanged.
 *
 *  Knowledge / rules / few-shot are summarised here, not transcribed
 *  in full · the full artifact lives in `persona_spec_json` and the
 *  Markdown export. The instruction is a bounded compile-down. */
export function synthesizePersonaInstruction(
  spec: PersonaSpec,
  meta: { name: string; roleTag: string },
): string {
  const lines: string[] = [];
  lines.push(`You are ${meta.name}, a board director.`);
  lines.push("");
  lines.push("## Identity");
  if (spec.spec.intellectualLineage.length > 0) {
    lines.push(`Lineage · ${truncList(spec.spec.intellectualLineage, 3)}`);
  }
  lines.push(`Role · ${meta.roleTag}`);
  if (spec.description) {
    lines.push(`Origin · ${truncate(spec.description, 240)}`);
  }
  lines.push("");

  lines.push("## Method");
  if (spec.spec.loadBearingConcepts.length > 0) {
    lines.push("Concepts you reach for first:");
    for (const c of spec.spec.loadBearingConcepts.slice(0, 5)) lines.push(`  · ${c}`);
    lines.push("");
  }
  if (spec.knowledge.keyThinkers.length > 0 || spec.knowledge.foundationalWorks.length > 0) {
    lines.push("Anchored in the work of:");
    for (const t of spec.knowledge.keyThinkers.slice(0, 5)) lines.push(`  · ${t.title} — ${truncate(t.summary, 120)}`);
    for (const w of spec.knowledge.foundationalWorks.slice(0, 3)) lines.push(`  · ${w.title} — ${truncate(w.summary, 120)}`);
    lines.push("");
  }

  if (spec.spec.referentSet.length > 0) {
    lines.push("## Referent set");
    for (const r of spec.spec.referentSet.slice(0, 6)) lines.push(`  · ${r}`);
    lines.push("");
  }

  if (spec.spec.contrarianTakes.length > 0) {
    lines.push("## Contrarian takes");
    for (const t of spec.spec.contrarianTakes.slice(0, 5)) lines.push(`  · ${t}`);
    lines.push("");
  }

  if (spec.rules.length > 0) {
    lines.push("## Rules");
    for (const r of spec.rules.slice(0, 12)) {
      lines.push(`  · (${r.kind}) ${r.rule}`);
    }
    lines.push("");
  }

  if (spec.spec.failureModes.length > 0) {
    lines.push("## Failure modes you guard against");
    for (const f of spec.spec.failureModes.slice(0, 5)) lines.push(`  · ${f}`);
    lines.push("");
  }

  // Voice / boundaries · derived from contrarian takes + rules
  // implicit. Keep this brief — the few-shot block (injected at
  // per-turn render time) carries the actual voice texture.
  lines.push("## Voice");
  lines.push("Specific over general. Named referents over abstractions. Hold the position when challenged unless the challenge surfaces a genuinely new constraint.");

  return truncate(lines.join("\n"), INSTRUCTION_MAX);
}

function truncList(items: string[], max: number): string {
  return items.slice(0, max).join(" · ");
}
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

/** Synthesize a 1–3 sentence bio from a persona spec, in the
 *  same voice register as the seed director bios (compact, move-
 *  oriented, refusal-aware). Pulls from contrarian takes / failure
 *  modes / load-bearing concepts since those carry the most
 *  distinctive signal · skips the lineage block (its "Influenced by:"
 *  prefix reads as bibliography, not voice).
 *
 *  Heuristic (not an LLM call) so the SSE final event can include
 *  it without an extra round-trip · the user can edit in the
 *  confirmation overlay if they want a different angle. */
export function synthesizePersonaBio(
  spec: PersonaSpec,
  meta: { name: string; roleTag: string },
): string {
  const core = spec.spec || { intellectualLineage: [], loadBearingConcepts: [], referentSet: [], failureModes: [], contrarianTakes: [] };
  const concepts = (core.loadBearingConcepts || []).filter((s) => typeof s === "string" && s.trim().length > 0);
  const failures = (core.failureModes || []).filter((s) => typeof s === "string" && s.trim().length > 0);
  const takes    = (core.contrarianTakes || []).filter((s) => typeof s === "string" && s.trim().length > 0);

  // Pull "Name" from "Name: gloss" entries — `toCore` flattens the
  // structured concept into a single string with a colon separator.
  const conceptName = (s: string) => {
    const i = s.indexOf(":");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  };
  const lower = (s: string) => {
    const t = s.trim();
    if (!t) return t;
    return t[0].toLowerCase() + t.slice(1);
  };
  const period = (s: string) => /[.!?]$/.test(s.trim()) ? s.trim() : s.trim() + ".";

  const parts: string[] = [];

  // Lead · what this director reaches for. Prefer load-bearing
  // concept (specific tool); fall back to first contrarian take
  // phrased as a stance.
  if (concepts.length > 0) {
    parts.push(`Reaches first for ${lower(conceptName(concepts[0]))}.`);
  } else if (takes.length > 0) {
    parts.push(period(takes[0]));
  }

  // Second · what they refuse / guard against. Failure mode reads
  // as a watchout; contrarian take #2 if no failures.
  if (failures.length > 0) {
    parts.push(`Watches for ${lower(failures[0])}${/[.!?]$/.test(failures[0]) ? "" : "."}`);
  } else if (takes.length > 1) {
    parts.push(period(takes[1]));
  } else if (concepts.length > 1) {
    parts.push(`Also leans on ${lower(conceptName(concepts[1]))}.`);
  }

  let bio = parts.join(" ").trim();
  // Final fallback · the spec was thin (rare). Use the user's
  // description trimmed to the bio cap so the field isn't empty.
  if (bio.length < 16) {
    const desc = (spec.description || "").trim();
    bio = desc.length > 16
      ? desc.slice(0, 280)
      : `A ${meta.roleTag || "director"} built via deep persona replication.`;
  }
  // 280-char cap matches the BIO_MAX validation in routes/agents.ts.
  return bio.length > 280 ? bio.slice(0, 279).trim() + "…" : bio;
}

/** Render the full persona artifact as Markdown for download. The
 *  consumer is `GET /api/agents/:id/persona.md`. Includes citations
 *  as inline links and the build-report differentiation score. */
export function renderPersonaMarkdown(agent: Agent): string {
  const spec = agent.personaSpec;
  if (!spec) {
    return `# ${agent.name}\n\n_No persona spec available._\n`;
  }
  const lines: string[] = [];
  lines.push(`# ${agent.name}`);
  lines.push("");
  lines.push(`> ${agent.bio}`);
  lines.push("");
  lines.push(`**Handle** · \`${agent.handle}\``);
  lines.push(`**Role** · ${agent.roleTag}`);
  lines.push(`**Built** · ${spec.generatedAt}`);
  if (typeof spec.differentiationScore === "number") {
    lines.push(`**Build differentiation (lexical)** · ${(spec.differentiationScore * 100).toFixed(1)}% divergence vs generic baseline`);
  }
  lines.push("");
  lines.push(`_Built from your description:_ ${spec.description}`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Persona spec");
  renderCore(lines, spec.spec);

  lines.push("## Knowledge context");
  renderKnowledge(lines, spec.knowledge);

  if (spec.rules.length > 0) {
    lines.push("## Behavioural rules");
    renderRules(lines, spec.rules);
  }

  if (spec.fewShot.length > 0) {
    lines.push("## Few-shot examples");
    for (let i = 0; i < spec.fewShot.length; i++) {
      const ex = spec.fewShot[i];
      lines.push(`### Example ${i + 1}`);
      lines.push(`**Scenario** · ${ex.scenario}`);
      lines.push("");
      lines.push("**A generic AI would say:**");
      lines.push("");
      lines.push(`> ${ex.genericResponse}`);
      lines.push("");
      lines.push(`**${agent.name} says:**`);
      lines.push("");
      lines.push(`> ${ex.personaResponse}`);
      if (ex.rationale) {
        lines.push("");
        lines.push(`_Rationale_ · ${ex.rationale}`);
      }
      lines.push("");
    }
  }

  if (spec.reflectionChecklist.length > 0) {
    lines.push("## Reflection checklist");
    lines.push("_Run silently before every turn._");
    lines.push("");
    for (let i = 0; i < spec.reflectionChecklist.length; i++) {
      lines.push(`${i + 1}. ${spec.reflectionChecklist[i]}`);
    }
    lines.push("");
  }

  if (spec.evalSet.length > 0) {
    lines.push("## Eval set");
    lines.push("_Test prompts + per-prompt build-time differentiation scores._");
    lines.push("");
    for (let i = 0; i < spec.evalSet.length; i++) {
      const e = spec.evalSet[i];
      const score = typeof e.divergenceScore === "number"
        ? ` · score ${(e.divergenceScore * 100).toFixed(0)}%`
        : "";
      lines.push(`${i + 1}. **${e.prompt}**${score}`);
      if (e.expectedSignature) {
        lines.push(`   _Expected_ · ${e.expectedSignature}`);
      }
    }
    lines.push("");
  }

  lines.push("## Tool access");
  lines.push(`- Web search · ${spec.toolAccess.webSearch ? "enabled" : "disabled"}`);
  lines.push("");

  if (spec.knowledge.searchQueries.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Build audit · search queries run");
    for (let i = 0; i < spec.knowledge.searchQueries.length; i++) {
      const q = spec.knowledge.searchQueries[i];
      lines.push(`${i + 1}. \`${q.query}\` · ${q.resultsCount} results · ${q.pagesRead} pages read`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderCore(lines: string[], spec: PersonaSpecCore): void {
  if (spec.intellectualLineage.length > 0) {
    lines.push("**Intellectual lineage**");
    for (const x of spec.intellectualLineage) lines.push(`- ${x}`);
    lines.push("");
  }
  if (spec.loadBearingConcepts.length > 0) {
    lines.push("**Load-bearing concepts**");
    for (const x of spec.loadBearingConcepts) lines.push(`- ${x}`);
    lines.push("");
  }
  if (spec.referentSet.length > 0) {
    lines.push("**Referent set**");
    for (const x of spec.referentSet) lines.push(`- ${x}`);
    lines.push("");
  }
  if (spec.failureModes.length > 0) {
    lines.push("**Failure modes**");
    for (const x of spec.failureModes) lines.push(`- ${x}`);
    lines.push("");
  }
  if (spec.contrarianTakes.length > 0) {
    lines.push("**Contrarian takes**");
    for (const x of spec.contrarianTakes) lines.push(`- ${x}`);
    lines.push("");
  }
}

function renderKnowledge(lines: string[], k: PersonaKnowledge): void {
  const section = (label: string, entries: PersonaKnowledgeEntry[]) => {
    if (entries.length === 0) return;
    lines.push(`### ${label}`);
    for (const e of entries) {
      const cites = e.citations.length > 0
        ? " · " + e.citations.map((u) => `[source](${u})`).join(" · ")
        : "";
      lines.push(`- **${e.title}** — ${e.summary}${cites}`);
    }
    lines.push("");
  };
  section("Key thinkers", k.keyThinkers);
  section("Foundational works", k.foundationalWorks);
  section("Recent developments", k.recentDevelopments);
  section("Contested claims", k.contestedClaims);
  if (k.keyThinkers.length === 0 && k.foundationalWorks.length === 0 && k.recentDevelopments.length === 0 && k.contestedClaims.length === 0) {
    lines.push("_No knowledge bundle was assembled (web search may not have been configured during build)._");
    lines.push("");
  }
}

function renderRules(lines: string[], rules: PersonaRule[]): void {
  for (const r of rules) {
    const prefix = r.kind === "always" ? "**Always**" : r.kind === "never" ? "**Never**" : "**When**";
    lines.push(`- ${prefix} · ${r.rule}`);
  }
  lines.push("");
}
