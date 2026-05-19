#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_BASE_URL = "http://127.0.0.1:3030";
const DEFAULT_POLL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;
const STABLE_POLLS = 3;

function usage(exitCode = 0) {
  const text = `Usage:
  node eval/agent/scripts/run-agent-case.mjs <agent-id> <case-md> [options]

Options:
  --base-url <url>       PrivateBoard server URL (default: ${DEFAULT_BASE_URL})
  --out-dir <dir>        Output directory (default: eval/agent/runs)
  --poll-ms <ms>         Poll interval while waiting for replies (default: ${DEFAULT_POLL_MS})
  --timeout-ms <ms>      Per-prompt timeout (default: ${DEFAULT_TIMEOUT_MS})
  --dry-run              Parse case and validate agent, but do not call the server
  --help                 Show this help

Example:
  node eval/agent/scripts/run-agent-case.mjs socrates eval/agent/cases/pricing-strategy.zh.md
`;
  process.stdout.write(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) usage(0);
  const positional = [];
  const opts = {
    baseUrl: DEFAULT_BASE_URL,
    outDir: "eval/agent/runs",
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--base-url") {
      opts.baseUrl = args[++i] || "";
    } else if (a === "--out-dir") {
      opts.outDir = args[++i] || "";
    } else if (a === "--poll-ms") {
      opts.pollMs = Number(args[++i]);
    } else if (a === "--timeout-ms") {
      opts.timeoutMs = Number(args[++i]);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) usage(1);
  if (!opts.baseUrl || !Number.isFinite(opts.pollMs) || !Number.isFinite(opts.timeoutMs)) {
    throw new Error("invalid option value");
  }
  return { agentId: positional[0], casePath: positional[1], opts };
}

function sqlEscape(s) {
  return String(s).replaceAll("'", "''");
}

function sqlite(query) {
  const db = join(homedir(), ".boardroom", "state.db");
  if (!existsSync(db)) throw new Error(`SQLite DB not found: ${db}`);
  return execFileSync("sqlite3", ["-separator", "\t", db, query], { encoding: "utf8" });
}

function getAgent(agentId) {
  const rows = sqlite(
    `select id, name, role_tag, role_kind, model_v, substr(replace(instruction, char(10), ' '), 1, 500)
     from agents where id='${sqlEscape(agentId)}';`,
  ).trim();
  if (!rows) throw new Error(`agent not found: ${agentId}`);
  const [id, name, roleTag, roleKind, modelV, instructionSnapshot] = rows.split("\t");
  if (roleKind !== "director") throw new Error(`agent is not a director: ${agentId} (${roleKind})`);
  return { id, name, roleTag, roleKind, modelV, instructionSnapshot };
}

