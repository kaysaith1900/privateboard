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
import { runMigrations } from "./storage/db.js";
import { reconcileAgentModels } from "./storage/reconcile-models.js";
import { ensureBoardroomDir } from "./utils/paths.js";
import { findFreePort } from "./utils/port.js";

const VERSION = "0.1.0";

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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    process.stdout.write(`\n  ▸ ${signal} received · shutting down\n`);
    try {
      await server.close();
    } catch (e) {
      console.error("  ! error closing server", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("privateboard failed to start:", err);
  process.exit(1);
});
