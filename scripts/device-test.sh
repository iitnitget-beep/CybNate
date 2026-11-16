#!/usr/bin/env bash
# Installs the APK on a running emulator/device, runs the in-app self test and saves the results.
set -uo pipefail
cd "$(dirname "$0")/.."
POLL_LOG="$(mktemp)"
trap 'rm -f "$POLL_LOG"' EXIT
adb install -r release/CybNate.apk
adb logcat -c
adb shell am start -n com.cybnate.app/.MainActivity
for i in $(seq 1 30); do
  adb logcat -d -s CybNateJS:I >"$POLL_LOG" 2>/dev/null || true
  grep -F "CYBUI ready" "$POLL_LOG" >/dev/null && break
  sleep 2
done
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
# Poll a file snapshot instead of piping adb through grep -q: with pipefail enabled,
# grep -q can close early and make adb exit via SIGPIPE, hiding the completion sentinel.
SELFTEST_DONE=0
for i in $(seq 1 120); do
  adb logcat -d -s CybNateJS:I >"$POLL_LOG" 2>/dev/null || true
  if grep -F "CYBTEST DONE" "$POLL_LOG" >/dev/null; then SELFTEST_DONE=1; break; fi
  sleep 5
done
if [ "$SELFTEST_DONE" -ne 1 ]; then echo "::warning::Self-test completion sentinel not seen within 600 seconds"; fi
{
  echo "CybNate on-device self test ($(date -u +%Y-%m-%dT%H:%MZ), Android $(adb shell getprop ro.build.version.release | tr -d '\r'), $(adb shell dumpsys package com.google.android.webview | grep -m1 versionName | tr -d ' \r'))"
  adb logcat -d -s CybNateJS:I | grep -o "CYBTEST.*" | grep -v "CYBTEST RAW" | sed -E 's/ \(https?:[^)]*\)$//'
} > release/selftest.txt
adb exec-out screencap -p > release/screenshot-selftest.png
adb logcat -d -s CybNateJS:I | grep -o "CYBTEST RAW.*" > release/model-raw.txt || true
adb logcat -d -s CybNateJS:I | grep -v "CYBTEST" | grep -o "CybNateJS.*" | tail -40 >> release/device-console.txt || true
# normal launch again to capture the chat produced by the agent run
adb shell am force-stop com.cybnate.app
adb shell am start -n com.cybnate.app/.MainActivity
sleep 12
adb exec-out screencap -p > release/screenshot-chat.png
cat release/selftest.txt
# first-launch screenshots: home (14 s) and home2 (30 s)
