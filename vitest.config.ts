import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Vitest config.
 *
 * Boardroom imports migration `.sql` files via tsup's text loader at build
 * time; vitest's underlying vite doesn't natively recognize `.sql`, so we
 * register a tiny plugin with a `load` hook that reads the file from disk
 * and exports its contents as the default export — mirroring the runtime
 * shape exactly.
 */
export default defineConfig({
  plugins: [
    {
      name: "sql-as-string",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".sql")) {
          const content = readFileSync(id, "utf8");
          return `export default ${JSON.stringify(content)};`;
        }
        return null;
      },
    },
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/_setup.ts"],
    // Forks pool: each test file gets its own child process, so the
    // module-level _db singleton in src/storage/db.ts can't bleed across.
    // Inside a file, beforeEach/afterEach handle cleanup.
    pool: "forks",
  },
});
