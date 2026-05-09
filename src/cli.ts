/**
 * boardroom CLI entrypoint · `npx boardroom@latest`
 *
 * Resolves the on-disk state directory, finds a free local port, starts the
 * Hono server, and pops the user's default browser at the right URL.
 *
 *   --port <n>     start on this port instead of auto-detect
 *   --host <h>     bind host (default 127.0.0.1, only override for dev)
 *   --no-open      don't auto-open the browser
 *   --version      print version
 */
import { Command } from "commander";
import open from "open";

import { runSeed } from "./seed/run.js";
import { startServer } from "./server.js";
import { closeDb, runMigrations } from "./storage/db.js";
import { cleanupOrphanedStreams } from "./storage/messages.js";
import { reconcileAgentModels } from "./storage/reconcile-models.js";
import { recoverStuckClarifyRooms } from "./storage/rooms.js";
import { listAllAgents } from "./storage/agents.js";
import { countMemoriesForAgent } from "./storage/memories.js";
import { runDreamCycle, bootCeilingFor } from "./orchestrator/dream.js";
import { ensureBoardroomDir } from "./utils/paths.js";
import { findFreePort } from "./utils/port.js";
import { VERSION } from "./version.js";

interface CliOptions {
  port?: string;
  host?: string;
  open?: boolean;
}

