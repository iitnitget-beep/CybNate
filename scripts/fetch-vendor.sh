#!/usr/bin/env bash
# Downloads pinned browser runtimes into ignored app assets; tarball integrity is checked before extraction.
set -euo pipefail
cd "$(dirname "$0")/.."

PYODIDE_VERSION="314.0.8"
PYODIDE_INTEGRITY="sha512-74Wq1kXOC+CCEzAfxuRAO701nAcCMLjf8NrwvWpu8S41dVMXwXmLQ05dYB+F4e46AdnGo0oq7YHSVUpHsoarLQ=="
BABEL_VERSION="8.1.2"
BABEL_INTEGRITY="sha512-QhsyXmrjad8I3/QozB5Qap9S7e3b7iUSf6QCmWR7qhOHkWVIDHIWQQaerjMVDv4p9Hh2luCbYc00CZJAItFXMw=="
PYODIDE_DEST="app/src/main/assets/www/vendor/pyodide"
BABEL_DEST="app/src/main/assets/www/vendor/babel"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

verify_tarball() {
  local file="$1" integrity="$2" actual expected
  actual="$(sha512sum "$file" | awk '{print $1}')"
  expected="$(printf '%s' "${integrity#sha512-}" | base64 -d | od -An -tx1 | tr -d ' \n')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Integrity mismatch for $(basename "$file"): expected $expected, got $actual" >&2
    return 1
  fi
}

fetch_package() {
  local name="$1" version="$2" tarball="$3" integrity="$4" unpack="$5"
  (cd "$TMP" && npm pack "$name@$version" --silent --pack-destination "$TMP" >/dev/null)
  [[ -s "$TMP/$tarball" ]] || { echo "npm pack did not produce $tarball" >&2; return 1; }
  verify_tarball "$TMP/$tarball" "$integrity"
  mkdir -p "$unpack"
  tar -xzf "$TMP/$tarball" -C "$unpack"
}

pyodide_ready() {
  [[ "$(cat "$PYODIDE_DEST/VERSION" 2>/dev/null || true)" == "$PYODIDE_VERSION" ]] || return 1
  local f
  for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do [[ -s "$PYODIDE_DEST/$f" ]] || return 1; done
}
if pyodide_ready; then
  echo "Pyodide $PYODIDE_VERSION already present"
else
  fetch_package pyodide "$PYODIDE_VERSION" "pyodide-$PYODIDE_VERSION.tgz" "$PYODIDE_INTEGRITY" "$TMP/pyodide-unpack"
  local_stage="$TMP/pyodide-ready"
  mkdir -p "$local_stage"
  for f in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
    [[ -s "$TMP/pyodide-unpack/package/$f" ]] || { echo "Pyodide package is missing $f" >&2; exit 1; }
    cp "$TMP/pyodide-unpack/package/$f" "$local_stage/"
  done
  printf '%s\n' "$PYODIDE_VERSION" > "$local_stage/VERSION"
  rm -rf "$PYODIDE_DEST"
  mkdir -p "$(dirname "$PYODIDE_DEST")"
  mv "$local_stage" "$PYODIDE_DEST"
  echo "Fetched and verified Pyodide $PYODIDE_VERSION"
fi

babel_ready() {
  [[ "$(cat "$BABEL_DEST/VERSION" 2>/dev/null || true)" == "$BABEL_VERSION" && -s "$BABEL_DEST/babel.min.js" ]] || return 1
  [[ "$(wc -c < "$BABEL_DEST/babel.min.js")" -lt 10000000 ]]
}
if babel_ready; then
  echo "Babel Standalone $BABEL_VERSION already present"
else
  fetch_package @babel/standalone "$BABEL_VERSION" "babel-standalone-$BABEL_VERSION.tgz" "$BABEL_INTEGRITY" "$TMP/babel-unpack"
  BABEL_FILE="$TMP/babel-unpack/package/babel.min.js"
  [[ -s "$BABEL_FILE" && "$(wc -c < "$BABEL_FILE")" -lt 10000000 ]] || { echo "Babel compiler is missing or unexpectedly large" >&2; exit 1; }
  local_stage="$TMP/babel-ready"
  mkdir -p "$local_stage"
  cp "$BABEL_FILE" "$local_stage/babel.min.js"
  printf '%s\n' "$BABEL_VERSION" > "$local_stage/VERSION"
  rm -rf "$BABEL_DEST"
  mkdir -p "$(dirname "$BABEL_DEST")"
  mv "$local_stage" "$BABEL_DEST"
  echo "Fetched and verified Babel Standalone $BABEL_VERSION"
fi

du -sh "$PYODIDE_DEST" "$BABEL_DEST"
