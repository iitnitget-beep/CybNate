#!/usr/bin/env bash
# Downloads the Pyodide runtime (CPython compiled to WebAssembly) into the app assets.
# It is about 12 MB, so it is fetched at build time instead of being committed.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="314.0.8"
DEST="app/src/main/assets/www/vendor/pyodide"
if [ -f "$DEST/pyodide.asm.wasm" ] && [ "$(cat "$DEST/VERSION" 2>/dev/null)" = "$VERSION" ]; then echo "Pyodide $VERSION already present"; exit 0; fi
TMP="$(mktemp -d)"
( cd "$TMP" && npm pack "pyodide@$VERSION" --silent >/dev/null && tar -xzf pyodide-*.tgz )
rm -rf "$DEST" && mkdir -p "$DEST"
for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do cp "$TMP/package/$f" "$DEST/"; done
echo "$VERSION" > "$DEST/VERSION"
rm -rf "$TMP"
du -sh "$DEST"
