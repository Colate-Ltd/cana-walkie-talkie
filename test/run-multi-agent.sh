#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# Multi-agent integration test (Tier 2). Boots a REAL server instance on a
# throwaway DB, mints tokens over the live REST API, launches several
# independent agent clients (each in its own PTY when available), drives a
# routing scenario, tests revocation, and asserts on what each agent logged.
#
#   bash test/run-multi-agent.sh           # auto PTY on macOS, plain bg elsewhere
#   WT_PTY=0 bash test/run-multi-agent.sh  # force plain background processes
#
# See test/TESTING.md for the rationale and what each check proves.
# ─────────────────────────────────────────────────────────────────────
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8899}"
ADMIN="test-admin-$$"
PEPPER="test-pepper"
DB="$REPO/.test-multi.db"
WS="ws://127.0.0.1:$PORT"
API="http://127.0.0.1:$PORT/api/bus"
HTTP="http://127.0.0.1:$PORT"

cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  pkill -f "scenario-agent.mjs" 2>/dev/null
  rm -f "$DB" "$DB-wal" "$DB-shm" "$HERE"/.agent-*.log
}
trap cleanup EXIT
rm -f "$DB" "$DB-wal" "$DB-shm"

# Small JSON extractor so we don't depend on python.
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

echo "== booting server on :$PORT (throwaway db) =="
( cd "$REPO" && ADMIN_TOKEN="$ADMIN" AGENT_TOKEN_PEPPER="$PEPPER" DB_PATH="$DB" PORT="$PORT" HOST=127.0.0.1 exec npx tsx src/server.ts ) >/dev/null 2>&1 &
SRV=$!
for i in $(seq 1 60); do curl -sf "$HTTP/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "$HTTP/healthz" >/dev/null 2>&1 || { echo "server failed to start"; exit 1; }

CHID=$(curl -s -X POST "$API/channels" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" -d '{"name":"Test Room"}' | jget 'o.id')
mint() { curl -s -X POST "$API/tokens" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d "{\"name\":\"$1\",\"channels\":[\"$CHID\"],\"capabilities\":[\"receive\",\"send\"],\"ttlHours\":1}" | jget 'o.key'; }
A=$(mint alice); B=$(mint bob); C=$(mint carol); D=$(mint dave)

# Launch an agent in a PTY (macOS `script`) or util-linux `script`, else plain
# bg. PIDs are captured so we can `wait` for just the agents — `wait` with no
# args would also block on the long-lived server background job.
AGENT_PIDS=()
launch() { # name role token lifetime
  local log="$HERE/.agent-$1.log"
  local cmd=(node "$HERE/scenario-agent.mjs" "$WS" "$CHID" "$3" "$1" "$2" "$4")
  if [ "${WT_PTY:-auto}" != "0" ] && command -v script >/dev/null 2>&1; then
    if [ "$(uname)" = "Darwin" ]; then script -q "$log" "${cmd[@]}" >/dev/null 2>&1 &
    else script -qfec "${cmd[*]}" "$log" >/dev/null 2>&1 & fi
  else "${cmd[@]}" >"$log" 2>&1 & fi
  AGENT_PIDS+=("$!")
}

echo "== launching alice(announcer) bob(echo) carol(echo) observer(listener) =="
launch alice announcer "$A" 16
launch bob   echo      "$B" 16
launch carol echo      "$C" 16
launch observer listener "$ADMIN" 16   # admin token => server handle "dashboard"
sleep 7

echo "== launching dave(listener) LATE to test history replay =="
launch dave listener "$D" 9
sleep 4

echo "== revoking bob's token to test live-socket teardown =="
BOB_ID=$(curl -s "$API/tokens" -H "authorization: Bearer $ADMIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).tokens.find(x=>x.name==="bob");process.stdout.write(t?t.id:"")})')
curl -s -X DELETE "$API/tokens/$BOB_ID" -H "authorization: Bearer $ADMIN" >/dev/null

echo "== waiting for agents to self-exit (flushes logs) =="
for pid in "${AGENT_PIDS[@]}"; do wait "$pid" 2>/dev/null; done
L() { cat "$HERE/.agent-$1.log" 2>/dev/null | tr -d '\r'; }

echo ""; echo "############### ASSERTIONS ###############"
pass=0; fail=0
chk() { if eval "$2"; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fail=$((fail+1)); fi; }
chk "bob received the broadcast"               "L bob   | grep -q 'RECV BROADCAST from=alice'"
chk "carol received the broadcast"             "L carol | grep -q 'RECV BROADCAST from=alice'"
chk "bob received the PRIVATE DM"              "L bob   | grep -q 'RECV PRIVATE from=alice'"
chk "carol did NOT see the private DM"         "! L carol | grep -q 'secret handshake'"
chk "observer did NOT see the private DM"      "! L observer | grep -q 'secret handshake'"
chk "carol received the directed message"      "L carol | grep -q 'RECV DIRECT->carol'"
chk "alice got bob's private ack back"         "L alice | grep -q 'RECV PRIVATE from=bob'"
chk "alice got carol's directed ack"           "L alice | grep -q 'from=carol'"
chk "presence: participant_joined observed"    "L observer | grep -q 'SYSTEM participant_joined'"
chk "late joiner dave got history replay"      "L dave  | grep -q 'HISTORY count=[1-9]'"
chk "dave history excluded the private DM"     "! L dave | grep -q 'secret handshake'"
chk "revoking bob closed his live socket"      "L bob   | grep -q 'CLOSE code=4003'"
echo ""; echo "result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