function parseCase(casePath) {
  const abs = resolve(casePath);
  if (!existsSync(abs)) throw new Error(`case file not found: ${abs}`);
  const md = readFileSync(abs, "utf8");
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(abs, ".md");
  const promptsStart = md.search(/^##\s+Prompts\s*$/m);
  if (promptsStart < 0) throw new Error(`case has no "## Prompts" section: ${abs}`);
  const afterPromptsHeader = md.slice(promptsStart).replace(/^##\s+Prompts\s*\n/m, "");
  const nextTopSection = afterPromptsHeader.search(/^##\s+/m);
  const promptsSection = nextTopSection >= 0
    ? afterPromptsHeader.slice(0, nextTopSection)
    : afterPromptsHeader;
  const chunks = promptsSection
    .split(/^###\s+/m)
    .map((s) => s.trim())
    .filter(Boolean);
  const prompts = chunks.map((chunk, i) => {
    const [firstLine = "", ...restLines] = chunk.split(/\n/);
    return {
      index: i + 1,
      title: firstLine.trim(),
      body: restLines.join("\n").trim(),
    };
  }).filter((p) => p.title && p.body.length > 0);
  if (prompts.length === 0) throw new Error(`case has no prompts: ${abs}`);
  return { abs, title, prompts };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} failed ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function createRoom(baseUrl, agent, firstPrompt, caseTitle) {
  const payload = {
    subject: `Agent eval · ${agent.name} · ${caseTitle}\n\n${firstPrompt}`,
    name: `Agent Eval · ${agent.name} · ${caseTitle}`.slice(0, 80),
    mode: "critique",
    intensity: "sharp",
    briefStyle: "auto",
    deliveryMode: "text",
    agentIds: [agent.id],
  };
  const json = await postJson(`${baseUrl}/api/rooms`, payload);
  return json.room.id;
}

function roomFlags(roomId) {
  const out = sqlite(
    `select status, awaiting_clarify, awaiting_continue from rooms where id='${sqlEscape(roomId)}';`,
  ).trim();
  if (!out) throw new Error(`room not found: ${roomId}`);
  const [status, awaitingClarify, awaitingContinue] = out.split("\t");
  return {
    status,
    awaitingClarify: awaitingClarify === "1",
    awaitingContinue: awaitingContinue === "1",
  };
}

function clearHarnessFlags(roomId) {
  sqlite(
    `update rooms
     set awaiting_clarify=0, awaiting_continue=0
     where id='${sqlEscape(roomId)}';`,
  );
}

function agentMessageCount(roomId, agentId) {
  return Number(sqlite(
    `select count(*) from messages
     where room_id='${sqlEscape(roomId)}'
       and author_kind='agent'
       and author_id='${sqlEscape(agentId)}';`,
  ).trim() || "0");
}

function latestAgentLength(roomId, agentId) {
  return Number(sqlite(
    `select coalesce(length(body), 0) from messages
     where room_id='${sqlEscape(roomId)}'
       and author_kind='agent'
       and author_id='${sqlEscape(agentId)}'
     order by created_at desc limit 1;`,
  ).trim() || "0");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAgentReply(roomId, agentId, targetCount, opts) {
  const started = Date.now();
  let lastLen = -1;
  let stable = 0;
  while (Date.now() - started < opts.timeoutMs) {
    const count = agentMessageCount(roomId, agentId);
    const len = latestAgentLength(roomId, agentId);
    process.stdout.write(
      `[wait] ${new Date().toISOString()} count=${count}/${targetCount} len=${len} stable=${stable}\n`,
    );
    if (count >= targetCount && len > 40) {
      if (len === lastLen) stable += 1;
      else stable = 0;
      lastLen = len;
      if (stable >= STABLE_POLLS) return;
    }
    await sleep(opts.pollMs);
  }
  throw new Error(`timed out waiting for ${agentId} response in room ${roomId}`);
}

async function sendPrompt(baseUrl, roomId, agentId, prompt) {
  clearHarnessFlags(roomId);
  await postJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    body: prompt,
    mentions: [agentId],
    mode: "now",
  });
}

async function forceInitialAgentTurn(baseUrl, roomId) {
  const flags = roomFlags(roomId);
  if (!flags.awaitingClarify) return false;
  process.stdout.write(`[harness] room is awaiting chair clarification; clearing flag and forcing target-agent turn\n`);
  clearHarnessFlags(roomId);
  await postJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/continue`, {});
  return true;
}

function readTranscript(roomId) {
  const out = sqlite(
    `select author_kind, ifnull(author_id,''), round_num, length(body), replace(body, char(10), ' ')
     from messages where room_id='${sqlEscape(roomId)}' order by created_at;`,
  ).trim();
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [authorKind, authorId, roundNum, length, body] = line.split("\t");
    return { authorKind, authorId, roundNum: Number(roundNum), length: Number(length), body };
  });
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "case";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function gitShort() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function renderRawMarkdown({ roomId, agent, caseInfo, transcript }) {
  const lines = [
    `# Raw Agent Eval Transcript`,
    ``,
    `- room id: \`${roomId}\``,
    `- target agent: \`${agent.id}\` (${agent.name})`,
    `- case: \`${caseInfo.abs}\``,
    ``,
  ];
  for (const m of transcript) {
    lines.push(
      `## ${m.authorKind}${m.authorId ? `:${m.authorId}` : ""} · round ${m.roundNum}`,
      ``,
      m.body,
      ``,
    );
  }
  return lines.join("\n");
}

function renderRunDraft({ roomId, agent, caseInfo, transcript }) {
  const agentMessages = transcript.filter((m) => m.authorKind === "agent" && m.authorId === agent.id);
  const lines = [
    `# Agent Eval Run`,
    ``,
    `- date: ${today()}`,
    `- commit: ${gitShort()}`,
    `- evaluator:`,
    `- target agent id: \`${agent.id}\``,
    `- target agent name: ${agent.name}`,
    `- target agent role tag: ${agent.roleTag}`,
    `- case: \`${caseInfo.abs}\``,
    `- model config: agent row model \`${agent.modelV}\`; routed through local PrivateBoard provider config`,
    `- language: zh`,
    ``,
    `## Setup Notes`,
    ``,
    `- invocation method: \`eval/agent/scripts/run-agent-case.mjs\` single-director room harness`,
    `- room id: \`${roomId}\``,
    `- agent instruction snapshot: ${agent.instructionSnapshot}`,
    `- prompt count: ${caseInfo.prompts.length}`,
    `- runtime notes: Chair procedural messages may exist in the room transcript; score only target-agent messages.`,
    ``,
    `## Response Log`,
    ``,
  ];
  caseInfo.prompts.forEach((prompt, i) => {
    const response = agentMessages[i]?.body || "";
    lines.push(
      `### ${prompt.index}. ${prompt.title}`,
      ``,
      `- prompt:`,
      ``,
      "```text",
      prompt.body,
      "```",
      ``,
      `- response:`,
      ``,
      response ? response : "_Missing response._",
      ``,
      `- notes:`,
      ``,
    );
  });
  lines.push(
    `## Scores`,
    ``,
    `| Dimension | Score | Evidence |`,
    `|---|---:|---|`,
    `| Lens 清晰度 |  |  |`,
    `| 独特性 |  |  |`,
    `| 论证质量 |  |  |`,
    `| 反例意识 |  |  |`,
    `| 信息校准 |  |  |`,
    `| 追问质量 |  |  |`,
    `| 纠偏吸收 |  |  |`,
    `| 协作张力 |  |  |`,
    `| 可行动性 |  |  |`,
    `| Voice 稳定性 |  |  |`,
    ``,
    `Average:`,
    ``,
    `## Failure Log`,
    ``,
    `| Severity | Category | Evidence | Suspected Cause | Owner |`,
    `|---|---|---|---|---|`,
    `|  |  |  |  |  |`,
    ``,
    `## Summary`,
    ``,
    `- pass / fail:`,
    `- default-cast eligible:`,
    `- strongest capability:`,
    `- weakest capability:`,
    `- recommended fix:`,
    ``,
  );
  return lines.join("\n");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

async function main() {
  const { agentId, casePath, opts } = parseArgs(process.argv.slice(2));
  const agent = getAgent(agentId);
  const caseInfo = parseCase(casePath);

  process.stdout.write(`agent=${agent.id} (${agent.name}) model=${agent.modelV}\n`);
  process.stdout.write(`case=${caseInfo.abs} prompts=${caseInfo.prompts.length}\n`);

  if (opts.dryRun) {
    caseInfo.prompts.forEach((p) => {
      process.stdout.write(`- ${p.index}. ${p.title} (${p.body.length} chars)\n`);
    });
    return;
  }

  const roomId = await createRoom(opts.baseUrl, agent, caseInfo.prompts[0].body, caseInfo.title);
  process.stdout.write(`room=${roomId}\n`);

  await sleep(1200);
  await forceInitialAgentTurn(opts.baseUrl, roomId);
  await waitForAgentReply(roomId, agent.id, 1, opts);
  for (let i = 1; i < caseInfo.prompts.length; i++) {
    const targetCount = i + 1;
    process.stdout.write(`posting prompt ${targetCount}/${caseInfo.prompts.length}: ${caseInfo.prompts[i].title}\n`);
    await sendPrompt(opts.baseUrl, roomId, agent.id, caseInfo.prompts[i].body);
    await sleep(1200);
    await forceInitialAgentTurn(opts.baseUrl, roomId);
    await waitForAgentReply(roomId, agent.id, targetCount, opts);
  }

  const transcript = readTranscript(roomId);
  const outDir = resolve(opts.outDir);
  const rawDir = join(outDir, "raw");
  ensureDir(rawDir);
  const caseSlug = slugify(basename(caseInfo.abs));
  const base = `${agent.id}-${caseSlug}-${today()}`;
  const rawPath = join(rawDir, `${base}.md`);
  const draftPath = join(outDir, `${base}.draft.md`);
  writeFileSync(rawPath, renderRawMarkdown({ roomId, agent, caseInfo, transcript }));
  writeFileSync(draftPath, renderRunDraft({ roomId, agent, caseInfo, transcript }));
  process.stdout.write(`raw=${rawPath}\n`);
  process.stdout.write(`draft=${draftPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
