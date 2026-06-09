#!/usr/bin/env bash
# Copy the web assets the on-device 3D stage needs into the app bundle resources.
# The native loopback server (LoopbackServer.swift) serves these at 127.0.0.1 so
# stage-embed.html's same-origin imports + GLB loads resolve with no server.
#
# Re-run after changing stage-embed / voice-3d-mobile / the avatar models:
#   bash scripts/copy-ios-web-assets.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=public
DEST=ios/Boardroom/Resources/web

rm -rf "$DEST"
mkdir -p "$DEST/mobile" "$DEST/vendor" "$DEST/avatars/models" "$DEST/avatars/3d" "$DEST/report/spines"

cp "$SRC/mobile/stage-embed.html"      "$DEST/mobile/"
cp "$SRC/mobile/voice-3d-mobile.js"    "$DEST/mobile/"
# Avatar render + customiser embeds · the hidden WKWebView (AvatarRenderer) loads
# avatar-embed.html to snapshot a seed → PNG (new-director portrait + the dice
# re-roll on the profile); avatar-editor-embed.html is the visible 捏脸 sheet.
# Without these the loopback 404s, the bridge never loads, render() times out →
# new directors get no 3D avatar and the dice does nothing. avatar-3d-snap.js is
# the IIFE avatar-embed pulls in (it lazy-imports three + avatar-3d.js).
cp "$SRC/mobile/avatar-embed.html"        "$DEST/mobile/"
cp "$SRC/mobile/avatar-editor-embed.html" "$DEST/mobile/"
cp "$SRC/avatar-3d-snap.js"            "$DEST/"
cp "$SRC/avatar-3d.js"                 "$DEST/"
cp "$SRC"/vendor/*.js                  "$DEST/vendor/" 2>/dev/null || true
cp "$SRC"/avatars/models/*.glb         "$DEST/avatars/models/"
# Seed directors' pre-rendered 3D portraits · AvatarView (rooms list, cast rail,
# director cards) loads /avatars/3d/<id>.png from the loopback. Without these the
# avatars fall back to a monogram. (User-created directors carry a data: URL.)
cp "$SRC"/avatars/3d/*.png             "$DEST/avatars/3d/" 2>/dev/null || true

# Closing-brief renderer · the native loopback serves report.html so the brief
# renders with the full spine system (P4-10) instead of plain markdown. It
# fetches /api/briefs/:id + /api/rooms/:id from the loopback, swaps in
# report/spines/<spine>.css, and renders the kami-chart fenced blocks inline.
cp "$SRC/report.html"                  "$DEST/"
cp "$SRC/themes.css"                   "$DEST/" 2>/dev/null || true
cp "$SRC"/report/spines/*.css          "$DEST/report/spines/"

# Structured brief modes · magazine / newspaper / ppt are self-contained single
# pages that fetch /api/briefs/:id and template the brief's body_json. The native
# loopback serves them; NativeBriefView opens the one matching the brief's style.
cp "$SRC/magazine.html"                "$DEST/" 2>/dev/null || true
cp "$SRC/newspaper.html"               "$DEST/" 2>/dev/null || true
cp "$SRC/ppt.html"                     "$DEST/" 2>/dev/null || true

echo "[copy-ios-web-assets] →  $DEST"
du -sh "$DEST"
