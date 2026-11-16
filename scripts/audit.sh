#!/usr/bin/env bash
# Repeatable repository hygiene and build-readiness checks.
set -u
cd "$(dirname "$0")/.."
passed=0
failed=0
check() {
  local name="$1"; shift
  if "$@"; then
    printf 'PASS %s\n' "$name"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n' "$name"
    failed=$((failed + 1))
  fi
}

not_tracked_keystore() {
  ! git ls-files | grep -Eiq '(^|/)[^/]*\.(jks|keystore)$'
}
no_gradle_password_literal() {
  ! grep -Fq "storePassword '" app/build.gradle
}
workflow_does_not_add_key() {
  ! grep -Eih '^[[:space:]]*git[[:space:]]+add([[:space:]]|$).*(keystore|\.jks|\.keystore)' .github/workflows/* 2>/dev/null
}
package_files_exist() { test -f package.json && test -f package-lock.json; }
required_docs_exist() { test -f LICENSE && test -f AGENTS.md && test -f CLAUDE.md; }
verify_exists() { test -f scripts/verify.sh; }
max_parallel_exists() { grep -Eq 'MAX_PARALLEL' app/src/main/assets/www/core.js; }
cleartext_manifest_policy() {
  if grep -Eq 'usesCleartextTraffic="true"' app/src/main/AndroidManifest.xml; then
    grep -Rq 'isAllowedHttpUrl' app/src/main/assets/www
  else
    return 0
  fi
}
no_tracked_sensitive_files() {
  ! git ls-files | grep -Eiq '(^|/)\.env($|\.)|(^|/)[^/]+\.(jks|keystore|pem)$'
}
server_package_and_syntax() {
  test -f server/package.json || return 1
  local found=0 f
  for f in server/src/*.js; do
    test -f "$f" || continue
    found=1
    node --check "$f" >/dev/null || return 1
  done
  test "$found" -eq 1
}

check 'keystore is not tracked' not_tracked_keystore
check "app/build.gradle has no storePassword literal" no_gradle_password_literal
check 'workflow never git-adds a keystore' workflow_does_not_add_key
check 'package.json and package-lock.json exist' package_files_exist
check 'LICENSE, AGENTS.md, and CLAUDE.md exist' required_docs_exist
check 'scripts/verify.sh exists' verify_exists
check 'MAX_PARALLEL is present in core.js' max_parallel_exists
if cleartext_manifest_policy; then
  if grep -Eq 'usesCleartextTraffic="true"' app/src/main/AndroidManifest.xml; then
    printf 'PASS manifest cleartext is guarded by isAllowedHttpUrl (LAN cleartext remains enabled by design)\n'
  else
    printf 'PASS manifest does not enable cleartext traffic\n'
  fi
  passed=$((passed + 1))
else
  printf 'FAIL manifest cleartext requires isAllowedHttpUrl in app request code\n'
  failed=$((failed + 1))
fi
check 'no tracked .env, .jks, .keystore, or .pem files' no_tracked_sensitive_files
check 'server/package.json exists and server/src JavaScript passes node --check' server_package_and_syntax
printf '%d passed, %d failed\n' "$passed" "$failed"
test "$failed" -eq 0
