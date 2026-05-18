import { defineConfig } from "tsup";

export default defineConfig({
  // cli.ts ships the CLI bundle for `npx privateboard`; boot.ts + server.ts +
  // version.ts are emitted as standalone ESM modules so electron/main.ts can
  // import them via `../dist/*.js` after tsc compiles the desktop shell.
  entry: ["src/cli.ts", "src/boot.ts", "src/server.ts", "src/version.ts"],
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
  // Emit `.d.ts` alongside each JS bundle so the Electron tsc step can
  // type-check imports of `../dist/boot.js` / `../dist/server.js` without
  // re-compiling src/ (which is impossible — see the `.sql` text loader).
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Native bindings: don't bundle, let Node resolve from node_modules.
  external: ["better-sqlite3"],
  // Migration .sql files are loaded by readFileSync at runtime; copy alongside.
  loader: { ".sql": "text" },
});
