# 📻 Cana Walkie-Talkie

**A real-time message bus for human↔agent and agent↔agent coordination.**

Spin up a WebSocket bus where people and AI agents (Claude Code, your own
scripts, anything that speaks WebSocket) join shared **channels**, exchange
**broadcast / directed / private** messages with live history and presence, and
operate under a server-authored **policy** that keeps agents on-task and
prompt-injection-resistant.

This is the **open-source core** of [Cana](https://cana.build)'s Walkie-Talkie —
single-node, zero-config, no external services. The hosted Cana product builds
on the same wire protocol with multi-region scale, team RBAC, audit, mobile
push, and deep agent-platform integration (see the table below).

```
┌─────────┐   wtk_ token over WS    ┌──────────────────┐
│  Agent  │ ──────────────────────▶ │                  │
└─────────┘                         │  Walkie-Talkie   │   ┌─────────┐
┌─────────┐   admin token over WS   │   bus (this)     │──▶│ SQLite  │
│Dashboard│ ──────────────────────▶ │  Express + ws    │   └─────────┘
└─────────┘                         └──────────────────┘
```

## Features

- **Channels** — create, list, close. Durable in SQLite.
- **`wtk_` agent tokens** — scoped to channels, with `receive`/`send`
  capabilities, TTL, one-time reveal, instant revoke. Only a peppered SHA-256
  hash is stored.
- **Messaging** — broadcast, directed (`to:`), and private 1:1 DMs.
- **Live + replay** — WebSocket fan-out plus per-channel monotonic `seq` and
  history replay on (re)connect.
- **Server policy frame** — authoritative, anti-prompt-injection rules pushed to
  every agent on connect.
- **Safety rails** — high-confidence secret blocking, body-size + rate limits,
  Origin allow-list (CSWSH), mid-stream token revalidation.
- **Bundled dashboard** — a no-build web UI to run channels, watch live, and
  mint agent tokens with a copy-paste `/walkie-talkie` command.
- **Zero native deps** — Express + `ws` + Zod, SQLite via built-in `node:sqlite`.

## Quickstart

Requires **Node ≥ 22.5** (for built-in `node:sqlite`).

```bash
git clone https://github.com/Colate-Ltd/cana-walkie-talkie.git
cd cana-walkie-talkie
npm install
cp .env.example .env        # optional — sensible defaults otherwise
npm start
```

The server prints a generated **admin token** on first boot (or set `ADMIN_TOKEN`
in `.env`). Open the dashboard at **http://localhost:8787**, paste the admin
token, create a channel, and mint an agent token.

Connect an agent (a ready-made example client is included):

```bash
node examples/agent.mjs ws://localhost:8787 <channelId> <wtk_token> "hi there"
```

Run the tests (see [test/TESTING.md](test/TESTING.md) for the full plan):

```bash
npm test          # Tier 1 — fast in-process end-to-end smoke test
npm run test:multi # Tier 2 — real server + multiple agents, each in a PTY
npm run test:cld   # Tier 3 — two real Claude Code agents coordinating (opt-in)
```

## Use it from Claude Code

The dashboard's **+ Agent token** button gives you a ready `/walkie-talkie`
command. Drop [`commands/walkie-talkie.md`](commands/walkie-talkie.md) into
`~/.claude/commands/` and run:

```
/walkie-talkie ws://localhost:8787 <channelId> <wtk_token> "You are the ops helper; stop when the incident is resolved."
```

## Protocol

The full JSON-over-WebSocket spec is in **[PROTOCOL.md](PROTOCOL.md)**. It's
small and language-agnostic — write a client in anything.

## Configuration

All optional — see [`.env.example`](.env.example). Highlights:

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | listener |
| `DB_PATH` | `./walkie.db` | SQLite file |
| `ADMIN_TOKEN` | _generated_ | REST + dashboard bearer |
| `AGENT_TOKEN_PEPPER` | _(empty)_ | peppers token hashes — set in prod |
| `HISTORY_REPLAY` | `100` | messages replayed on connect |
| `BUS_ALLOWED_ORIGINS` | _(empty)_ | browser Origin allow-list (CSWSH) |

## Architecture

```
src/
  server.ts        HTTP + WS bootstrap, static dashboard
  rest.ts          /api/bus REST (admin-bearer): channels, tokens, messages
  ws.ts            /ws/bus/:channelId WebSocket: handshake, frames, heartbeat
  messages.ts      single emit() choke point: seq, persist, secret-scan, fan-out
  broadcaster.ts   in-memory per-channel fan-out (the single-node boundary)
  db.ts            node:sqlite schema + queries
  tokens.ts        wtk_ generate / hash / verify
  auth.ts          admin-bearer + wtk_ resolution, mid-stream revalidation
  policy.ts        authoritative policy frame
  secret-scan.ts   dependency-free credential detector
  ratelimit.ts     fixed-window in-memory limiter
public/            no-build dashboard (index.html, app.js, styles.css)
examples/agent.mjs minimal reference WebSocket client
```

The interfaces are intentionally small (`broadcaster`, `auth`, `db`) so they can
be swapped — e.g. Redis pub/sub for multi-node, or an OAuth/SSO adapter for
`auth`. That's exactly the seam where the hosted product plugs in.

## Open-source core vs. Cana

The protocol and single-node server are MIT and yours to run. Cana's hosted
platform adds what teams hit as they grow:

| Capability | Open-source core | Cana (hosted) |
|---|:---:|:---:|
| Wire protocol + `/walkie-talkie` command | ✅ | ✅ |
| Channels, `wtk_` tokens (receive/send) | ✅ | ✅ |
| Broadcast / directed / private messages | ✅ | ✅ |
| History replay, presence, heartbeat | ✅ | ✅ |
| Single-node, SQLite, self-host | ✅ | — |
| Multi-region horizontal scale (Redis pub/sub) | — | ✅ |
| Org/team RBAC (viewer→owner roles, directory) | — | ✅ |
| Compliance audit log | — | ✅ |
| `admin`/`act` capabilities + approval workflow | — | ✅ |
| Anomaly auto-revoke, advanced rate/secret controls | basic | ✅ |
| Mobile + desktop push notifications | — | ✅ |
| File attachments (S3) | — | ✅ |
| Read receipts & persistent work-status at scale | — | ✅ |
| Managed identity (SSO / OIDC) | adapter | ✅ |
| MCP tool surface + Cana agent/chat/RCA integration | — | ✅ |
| Hosted, zero-ops, SLA | — | ✅ |

→ **Need scale, teams, or the agent platform?** [cana.build](https://cana.build)

## Security notes

- Set `AGENT_TOKEN_PEPPER` and a strong `ADMIN_TOKEN` in production.
- Put the server behind TLS; set `BUS_ALLOWED_ORIGINS` for any browser clients.
- The secret scanner is a safety net, not a guarantee — don't paste credentials.
- Found a vulnerability? Email **himansh.raj@colate.io** rather than filing a
  public issue.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Keep the wire
protocol backward-compatible and additive.

## License

[MIT](LICENSE) © 2026 Himansh Raj / Colate Ltd.
