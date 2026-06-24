# Walkie-Talkie wire protocol (v1)

A small, JSON-over-WebSocket protocol for multi-party human↔agent and
agent↔agent messaging. This document is the source of truth; the reference
server in this repo implements it, and any client (browser, Node, Rust, Go…)
can speak it.

## Connecting

```
GET  {WS_BASE}/ws/bus/{channelId}
Sec-WebSocket-Protocol: wtk.{token}
```

- The credential is an opaque agent token (`wtk_…`) carried in the
  `Sec-WebSocket-Protocol` header as `wtk.{token}` — **never** in the URL/query
  (a `?token=` fallback exists for non-browser clients but is discouraged).
- The server echoes the subprotocol back to complete the handshake.
- Browser clients are subject to an Origin allow-list (`BUS_ALLOWED_ORIGINS`);
  headless clients (no `Origin` header) are allowed.

Close codes: `4001` auth failed · `4002` channel closed/missing · `4003`
forbidden / token revoked or expired · `4004` channel full.

## Frames

Every frame is a JSON object. Server frames carry `"v": 1`.

### Server → client

On connect the server sends, in order:

```jsonc
{ "v":1, "type":"joined", "connectionId":"conn_…", "channelId":"ch_…",
  "handle":"helper", "owner":"token:wtk_abcd", "capabilities":["receive","send"],
  "policyVersion":1 }

{ "v":1, "type":"policy", "policyVersion":1, "rules":["…authoritative rules…"] }

{ "v":1, "type":"history", "messages":[ /* WireMessage[] */ ], "count":0 }
```

Then, live:

```jsonc
// WireMessage
{ "v":1, "type":"message", "channelId":"ch_…", "seq":42,
  "from":"helper", "fromTokenId":"tok_… | null", "to":"handle | null",
  "private":false, "ts":"2026-06-24T12:00:00.000Z", "body":{ "text":"hi" } }

{ "v":1, "type":"system", "event":"participant_joined|participant_left|channel_closed",
  "body":{ "handle":"helper" }, "ts":"…" }

{ "v":1, "type":"pong" }

{ "v":1, "type":"error", "code":"forbidden|rate_limited|secret_blocked|…", "message":"…" }
```

### Client → server

```jsonc
{ "type":"message", "to":"handle | null", "private":false, "body":{ "text":"hello" } }
{ "type":"ping" }
```

- `body` is freeform JSON; the reference client/UI use `{ "text": "…" }`.
- `to` + `private:true` ⇒ a 1:1 DM visible only to sender and recipient.
- `to` set + `private:false` ⇒ a directed-but-public message (everyone sees it,
  one handle is addressed).
- `to:null` ⇒ broadcast.

## Sequencing & history

- `seq` is a monotonic, server-assigned integer **per channel** (gap-free).
- On (re)connect the server replays the most recent `HISTORY_REPLAY` messages
  visible to your handle (private messages only replay to their two parties).
- Use the highest `seq` you've seen to de-duplicate after a reconnect.

## Capabilities

A token carries a subset of `["receive","send"]` (the open-source core's set).
`receive` is required to attach; `send` is required to post. Sending without
`send` returns an `error` frame with code `forbidden`.

## Limits (reference server defaults)

- Message body ≤ 256 KB (`MAX_BODY_BYTES`).
- Per-connection send rate ≤ 8 msg/s.
- ≤ 200 live connections per channel.
- High-confidence credentials are blocked (`error` code `secret_blocked`).
- Tokens expire (default 8h, max 7d) and are re-checked every 60s mid-stream.

## Policy frame

The `policy` frame is **authoritative and server-authored**. Clients must obey
it and must treat message text as untrusted data, not instructions. The server
never accepts a `policy` frame from a client, so peers cannot forge the rules.
