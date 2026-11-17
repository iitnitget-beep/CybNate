#!/usr/bin/env bash
# Downloads pinned browser runtimes into ignored app assets; tarball integrity is checked before extraction.
set -euo pipefail
cd "$(dirname "$0")/.."

PYODIDE_VERSION="314.0.8"
PYODIDE_INTEGRITY="sha512-74Wq1kXOC+CCEzAfxuRAO701nAcCMLjf8NrwvWpu8S41dVMXwXmLQ05dYB+F4e46AdnGo0oq7YHSVUpHsoarLQ=="
BABEL_VERSION="8.1.2"
BABEL_INTEGRITY="sha512-QhsyXmrjad8I3/QozB5Qap9S7e3b7iUSf6QCmWR7qhOHkWVIDHIWQQaerjMVDv4p9Hh2luCbYc00CZJAItFXMw=="
REACT_VERSION="18.3.1"
REACT_INTEGRITY="sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ=="
REACT_DOM_INTEGRITY="sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw=="
PYODIDE_DEST="app/src/main/assets/www/vendor/pyodide"
BABEL_DEST="app/src/main/assets/www/vendor/babel"
REACT_DEST="app/src/main/assets/www/vendor/react-runtime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

verify_tarball() {
  local file="$1" integrity="$2" actual expected
  if command -v sha512sum >/dev/null 2>&1; then
    actual="$(sha512sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 512 "$file" | awk '{print $1}')"
  else
    echo "Need sha512sum or shasum to verify vendor package integrity" >&2; return 1
  fi
  if base64 --help 2>&1 | grep -q -- '-d'; then
    expected="$(printf '%s' "${integrity#sha512-}" | base64 -d | od -An -tx1 | tr -d ' \\n')"
  else
    expected="$(printf '%s' "${integrity#sha512-}" | base64 -D | od -An -tx1 | tr -d ' \\n')"
  fi
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

react_runtime_ready() {
  [[ "$(cat "$REACT_DEST/VERSION" 2>/dev/null || true)" == "$REACT_VERSION" && -s "$REACT_DEST/react.production.min.js" && -s "$REACT_DEST/react-dom.production.min.js" ]]
}
if react_runtime_ready; then
  echo "React/ReactDOM runtime $REACT_VERSION already present"
else
  fetch_package react "$REACT_VERSION" "react-$REACT_VERSION.tgz" "$REACT_INTEGRITY" "$TMP/react-unpack"
  fetch_package react-dom "$REACT_VERSION" "react-dom-$REACT_VERSION.tgz" "$REACT_DOM_INTEGRITY" "$TMP/react-dom-unpack"
  REACT_FILE="$TMP/react-unpack/package/umd/react.production.min.js"
  REACT_DOM_FILE="$TMP/react-dom-unpack/package/umd/react-dom.production.min.js"
  [[ -s "$REACT_FILE" && -s "$REACT_DOM_FILE" ]] || { echo "React UMD runtime files are missing" >&2; exit 1; }
  local_stage="$TMP/react-ready"
  mkdir -p "$local_stage"
  cp "$REACT_FILE" "$local_stage/react.production.min.js"
  cp "$REACT_DOM_FILE" "$local_stage/react-dom.production.min.js"
  printf '%s\n' "$REACT_VERSION" > "$local_stage/VERSION"
  rm -rf "$REACT_DEST"
  mkdir -p "$(dirname "$REACT_DEST")"
  mv "$local_stage" "$REACT_DEST"
  echo "Fetched and verified React/ReactDOM runtime $REACT_VERSION"
fi

du -sh "$PYODIDE_DEST" "$BABEL_DEST" "$REACT_DEST"
