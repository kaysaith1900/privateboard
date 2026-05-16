/**
 * privateboard CLI entrypoint · `npx privateboard@latest`
 *
 * Parses argv, runs the shared boot sequence (migrations + recoveries +
 * server), prints the banner, pops the user's browser, then wires every
 * exit signal to the WAL-safe shutdown path. The actual boot logic lives
 * in `boot.ts` so the Electron desktop client can call it too.
 *
 *   --port <n>     start on this port instead of auto-detect
 *   --host <h>     bind host (default 127.0.0.1, only override for dev)
 *   --no-open      don't auto-open the browser
 *   --version      print version
 */
import { Command } from "commander";
import open from "open";

import { bootApp, shutdownApp } from "./boot.js";
import { closeDb } from "./storage/db.js";
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

  const portArg = opts.port ? Number.parseInt(opts.port, 10) : undefined;
  if (portArg !== undefined && (Number.isNaN(portArg) || portArg < 1 || portArg > 65535)) {
    console.error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }

  const { server, dirs, applied, seed, reconcile } = await bootApp({
    port: portArg,
    host: opts.host,
  });

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

  // Graceful shutdown · see boot.ts shutdownApp for why every exit path
  // funnels through the same helper. SIGINT (Ctrl+C), SIGTERM (`kill <pid>`),
  // and SIGHUP (terminal close — default Node behaviour terminates WITHOUT
  // running other handlers, so it must be hooked explicitly) get the full
  // async drain. The `exit` hook is a sync last-resort flush for paths that
  // bypass the signal handlers (uncaughtException, nodemon restart, parent
  // SIGKILL of the child) — better-sqlite3's close() is synchronous so we
  // still get a WAL checkpoint even when we can't await anything else.
  const onSignal = (signal: string) => {
    process.stdout.write(`\n  ▸ ${signal} received · shutting down\n`);
    void shutdownApp(server).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGHUP", () => onSignal("SIGHUP"));
  process.on("exit", () => {
    try { closeDb(); } catch { /* */ }
  });
}

main().catch((err) => {
  console.error("privateboard failed to start:", err);
  process.exit(1);
});
