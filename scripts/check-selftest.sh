#!/usr/bin/env bash
# Validate that the device self-test report is complete and internally consistent.
set -euo pipefail
REPORT="${1:-release/selftest.txt}"

fail() {
  printf 'SELFTEST REPORT FAILED: %s\n' "$1" >&2
  exit 1
}

[ -f "$REPORT" ] || fail "report file is missing: $REPORT"
grep -q '^CYBTEST START ' "$REPORT" || fail 'CYBTEST START marker is missing'
! grep -q '^CYBTEST INCOMPLETE ' "$REPORT" || fail 'report explicitly marks the run incomplete'

summary_count="$(grep -Ec '^CYBTEST DONE pass=[0-9]+ fail=[0-9]+ skip=[0-9]+$' "$REPORT" || true)"
[ "$summary_count" -eq 1 ] || fail "expected exactly one valid DONE summary; found $summary_count"
summary="$(grep -E '^CYBTEST DONE pass=[0-9]+ fail=[0-9]+ skip=[0-9]+$' "$REPORT")"
read -r reported_pass reported_fail reported_skip < <(
  printf '%s\n' "$summary" | sed -E 's/^CYBTEST DONE pass=([0-9]+) fail=([0-9]+) skip=([0-9]+)$/\1 \2 \3/'
)

actual_pass="$(grep -Ec '^CYBTEST PASS ' "$REPORT" || true)"
actual_fail="$(grep -Ec '^CYBTEST FAIL ' "$REPORT" || true)"
actual_skip="$(grep -Ec '^CYBTEST SKIP ' "$REPORT" || true)"

[ "$reported_pass" -eq "$actual_pass" ] || fail "PASS count mismatch: summary=$reported_pass report=$actual_pass"
[ "$reported_fail" -eq "$actual_fail" ] || fail "FAIL count mismatch: summary=$reported_fail report=$actual_fail"
[ "$reported_skip" -eq "$actual_skip" ] || fail "SKIP count mismatch: summary=$reported_skip report=$actual_skip"
[ "$reported_fail" -eq 0 ] || fail "$reported_fail device test(s) failed"

printf 'SELFTEST REPORT OK: pass=%s fail=%s skip=%s\n' "$reported_pass" "$reported_fail" "$reported_skip"