async function main(): Promise<void> {
  const program = new Command()
    .name("privateboard")
    .description("PrivateBoard · your private board meeting, on call. Local-first, multi-agent thinking.")
    .version(VERSION)
    .option("-p, --port <n>", "port to listen on (default: auto-detect from 3030)")
    .option("--host <h>", "host to bind", "127.0.0.1")
    .option("--no-open", "don't open the browser automatically");

  program.parse();
  const opts = program.opts<CliOptions>();

  const dirs = ensureBoardroomDir();

  // Bring storage up-to-date and seed the default directors on first run.
  const { applied } = runMigrations();
  const seed = runSeed();

  // Reconcile every agent's modelV against the user's currently
  // configured keys. The seed inserts directors with a hard-coded
  // primary (opus-4-7), and a user who configured e.g. an OpenAI-only
  // key earlier — before the reconcile path was hooked into PUT
  // /api/keys — would otherwise stay stuck on an unreachable model
  // until they re-saved a key. Running it here makes every boot
  // self-heal so the chair always points at a model the keys can
  // actually serve.
  let reconcile: { switched: number; cleared: number } | null = null;
  try {
    const r = reconcileAgentModels();
    reconcile = { switched: r.switched.length, cleared: r.cleared.length };
  } catch (e) {
    process.stderr.write(`[boot] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Clean up streaming placeholders left behind by a previous crash
  // or by the historical bug where stream-iterator throws skipped the
  // message-finalise path. Without this the user opens a room that
  // was mid-stream when the server died and sees a director "thinking"
  // forever, with no way to recover except deleting the DB.
  try {
    const orphans = cleanupOrphanedStreams();
    if (orphans.fixed + orphans.deleted > 0) {
      process.stderr.write(
        `[boot] cleaned ${orphans.fixed} stuck stream(s), dropped ${orphans.deleted} empty placeholder(s)\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`[boot] orphan cleanup failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Unstick rooms whose chair-clarify pipeline died mid-stream. Without
  // this, opening such a room shows the user's opening question and
  // nothing else, with the input bar locked by awaiting_clarify · the
  // user perceives "data was wiped" but the room is just frozen
  // waiting for a chair speech that never arrived. Clearing the flag
  // lets the user pick up where they left off — their next message
  // kicks the directors straight off their opening question.
  try {
    const fixed = recoverStuckClarifyRooms();
    if (fixed > 0) {
      process.stderr.write(`[boot] unstuck ${fixed} room(s) frozen in chair-clarify\n`);
    }
  } catch (e) {
    process.stderr.write(`[boot] clarify recovery failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Memory metabolism · boot-time sweep. Per-agent counters live in
  // process memory and reset on restart, so an agent whose pile
  // overflowed mid-cycle (process crashed during a dream) never
  // gets caught by the post-adjourn trigger. Force a dream for any
  // agent whose memory count exceeds the safety ceiling — Phase 1
  // is just heuristic decay, so this is cheap.
  void (async () => {
    try {
      const agents = listAllAgents();
      let triggered = 0;
      for (const agent of agents) {
        // Role-aware ceiling · chair tolerates a smaller pile before
        // a forced sweep, since its memory churns more often.
        if (countMemoriesForAgent(agent.id) > bootCeilingFor(agent.roleKind)) {
          await runDreamCycle(agent.id);
          triggered += 1;
        }
      }
      if (triggered > 0) {
        process.stderr.write(`[boot] dream sweep triggered for ${triggered} agent(s) over ceiling\n`);
      }
    } catch (e) {
      process.stderr.write(`[boot] dream sweep failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  })();

  const portArg = opts.port ? Number.parseInt(opts.port, 10) : undefined;
  if (portArg !== undefined && (Number.isNaN(portArg) || portArg < 1 || portArg > 65535)) {
    console.error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }

  const port = portArg ?? (await findFreePort(3030));
  const host = opts.host ?? "127.0.0.1";

  const server = await startServer({ port, host });

  // Banner
  const bannerLines = [
    "",
    "  ▸ privateboard v" + VERSION,
    "    state · " + dirs.base,
    "    listening · " + server.url,
  ];
  if (applied.length > 0) {
    bannerLines.push("    migrations applied · " + applied.join(", "));
  }
  if (seed.insertedAgents > 0) {
    bannerLines.push("    seeded · " + seed.insertedAgents + " director(s)");
  }
  if (reconcile && (reconcile.switched > 0 || reconcile.cleared > 0)) {
    const parts: string[] = [];
    if (reconcile.switched > 0) parts.push(reconcile.switched + " switched");
    if (reconcile.cleared > 0) parts.push(reconcile.cleared + " cleared");
    bannerLines.push("    model reconcile · " + parts.join(", "));
  }
  bannerLines.push("    (ctrl-c to stop)", "");
  process.stdout.write(bannerLines.join("\n") + "\n");

  if (opts.open !== false) {
    open(server.url).catch(() => {
      /* opening is best-effort; the URL is in the banner anyway */
    });
  }

  // Graceful shutdown · server first (stop accepting requests / drain
  // SSE), then DB (force WAL checkpoint + close the file handle).
  // Skipping the DB close was the root cause of "user data disappears
  // after restart" reports — WAL writes that hadn't been auto-
  // checkpointed yet would sit in state.db-wal and could be partially
  // rolled back on next-process recovery. Explicit checkpoint here
  // makes on-disk state always consistent at shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n  ▸ ${signal} received · shutting down\n`);
    try {
      await server.close();
    } catch (e) {
      console.error("  ! error closing server", e);
    }
    try {
      closeDb();
    } catch (e) {
      console.error("  ! error closing db", e);
    }
    process.exit(0);
  };
  // SIGINT (Ctrl+C) and SIGTERM (`kill <pid>`) get the full async
  // shutdown — server drain + WAL checkpoint + close.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // SIGHUP fires when the controlling terminal closes (Cmd+W on
  // iTerm, closing a Terminal tab, parent shell exit). Default Node
  // behaviour on SIGHUP is to terminate WITHOUT running our SIGINT/
  // SIGTERM handlers — the in-flight WAL writes get abandoned and
  // the user's most recent rooms / briefs / messages are lost on
  // next start. Route SIGHUP through the same shutdown path so
  // closing the terminal is data-safe.
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  // Last-resort sync flush · runs on EVERY process exit, including
  // ones that bypass our signal handlers (uncaughtException after a
  // setImmediate, nodemon's restart kill, parent shell SIGKILL of
  // the child). better-sqlite3's close() is synchronous, so we get
  // one final WAL checkpoint even when we can't await anything else.
  // Idempotent if shutdown() already ran (closeDb nulls the handle).
  process.on("exit", () => {
    try { closeDb(); } catch { /* */ }
  });
}

main().catch((err) => {
  console.error("privateboard failed to start:", err);
  process.exit(1);
});
