/**
 * Resolve and prepare on-disk locations for Boardroom state.
 *
 * Default base is ~/.boardroom; tests / multi-instance setups can override
 * via the BOARDROOM_DIR env var. All resolution is lazy (read on each call)
 * so a test can `process.env.BOARDROOM_DIR = ...` after import.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BoardroomDirs {
  base: string;
  knowledge: string;
  briefs: string;
  exports: string;
  logs: string;
}

function basePath(): string {
  const override = process.env.BOARDROOM_DIR;
  if (override && override.trim()) return override;
  return join(homedir(), ".boardroom");
}

function dirs(): BoardroomDirs {
  const base = basePath();
  return {
    base,
    knowledge: join(base, "knowledge"),
    briefs:    join(base, "briefs"),
    exports:   join(base, "exports"),
    logs:      join(base, "logs"),
  };
}

export function ensureBoardroomDir(): BoardroomDirs {
  const d = dirs();
  for (const dir of Object.values(d)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return d;
}

export function statePath(): string {
  return join(basePath(), "state.db");
}

/**
 * Resolve the package's bundled `public/` directory.
 * In dev (running tsx) `__dirname` points to src/utils; in prod it points to
 * dist/. Both cases: walk one level up from where the bundle lives.
 */
export function publicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "public"),
    resolve(here, "..", "..", "public"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}
