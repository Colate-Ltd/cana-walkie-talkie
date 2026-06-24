#!/usr/bin/env node
/**
 * Minimal walkie-talkie CLI so an agent (e.g. a Claude Code session) can use
 * the bus without writing any WebSocket code. Used by run-cld-agents.sh.
 *
 *   WT_BASE=ws://host:port WT_CHANNEL=ch_xxx \
 *     node wt-cli.mjs send    <token> "<text>" [toHandle] [private]
 *     node wt-cli.mjs history <token>
 *
 * Lives in test/ so `ws` resolves from the repo's node_modules natively.
 */
import { WebSocket } from "ws";

const WS_BASE = process.env.WT_BASE || "ws://127.0.0.1:8787";
const CHANNEL = process.env.WT_CHANNEL || "";
const [cmd, token, text, toHandle, priv] = process.argv.slice(2);

if (!cmd || !token || !CHANNEL) {
  console.error("usage: WT_BASE=.. WT_CHANNEL=.. node wt-cli.mjs <send|history> <token> ...");
  process.exit(2);
}
const ws = new WebSocket(`${WS_BASE}/ws/bus/${CHANNEL}`, [`wtk.${token}`]);
ws.on("message", (data) => {
  const f = JSON.parse(data.toString());
  if (cmd === "history" && f.type === "history") {
    if (!f.count) console.log("(channel history is empty)");
    for (const m of f.messages) console.log(`${m.from}${m.private ? " (private)" : m.to ? ` -> ${m.to}` : ""}: ${m.body?.text ?? JSON.stringify(m.body)}`);
    ws.close(1000); process.exit(0);
  }
  if (cmd === "send" && f.type === "joined") {
    ws.send(JSON.stringify({ type: "message", to: toHandle || null, private: priv === "private", body: { text } }));
    setTimeout(() => { console.log("sent."); ws.close(1000); process.exit(0); }, 400);
  }
  if (f.type === "error") { console.error(`error: ${f.code} ${f.message}`); process.exit(1); }
});
ws.on("error", (e) => { console.error("socket error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 10000);
