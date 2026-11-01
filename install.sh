#!/bin/sh
# Installs (or updates) OXplorer from the newest GitHub release:
#
#   curl -fsSL https://raw.githubusercontent.com/ersinkoc/oXplorer/main/install.sh | sh
#
# OXPLORER_VERSION=0.1.0-beta.2  install that release instead of the newest
# OXPLORER_DEST=~/Applications   install somewhere other than /Applications
#
# Files curl downloads carry no quarantine flag, so macOS opens the app without
# the "unidentified developer" prompt; the flag is cleared anyway in case.

set -eu

REPO="ersinkoc/oXplorer"
APP="OXplorer.app"
DEST="${OXPLORER_DEST:-/Applications}"

say() { printf '%s\n' "$*"; }
fail() {
  say "OXplorer: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "OXplorer runs on macOS only."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 14 ] || fail "OXplorer needs macOS 14 or later (this Mac has $(sw_vers -productVersion))."
command -v curl >/dev/null || fail "curl is missing."

if [ -n "${OXPLORER_VERSION:-}" ]; then
  api="https://api.github.com/repos/$REPO/releases/tags/v${OXPLORER_VERSION#v}"
else
  # Newest first, betas included (releases/latest skips pre-releases).
  api="https://api.github.com/repos/$REPO/releases?per_page=10"
fi

url=$(curl -fsSL "$api" |
  grep -o '"browser_download_url": *"[^"]*\.app\.tar\.gz"' |
  head -n 1 |
  sed 's/.*"\(https:[^"]*\)"$/\1/') || true
[ -n "$url" ] || fail "no release with an app archive found at $api"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $url"
curl -fL --progress-bar "$url" -o "$tmp/oxplorer.tar.gz"
tar -xzf "$tmp/oxplorer.tar.gz" -C "$tmp"
[ -d "$tmp/$APP" ] || fail "the download doesn't contain $APP"

if pgrep -xq OXplorer; then
  fail "OXplorer is running. Quit it (⌘Q) and run the installer again."
fi

mkdir -p "$DEST"
sudo=""
if [ ! -w "$DEST" ] || { [ -e "$DEST/$APP" ] && [ ! -w "$DEST/$APP" ]; }; then
  say "Installing into $DEST needs an administrator password."
  sudo="sudo"
fi

# Replace only our own app bundle.
if [ -e "$DEST/$APP" ]; then
  $sudo rm -rf "$DEST/$APP"
fi
$sudo ditto "$tmp/$APP" "$DEST/$APP"
$sudo xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

version=$(defaults read "$DEST/$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
say "OXplorer $version is installed in $DEST."
say "Open it from Launchpad or with: open \"$DEST/$APP\""
