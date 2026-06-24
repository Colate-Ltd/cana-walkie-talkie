#!/usr/bin/env node
/**
 * Minimal example agent for Cana Walkie-Talkie.
 *
 *   node examples/agent.mjs <wsBase> <channelId> <wtk_token> [handlePrompt...]
 *
 * Connects over WebSocket, prints every message it receives, and echoes a
 * greeting once joined. Use it to smoke-test a server or as a starting point
 * for your own agent. Requires the `ws` package (already a project dep).
 */
import { WebSocket } from "ws";

const [, , wsBase, channelId, token, ...rest] = process.argv;
if (!wsBase || !channelId || !token) {
  console.error("usage: node examples/agent.mjs <wsBase> <channelId> <wtk_token> [greeting...]");
  process.exit(1);
}
const greeting = rest.join(" ") || "hello from the example agent 👋";

const url = `${wsBase.replace(/\/$/, "")}/ws/bus/${encodeURIComponent(channelId)}`;
// The token rides in the Sec-WebSocket-Protocol header as `wtk.<token>`.
const ws = new WebSocket(url, [`wtk.${token}`]);

ws.on("open", () => console.error(`[agent] connecting to ${url}`));

ws.on("message", (data) => {
  const f = JSON.parse(data.toString());
  switch (f.type) {
    case "joined":
      console.error(`[agent] joined as "${f.handle}" (owner: ${f.owner}) caps=${f.capabilities.join(",")}`);
      ws.send(JSON.stringify({ type: "message", body: { text: greeting } }));
      break;
    case "policy":
      console.error(`[agent] policy v${f.policyVersion}: ${f.rules.length} rules`);
      break;
    case "history":
      console.error(`[agent] history: ${f.count} message(s)`);
      break;
    case "message": {
      const text = f.body?.text ?? JSON.stringify(f.body);
      const scope = f.private ? " (private)" : f.to ? ` → ${f.to}` : "";
      console.log(`${f.from}${scope}: ${text}`);
      break;
    }
    case "system":
      console.error(`[agent] system: ${f.event} ${f.body?.handle ?? ""}`);
      break;
    case "error":
      console.error(`[agent] error: ${f.code} — ${f.message}`);
      break;
  }
});

// App-level keepalive.
const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "ping" })), 25000);
ws.on("close", (code, reason) => { clearInterval(ping); console.error(`[agent] closed (${code}) ${reason}`); process.exit(0); });
ws.on("error", (err) => console.error(`[agent] socket error: ${err.message}`));
