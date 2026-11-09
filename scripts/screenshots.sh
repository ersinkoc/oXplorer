#!/bin/sh
# Regenerates the README screenshots in docs/screenshots/.
#
# 1. scripts/demo-content.sh builds demo folders in /Users/Shared/OXplorer Demo.
# 2. A hidden dev build stages each scene (src/dev/screenshots.ts) and saves what
#    its web view draws. No Screen Recording permission is needed, but the native
#    window frame and the sidebar's vibrancy aren't part of that picture, so
# 3. headless Chrome puts each one in a macOS-style window (frame, traffic lights,
#    sidebar backdrop, shadow) on a transparent background.
#
# Needs Google Chrome. Usage: scripts/screenshots.sh
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
demo="/Users/Shared/OXplorer Demo"
out="$repo/docs/screenshots"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
raw=$(mktemp -d)
trap 'rm -rf "$raw" "$demo"' EXIT

sh "$repo/scripts/demo-content.sh" "$demo"

log="$raw/dev.log"
(cd "$repo" && OX_SHOTS_DIR="$raw" pnpm tauri dev -- -- "$demo" >"$log" 2>&1) &
for _ in $(seq 1 200); do
  grep -q "shots done\|shots FAIL" "$log" 2>/dev/null && break
  sleep 3
done
pkill -f "target/debug/oxplorer" || true
grep "shots FAIL" "$log" && exit 1
grep -q "shots done" "$log" || { echo "the dev build never finished the shots (see $log)"; exit 1; }

# Scenes in dark mode get a dark sidebar backdrop.
dark=" preview-dark terminal disk-usage "
mkdir -p "$out"
for png in "$raw"/*.png; do
  name=$(basename "$png" .png)
  w=$(sips -g pixelWidth "$png" | awk '/pixelWidth/ {print $2}')
  h=$(sips -g pixelHeight "$png" | awk '/pixelHeight/ {print $2}')
  case "$dark" in
    *" $name "*) backdrop="#2c2c2e"; edge="rgba(255,255,255,.16)" ;;
    *) backdrop="#e8e8ea"; edge="rgba(0,0,0,.22)" ;;
  esac
  pad=96
  cat >"$raw/$name.html" <<EOF
<!doctype html><html><body style="margin:0;background:transparent">
<div style="position:absolute;left:${pad}px;top:$((pad / 2))px;width:${w}px;height:${h}px;border-radius:24px;
  overflow:hidden;background:$backdrop;box-shadow:0 0 0 2px $edge,0 40px 110px rgba(0,0,0,.38),0 10px 30px rgba(0,0,0,.18)">
  <img src="$name.png" style="display:block;width:${w}px;height:${h}px">
  <div style="position:absolute;left:40px;top:36px;display:flex;gap:16px">
    <span style="width:24px;height:24px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)"></span>
    <span style="width:24px;height:24px;border-radius:50%;background:#febc2e;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)"></span>
    <span style="width:24px;height:24px;border-radius:50%;background:#28c840;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)"></span>
  </div>
</div></body></html>
EOF
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size=$((w + pad * 2)),$((h + pad * 2)) \
    --screenshot="$out/$name.png" "file://$raw/$name.html" >/dev/null 2>&1
  echo "docs/screenshots/$name.png"
done
