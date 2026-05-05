/**
 * Hono application — serves the static prototype + a thin /api surface.
 * P0 only includes a health check; later phases will mount real routers.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";

import { agentsRouter } from "./routes/agents.js";
import { avatarRouter } from "./routes/avatar.js";
import { briefsRouter } from "./routes/briefs.js";
import { keysRouter } from "./routes/keys.js";
import { modelsRouter } from "./routes/models.js";
import { prefsRouter } from "./routes/prefs.js";
import { roomsRouter } from "./routes/rooms.js";
import { usageRouter } from "./routes/usage.js";
import { publicDir } from "./utils/paths.js";

interface StartOptions {
  port: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export function createApp() {
  const app = new Hono();
  const dir = publicDir();

  if (!existsSync(dir)) {
    // Fail loud at startup rather than 404-ing silently per request.
    throw new Error(
      `public/ directory not found at: ${dir}\n` +
        `Build the package or check that public/ is bundled alongside dist/.`,
    );
  }

  // Two-tier cache policy. Registered FIRST so it sits on top of every
  // route + the static handler — Hono runs middleware in declaration
  // order and a `app.route(...)` that returns a response short-circuits
  // anything declared after it.
  //
  //  1. /api/* responses · `no-store`. State APIs (keys, prefs, models,
  //     rooms, agents, …) reflect mutable server state — every read
  //     must hit the server. `no-store` forbids both the disk cache AND
  //     any heuristic memory cache, which closes the door on the
  //     failure mode where a browser silently serves a stale
  //     GET /api/keys after a PUT and the UI keeps showing "○ not set"
  //     forever.
  //  2. static HTML / JS / CSS · `no-cache, must-revalidate`. The
  //     prototype is iterated on heavily; stale JS strands users on
  //     yesterday's bundle. Combined with the etag the static handler
  //     emits, the steady state becomes 304 (cheap) and the worst case
  //     is one fresh bundle per page load.
  app.use("/*", async (c, next) => {
    await next();
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api/")) {
      c.res.headers.set("Cache-Control", "no-store");
      return;
    }
    const ct = c.res.headers.get("content-type") || "";
    if (
      ct.startsWith("text/html") ||
      ct.startsWith("application/javascript") ||
      ct.startsWith("text/javascript") ||
      ct.startsWith("text/css")
    ) {
      c.res.headers.set("Cache-Control", "no-cache, must-revalidate");
    }
  });

  // /api · health check
  app.get("/api/health", (c) =>
    c.json({ ok: true, version: "0.1.0", time: new Date().toISOString() }),
  );

  // /api routers
  app.route("/api/prefs", prefsRouter());
  app.route("/api/agents", agentsRouter());
  app.route("/api/keys", keysRouter());
  app.route("/api/models", modelsRouter());
  app.route("/api/rooms", roomsRouter());
  app.route("/api/briefs", briefsRouter());
  app.route("/api/avatar", avatarRouter());
  app.route("/api/usage", usageRouter());

  // Static prototype — `/` lands on the dashboard prototype. P0 keeps the
  // prototype file names intact so the cross-page links inside it still work.
  app.use(
    "/*",
    serveStatic({
      root: dir,
      rewriteRequestPath: (path) => (path === "/" ? "/prototype-dashboard.html" : path),
    }),
  );

  return app;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const app = createApp();
  const host = opts.host ?? "127.0.0.1";

  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port: opts.port,
  });

  return {
    url: `http://${host}:${opts.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      }),
  };
}
