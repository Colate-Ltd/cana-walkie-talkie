#!/usr/bin/env node
/**
 * Scenario test client used by run-multi-agent.sh. Connects to a running bus,
 * logs every frame it receives, and (per role) drives a scripted timeline.
 *
 *   node scenario-agent.mjs <wsBase> <channelId> <token> <name> <role> [lifetimeSec]
 *
 * roles:
 *   announcer  – broadcasts, then a private DM to bob, then a directed msg to carol
 *   echo       – replies "ack from <name>" to anything addressed to it
 *   listener   – just logs (used for the late joiner and the observer)
 *
 * Lives in test/ so `ws` resolves from the repo's node_modules natively.
 */
import { WebSocket } from "ws";

const [, , wsBase, channelId, token, name, role, lifetimeArg] = process.argv;
const lifetimeMs = (Number(lifetimeArg) || 14) * 1000;
const log = (...a) => console.log(`[${name}]`, ...a);
const url = `${wsBase.replace(/\/$/, "")}/ws/bus/${encodeURIComponent(channelId)}`;
const ws = new WebSocket(url, [`wtk.${token}`]);
const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

ws.on("open", () => log("OPEN"));
ws.on("message", (data) => {
  const f = JSON.parse(data.toString());
  if (f.type === "joined") {
    log(`JOINED handle=${f.handle} caps=${f.capabilities.join(",")}`);
    if (role === "announcer") {
      setTimeout(() => send({ type: "message", body: { text: "hello all, this is alice" } }), 1500);
      setTimeout(() => send({ type: "message", to: "bob", private: true, body: { text: "psst bob, secret handshake" } }), 3000);
      setTimeout(() => send({ type: "message", to: "carol", private: false, body: { text: "carol, please ack" } }), 4500);
    }
  } else if (f.type === "policy") {
    log(`POLICY v${f.policyVersion} rules=${f.rules.length}`);
  } else if (f.type === "history") {
    log(`HISTORY count=${f.count}` + (f.count ? " :: " + f.messages.map((m) => `${m.from}:${m.body?.text ?? ""}`).join(" | ") : ""));
  } else if (f.type === "message") {
    const scope = f.private ? "PRIVATE" : f.to ? `DIRECT->${f.to}` : "BROADCAST";
    log(`RECV ${scope} from=${f.from} seq=${f.seq} text=${JSON.stringify(f.body?.text ?? f.body)}`);
    if (role === "echo" && f.to === name && f.from !== name) {
      send({ type: "message", to: f.from, private: !!f.private, body: { text: `ack from ${name}` } });
    }
  } else if (f.type === "system") {
    log(`SYSTEM ${f.event} ${f.body?.handle ?? ""}`);
  } else if (f.type === "error") {
    log(`ERROR code=${f.code} msg=${f.message}`);
  }
});

const ping = setInterval(() => send({ type: "ping" }), 20000);
// Clean self-exit so PTY logs flush (never rely on SIGTERM/pkill mid-stream).
setTimeout(() => { log("LIFETIME_END"); try { ws.close(1000, "done"); } catch {} setTimeout(() => process.exit(0), 300); }, lifetimeMs);
ws.on("close", (code, reason) => { clearInterval(ping); log(`CLOSE code=${code} reason=${reason || ""}`); process.exit(0); });
ws.on("error", (e) => log(`SOCKET_ERR ${e.message}`));
