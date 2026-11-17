#!/usr/bin/env bash
# Regression tests for scripts/check-selftest.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CHECKER="$ROOT/scripts/check-selftest.sh"

cat > "$TMP/valid.txt" <<'REPORT'
CybNate test header
CYBTEST START ua=test
CYBTEST PASS one :: ok
CYBTEST PASS two :: ok
CYBTEST SKIP network :: offline
CYBTEST DONE pass=2 fail=0 skip=1
REPORT
bash "$CHECKER" "$TMP/valid.txt" >/dev/null

cat > "$TMP/missing-done.txt" <<'REPORT'
CybNate test header
CYBTEST START ua=test
CYBTEST PASS one :: ok
REPORT
if bash "$CHECKER" "$TMP/missing-done.txt" >/dev/null 2>&1; then
  echo 'FAIL checker accepted a missing DONE marker' >&2; exit 1
fi

cat > "$TMP/mismatch.txt" <<'REPORT'
CybNate test header
CYBTEST START ua=test
CYBTEST PASS one :: ok
CYBTEST DONE pass=2 fail=0 skip=0
REPORT
if bash "$CHECKER" "$TMP/mismatch.txt" >/dev/null 2>&1; then
  echo 'FAIL checker accepted inconsistent totals' >&2; exit 1
fi

cat > "$TMP/failure.txt" <<'REPORT'
CybNate test header
CYBTEST START ua=test
CYBTEST FAIL one :: broken
CYBTEST DONE pass=0 fail=1 skip=0
REPORT
if bash "$CHECKER" "$TMP/failure.txt" >/dev/null 2>&1; then
  echo 'FAIL checker accepted a failed suite' >&2; exit 1
fi

cat > "$TMP/incomplete.txt" <<'REPORT'
CybNate test header
CYBTEST START ua=test
CYBTEST INCOMPLETE reason=timeout
REPORT
if bash "$CHECKER" "$TMP/incomplete.txt" >/dev/null 2>&1; then
  echo 'FAIL checker accepted an incomplete report' >&2; exit 1
fi

echo 'SELFTEST REPORT TESTS PASS'
