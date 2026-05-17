# Release workflow · PrivateBoard

How a new version goes from local commit to "downloaded + ready to
restart" on every user's Mac.

## Stack

- **electron-builder** packages the `.dmg`, signs it with the
  Developer ID Application cert, and notarizes via Apple's
  notary service.
- **electron-updater** (runtime dep) lives inside the packaged app
  and polls GitHub Releases for a newer `latest-mac.yml` manifest
  on launch and every 4 hours.
- **GitHub Releases** is the artifact host. electron-builder uploads
  the `.dmg`, `.dmg.blockmap`, and `latest-mac.yml` to the release
  whose tag matches the version in `package.json`.

The user-facing flow:

1. App launches → 3 seconds later autoUpdater hits
   `https://github.com/kaysaith1900/privateboard/releases/latest/download/latest-mac.yml`.
2. If `latest-mac.yml#version` is greater than `app.getVersion()`,
   the `.dmg` is downloaded in the background.
3. When the download finishes a dialog asks the user to "现在重启更新" or
   "稍后". Choosing "稍后" defers to the next quit (autoInstallOnAppQuit).

Manual trigger: **App ▸ Check for Updates…** in the menu bar.

## Prerequisites (one-time)

- Apple Developer ID Application cert installed in macOS Keychain
  (`security find-identity -v -p codesigning` should list it).
- A GitHub **classic Personal Access Token** with `repo` scope (or
  fine-grained PAT with `contents: read & write` on
  `kaysaith1900/privateboard`). Save to a local env var, e.g. in
  `~/.zshrc`:
  ```sh
  export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxx
  ```
- Apple ID + app-specific password for notarization (electron-builder
  reads `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` env
  vars).

## Per-release checklist

```sh
# 1. Bump version + sync src/version.ts
npm version patch --no-git-tag-version    # or minor / major
npm run sync-version

# 2. Commit + tag (the project convention; tag matches the package
#    version exactly so electron-updater's `latest-mac.yml` lookup
#    aligns with the GitHub Release tag).
git add -A
git commit -m "v0.x.y · short title"
git tag v0.x.y
git push origin main
git push origin v0.x.y

# 3. Build + publish the macOS bundle to the release named v0.x.y.
#    `--publish always` ships dmg + blockmap + latest-mac.yml to the
#    release for the current tag.
GH_TOKEN=$GH_TOKEN npm run electron:dist

# 4. (optional) Sanity-check by opening the release page
gh release view v0.x.y
```

If the `v0.x.y` release doesn't exist yet, electron-builder creates
it as a **draft** and uploads the artifacts. Flip it to "published"
manually via `gh release edit v0.x.y --draft=false` or in the GitHub
UI; autoUpdater ignores drafts.

If a release with this tag already exists (e.g., you ran
`gh release create v0.x.y` before `electron:dist`), the artifacts
are uploaded into that existing release — no new release record is
created.

## Local-only build (no upload)

```sh
npm run electron:dist:local
```

Same `.dmg` output under `release/`, but `--publish never` so
electron-builder doesn't touch GitHub. Useful for smoke-testing the
package locally before promoting.

## Unsigned build (no notarization, no upload)

```sh
npm run electron:dist:unsigned
```

For quick iteration when you don't want to wait on notarization.
The unsigned `.dmg` can't auto-update on user machines — Squirrel.Mac
refuses to replace a non-signed binary. Use only for local testing.

## Skipping the auto-update for a release

If you push a hot-fix you want to ship to new users but not
auto-rollout to existing users, mark the release as a **pre-release**
on GitHub. `autoUpdater.allowPrerelease` defaults to `false` so
existing apps will ignore it. Promote to stable when you're ready by
unchecking "Set as a pre-release" on the GitHub release page.

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find latest-mac.yml` in `update-error` log | Release exists but the artifact wasn't uploaded (e.g. `--publish never` was used or `GH_TOKEN` was missing during dist) | Re-run `electron:dist` with `GH_TOKEN` set, or upload the file manually via `gh release upload v0.x.y release/latest-mac.yml` |
| Update appears to download but never installs | The packaged `.app` isn't signed or the signature is invalid | Confirm `codesign --verify --deep --strict /Applications/PrivateBoard.app` passes; check `notarize: true` was honored (you'll see a `stapler` step in electron-builder's log) |
| `Error: net::ERR_CERT_AUTHORITY_INVALID` from autoUpdater on user machines | macOS clock skew or a corporate MITM proxy | Surface in the in-app error log; user fixes their system |
| Users on `v0.x.y - 1` see no update prompt even though `v0.x.y` is published | The packaged old binary doesn't have `electron-updater` integrated yet (this feature was added in v0.1.21) | Manual one-time upgrade required — once they're on v0.1.21+ subsequent updates flow normally |

## Files involved

- `package.json` · `build.publish` (provider + repo) and the
  `electron:dist` script (`--publish always`).
- `electron/main.ts` · `startAutoUpdater()` subscribes to
  `update-downloaded` and presents the restart dialog.
- `electron/menu.ts` · "Check for Updates…" entry in the App menu.
- `src/version.ts` · stays in lock-step with `package.json#version`
  via `npm run sync-version` so the CLI banner and `/api/version`
  show the same number autoUpdater compares against.
