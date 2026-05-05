/**
 * Long-term memory extraction · runs at room adjourn for every agent
 * that participated. Each agent (directors + chair) gets a small LLM
 * pass: "from THIS room, what did you learn about the user worth
 * carrying into future rooms?" The output is parsed into 0-3 first-
 * person facts that get stored as `agent_memories` rows.
 *
 * Skipped entirely when room.incognito = true. Failures are
 * non-fatal — adjourn still completes, the agent just doesn't get
 * new memories from this room.
 */
import { callLLM } from "../ai/adapter.js";
import { isModelV } from "../ai/registry.js";
import { getAgent, listAllAgents, type Agent } from "../storage/agents.js";
import { insertMemory, type MemoryKind } from "../storage/memories.js";
import { listRecentMessages } from "../storage/messages.js";
import { getPrefs } from "../storage/prefs.js";
import { getRoom, listRoomMembers } from "../storage/rooms.js";

const ALLOWED_KINDS: ReadonlySet<MemoryKind> = new Set(["fact", "observation", "preference", "goal"]);

interface ExtractedNote {
  content: string;
  kind: MemoryKind;
  confidence: number;
}

const MEMORY_HISTORY_TURNS = 60;

/**
 * Run the extraction pass for every member of the room. Best-effort:
 * each agent's call is independent, errors are swallowed per-agent so
 * one model failure can't block the whole room from filing.
 */
