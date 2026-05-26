/**
 * Shared boot / shutdown for every PrivateBoard entrypoint.
 *
 * Two entrypoints call into here:
 *   - src/cli.ts          → `npx privateboard`
 *   - electron/main.ts    → packaged desktop app
 *
 * Both must run the same migrations + recoveries + reconcile + dream sweep so
 * `~/.boardroom/state.db` stays consistent regardless of who opens it. The
 * banner / signal-handler bookkeeping stays in the caller — `bootApp` returns
 * structured results so each surface can render its own progress.
 */
import { runSeed } from "./seed/run.js";
import { startServer, type RunningServer } from "./server.js";
import { closeDb, runMigrations } from "./storage/db.js";

// Re-exported so the Electron main process can register `closeDb` directly
// in its `process.on("exit")` last-resort sync hook without depending on the
// internal storage module path.
export { closeDb };
import { cleanupOrphanedStreams } from "./storage/messages.js";
import { reconcileAgentModels } from "./storage/reconcile-models.js";
import { recoverStuckClarifyRooms } from "./storage/rooms.js";
import { markRunningJobsFailed } from "./storage/persona-jobs.js";
import { recoverStuckCloneJobs } from "./storage/clone-jobs.js";
import { listAllAgents } from "./storage/agents.js";
import { countMemoriesForAgent } from "./storage/memories.js";
import { runDreamCycle, bootCeilingFor } from "./orchestrator/dream.js";
import { ensureBoardroomDir, type BoardroomDirs } from "./utils/paths.js";
import { findFreePort } from "./utils/port.js";

export interface BootOptions {
  port?: number;
  host?: string;
}

export interface BootResult {
  server: RunningServer;
  dirs: BoardroomDirs;
  port: number;
  host: string;
  applied: string[];
  seed: ReturnType<typeof runSeed>;
  reconcile: { switched: number; cleared: number } | null;
}

export async function bootApp(opts: BootOptions = {}): Promise<BootResult> {
  const dirs = ensureBoardroomDir();

  const { applied } = runMigrations();
  const seed = runSeed();

  let reconcile: { switched: number; cleared: number } | null = null;
  try {
    const r = reconcileAgentModels();
    reconcile = { switched: r.switched.length, cleared: r.cleared.length };
  } catch (e) {
    process.stderr.write(`[boot] reconcile failed: ${errMsg(e)}\n`);
  }

  try {
    const orphans = cleanupOrphanedStreams();
    if (orphans.fixed + orphans.deleted > 0) {
      process.stderr.write(
        `[boot] cleaned ${orphans.fixed} stuck stream(s), dropped ${orphans.deleted} empty placeholder(s)\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`[boot] orphan cleanup failed: ${errMsg(e)}\n`);
  }

  // Runtime orphan watchdog · every 60s, sweep any message that has
  // been streaming:true for over 5 minutes with no token update. The
  // per-turn try/finally in streamSpeakerTurn already finalises on
  // abort / timeout / exception; this is a defense-in-depth net for
  // future code paths or rare race conditions that bypass it. The 5
  // min threshold is far above the 120s hard cap so legitimate long
  // streams aren't killed mid-flight.
  startRuntimeOrphanSweep();

  try {
    const fixed = recoverStuckClarifyRooms();
    if (fixed > 0) {
      process.stderr.write(`[boot] unstuck ${fixed} room(s) frozen in chair-clarify\n`);
    }
  } catch (e) {
    process.stderr.write(`[boot] clarify recovery failed: ${errMsg(e)}\n`);
  }

  try {
    const failed = markRunningJobsFailed();
    if (failed > 0) {
      process.stderr.write(`[boot] marked ${failed} persona-build job(s) failed (server restarted mid-build)\n`);
    }
  } catch (e) {
    process.stderr.write(`[boot] persona-job recovery failed: ${errMsg(e)}\n`);
  }

  try {
    const failed = recoverStuckCloneJobs();
    if (failed > 0) {
      process.stderr.write(`[boot] marked ${failed} voice-clone job(s) failed (server restarted mid-clone)\n`);
    }
  } catch (e) {
    process.stderr.write(`[boot] voice-clone recovery failed: ${errMsg(e)}\n`);
  }

  // Dream sweep · fire-and-forget. Per-agent memory counters reset on
  // restart, so an agent whose pile overflowed mid-cycle (process crashed
  // during a previous dream) never gets caught by the post-adjourn trigger.
  void (async () => {
    try {
      const agents = listAllAgents();
      let triggered = 0;
      for (const agent of agents) {
        if (countMemoriesForAgent(agent.id) > bootCeilingFor(agent.roleKind)) {
          await runDreamCycle(agent.id);
          triggered += 1;
        }
      }
      if (triggered > 0) {
        process.stderr.write(`[boot] dream sweep triggered for ${triggered} agent(s) over ceiling\n`);
      }
    } catch (e) {
      process.stderr.write(`[boot] dream sweep failed: ${errMsg(e)}\n`);
    }
  })();

  const port = opts.port ?? (await findFreePort(3030));
  const host = opts.host ?? "127.0.0.1";
  const server = await startServer({ port, host });

  return { server, dirs, port, host, applied, seed, reconcile };
}

/**
 * Stop the server (drain SSE / close listeners) then force the SQLite WAL
 * to checkpoint and close the file handle. Idempotent — multiple exit paths
 * can race into this safely.
 *
 * Every process exit route MUST funnel through here. Skipping the DB close
 * leaves WAL writes uncheckpointed on disk and the user perceives "data was
 * wiped" on next start.
 */
let shuttingDown = false;
export async function shutdownApp(server: RunningServer | null): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stopRuntimeOrphanSweep();
  try {
    await server?.close();
  } catch (e) {
    console.error("  ! error closing server", e);
  }
  try {
    closeDb();
  } catch (e) {
    console.error("  ! error closing db", e);
  }
}

/* ── Runtime orphan sweep ───────────────────────────────────────────
   Periodic watchdog that finalises any message left in streaming:true
   for over 5 minutes. The per-turn try/finally in streamSpeakerTurn
   already handles abort / timeout / exception paths; this is the
   safety net for any future code path that bypasses it. Wired into
   bootApp + shutdownApp so the interval starts at boot and clears at
   shutdown (no leaked timers on hot reload). */
const RUNTIME_SWEEP_INTERVAL_MS = 60_000;
const RUNTIME_SWEEP_MAX_AGE_MS = 5 * 60_000;
let runtimeSweepTimer: ReturnType<typeof setInterval> | null = null;

function startRuntimeOrphanSweep(): void {
  if (runtimeSweepTimer) return;
  runtimeSweepTimer = setInterval(() => {
    try {
      const r = cleanupOrphanedStreams({
        maxAgeMs: RUNTIME_SWEEP_MAX_AGE_MS,
        reason: "runtime-sweep · 5min stuck",
      });
      if (r.fixed + r.deleted > 0) {
        process.stderr.write(
          `[runtime-sweep] finalised ${r.fixed} stuck stream(s), dropped ${r.deleted} empty placeholder(s)\n`,
        );
      }
    } catch (e) {
      process.stderr.write(`[runtime-sweep] failed: ${errMsg(e)}\n`);
    }
  }, RUNTIME_SWEEP_INTERVAL_MS);
}

function stopRuntimeOrphanSweep(): void {
  if (runtimeSweepTimer) {
    clearInterval(runtimeSweepTimer);
    runtimeSweepTimer = null;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
