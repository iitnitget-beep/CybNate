#!/usr/bin/env bash
# Downloads the Pyodide runtime (CPython compiled to WebAssembly) into the app assets.
# It is about 12 MB, so it is fetched at build time instead of being committed.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="314.0.8"
BABEL_VERSION="8.1.2"
DEST="app/src/main/assets/www/vendor/pyodide"
BABEL_DEST="app/src/main/assets/www/vendor/babel"
TMP="$(mktemp -d)"
if [ ! -f "$DEST/pyodide.asm.wasm" ] || [ "$(cat "$DEST/VERSION" 2>/dev/null)" != "$VERSION" ]; then
  ( cd "$TMP" && npm pack "pyodide@$VERSION" --silent >/dev/null && tar -xzf pyodide-*.tgz )
  rm -rf "$DEST" && mkdir -p "$DEST"
  for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do cp "$TMP/package/$f" "$DEST/"; done
  echo "$VERSION" > "$DEST/VERSION"
  echo "Fetched Pyodide $VERSION"
else echo "Pyodide $VERSION already present"; fi
if [ ! -f "$BABEL_DEST/babel.min.js" ] || [ "$(cat "$BABEL_DEST/VERSION" 2>/dev/null)" != "$BABEL_VERSION" ]; then
  ( cd "$TMP" && npm pack "@babel/standalone@$BABEL_VERSION" --silent >/dev/null && mkdir babel-package && tar -xzf babel-standalone-*.tgz -C babel-package )
  mkdir -p "$BABEL_DEST"
  cp "$TMP/babel-package/package/babel.min.js" "$BABEL_DEST/babel.min.js"
  echo "$BABEL_VERSION" > "$BABEL_DEST/VERSION"
  echo "Fetched Babel Standalone $BABEL_VERSION"
else echo "Babel Standalone $BABEL_VERSION already present"; fi
rm -rf "$TMP"
du -sh "$DEST" "$BABEL_DEST"