export async function extractMemoriesAfterAdjourn(roomId: string): Promise<void> {
  const room = getRoom(roomId);
  if (!room) return;
  if (room.incognito) {
    process.stderr.write(`[memory] room ${roomId.slice(0, 8)} incognito · skipping extraction\n`);
    return;
  }

  const memberRows = listRoomMembers(roomId);
  if (memberRows.length === 0) return;

  // Chair + directors all participate. listRoomMembers includes the
  // chair (position -1), so iterate everyone with roleKind agent.
  const agents: Agent[] = memberRows
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null);
  if (agents.length === 0) return;

  // Pull history once · all agents share the same transcript view.
  const history = listRecentMessages(roomId, MEMORY_HISTORY_TURNS);
  if (history.length === 0) return;

  const prefs = getPrefs();
  const userName = prefs.name || "the user";

  // Format the transcript for the extraction prompt — speakers labeled,
  // directors by handle, chair as "Chair", user by their name.
  const transcript = history
    .filter((m) => m.body && m.body.trim())
    .map((m) => {
      if (m.authorKind === "user") return `[${userName}] ${m.body}`;
      if (m.authorKind === "system") return `[system] ${m.body}`;
      const a = agents.find((x) => x.id === m.authorId);
      const label = a ? `${a.name} · ${a.handle}` : "Director";
      return `[${label}] ${m.body}`;
    })
    .join("\n\n");

  await Promise.all(
    agents.map(async (agent) => {
      if (!isModelV(agent.modelV)) return;
      try {
        const notes = await runExtractionForAgent(agent, transcript, userName);
        for (const note of notes) {
          insertMemory({
            agentId: agent.id,
            content: note.content,
            kind: note.kind,
            source: "extracted",
            sourceRoom: roomId,
            confidence: note.confidence,
          });
        }
        process.stderr.write(
          `[memory] ${agent.name} (${agent.id.slice(0, 8)}) · ${notes.length} note(s) extracted\n`,
        );
      } catch (e) {
        process.stderr.write(
          `[memory] ${agent.name} extraction failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }),
  );
}

/** Run one agent's extraction · single non-streaming call returning
 *  a parseable list. Uses the agent's configured modelV so the lens
 *  and language preferences carry through; capped at 600 tokens. */
async function runExtractionForAgent(
  agent: Agent,
  transcript: string,
  userName: string,
): Promise<ExtractedNote[]> {
  const system = [
    `You are ${agent.name} (${agent.handle}), a director participating in a multi-agent boardroom.`,
    "",
    `Your role description:`,
    agent.bio || agent.roleTag || "(no description)",
    "",
    `─── YOUR TASK · MEMORY EXTRACTION ───`,
    `The room you just participated in has just adjourned. Your job NOW is purely meta — extract 0 to 3 things about ${userName} that are worth REMEMBERING for FUTURE rooms.`,
    "",
    `What counts:`,
    `· Stable facts about ${userName} (occupation, project, expertise, language preference, recurring constraints).`,
    `· Reading-of-the-user observations through YOUR specific lens (different agents notice different things).`,
    `· Stated preferences (how they like to think, format, push back).`,
    `· Stated goals with concrete horizons.`,
    "",
    `What does NOT count (do NOT extract):`,
    `· Anything about the discussion topic itself or what the directors said.`,
    `· Generic platitudes ("the user is thoughtful").`,
    `· Things the user just told ${agent.name} once that aren't generalisable.`,
    `· Anything you only inferred — only assert what the transcript supports.`,
    "",
    `Output STRICT format · one JSON line per note. NO prose, NO markdown, NO code fence. If nothing is worth remembering, output the literal token NONE on a single line.`,
    "",
    `Each line:`,
    `{"content": "first-person sentence about ${userName}", "kind": "fact|observation|preference|goal", "confidence": 0.0-1.0}`,
    "",
    `Examples (English):`,
    `{"content": "${userName} is a cofounder building an HR SaaS focused on resume screening", "kind": "fact", "confidence": 0.9}`,
    `{"content": "${userName} struggles to define load-bearing terms before reasoning", "kind": "observation", "confidence": 0.7}`,
    "",
    `Examples (Chinese · use Chinese when the room was conducted in Chinese):`,
    `{"content": "${userName} 是一家 HR SaaS 的 cofounder，主要做简历筛选自动化", "kind": "fact", "confidence": 0.9}`,
    "",
    `Hard rules:`,
    `· Output ONLY JSON lines OR the literal token NONE. Nothing else.`,
    `· Maximum 3 notes. Often 0 is correct.`,
    `· Match the language the room was conducted in.`,
    `· Use first-person assertions about ${userName}, not "the user".`,
  ].join("\n");

  const user = [
    `─── ROOM TRANSCRIPT (just adjourned) ───`,
    transcript || "(empty room — nothing to extract)",
    ``,
    `─── YOUR EXTRACTION ───`,
    `0–3 JSON-line notes about ${userName} from your lens, OR the literal token NONE.`,
  ].join("\n");

  const raw = await callLLM({
    modelV: agent.modelV as never,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    maxTokens: 600,
  });

  return parseExtractionOutput(raw);
}

/** Parse the LLM's line-delimited JSON output. Tolerates code-fenced
 *  output, blank lines, and the NONE escape token. Skips lines that
 *  don't parse cleanly rather than throwing — partial extraction is
 *  better than dropping the whole batch. */
export function parseExtractionOutput(raw: string): ExtractedNote[] {
  const stripped = raw
    .trim()
    // strip a code fence if the model wrapped its output
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (!stripped) return [];
  if (/^\s*NONE\s*$/i.test(stripped)) return [];

  const notes: ExtractedNote[] = [];
  for (const rawLine of stripped.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const content = typeof obj.content === "string" ? obj.content.trim() : "";
    if (!content || content.length > 280) continue;
    const kindRaw = typeof obj.kind === "string" ? obj.kind : "fact";
    const kind: MemoryKind = ALLOWED_KINDS.has(kindRaw as MemoryKind)
      ? (kindRaw as MemoryKind)
      : "fact";
    const conf =
      typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
        ? Math.max(0, Math.min(1, obj.confidence))
        : 0.7;
    notes.push({ content, kind, confidence: conf });
    if (notes.length >= 3) break;
  }
  return notes;
}

/** Convenience · used by orchestrator route to mention all agents
 *  scheduled to extract (purely for stderr logging). */
export function listExtractionTargets(roomId: string): Agent[] {
  const memberRows = listRoomMembers(roomId);
  if (memberRows.length === 0) return [];
  return memberRows
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null);
}

/** Test seam — exposes listAllAgents for cases where the room has
 *  pruned members but you still want every agent to extract. Not
 *  used in v1 (we only extract for room participants). */
export const _internals = { listAllAgents };
