#!/usr/bin/env bash
# End-to-end: INBOX.md interrupts a long wait (test 1); wait still elapses
# normally without an inbox (test 2).
set -u
REPO="C:/Users/msn/Documents/Source/plainloop"
FAKEPI="C:/Users/msn/Documents/Source/plainloop/.test/fakepi.cmd"

T=$(mktemp -d)
mkdir -p "$T/mission"
echo "# test mission" > "$T/mission/MISSION.md"
echo "# state" > "$T/mission/STATE.md"
cd "$T"

echo "=== TEST 1: inbox interrupts a 15s wait ==="
START=$(date +%s)
PI_BIN="$FAKEPI" FAKE_TASK_HEADER=1 FAKE_WAIT_MS=15000 node "$REPO/plainloop.mjs" run "$T/mission" --verbose &
DPID=$!
sleep 4
cat > "$T/mission/INBOX.md" <<'EOF'
## [2026-09-02T15:00:00+02:00] urgent request
please handle this now
EOF
wait $DPID
CODE=$?
END=$(date +%s)
echo "exit code: $CODE   wall time: $((END-START))s (want ~5-8s, NOT ~15s)"
echo "--- events.jsonl ---"
cat "$T/mission/events.jsonl" 2>/dev/null
echo
echo "=== TEST 2: wait elapses with no inbox ==="
mkdir -p "$T/mission2"
echo "# test mission 2" > "$T/mission2/MISSION.md"
START=$(date +%s)
PI_BIN="$FAKEPI" FAKE_TASK_HEADER=1 FAKE_WAIT_MS=5000 node "$REPO/plainloop.mjs" run "$T/mission2" --verbose &
DPID=$!
wait $DPID
CODE=$?
END=$(date +%s)
echo "exit code: $CODE   wall time: $((END-START))s (want ~6-8s)"
echo "--- events.jsonl ---"
cat "$T/mission2/events.jsonl" 2>/dev/null
rm -rf "$T"
echo "ALL TESTS DONE"
