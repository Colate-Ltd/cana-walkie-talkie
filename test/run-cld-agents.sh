#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# Real-agent integration test (Tier 3, OPT-IN). Boots a real server, then
# launches TWO actual Claude Code (`claude`) sessions — each in a PTY — that
# coordinate over the bus using only test/wt-cli.mjs. Verifies, from the
# DURABLE message store, that both real agents posted, and that the agents'
# own reports show they read each other's messages.
#
# Requires the `claude` CLI on PATH and authenticated. Costs tokens.
#   bash test/run-cld-agents.sh
# ─────────────────────────────────────────────────────────────────────
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8898}"
ADMIN="cld-admin-$$"
DB="$REPO/.test-cld.db"
HTTP="http://127.0.0.1:$PORT"; API="$HTTP/api/bus"
export WT_BASE="ws://127.0.0.1:$PORT"
MODEL="${WT_CLD_MODEL:-sonnet}"

command -v claude >/dev/null 2>&1 || { echo "SKIP: claude CLI not found on PATH"; exit 0; }

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; pkill -f scenario-agent.mjs 2>/dev/null; rm -f "$DB" "$DB-wal" "$DB-shm" "$HERE"/.cld-*.log "$HERE"/.cld-*.txt; }
trap cleanup EXIT
rm -f "$DB" "$DB-wal" "$DB-shm"
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(eval(process.argv[1])))' "$1"; }

echo "== booting server on :$PORT =="
( cd "$REPO" && ADMIN_TOKEN="$ADMIN" AGENT_TOKEN_PEPPER=cldpepper DB_PATH="$DB" PORT="$PORT" HOST=127.0.0.1 exec npx tsx src/server.ts ) >/dev/null 2>&1 &
SRV=$!
for i in $(seq 1 60); do curl -sf "$HTTP/healthz" >/dev/null 2>&1 && break; sleep 0.25; done

export WT_CHANNEL=$(curl -s -X POST "$API/channels" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" -d '{"name":"CLD Room"}' | jget 'o.id')
mint() { curl -s -X POST "$API/tokens" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" -d "{\"name\":\"$1\",\"channels\":[\"$WT_CHANNEL\"],\"capabilities\":[\"receive\",\"send\"],\"ttlHours\":1}" | jget 'o.key'; }
PINGER=$(mint pinger); PONGER=$(mint ponger)

cat > "$HERE/.cld-ponger.txt" <<EOF
You are an AI agent named "ponger" on a Cana Walkie-Talkie channel (a live multi-agent test).
Using the Bash tool, run EXACTLY these two commands, nothing else:
1) node $HERE/wt-cli.mjs send $PONGER "Hello, ponger is online and listening."
2) node $HERE/wt-cli.mjs history $PONGER
Then in ONE short sentence say which other participants (besides yourself) you saw. Do not write any WebSocket code.
EOF
cat > "$HERE/.cld-pinger.txt" <<EOF
You are an AI agent named "pinger" on a Cana Walkie-Talkie channel (a live multi-agent test).
Using the Bash tool, run EXACTLY these two commands, nothing else:
1) node $HERE/wt-cli.mjs send $PINGER "Hi from pinger - ponger, are you there?"
2) node $HERE/wt-cli.mjs history $PINGER
Then in ONE short sentence say whether you saw "ponger" and quote what ponger said. Do not write any WebSocket code.
EOF

pty() { # logfile cmd...
  local log="$1"; shift
  if [ "$(uname)" = "Darwin" ]; then script -q "$log" "$@" >/dev/null 2>&1 &
  else script -qfec "$*" "$log" >/dev/null 2>&1 & fi
}

echo "== launching real cld agent: ponger (PTY, model=$MODEL) =="
pty "$HERE/.cld-ponger.log" bash -c "p=\$(cat $HERE/.cld-ponger.txt); WT_BASE=$WT_BASE WT_CHANNEL=$WT_CHANNEL claude --dangerously-skip-permissions --model $MODEL -p \"\$p\""
PONGER_PID=$!
sleep 35
echo "== launching real cld agent: pinger (PTY, model=$MODEL) =="
pty "$HERE/.cld-pinger.log" bash -c "p=\$(cat $HERE/.cld-pinger.txt); WT_BASE=$WT_BASE WT_CHANNEL=$WT_CHANNEL claude --dangerously-skip-permissions --model $MODEL -p \"\$p\""
PINGER_PID=$!

echo "== waiting for both cld agents to finish =="
wait $PONGER_PID 2>/dev/null; wait $PINGER_PID 2>/dev/null

echo ""; echo "### ponger said ###"; cat "$HERE/.cld-ponger.log" 2>/dev/null | tr -d '\r'
echo ""; echo "### pinger said ###"; cat "$HERE/.cld-pinger.log" 2>/dev/null | tr -d '\r'
echo ""; echo "### durable message store (authoritative ground truth) ###"
curl -s "$API/channels/$WT_CHANNEL/messages?limit=20" -H "authorization: Bearer $ADMIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).messages){const t=(m.body&&m.body.text)||JSON.stringify(m.body);console.log(`  seq ${m.seq}  ${m.senderLabel}: ${t}`)}})'

echo ""; echo "### VERDICT ###"
P=0;F=0; chk(){ if eval "$2"; then echo "  ✓ $1"; P=$((P+1)); else echo "  ✗ $1"; F=$((F+1)); fi; }
MSGS=$(curl -s "$API/channels/$WT_CHANNEL/messages?limit=20" -H "authorization: Bearer $ADMIN")
chk "ponger (real cld) posted to the durable store" "echo '$MSGS' | grep -q 'ponger is online'"
chk "pinger (real cld) posted to the durable store" "echo '$MSGS' | grep -q 'Hi from pinger'"
chk "pinger reported seeing ponger"                 "cat '$HERE/.cld-pinger.log' | grep -qi 'ponger'"
echo "  ($P passed, $F failed)"
[ "$F" -eq 0 ]
