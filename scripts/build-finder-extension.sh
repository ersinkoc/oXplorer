#!/bin/sh
# Builds the Finder Sync extension (universal) into src-tauri/target/finder/OXplorerFinder.appex.
# Runs before bundling (tauri.conf.json → build.beforeBundleCommand); the bundle embeds it
# under Contents/PlugIns. Signs with $APPLE_SIGNING_IDENTITY when that identity is in the
# keychain (release), otherwise ad hoc (local builds).
set -eu
cd "$(dirname "$0")/.."
SRC=extensions/finder-sync
OUT=src-tauri/target/finder
APPEX="$OUT/OXplorerFinder.appex"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)

rm -rf "$APPEX"
mkdir -p "$APPEX/Contents/MacOS" "$OUT/obj"
for arch in arm64 x86_64; do
  xcrun swiftc "$SRC/FinderSync.swift" \
    -module-name OXplorerFinder \
    -target "$arch-apple-macos14.0" \
    -application-extension \
    -O -whole-module-optimization \
    -framework Cocoa -framework FinderSync \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -o "$OUT/obj/OXplorerFinder-$arch"
done
lipo -create "$OUT/obj/OXplorerFinder-arm64" "$OUT/obj/OXplorerFinder-x86_64" -output "$APPEX/Contents/MacOS/OXplorerFinder"
sed "s/VERSION/$VERSION/g" "$SRC/Info.plist" > "$APPEX/Contents/Info.plist"

IDENTITY=-
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && security find-identity -v -p codesigning | grep -q "$APPLE_SIGNING_IDENTITY"; then
  IDENTITY="$APPLE_SIGNING_IDENTITY"
fi
# Notarization needs a secure timestamp; ad hoc signatures can't have one.
TIMESTAMP=--timestamp
[ "$IDENTITY" = "-" ] && TIMESTAMP=--timestamp=none
codesign --force --sign "$IDENTITY" --options runtime "$TIMESTAMP" \
  --entitlements "$SRC/OXplorerFinder.entitlements" "$APPEX"
echo "Finder extension: $APPEX (signed: $IDENTITY)"
