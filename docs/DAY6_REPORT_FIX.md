# Day 6 — Device self-test report reliability

Date: 2026-11-17  
Branch: `work/day5-baseline`

## Finding

The previous device runner used a fixed loop of 260 polls with a 5-second sleep (maximum 21 minutes 40 seconds). After the loop, it always wrote whatever `CYBTEST` lines were present into `release/selftest.txt`; it did not require or verify the terminal `CYBTEST DONE` marker before replacing the report.

The in-app self-test runs many serial checks. Each check has a 300-second timeout, and some checks perform network, package-installation, Python-runtime, or agent work. The suite can therefore outlast the old 21m40s polling window. The latest report contained only the initial 9 visible PASS lines and no DONE summary.

This is a confirmed reporting-path defect that can produce incomplete reports. It is not proof that this was the only reason the historical run stopped early; device logs from that run are insufficient to establish the exact runtime failure.

## Changes made on the development branch

1. `scripts/device-test.sh`
   - Increased the default self-test wait to 32 minutes (configurable with `CYBNATE_SELFTEST_TIMEOUT_SECONDS`).
   - Captures the log once and writes the report through a temporary file before replacing the previous report.
   - Adds an explicit `CYBTEST INCOMPLETE` marker and exits non-zero if the suite does not emit a valid DONE marker.
   - Stops the app after capturing diagnostics.

2. `scripts/check-selftest.sh`
   - Requires START and exactly one valid DONE summary.
   - Rejects reports marked INCOMPLETE.
   - Compares reported PASS/FAIL/SKIP totals with the actual records.
   - Rejects any non-zero failure count.

3. `tests/selftest-report.test.sh`
   - Adds fixture checks for valid reports, missing DONE, mismatched counts, failed tests, and incomplete reports.

4. `.github/workflows/build-apk.yml`
   - Runs the report-checker regression tests in the regular test job.
   - Uploads device diagnostics even when the emulator test fails.
   - Runs the strict report validator with `if: always()`, so a missing or incomplete report fails the device-test job.

5. `scripts/audit.sh`
   - Verifies that the report checker and its regression tests are wired into CI.

## Verification status

- Source changes committed to the development branch: yes.
- GitHub branch contents re-fetched after changes: yes.
- Full repository test suite: not run from this connector session.
- Android emulator workflow: not run from this connector session.
- CI green status: not claimed.
- Main branch changed: no.
- Paid services enabled: no.

## Remaining risk

The Android emulator suite still depends on network/provider availability and may reach its 32-minute timeout. A timeout will now be explicit and diagnosable rather than being silently saved as a seemingly normal partial report. The next step is to run the workflow on this branch and inspect its uploaded diagnostics and job logs.
