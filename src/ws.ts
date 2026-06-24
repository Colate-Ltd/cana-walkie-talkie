import crypto from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config, limits } from "./config.js";
import { resolveWsIdentity, tokenStillValid } from "./auth.js";
import { getChannel } from "./db.js";
import {
  addConnection,
  removeConnection,
  deliverSystem,
  connectionCount,
} from "./broadcaster.js";
import { emitMessage, historyFor } from "./messages.js";
import { policyFrame, POLICY_VERSION } from "./policy.js";
import { allow } from "./ratelimit.js";
import type { ClientFrame, ServerFrame } from "./types.js";

const HEARTBEAT_MS = 30_000;
const REVALIDATE_MS = 60_000;

/** Pull the raw token out of the Sec-WebSocket-Protocol header (`wtk.<token>`)
 *  or, as a fallback, the `?token=` query param. */
function extractToken(req: IncomingMessage, url: URL): string {
  const proto = req.headers["sec-websocket-protocol"];
  if (proto) {
    const first = String(proto).split(",")[0]!.trim();
    if (first.startsWith("wtk.")) return first.slice(4);
  }
  return url.searchParams.get("token") ?? "";
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers["origin"];
  if (!origin) return true; // headless agent — no Origin header
  if (config.allowedOrigins.length === 0) {
    // Same-origin dashboard requests carry an Origin; allow the host we serve.
    const host = req.headers["host"];
    return !!host && (origin === `http://${host}` || origin === `https://${host}`);
  }
  return config.allowedOrigins.includes(String(origin));
}

export function attachWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxBodyBytes + 4096,
    // Echo the token-bearing subprotocol so browser clients accept the handshake.
    handleProtocols: (protocols) => {
      const first = [...protocols][0];
      return first ?? false;
    },
  });

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    const match = url.pathname.match(/^\/ws\/bus\/([^/]+)\/?$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const channelId = decodeURIComponent(match[1]!);

    if (!originAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, req, channelId);
    });
  });
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function handleConnection(ws: WebSocket, req: IncomingMessage, channelId: string): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const rawToken = extractToken(req, url);

  const auth = resolveWsIdentity(rawToken, channelId);
  if (!auth.ok) {
    send(ws, { v: 1, type: "error", code: auth.code, message: auth.message });
    ws.close(4001, auth.code);
    return;
  }
  const identity = auth.identity;

  const channel = getChannel(channelId);
  if (!channel || channel.status !== "active") {
    send(ws, { v: 1, type: "error", code: "channel_closed", message: "channel is closed or missing" });
    ws.close(4002, "channel_closed");
    return;
  }
  if (!identity.capabilities.includes("receive")) {
    send(ws, { v: 1, type: "error", code: "forbidden", message: "token cannot receive" });
    ws.close(4003, "forbidden");
    return;
  }
  if (connectionCount(channel.id) >= limits.maxConnectionsPerChannel) {
    send(ws, { v: 1, type: "error", code: "channel_full", message: "channel connection limit reached" });
    ws.close(4004, "channel_full");
    return;
  }

  const connId = "conn_" + crypto.randomBytes(8).toString("hex");
  const conn = {
    id: connId,
    channelId: channel.id,
    handle: identity.handle,
    tokenId: identity.tokenId,
    send: (frame: ServerFrame) => send(ws, frame),
    close: (code: number, reason: string) => ws.close(code, reason),
  };
  addConnection(conn);

  // Handshake: joined → policy → history, then live presence.
  send(ws, {
    v: 1,
    type: "joined",
    connectionId: connId,
    channelId: channel.id,
    handle: identity.handle,
    owner: identity.owner,
    capabilities: identity.capabilities,
    policyVersion: POLICY_VERSION,
  });
  send(ws, policyFrame());
  const history = historyFor(channel.id, identity.handle);
  send(ws, { v: 1, type: "history", messages: history, count: history.length });
  deliverSystem(channel.id, { v: 1, type: "system", event: "participant_joined", body: { handle: identity.handle }, ts: new Date().toISOString() });

  // ── Liveness: app-level ping/pong + WS control-frame heartbeat ──────
  let alive = true;
  ws.on("pong", () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) { ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, HEARTBEAT_MS);

  // Mid-stream revocation / expiry enforcement.
  const revalidate = setInterval(() => {
    if (!tokenStillValid(identity.tokenId)) {
      send(ws, { v: 1, type: "error", code: "revoked", message: "token revoked or expired" });
      ws.close(4003, "revoked");
    }
  }, REVALIDATE_MS);

  ws.on("message", (data) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      send(ws, { v: 1, type: "error", code: "bad_frame", message: "invalid JSON" });
      return;
    }

    if (frame.type === "ping") {
      send(ws, { v: 1, type: "pong" });
      return;
    }

    if (frame.type === "message") {
      if (!identity.capabilities.includes("send")) {
        send(ws, { v: 1, type: "error", code: "forbidden", message: "token cannot send" });
        return;
      }
      if (!allow(`wsmsg:${connId}`, limits.perConnRatePerSec, 1000)) {
        send(ws, { v: 1, type: "error", code: "rate_limited", message: "slow down" });
        return;
      }
      const result = emitMessage({
        channelId: channel.id,
        from: identity.handle,
        fromTokenId: identity.tokenId,
        to: frame.to ?? null,
        private: frame.private,
        body: frame.body,
      });
      if (!result.ok) {
        send(ws, { v: 1, type: "error", code: result.code, message: result.message });
      }
      return;
    }

    send(ws, { v: 1, type: "error", code: "unknown_frame", message: "unsupported frame type" });
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(revalidate);
    removeConnection(channel.id, connId);
    deliverSystem(channel.id, { v: 1, type: "system", event: "participant_left", body: { handle: identity.handle }, ts: new Date().toISOString() });
  });

  ws.on("error", () => { /* close handler does cleanup */ });
}
