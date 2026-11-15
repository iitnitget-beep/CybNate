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
adb logcat -d -s CybNateJS:I | grep -o "CYB.*" > release/device-console.txt || true
adb shell am force-stop com.cybnate.app
adb logcat -c
adb shell am start -n com.cybnate.app/.MainActivity --ez selftest true
for i in $(seq 1 260); do
  adb logcat -d -s CybNateJS:I 2>/dev/null | grep -q "CYBTEST DONE" && break
  sleep 5
done
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
