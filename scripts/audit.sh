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
  ! grep -Eiq "storePassword[[:space:]]*=?[[:space:]]*['\"]" app/build.gradle
}
workflow_does_not_add_key() {
  ! grep -Eih '^[[:space:]]*git[[:space:]]+add([[:space:]]|$).*(keystore|\.(jks|keystore|pem|p12|bks|key))' .github/workflows/* 2>/dev/null
}
package_files_exist() { test -f package.json && test -f package-lock.json; }
required_docs_exist() { test -f LICENSE && test -f AGENTS.md && test -f CLAUDE.md; }
verify_exists() { test -f scripts/verify.sh; }
max_parallel_exists() { grep -Eq 'MAX_PARALLEL' app/src/main/assets/www/core.js; }
manifest_cleartext_safe() {
  if ! grep -Eq 'usesCleartextTraffic="true"' app/src/main/AndroidManifest.xml; then return 0; fi
  app=app/src/main/assets/www/app.js
  awk '/function nativeStream/ {inside=1} inside && /requireAllowedHttpUrl\(url\)/ {guard=NR} inside && /Native\.http\(/ {sent=NR; exit !(guard && guard < sent)} END {if (!sent) exit 1}' "$app" &&
  awk '/async function httpStream/ {inside=1} inside && /requireAllowedHttpUrl\(url\)/ {guard=NR} inside && /await fetch\(/ {sent=NR; exit !(guard && guard < sent)} END {if (!sent) exit 1}' "$app" &&
  grep -Fq 'self.UrlPolicy.isAllowedHttpUrl(target)' app/src/main/assets/www/jsworker.js &&
  grep -Fq 'if (!isAllowedHttpUrl(current))' app/src/main/java/com/cybnate/app/MainActivity.java &&
  grep -Fq 'if (!isAllowedHttpUrl(next))' app/src/main/java/com/cybnate/app/MainActivity.java
}
no_tracked_sensitive_files() {
  ! git ls-files | grep -Eiq '(^|/)\.env($|\.)|(^|/)[^/]*\.(jks|keystore|pem|p12|bks|key)$'
}
sensitive_patterns_ignored() {
  local pattern
  for pattern in '.env' '.env.*' '*.jks' '*.keystore' '*.pem' '*.p12' '*.bks' '*.key'; do
    grep -Fxq "$pattern" .gitignore || return 1
  done
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
workflow_runs_audit() {
  grep -Eq '^[[:space:]]*-[[:space:]]+name: Repository audit' .github/workflows/build-apk.yml &&
    grep -Fq 'run: bash scripts/audit.sh' .github/workflows/build-apk.yml
}
workflow_gate_accepts_skip_count() {
  grep -Eiq 'run:[[:space:]]*grep .*CYBTEST DONE pass=.*fail=0 skip=' .github/workflows/build-apk.yml
}

check 'keystore is not tracked' not_tracked_keystore
check 'app/build.gradle has no storePassword literal' no_gradle_password_literal
check 'workflow never git-adds key material' workflow_does_not_add_key
check 'package.json and package-lock.json exist' package_files_exist
check 'LICENSE, AGENTS.md, and CLAUDE.md exist' required_docs_exist
check 'scripts/verify.sh exists' verify_exists
check 'MAX_PARALLEL is present in core.js' max_parallel_exists
if manifest_cleartext_safe; then
  if grep -Eq 'usesCleartextTraffic="true"' app/src/main/AndroidManifest.xml; then
    printf 'PASS cleartext manifest has all required request-code guards (LAN cleartext remains enabled by design)\n'
  else
    printf 'PASS manifest does not enable cleartext traffic\n'
  fi
  passed=$((passed + 1))
else
  printf 'FAIL cleartext manifest requires app, worker, native-request, and native-redirect guards\n'
  failed=$((failed + 1))
fi
check 'no tracked .env, .jks, .keystore, .pem, .p12, .bks, or .key files' no_tracked_sensitive_files
check 'sensitive file patterns are ignored in .gitignore' sensitive_patterns_ignored
check 'server/package.json exists and server/src JavaScript passes node --check' server_package_and_syntax
check 'build workflow runs scripts/audit.sh' workflow_runs_audit
check 'device gate requires DONE pass, zero failures, and skip count' workflow_gate_accepts_skip_count
printf '%d passed, %d failed\n' "$passed" "$failed"
test "$failed" -eq 0
