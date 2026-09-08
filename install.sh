#!/usr/bin/env bash
# Install StatusMonitorGnome into the user extensions directory.
set -euo pipefail

UUID="statusmonitorgnome@yenreh.github.com"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/metadata.json" "$SRC/extension.js" "$SRC/prefs.js" \
      "$SRC/stylesheet.css" "$SRC/schemas" "$SRC/icons" "$DEST/"

echo "Installed in $DEST"
echo "Log out and back in (Wayland), then run: gnome-extensions enable $UUID"
