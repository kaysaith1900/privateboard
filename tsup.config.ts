import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Native bindings: don't bundle, let Node resolve from node_modules.
  external: ["better-sqlite3"],
  // Migration .sql files are loaded by readFileSync at runtime; copy alongside.
  loader: { ".sql": "text" },
});
