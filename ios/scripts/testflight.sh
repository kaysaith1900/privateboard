#!/usr/bin/env bash
#
# One-shot TestFlight release · bumps the build number, regenerates the Xcode
# project, archives, exports an App-Store-signed IPA, and uploads it.
#
#   ./scripts/testflight.sh              # bump build (+1), package, upload
#   ./scripts/testflight.sh --no-bump    # reuse the current build number
#   ./scripts/testflight.sh --no-upload  # build + export only, skip upload
#
# Requires (already set up):
#   · DEVELOPMENT_TEAM in project.yml + Apple ID signed into Xcode (auto-signing)
#   · ExportOptions.plist next to project.yml (method: app-store-connect)
#   · An App Store Connect API key .p8 at ~/.appstoreconnect/private_keys/
#     named AuthKey_<KEYID>.p8 · pass its ids via env or the defaults below.
#   · The app record must already exist in App Store Connect (bundle id below).
#
set -euo pipefail

# ── Config (override via env) ───────────────────────────────────────────────
ASC_API_KEY="${ASC_API_KEY:-JG3GFD46QG}"
ASC_API_ISSUER="${ASC_API_ISSUER:-69a6de7a-8d95-47e3-e053-5b8c7c11a4d1}"
SCHEME="${SCHEME:-Boardroom}"

# ── Locate the iOS project dir (the folder holding project.yml) ─────────────
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$IOS_DIR"
[ -f project.yml ] || { echo "✗ project.yml not found in $IOS_DIR"; exit 1; }

BUMP=1; UPLOAD=1
for arg in "$@"; do
  case "$arg" in
    --no-bump)   BUMP=0 ;;
    --no-upload) UPLOAD=0 ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

# ── 1 · bump CURRENT_PROJECT_VERSION ────────────────────────────────────────
cur="$(grep -E '^[[:space:]]*CURRENT_PROJECT_VERSION:' project.yml | head -1 | sed -E 's/.*"([0-9]+)".*/\1/')"
[ -n "$cur" ] || { echo "✗ couldn't read CURRENT_PROJECT_VERSION"; exit 1; }
if [ "$BUMP" -eq 1 ]; then
  next=$((cur + 1))
  sed -i '' -E "s/(CURRENT_PROJECT_VERSION: )\"[0-9]+\"/\1\"$next\"/" project.yml
  echo "▸ build number  $cur → $next"
else
  next="$cur"
  echo "▸ build number  $next (no bump)"
fi

# ── 2 · regenerate the project from project.yml ─────────────────────────────
echo "▸ xcodegen generate"
xcodegen generate >/dev/null

# ── 3 · archive (device, auto-signed) ───────────────────────────────────────
rm -rf build/Boardroom.xcarchive build/export
echo "▸ archiving…"
xcodebuild -scheme "$SCHEME" -destination 'generic/platform=iOS' \
  -archivePath build/Boardroom.xcarchive -allowProvisioningUpdates archive \
  >build/archive.log 2>&1 || { echo "✗ archive failed · tail build/archive.log:"; tail -20 build/archive.log; exit 1; }

# ── 4 · export the App-Store-signed IPA ─────────────────────────────────────
echo "▸ exporting IPA…"
xcodebuild -exportArchive -archivePath build/Boardroom.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export -allowProvisioningUpdates \
  >build/export.log 2>&1 || { echo "✗ export failed · tail build/export.log:"; tail -20 build/export.log; exit 1; }
IPA="build/export/Boardroom.ipa"
[ -f "$IPA" ] || { echo "✗ no IPA produced"; exit 1; }
echo "▸ IPA ready · build $next · $(du -h "$IPA" | cut -f1)"

# ── 5 · upload to TestFlight ────────────────────────────────────────────────
if [ "$UPLOAD" -eq 1 ]; then
  echo "▸ uploading to TestFlight…"
  xcrun altool --upload-app -f "$IPA" -t ios \
    --apiKey "$ASC_API_KEY" --apiIssuer "$ASC_API_ISSUER"
  echo "✓ uploaded · build $next will appear in App Store Connect → TestFlight after processing (~5–15 min)."
else
  echo "✓ packaged (upload skipped) · $IPA"
fi
