#!/usr/bin/env bash
# End-to-end: parent settles without TASK.md/STOP → driver re-prompts the
# same parent instead of hard-stopping (parentRetries).
#   TEST A: empty settle on attempt 1, TASK.md on attempt 2 → loop continues
#   TEST B: empty settles on both attempts → stop "after 2 attempts"
#   TEST C: STOP on the first attempt → stops immediately, no retry
set -u
REPO="C:/Users/msn/Documents/Source/plainloop"
FAKEPI="C:/Users/msn/Documents/Source/plainloop/.test/fakepi-parent-retry.cmd"

new_mission() {
  local d="$1"
  mkdir -p "$d"
  echo "# test mission" > "$d/MISSION.md"
  echo "# state" > "$d/STATE.md"
}

T=$(mktemp -d)
cd "$T"

echo "=== TEST A: retry succeeds on attempt 2 → loop continues ==="
new_mission "$T/a"
PI_BIN="$FAKEPI" FAKE_PARENT_EMPTY=1 node "$REPO/plainloop.mjs" run "$T/a" --verbose
CODE=$?
echo "exit code: $CODE (want 1 — stopped later by parent STOP, not by missing TASK.md)"
echo "--- events.jsonl ---"
cat "$T/a/events.jsonl"
A_OK=1
grep -q 'parent_retry' "$T/a/events.jsonl" || { echo "FAIL A: no parent_retry event"; A_OK=0; }
grep -q 're-prompting' "$T/a/events.jsonl" || { echo "FAIL A: no retry log line"; A_OK=0; }
grep -q 'archived history/TASK-0001.md' "$T/a/events.jsonl" || { echo "FAIL A: task never archived"; A_OK=0; }
grep -q 'after 2 attempts' "$T/a/events.jsonl" && { echo "FAIL A: hard-stopped on missing TASK.md"; A_OK=0; }
grep -q 'Your previous turn ended without writing TASK.md' "$T/a/.fakepi-prompts" || { echo "FAIL A: retry prompt missing corrective nudge"; A_OK=0; }
grep -q 'STOP test done' "$T/a/events.jsonl" || { echo "FAIL A: expected STOP at task 2"; A_OK=0; }
echo "TEST A: $([ $A_OK -eq 1 ] && echo PASS || echo FAIL)"
echo

echo "=== TEST B: budget exhausted → stop after 2 attempts ==="
new_mission "$T/b"
PI_BIN="$FAKEPI" FAKE_PARENT_EMPTY=2 node "$REPO/plainloop.mjs" run "$T/b" --verbose
CODE=$?
echo "exit code: $CODE (want 1)"
echo "--- events.jsonl ---"
cat "$T/b/events.jsonl"
B_OK=1
grep -q 'parent did not write TASK.md after 2 attempts' "$T/b/events.jsonl" || { echo "FAIL B: wrong stop reason"; B_OK=0; }
[ "$(grep -c 'parent_retry' "$T/b/events.jsonl")" = "1" ] || { echo "FAIL B: expected exactly 1 parent_retry event"; B_OK=0; }
echo "TEST B: $([ $B_OK -eq 1 ] && echo PASS || echo FAIL)"
echo

echo "=== TEST C: STOP on first attempt → immediate stop, no retry ==="
new_mission "$T/c"
PI_BIN="$FAKEPI" FAKE_PARENT_STOP=1 node "$REPO/plainloop.mjs" run "$T/c" --verbose
CODE=$?
echo "exit code: $CODE (want 1)"
echo "--- events.jsonl ---"
cat "$T/c/events.jsonl"
C_OK=1
grep -q 'STOP done on first try' "$T/c/events.jsonl" || { echo "FAIL C: wrong stop reason"; C_OK=0; }
grep -q 'parent_retry' "$T/c/events.jsonl" 2>/dev/null && { echo "FAIL C: STOP must never be retried"; C_OK=0; }
echo "TEST C: $([ $C_OK -eq 1 ] && echo PASS || echo FAIL)"

rm -rf "$T"
if [ ${A_OK:-0} -eq 1 ] && [ ${B_OK:-0} -eq 1 ] && [ ${C_OK:-0} -eq 1 ]; then
  echo "ALL TESTS DONE (pass)"
else
  echo "ALL TESTS DONE (FAILURES)"
  exit 1
fi
