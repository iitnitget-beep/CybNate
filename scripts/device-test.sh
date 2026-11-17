#!/usr/bin/env bash
# Installs the APK on a running emulator/device, runs the in-app self test and saves the results.
set -uo pipefail
cd "$(dirname "$0")/.."
adb install -r release/CybNate.apk
adb logcat -c
adb shell am start -n com.cybnate.app/.MainActivity
for i in $(seq 1 30); do adb logcat -d -s CybNateJS:I 2>/dev/null | grep -q "CYBUI ready" && break; sleep 2; done
sleep 14
adb exec-out screencap -p > release/screenshot-home.png
FOCUS1=$(adb shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | tr '\n' ' ' || true)
sleep 16
adb exec-out screencap -p > release/screenshot-home2.png
adb logcat -d -s CybNateJS:I | grep -o "CYB.*" > release/device-console.txt || true
echo "FOCUS1 $FOCUS1" >> release/device-console.txt
adb shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' >> release/device-console.txt || true
adb logcat -d | grep -iE 'ANR in|chromium.*(error|crash)|Displayed com.cybnate|FATAL' | tail -15 >> release/device-console.txt || true
adb shell am force-stop com.cybnate.app
adb logcat -c
adb shell am start -n com.cybnate.app/.MainActivity --ez selftest true

# The old 260 x 5-second loop stopped after 21m40s and silently saved partial
# output. The suite contains several network and long-running tests, so allow
# up to 32 minutes while staying inside the 40-minute Actions job timeout.
SELFTEST_TIMEOUT_SECONDS="${CYBNATE_SELFTEST_TIMEOUT_SECONDS:-1920}"
POLL_INTERVAL_SECONDS=5
POLL_COUNT=$(( (SELFTEST_TIMEOUT_SECONDS + POLL_INTERVAL_SECONDS - 1) / POLL_INTERVAL_SECONDS ))
SELFTEST_COMPLETE=0
for i in $(seq 1 "$POLL_COUNT"); do
  if adb logcat -d -s CybNateJS:I 2>/dev/null | grep -q "CYBTEST DONE"; then
    SELFTEST_COMPLETE=1
    break
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

# Capture once, then atomically replace the report so a failed capture cannot
# leave a half-written file that looks like a completed report.
SELFTEST_LOG="$(adb logcat -d -s CybNateJS:I 2>/dev/null || true)"
REPORT_TMP="release/selftest.txt.tmp"
{
  echo "CybNate on-device self test ($(date -u +%Y-%m-%dT%H:%MZ), Android $(adb shell getprop ro.build.version.release | tr -d '\r'), $(adb shell dumpsys package com.google.android.webview | grep -m1 versionName | tr -d ' \r'))"
  printf '%s\n' "$SELFTEST_LOG" | grep -o "CYBTEST.*" | grep -v "CYBTEST RAW" | sed -E 's/ \(https?:[^)]*\)$//' || true
} > "$REPORT_TMP"
mv "$REPORT_TMP" release/selftest.txt

adb exec-out screencap -p > release/screenshot-selftest.png
printf '%s\n' "$SELFTEST_LOG" | grep -o "CYBTEST RAW.*" > release/model-raw.txt || true
adb logcat -d -s CybNateJS:I | grep -v "CYBTEST" | grep -o "CybNateJS.*" | tail -40 >> release/device-console.txt || true
# Stop any test still running before collecting the final diagnostics.
adb shell am force-stop com.cybnate.app

if [ "$SELFTEST_COMPLETE" -ne 1 ]; then
  echo "CYBTEST INCOMPLETE reason=timeout after ${SELFTEST_TIMEOUT_SECONDS}s without a DONE marker" >> release/selftest.txt
  cat release/selftest.txt
  exit 1
fi
if ! grep -Eq '^CYBTEST DONE pass=[0-9]+ fail=[0-9]+ skip=[0-9]+$' release/selftest.txt; then
  echo "CYBTEST INCOMPLETE reason=DONE marker was not present in captured report" >> release/selftest.txt
  cat release/selftest.txt
  exit 1
fi

cat release/selftest.txt
# first-launch screenshots: home (14 s) and home2 (30 s)
