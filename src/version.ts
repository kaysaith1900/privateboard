/**
 * Single source of truth for the app version.
 *
 * Imported by `cli.ts` (CLI banner / `--version`), `server.ts` (the
 * `/health` payload + the `/api/version` endpoint), and bundled into
 * the frontend via the version endpoint. Bump alongside `package.json`
 * on every release — the existing `npm version <patch|minor|major>`
 * + commit pattern updates package.json automatically; this file
 * needs the matching manual bump.
 *
 * If two strings drift (bumped one but not the other), the wrong
 * number ends up surfaced in the user-facing footer or banner. Keep
 * this file as the canonical source — every callsite reads from here.
 */
export const VERSION = "0.1.17";
