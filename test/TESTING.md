# Test plan

Three tiers, smallest/fastest first. All run against the real protocol; the
higher tiers exercise progressively more realistic launch conditions.

| Tier | Command | Scope | Needs |
|------|---------|-------|-------|
| 1 — Smoke | `npm test` | In-process end-to-end: boots the server in the test process and drives one agent + one dashboard connection through the whole lifecycle. | node only |
| 2 — Multi-agent | `npm run test:multi` | Real server process + **several independent agent clients, each in its own PTY**, exercising every routing mode, history replay, presence, and revocation. | node (+ `script` for PTY) |
| 3 — Real agents | `npm run test:cld` | Two **actual Claude Code (`claude`) sessions** in PTYs coordinating over the bus, verified against the durable store. Opt-in. | `claude` CLI, authenticated |

## Tier 1 — smoke (`test/smoke.ts`)

Boots the server in-process against a throwaway SQLite file and asserts: auth
enforcement, channel + token lifecycle, the WS handshake (`joined`→`policy`→
`history`), message fan-out, server-assigned `seq`, high-confidence secret
blocking, and that revoking a token closes its live socket. Fast (<5s), no
external processes — the first thing to run.

## Tier 2 — multi-agent (`test/run-multi-agent.sh`)

Self-contained. Boots a real server on a throwaway DB, mints tokens over the
live REST API, then launches independent agents — `alice` (announcer), `bob`
and `carol` (echo), an admin `observer`, and a late-joining `dave` — each as a
separate OS process in its own PTY. The announcer broadcasts, sends a private
DM to bob, and a directed message to carol; bob is then revoked mid-stream.

The 12 assertions prove, from each agent's own log:

- broadcast reaches everyone; directed (`to:`) reaches everyone but is addressed;
- a **private** DM reaches only sender + recipient (carol and the observer never see it);
- echo replies route back (including a private ack);
- presence (`participant_joined`/`left`) is delivered;
- a late joiner gets history replay **with private messages excluded**;
- revoking a token closes its live socket (`CLOSE 4003`).

PTY is automatic on macOS (BSD `script`) and util-linux (`script -c`); set
`WT_PTY=0` to force plain background processes (e.g. minimal CI images).

## Tier 3 — real Claude agents (`test/run-cld-agents.sh`, opt-in)

Boots a real server, then launches two genuine `claude` sessions in PTYs. Each
is told (prompt only) to announce itself and read channel history using
`test/wt-cli.mjs` — a tiny send/history CLI, so the agent writes no WebSocket
code. Success = both greetings present in the **durable message store** (the
authoritative ground truth) and the agents' reports show they read each other's
messages. Requires the `claude` CLI and spends tokens; skips cleanly if absent.
Override the model with `WT_CLD_MODEL` (default `sonnet`).

## Harness notes (lessons baked into these scripts)

These bit us while building the suite; the scripts already account for them:

- **`NODE_PATH` is ignored for ESM imports.** Test clients live under `test/`
  so `import { WebSocket } from "ws"` resolves from the repo's `node_modules`
  natively — don't try to inject it via `NODE_PATH`.
- **PTYs don't flush on SIGTERM.** Killing a `script`-wrapped process with
  `pkill` loses its buffered log tail. Every agent self-exits cleanly on a
  lifetime timer and the orchestrator `wait`s for natural exit instead of
  killing — so all logs flush.
- **Use a fresh DB per run.** Messages are durable; a reused channel makes
  history-replay counts non-deterministic. Each tier uses a throwaway DB.
- **Revocation is permanent.** A revoked token can't be reused — re-mint
  between runs (the self-contained scripts always mint fresh).
- **Durable store is ground truth.** When a live observer's log is ambiguous,
  assert against `GET /api/bus/channels/:id/messages` (SQLite), not the socket.
