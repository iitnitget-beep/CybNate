#!/usr/bin/env bash
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() {
  printf 'VERIFY FAILED: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js is required to run tests/core.test.js and tests/safety.test.js.'
[ -f tests/core.test.js ] || fail 'Verification gate is incomplete: tests/core.test.js is missing.'
[ -f tests/safety.test.js ] || fail 'Verification gate is incomplete: tests/safety.test.js is missing.'
[ -f tests/cleartext.test.js ] || fail 'Verification gate is incomplete: tests/cleartext.test.js is missing.'
[ -f tests/planner.test.js ] || fail 'Verification gate is incomplete: tests/planner.test.js is missing.'

printf '%s\n' '==> bash scripts/audit.sh'
bash scripts/audit.sh
printf '%s\n' '==> node tests/cleartext.test.js'
node tests/cleartext.test.js
printf '%s\n' '==> node tests/core.test.js'
node tests/core.test.js
printf '%s\n' '==> node tests/safety.test.js'
node tests/safety.test.js
printf '%s\n' '==> node tests/planner.test.js'
node tests/planner.test.js

if [ "${VERIFY_JS_ONLY:-0}" = '1' ]; then
  printf '%s\n' 'JS-only checks passed. Android build gate was explicitly skipped (not a full verify).'
  exit 0
fi

command -v java >/dev/null 2>&1 || fail 'Android build gate not run: JDK 17 (java) is missing.'
java_version="$(java -version 2>&1 | sed -n '1s/.*version "\([^"]*\)".*/\1/p')"
case "$java_version" in
  17|17.*) ;;
  *) fail "Android build gate requires JDK 17; detected '${java_version:-unknown}' from java -version." ;;
esac
command -v gradle >/dev/null 2>&1 || fail 'Android build gate not run: Gradle is missing.'

sdk_dir="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$sdk_dir" ] && [ -f local.properties ]; then
  sdk_dir="$(sed -n 's/^sdk\.dir=//p' local.properties | head -n 1 | sed 's/\\\\:/\:/g; s/\\\\ / /g')"
fi
[ -n "$sdk_dir" ] || fail 'Android build gate not run: set ANDROID_SDK_ROOT (or ANDROID_HOME) to an Android SDK installation.'
[ -d "$sdk_dir/platforms/android-34" ] || fail "Android build gate not run: Android SDK platform 34 is missing under '$sdk_dir'."

printf '%s\n' '==> gradle :app:testReleaseUnitTest :app:assembleDebug'
gradle :app:testReleaseUnitTest :app:assembleDebug
printf '%s\n' 'Full verification passed, including the Android build gate.'
